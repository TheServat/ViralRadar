/**
 * Ranked charts: Steam, Apple and Spotify.
 *
 * These three are grouped because they share a shape no other source here has.
 * A chart gives a *position*, not a count - nobody publishes how many people
 * played a game or streamed a song - so rank is inverted into a score where
 * first place is worth the most. Movement up the chart then reads as growth,
 * which is exactly the signal that matters: entering the top ten this week is
 * news, sitting at number four for a year is not.
 *
 * Steam is the exception and does give a real number: concurrent players.
 */
import { config } from '../config.ts';
import { getJson, mapLimit } from '../net/fetcher.ts';
import { hash64 } from '../core/text.ts';
import {
  intOrNull,
  metricsOf,
  VALID,
  type PluginContext,
  type SourceCapabilities,
  type SourcePlugin,
  type ValidationResult,
} from './types.ts';
import type { RawContent } from '../core/types.ts';

const CAPABILITIES: SourceCapabilities = {
  contentTypes: ['link', 'audio', 'video'],
  metrics: ['nativeScore', 'views'],
  primaryMetric: 'nativeScore',
  engagementReference: 0.1,
  hasAuthor: true,
  hasHashtags: false,
  hasCountry: true,
  supportsRefresh: true,
  supportsTrending: true,
  supportsSearch: false,
  supportsHistoricalMetrics: false,
  baseReliability: 0.8,
};

/**
 * Rank to score.
 *
 * A chart of 100 makes first place worth 100 and last place worth 1, so the
 * usual velocity and acceleration maths applies unchanged: climbing produces
 * positive growth, slipping produces negative.
 */
function rankScore(rank: number, size: number): number {
  return Math.max(1, size - rank + 1);
}

// ── Steam ──────────────────────────────────────────────────────────────────

interface SteamRank {
  rank: number;
  appid: number;
  peak_in_game?: number;
  last_week_rank?: number;
}

interface AppDetails {
  [appid: string]: { success?: boolean; data?: { name?: string; type?: string; header_image?: string } };
}

/**
 * Steam publishes ranks by app id and nothing else, so names are resolved once
 * and remembered: a game's name does not change, and looking it up every cycle
 * would be dozens of needless requests.
 */
async function steamNames(appIds: readonly number[], ctx: PluginContext): Promise<Map<number, string>> {
  const cached = new Map<number, string>();
  const missing: number[] = [];

  for (const id of appIds) {
    const name = ctx.state.get(`steam:${id}`);
    if (name === null) missing.push(id);
    else cached.set(id, name);
  }

  if (missing.length > 0) {
    const settled = await mapLimit(missing.slice(0, 30), 2, async (appid) => {
      const details = await getJson<AppDetails>(
        `https://store.steampowered.com/api/appdetails?appids=${appid}&filters=basic`,
        { context: 'steam', rps: 1, retries: 0 },
      );
      const name = details[String(appid)]?.data?.name;
      return name === undefined ? null : { appid, name };
    });
    for (const result of settled) {
      if (result.status !== 'fulfilled' || result.value === null) continue;
      cached.set(result.value.appid, result.value.name);
      ctx.state.set(`steam:${result.value.appid}`, result.value.name);
    }
  }
  return cached;
}

async function readSteam(ctx: PluginContext): Promise<RawContent[]> {
  const response = await getJson<{ response?: { ranks?: SteamRank[]; rollup_date?: number } }>(
    'https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/',
    { context: 'steam', rps: 1 },
  );
  const ranks = (response.response?.ranks ?? []).slice(0, 40);
  if (ranks.length === 0) return [];

  const names = await steamNames(ranks.map((r) => r.appid), ctx);

  return ranks.map((entry) => ({
    sourceId: 'charts',
    externalId: `steam:${entry.appid}`,
    url: `https://store.steampowered.com/app/${entry.appid}`,
    title: names.get(entry.appid) ?? `Steam app ${entry.appid}`,
    body: null,
    contentType: 'link' as const,
    authorId: 'steam',
    authorName: 'Steam',
    thumbnailUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${entry.appid}/header.jpg`,
    publishedAt: null,
    metrics: metricsOf({
      nativeScore: rankScore(entry.rank, ranks.length),
      // The one real count in this file: concurrent players at peak.
      views: intOrNull(entry.peak_in_game),
    }),
    raw: { chart: 'steam-most-played', rank: entry.rank, previousRank: entry.last_week_rank ?? null },
  }));
}

// ── Apple ──────────────────────────────────────────────────────────────────

interface AppleFeed {
  feed?: {
    title?: string;
    results?: {
      id?: string;
      name?: string;
      artistName?: string;
      url?: string;
      artworkUrl100?: string;
      releaseDate?: string;
    }[];
  };
}

/**
 * Apple's marketing feeds cover podcasts, music and apps per storefront.
 *
 * Not every country has a storefront - Iran does not - so an unsupported
 * region answers with an error rather than an empty list, and is skipped with
 * one line instead of being retried every cycle.
 */
async function readApple(kind: string, country: string): Promise<RawContent[]> {
  const [media, chart] = kind.split('/');
  const url = `https://rss.applemarketingtools.com/api/v2/${country.toLowerCase()}/${media}/${chart}/25/${media === 'music' ? 'songs' : media}.json`;

  const response = await getJson<AppleFeed>(url, { context: 'apple', rps: 1, retries: 0 });
  const results = response.feed?.results ?? [];

  return results.map((entry, index) => ({
    sourceId: 'charts',
    externalId: `apple:${country}:${media}:${entry.id ?? hash64(entry.name ?? String(index)).toString(16)}`,
    url: entry.url ?? 'https://www.apple.com',
    title: entry.name ?? 'unknown',
    body: entry.artistName ?? null,
    contentType: (media === 'music' ? 'audio' : 'link') as 'audio' | 'link',
    authorId: entry.artistName ?? null,
    authorName: entry.artistName ?? null,
    thumbnailUrl: entry.artworkUrl100 ?? null,
    publishedAt:
      entry.releaseDate === undefined ? null : Math.floor(Date.parse(entry.releaseDate) / 1000),
    publishedAtSource: 'api' as const,
    metrics: metricsOf({ nativeScore: rankScore(index + 1, results.length) }),
    region: country,
    country: { value: country, confidence: 1, source: 'region_param' },
    raw: { chart: `apple-${media}`, rank: index + 1, storefront: country, title: response.feed?.title ?? null },
  }));
}

// ── Spotify ────────────────────────────────────────────────────────────────

interface SpotifyCharts {
  chartEntryViewResponses?: {
    displayChart?: { chartMetadata?: { readableTitle?: string } };
    entries?: {
      chartEntryData?: { currentRank?: number; previousRank?: number };
      trackMetadata?: {
        trackName?: string;
        trackUri?: string;
        artists?: { name?: string }[];
        displayImageUri?: string;
      };
    }[];
  }[];
}

async function readSpotify(ctx: PluginContext): Promise<RawContent[]> {
  const response = await getJson<SpotifyCharts>(
    'https://charts-spotify-com-service.spotify.com/public/v0/charts',
    { context: 'spotify', rps: 0.5 },
  );

  const out: RawContent[] = [];
  for (const chart of response.chartEntryViewResponses ?? []) {
    const title = chart.displayChart?.chartMetadata?.readableTitle ?? 'Spotify chart';
    const entries = chart.entries ?? [];

    for (const entry of entries) {
      const track = entry.trackMetadata;
      const rank = entry.chartEntryData?.currentRank;
      if (track?.trackName === undefined || rank === undefined) continue;

      const id = track.trackUri?.split(':').pop() ?? hash64(track.trackName).toString(16);
      out.push({
        sourceId: 'charts',
        externalId: `spotify:${id}`,
        url: `https://open.spotify.com/track/${id}`,
        title: track.trackName,
        body: (track.artists ?? []).map((a) => a.name).filter(Boolean).join(', ') || null,
        contentType: 'audio',
        authorId: track.artists?.[0]?.name ?? null,
        authorName: track.artists?.[0]?.name ?? null,
        thumbnailUrl: track.displayImageUri ?? null,
        publishedAt: null,
        metrics: metricsOf({ nativeScore: rankScore(rank, entries.length) }),
        raw: {
          chart: title,
          rank,
          previousRank: entry.chartEntryData?.previousRank ?? null,
        },
      });
    }
  }
  ctx.logger.debug('spotify read', { items: out.length });
  return out;
}

// ── Plugin ─────────────────────────────────────────────────────────────────

export function createChartsSource(): SourcePlugin {
  return {
    id: 'charts',
    name: 'Charts (Steam, Apple, Spotify)',
    version: '1.0.0',
    capabilities: CAPABILITIES,

    validate(): ValidationResult {
      return VALID;
    },

    async discover(ctx: PluginContext): Promise<readonly RawContent[]> {
      const out: RawContent[] = [];
      const jobs: { name: string; run: () => Promise<RawContent[]> }[] = [];

      if (config.charts.steam) jobs.push({ name: 'steam', run: () => readSteam(ctx) });
      if (config.charts.spotify) jobs.push({ name: 'spotify', run: () => readSpotify(ctx) });

      for (const country of config.charts.appleCountries) {
        for (const kind of config.charts.appleCharts) {
          jobs.push({ name: `apple:${country}:${kind}`, run: () => readApple(kind, country) });
        }
      }

      const settled = await mapLimit(jobs, 2, (job) => job.run());
      for (const [i, result] of settled.entries()) {
        if (result.status === 'fulfilled') {
          out.push(...result.value);
          continue;
        }
        // A storefront that does not exist for a country is a fact about the
        // world, not a failure worth alarming about.
        ctx.logger.info('chart unavailable', {
          chart: jobs[i]?.name,
          reason: (result.reason as Error).message.slice(0, 120),
        });
      }
      return out;
    },

    /** Charts republish wholesale, so a refresh is another read of the charts. */
    async refresh(ctx: PluginContext) {
      const items = await this.discover(ctx);
      return items.map((i) => ({ externalId: i.externalId, metrics: i.metrics }));
    },
  };
}

export { rankScore };
