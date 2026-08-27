/**
 * Giphy: trending GIFs.
 *
 * Where a reaction format spreads before it reaches the platforms that count
 * views. Worth watching for exactly that reason, with one honest limitation:
 * the trending endpoint publishes an ordering and no numbers at all. So rank
 * becomes the score, the way it does for the music and game charts - climbing
 * the list reads as growth, and sitting still reads as nothing happening.
 *
 * Needs a free API key: one form, no review.
 */
import { config } from '../config.ts';
import { getJson } from '../net/fetcher.ts';
import {
  configurationRequired,
  metricsOf,
  VALID,
  type PluginContext,
  type SourceCapabilities,
  type SourcePlugin,
  type ValidationResult,
} from './types.ts';
import type { RawContent } from '../core/types.ts';

const API = 'https://api.giphy.com/v1';
const HELP_URL = 'https://developers.giphy.com/dashboard/';

const CAPABILITIES: SourceCapabilities = {
  contentTypes: ['image', 'video'],
  metrics: ['nativeScore'],
  primaryMetric: 'nativeScore',
  engagementReference: 0.1,
  hasAuthor: true,
  hasHashtags: true,
  hasCountry: false,
  supportsRefresh: true,
  supportsTrending: true,
  supportsSearch: false,
  supportsHistoricalMetrics: false,
  // Rank-only, no counts: real but coarse, and the reliability says so.
  baseReliability: 0.6,
};

interface Gif {
  id: string;
  title?: string;
  url?: string;
  slug?: string;
  import_datetime?: string;
  trending_datetime?: string;
  username?: string;
  user?: { display_name?: string; username?: string; profile_url?: string };
  images?: { fixed_height_small?: { url?: string }; preview_gif?: { url?: string } };
}

/** First place scores highest; last place still scores. */
function rankScore(rank: number, size: number): number {
  return Math.max(1, size - rank + 1);
}

function toContent(gif: Gif, rank: number, size: number, kind: string): RawContent | null {
  const title = (gif.title ?? '').trim();
  if (title.length === 0) return null;

  return {
    sourceId: 'giphy',
    externalId: gif.id,
    url: gif.url ?? `https://giphy.com/gifs/${gif.slug ?? gif.id}`,
    title,
    body: null,
    contentType: 'video',
    authorId: gif.username || gif.user?.username || null,
    authorName: gif.user?.display_name || gif.username || null,
    authorUrl: gif.user?.profile_url ?? null,
    thumbnailUrl: gif.images?.fixed_height_small?.url ?? gif.images?.preview_gif?.url ?? null,
    // When Giphy started trending it, which is the moment that matters here -
    // not when it was uploaded, which may be years earlier.
    publishedAt:
      gif.trending_datetime === undefined || gif.trending_datetime.startsWith('0000')
        ? null
        : Math.floor(Date.parse(`${gif.trending_datetime.replace(' ', 'T')}Z`) / 1000),
    publishedAtSource: 'api',
    metrics: metricsOf({ nativeScore: rankScore(rank, size) }),
    hashtags: (title.match(/\b[\p{L}]{3,}\b/gu) ?? []).slice(0, 5).map((w) => w.toLowerCase()),
    raw: { rank, chart: kind, importedAt: gif.import_datetime ?? null },
  };
}

async function readTrending(kind: 'gifs' | 'stickers', ctx: PluginContext): Promise<RawContent[]> {
  const url = `${API}/${kind}/trending?api_key=${encodeURIComponent(config.giphy.apiKey)}&limit=50&rating=${config.giphy.rating}`;
  const response = await getJson<{ data?: Gif[] }>(url, { context: 'giphy', rps: 1 });
  const gifs = response.data ?? [];

  const out: RawContent[] = [];
  for (const [index, gif] of gifs.entries()) {
    const content = toContent(gif, index + 1, gifs.length, kind);
    if (content !== null) out.push(content);
  }
  ctx.logger.debug('trending read', { kind, items: out.length });
  return out;
}

export function createGiphySource(): SourcePlugin {
  return {
    id: 'giphy',
    name: 'Giphy',
    version: '1.0.0',
    capabilities: CAPABILITIES,

    validate(): ValidationResult {
      if (config.giphy.apiKey === '') {
        return configurationRequired(
          'Set GIPHY_API_KEY in .env. Create an app at developers.giphy.com/dashboard and copy the API key.',
          HELP_URL,
        );
      }
      return VALID;
    },

    async discover(ctx: PluginContext): Promise<readonly RawContent[]> {
      const out: RawContent[] = [];
      const seen = new Set<string>();

      for (const kind of ['gifs', 'stickers'] as const) {
        try {
          for (const item of await readTrending(kind, ctx)) {
            if (seen.has(item.externalId)) continue;
            seen.add(item.externalId);
            out.push(item);
          }
        } catch (e) {
          ctx.logger.warn('trending failed', { kind, error: (e as Error).message });
        }
      }
      return out;
    },

    /** The chart republishes wholesale, so a refresh is another read of it. */
    async refresh(ctx: PluginContext) {
      const items = await this.discover(ctx);
      return items.map((i) => ({ externalId: i.externalId, metrics: i.metrics }));
    },
  };
}
