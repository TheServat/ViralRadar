/**
 * TMDB: films and television, trending.
 *
 * TMDB publishes a `popularity` figure that is recomputed daily from views,
 * votes and watchlist activity across its own audience. It is a relative
 * number rather than a count of anything, but it *moves*, which is what this
 * system needs - a title climbing from 40 to 300 in three days is the signal,
 * not the absolute value.
 *
 * Needs a free API key: register, confirm an email, done.
 */
import { config } from '../config.ts';
import { getJson, mapLimit } from '../net/fetcher.ts';
import {
  configurationRequired,
  intOrNull,
  metricsOf,
  VALID,
  type PluginContext,
  type RefreshRequest,
  type RefreshResult,
  type SourceCapabilities,
  type SourcePlugin,
  type ValidationResult,
} from './types.ts';
import type { RawContent } from '../core/types.ts';

const API = 'https://api.themoviedb.org/3';
const IMAGE = 'https://image.tmdb.org/t/p/w300';
const HELP_URL = 'https://www.themoviedb.org/settings/api';

const CAPABILITIES: SourceCapabilities = {
  contentTypes: ['video'],
  metrics: ['nativeScore', 'comments'],
  primaryMetric: 'nativeScore',
  // votes against popularity; a well-rated title gathers votes steadily.
  engagementReference: 0.5,
  hasAuthor: false,
  hasHashtags: true,
  hasCountry: true,
  supportsRefresh: true,
  supportsTrending: true,
  supportsSearch: false,
  supportsHistoricalMetrics: false,
  baseReliability: 0.85,
};

interface Trending {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  overview?: string;
  popularity?: number;
  vote_count?: number;
  vote_average?: number;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  original_language?: string;
  genre_ids?: number[];
}

/** TMDB's own genre ids, so a title carries usable tags without a second call. */
const GENRES: Readonly<Record<number, string>> = {
  28: 'action', 12: 'adventure', 16: 'animation', 35: 'comedy', 80: 'crime',
  99: 'documentary', 18: 'drama', 10751: 'family', 14: 'fantasy', 36: 'history',
  27: 'horror', 10402: 'music', 9648: 'mystery', 10749: 'romance', 878: 'sci-fi',
  10770: 'tv-movie', 53: 'thriller', 10752: 'war', 37: 'western',
  10759: 'action-adventure', 10762: 'kids', 10763: 'news', 10764: 'reality',
  10765: 'sci-fi-fantasy', 10766: 'soap', 10767: 'talk', 10768: 'war-politics',
};

function url(path: string, params: Record<string, string> = {}): string {
  const u = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('api_key', config.tmdb.apiKey);
  u.searchParams.set('language', config.tmdb.language);
  return u.toString();
}

/**
 * Popularity is a float that can sit below one. Rounding it to an integer would
 * flatten the whole lower half of the scale into zero, so it is scaled first -
 * the unit is arbitrary either way, and only the movement matters.
 */
function popularityScore(popularity: number | undefined): number | null {
  return typeof popularity === 'number' && Number.isFinite(popularity)
    ? Math.round(popularity * 100)
    : null;
}

function toContent(item: Trending, window: string): RawContent | null {
  const title = item.title ?? item.name;
  if (title === undefined || title.length === 0) return null;
  const kind = item.media_type === 'tv' ? 'tv' : 'movie';
  const released = item.release_date ?? item.first_air_date;

  return {
    sourceId: 'tmdb',
    externalId: `${kind}:${item.id}`,
    url: `https://www.themoviedb.org/${kind}/${item.id}`,
    title,
    body: item.overview?.slice(0, 800) ?? null,
    contentType: 'video',
    authorId: null,
    authorName: null,
    thumbnailUrl: item.poster_path === null || item.poster_path === undefined ? null : `${IMAGE}${item.poster_path}`,
    // The release date, which is genuinely when it came out - not when TMDB
    // started trending it. Age is measured from first sighting instead.
    publishedAt: released === undefined ? null : Math.floor(Date.parse(released) / 1000),
    publishedAtSource: 'api',
    metrics: metricsOf({
      nativeScore: popularityScore(item.popularity),
      comments: intOrNull(item.vote_count),
    }),
    hashtags: [
      kind,
      ...(item.genre_ids ?? []).map((id) => GENRES[id]).filter((g): g is string => g !== undefined),
    ],
    raw: {
      window,
      mediaType: kind,
      voteAverage: item.vote_average ?? null,
      originalLanguage: item.original_language ?? null,
    },
  };
}

export function createTmdbSource(): SourcePlugin {
  return {
    id: 'tmdb',
    name: 'TMDB (film and television)',
    version: '1.0.0',
    capabilities: CAPABILITIES,

    validate(): ValidationResult {
      if (config.tmdb.apiKey === '') {
        return configurationRequired(
          'Set TMDB_API_KEY in .env. Register free at themoviedb.org, then Settings → API → request an API key (v3 auth).',
          HELP_URL,
        );
      }
      return VALID;
    },

    async discover(ctx: PluginContext): Promise<readonly RawContent[]> {
      const out: RawContent[] = [];
      const seen = new Set<string>();

      // Day and week together: the day list catches a sudden arrival, the week
      // list keeps a slower climb from vanishing between cycles.
      for (const window of ['day', 'week'] as const) {
        try {
          const response = await getJson<{ results?: Trending[] }>(
            url(`trending/all/${window}`),
            { context: 'tmdb', rps: 2 },
          );
          for (const item of response.results ?? []) {
            const content = toContent(item, window);
            if (content === null || seen.has(content.externalId)) continue;
            seen.add(content.externalId);
            out.push(content);
          }
        } catch (e) {
          ctx.logger.warn('trending failed', { window, error: (e as Error).message });
        }
      }

      ctx.logger.debug('collected', { items: out.length });
      return out;
    },

    async refresh(ctx: PluginContext, items: readonly RefreshRequest[]): Promise<readonly RefreshResult[]> {
      // No batch endpoint; capped so a refresh cycle stays short.
      const settled = await mapLimit(items.slice(0, 50), 3, async (item) => {
        const [kind, id] = item.externalId.split(':');
        if (kind === undefined || id === undefined) return null;
        const detail = await getJson<Trending>(url(`${kind}/${id}`), {
          context: 'tmdb',
          rps: 3,
          retries: 0,
        });
        return {
          externalId: item.externalId,
          metrics: metricsOf({
            nativeScore: popularityScore(detail.popularity),
            comments: intOrNull(detail.vote_count),
          }),
        } satisfies RefreshResult;
      });

      const results: RefreshResult[] = [];
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value !== null) results.push(r.value);
      }
      if (results.length > 0) ctx.logger.debug('refreshed', { items: results.length });
      return results;
    },
  };
}

export { popularityScore };
