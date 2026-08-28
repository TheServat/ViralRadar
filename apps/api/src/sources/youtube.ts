/**
 * YouTube via the official Data API v3.
 *
 * The most valuable source in the system, because it is the only one that hands
 * over a real view counter. Everything else measures reactions; this measures
 * watching, which is what the question "what are people watching right now"
 * actually asks.
 *
 * Requires a free API key. Without one the source reports
 * CONFIGURATION_REQUIRED and is skipped - it is never faked.
 *
 * Quota: videos.list and channels.list cost 1 unit per call, and the free daily
 * allowance is 10,000. A 20-minute discovery cycle over two regions plus hot
 * refreshes uses a small fraction of that.
 */
import { config } from '../config.ts';
import { getJson, mapLimit } from '../net/fetcher.ts';
import { isRadarError } from '../errors.ts';
import { parseFeed, tagText } from '../core/xml.ts';
import { getText } from '../net/fetcher.ts';
import {
  configurationRequired,
  intOrNull,
  metricsOf,
  VALID,
  type CreatorSample,
  type PluginContext,
  type RefreshRequest,
  type RefreshResult,
  type SourceCapabilities,
  type SourcePlugin,
  type ValidationResult,
} from './types.ts';
import type { ContentType, RawContent } from '../core/types.ts';

const API = 'https://www.googleapis.com/youtube/v3';
const HELP_URL = 'https://console.cloud.google.com/apis/library/youtube.googleapis.com';

const CAPABILITIES: SourceCapabilities = {
  contentTypes: ['video', 'short_video'],
  metrics: ['views', 'likes', 'comments'],
  primaryMetric: 'views',
  // (likes + comments) / views: 8% is an outstanding ratio on YouTube.
  engagementReference: 0.08,
  hasAuthor: true,
  hasHashtags: true,
  hasCountry: true,
  supportsRefresh: true,
  supportsTrending: true,
  supportsSearch: true,
  supportsHistoricalMetrics: false,
  baseReliability: 1,
};

interface YtVideo {
  readonly id: string;
  readonly snippet?: {
    publishedAt?: string;
    channelId?: string;
    channelTitle?: string;
    title?: string;
    description?: string;
    thumbnails?: Record<string, { url?: string }>;
    tags?: string[];
    defaultAudioLanguage?: string;
    defaultLanguage?: string;
  };
  readonly statistics?: {
    viewCount?: string;
    likeCount?: string;
    commentCount?: string;
  };
  readonly contentDetails?: { duration?: string };
}

interface YtListResponse<T> {
  readonly items?: T[];
  readonly error?: { code?: number; message?: string; errors?: { reason?: string }[] };
}

interface YtChannel {
  readonly id: string;
  readonly statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean };
}

/** ISO-8601 duration ("PT1M30S") to seconds. */
export function parseDuration(iso: string | undefined): number | null {
  if (iso === undefined) return null;
  const m = iso.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (m === null) return null;
  const [, d, h, min, s] = m;
  const total = Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0);
  return Number.isFinite(total) ? total : null;
}

function classify(durationSec: number | null): ContentType {
  if (durationSec === null) return 'video';
  return durationSec <= 60 ? 'short_video' : 'video';
}

function bestThumb(snippet: YtVideo['snippet']): string | null {
  const t = snippet?.thumbnails;
  if (t === undefined) return null;
  return t['medium']?.url ?? t['high']?.url ?? t['default']?.url ?? null;
}

function hashtagsOf(video: YtVideo): string[] {
  const text = `${video.snippet?.title ?? ''} ${video.snippet?.description?.slice(0, 500) ?? ''}`;
  const found = [...text.matchAll(/#([\p{L}\p{N}_]{2,40})/gu)].map((m) => (m[1] as string).toLowerCase());
  const tags = (video.snippet?.tags ?? []).slice(0, 5).map((t) => t.toLowerCase());
  return [...new Set([...found, ...tags])].slice(0, 12);
}

function toContent(video: YtVideo, region: string | null): RawContent | null {
  const snippet = video.snippet;
  if (snippet?.title === undefined) return null;
  const duration = parseDuration(video.contentDetails?.duration);

  return {
    sourceId: 'youtube',
    externalId: video.id,
    url: `https://www.youtube.com/watch?v=${video.id}`,
    title: snippet.title,
    body: snippet.description?.slice(0, 1000) ?? null,
    contentType: classify(duration),
    authorId: snippet.channelId ?? null,
    authorName: snippet.channelTitle ?? null,
    authorUrl: snippet.channelId === undefined ? null : `https://www.youtube.com/channel/${snippet.channelId}`,
    thumbnailUrl: bestThumb(snippet),
    publishedAt: snippet.publishedAt === undefined ? null : Math.floor(Date.parse(snippet.publishedAt) / 1000),
    publishedAtSource: 'api',
    metrics: metricsOf({
      views: intOrNull(video.statistics?.viewCount),
      likes: intOrNull(video.statistics?.likeCount),
      comments: intOrNull(video.statistics?.commentCount),
    }),
    hashtags: hashtagsOf(video),
    region,
    // The chart is region-scoped, but a video trending in the US is not
    // necessarily *from* the US - hence a moderate confidence, not 1.
    country:
      region === null ? null : { value: region, confidence: 0.5, source: 'region_param' },
    raw: { durationSec: duration, audioLanguage: snippet.defaultAudioLanguage ?? null },
  };
}

function apiUrl(path: string, params: Record<string, string>): string {
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', config.youtube.apiKey);
  return url.toString();
}

/** Turns Google's 403 bodies into a message that says what to actually do. */
function explain(e: unknown): unknown {
  if (!isRadarError(e)) return e;
  const body = String(e.details['body'] ?? '');
  if (body.includes('quotaExceeded')) {
    return Object.assign(e, { message: 'YouTube daily API quota exhausted; it resets at midnight Pacific time' });
  }
  if (body.includes('API key not valid') || body.includes('keyInvalid')) {
    return Object.assign(e, { message: 'YOUTUBE_API_KEY is not valid for the YouTube Data API v3' });
  }
  if (body.includes('accessNotConfigured')) {
    return Object.assign(e, {
      message: 'YouTube Data API v3 is not enabled for this Google Cloud project',
    });
  }
  return e;
}

async function fetchVideos(ids: readonly string[]): Promise<YtVideo[]> {
  if (ids.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push([...ids.slice(i, i + 50)]);

  const settled = await mapLimit(chunks, 2, async (chunk) => {
    const res = await getJson<YtListResponse<YtVideo>>(
      apiUrl('videos', { part: 'snippet,statistics,contentDetails', id: chunk.join(','), maxResults: '50' }),
      { context: 'youtube', rps: 3 },
    );
    return res.items ?? [];
  });

  const out: YtVideo[] = [];
  for (const r of settled) if (r.status === 'fulfilled') out.push(...r.value);
  return out;
}

/**
 * Prices a set of video ids, charging the quota it costs.
 *
 * `videos.list` bills one unit per call of up to fifty ids. That is cheap next
 * to a hundred-unit search, but it was previously not charged at all, so the
 * daily figure under-reported real spend — and the discrepancy grows with
 * every id that arrives from a free channel feed rather than from search.
 *
 * Charged before the call, so a refusal costs nothing, and trimmed to what the
 * remaining budget can actually pay for rather than abandoned entirely.
 */
async function priceVideos(ctx: PluginContext, ids: readonly string[]): Promise<YtVideo[]> {
  if (ids.length === 0) return [];
  const affordable: string[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    if (!spend(ctx, 1)) {
      ctx.logger.info('quota budget reached while pricing videos', {
        priced: affordable.length,
        skipped: ids.length - affordable.length,
      });
      break;
    }
    affordable.push(...ids.slice(i, i + 50));
  }
  return fetchVideos(affordable);
}

/**
 * Regions YouTube publishes a trending chart for.
 *
 * Not every country has one — Iran, among others, is absent from the list, so
 * `regionCode=IR` is a hard 400 rather than an empty result. Checking once
 * turns that into a single explanatory line instead of an error every cycle.
 *
 * `search` accepts those same region codes, which is why open discovery below
 * covers audiences the chart cannot reach.
 */
let chartRegions: Set<string> | null = null;

async function supportedRegions(): Promise<Set<string> | null> {
  if (chartRegions !== null) return chartRegions;
  try {
    const res = await getJson<{ items?: { snippet?: { gl?: string } }[] }>(
      apiUrl('i18nRegions', { part: 'snippet', hl: 'en' }),
      { context: 'youtube', rps: 3, retries: 1 },
    );
    const codes = (res.items ?? [])
      .map((i) => i.snippet?.gl)
      .filter((c): c is string => c !== undefined);
    if (codes.length === 0) return null;
    chartRegions = new Set(codes);
    return chartRegions;
  } catch {
    // Unknown is not the same as unsupported: fall back to trying them all.
    return null;
  }
}

async function fetchMostPopular(region: string): Promise<YtVideo[]> {
  const res = await getJson<YtListResponse<YtVideo>>(
    apiUrl('videos', {
      part: 'snippet,statistics,contentDetails',
      chart: 'mostPopular',
      regionCode: region,
      maxResults: '50',
    }),
    { context: 'youtube', rps: 3 },
  );
  return res.items ?? [];
}

// ── Open discovery ─────────────────────────────────────────────────────────

/**
 * Quota ledger.
 *
 * `search` costs 100 units against a free daily allowance of 10,000, so it is
 * the one call that can exhaust the day on its own. The spend is tracked in
 * plugin state and reset per UTC date, which is when Google resets it too.
 */
/**
 * Uploads to read per creator. Ten is comfortably more than the five samples a
 * breakout verdict needs, and few enough that a channel's whole recent history
 * still fits one batched pricing call.
 */
const HISTORY_PER_CREATOR = 10;

function spend(ctx: PluginContext, units: number): boolean {
  const today = new Date(ctx.now() * 1000).toISOString().slice(0, 10);
  if (ctx.state.get('quotaDay') !== today) {
    ctx.state.set('quotaDay', today);
    ctx.state.setNumber('quotaSpent', 0);
  }
  const spent = ctx.state.getNumber('quotaSpent', 0);
  if (spent + units > config.youtube.quotaBudget) return false;
  ctx.state.setNumber('quotaSpent', spent + units);
  return true;
}

export function quotaSpentToday(ctx: PluginContext): number {
  const today = new Date(ctx.now() * 1000).toISOString().slice(0, 10);
  return ctx.state.get('quotaDay') === today ? ctx.state.getNumber('quotaSpent', 0) : 0;
}

/**
 * Picks which seed words this run will use.
 *
 * A rotating cursor rather than a random pick: over a handful of runs every
 * term gets used exactly as often as every other, and the coverage does not
 * depend on luck.
 */
export function rotateTerms(terms: readonly string[], cursor: number, count: number): string[] {
  if (terms.length === 0 || count <= 0) return [];
  const picked: string[] = [];
  for (let i = 0; i < Math.min(count, terms.length); i++) {
    picked.push(terms[(cursor + i) % terms.length] as string);
  }
  return picked;
}

/**
 * Discovery with no channel list at all.
 *
 * `search` accepts `regionCode=IR` even though the trending chart does not, so
 * this is the only way to see Iranian content on YouTube — and it is the better
 * mechanism regardless: any channel can surface, including one nobody has heard
 * of yet, which is exactly the case the radar exists to catch.
 *
 * Two orderings, alternating between runs:
 *   viewCount — recent uploads already pulling views: viral now
 *   date      — the newest uploads: caught before anything has happened yet
 */
async function openSearch(ctx: PluginContext): Promise<string[]> {
  const terms = config.youtube.searchTerms;
  if (terms.length === 0 || config.youtube.searchesPerRun === 0) return [];

  const cursor = ctx.state.getNumber('searchCursor', 0);
  const runCount = ctx.state.getNumber('searchRuns', 0);
  const selected = rotateTerms(terms, cursor, config.youtube.searchesPerRun);
  const order = runCount % 2 === 0 ? 'viewCount' : 'date';
  const publishedAfter = new Date((ctx.now() - config.youtube.searchWindowHours * 3600) * 1000).toISOString();

  const ids: string[] = [];
  for (const term of selected) {
    if (!spend(ctx, 100)) {
      ctx.logger.warn('daily search budget reached; open discovery paused until tomorrow', {
        spent: quotaSpentToday(ctx),
        budget: config.youtube.quotaBudget,
      });
      break;
    }
    try {
      const res = await getJson<YtListResponse<{ id?: { videoId?: string } }>>(
        apiUrl('search', {
          part: 'id',
          type: 'video',
          q: term,
          order,
          publishedAfter,
          maxResults: '50',
          ...(ctx.regions[0] === undefined ? {} : { regionCode: ctx.regions[0] }),
          ...(ctx.languages[0] === undefined ? {} : { relevanceLanguage: ctx.languages[0] }),
        }),
        { context: 'youtube', rps: 2 },
      );
      const found = (res.items ?? [])
        .map((i) => i.id?.videoId)
        .filter((v): v is string => v !== undefined);
      ids.push(...found);
      ctx.logger.debug('open search', { term, order, found: found.length });
    } catch (e) {
      ctx.logger.warn('search failed', { term, error: (explain(e) as Error).message });
    }
  }

  ctx.state.setNumber('searchCursor', (cursor + selected.length) % terms.length);
  ctx.state.setNumber('searchRuns', runCount + 1);
  return [...new Set(ids)];
}

/**
 * Recent uploads from watched channels, read from the public channel feed.
 * Costs no API quota; the feed has no view counts, so the ids are then priced
 * up in one batched videos.list call.
 */
async function fetchWatchedChannelVideoIds(channelIds: readonly string[]): Promise<string[]> {
  const settled = await mapLimit(channelIds, 3, async (channelId) => {
    const xml = await getText(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`,
      { context: 'youtube-feed', rps: 1 },
    );
    return parseFeed(xml)
      .map((item) => tagText(item.raw, 'videoId'))
      .filter((id): id is string => id !== null)
      .slice(0, 10);
  });

  const ids: string[] = [];
  for (const r of settled) if (r.status === 'fulfilled') ids.push(...r.value);
  return ids;
}

/**
 * Recent uploads by a channel, priced up, for baselines only.
 *
 * The channel feed is public XML and costs no API quota at all, which is what
 * makes backfilling thousands of creators affordable. It carries no view
 * counts, so the ids it yields are priced in one batched `videos.list` call —
 * one unit per fifty videos, so a hundred channels costs about thirty units
 * out of a ten thousand unit day.
 *
 * A channel that 404s, is deleted, or has no uploads simply contributes
 * nothing. There is no such thing as a failed backfill worth reporting.
 */
async function fetchCreatorHistory(
  ctx: PluginContext,
  channelIds: readonly string[],
): Promise<readonly CreatorSample[]> {
  const perChannel = await mapLimit(channelIds, 3, async (channelId) => {
    const xml = await getText(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`,
      { context: 'youtube-history', rps: 1 },
    );
    const ids = parseFeed(xml)
      .map((item) => tagText(item.raw, 'videoId'))
      .filter((id): id is string => id !== null)
      .slice(0, HISTORY_PER_CREATOR);
    return { channelId, ids };
  });

  const byVideo = new Map<string, string>();
  for (const settled of perChannel) {
    if (settled.status !== 'fulfilled') continue;
    for (const id of settled.value.ids) byVideo.set(id, settled.value.channelId);
  }
  if (byVideo.size === 0) return [];

  const videos = await priceVideos(ctx, [...byVideo.keys()]);
  const samples: CreatorSample[] = [];
  for (const video of videos) {
    const views = Number(video.statistics?.viewCount ?? NaN);
    if (!Number.isFinite(views)) continue;
    // The channel from the feed, not from the video: they agree, and trusting
    // the feed keeps one video appearing under one creator.
    const creator = byVideo.get(video.id);
    if (creator === undefined) continue;

    const published = video.snippet?.publishedAt;
    const at = published === undefined ? null : Math.floor(new Date(published).getTime() / 1000);
    samples.push({
      creatorExternalId: creator,
      itemExternalId: video.id,
      metric: 'views',
      value: views,
      publishedAt: at !== null && Number.isFinite(at) ? at : null,
    });
  }
  return samples;
}

export function createYouTubeSource(): SourcePlugin {
  return {
    id: 'youtube',
    name: 'YouTube',
    version: '1.0.0',
    capabilities: CAPABILITIES,

    validate(): ValidationResult {
      if (config.youtube.apiKey === '') {
        return configurationRequired(
          'Set YOUTUBE_API_KEY in .env. Create a free key: Google Cloud Console -> enable "YouTube Data API v3" -> Credentials -> API key.',
          HELP_URL,
        );
      }
      return VALID;
    },

    async discover(ctx: PluginContext): Promise<readonly RawContent[]> {
      const requested = ctx.regions.length > 0 ? ctx.regions : ['US'];
      const charts = await supportedRegions();
      const regions = charts === null ? requested : requested.filter((r) => charts.has(r));
      const unsupported = requested.filter((r) => !regions.includes(r));
      const out: RawContent[] = [];

      if (unsupported.length > 0) {
        ctx.logger.info('no YouTube trending chart for these regions; open search covers them instead', {
          unsupported,
        });
      }

      for (const region of regions) {
        try {
          spend(ctx, 1);
          const videos = await fetchMostPopular(region);
          for (const v of videos) {
            const c = toContent(v, region);
            if (c !== null) out.push(c);
          }
        } catch (e) {
          const explained = explain(e);
          ctx.logger.warn('region failed', { region, error: (explained as Error).message });
          // Quota and key problems are global, not per-region: stop early.
          if (isRadarError(explained) && explained.kind === 'AUTH_REQUIRED') throw explained;
        }
      }

      // Open discovery: any channel, no list, nothing named in advance.
      try {
        const known = new Set(out.map((c) => c.externalId));
        const searched = (await openSearch(ctx)).filter((id) => !known.has(id));
        for (const v of await priceVideos(ctx, searched)) {
          const c = toContent(v, ctx.regions[0] ?? null);
          if (c !== null) {
            out.push(c);
            known.add(c.externalId);
          }
        }
        if (searched.length > 0) ctx.logger.info('open discovery', { videos: searched.length });
      } catch (e) {
        ctx.logger.warn('open search failed', { error: (explain(e) as Error).message });
      }

      /*
       * Channels followed for free.
       *
       * This is the cheapest discovery the API allows and the most targeted.
       * `search.list` costs 100 quota units per call and returns whatever
       * matches; a channel's public feed costs nothing and returns the newest
       * uploads of a channel already measured as worth following. Pricing the
       * ids afterwards costs one unit per fifty.
       *
       * The list is two parts: whatever the user named explicitly, plus the
       * channels this source has learned are good. Nothing is named in advance
       * for the second part - it is read back out of the scores discovery
       * itself produced.
       */
      const watched = [
        ...config.youtube.watchChannels,
        ...ctx.provenCreators(config.discovery.watchTop),
      ].filter((id, i, list) => list.indexOf(id) === i);

      if (watched.length > 0) {
        try {
          const ids = await fetchWatchedChannelVideoIds(watched);
          // Against this run *and* against what is already stored. A feed
          // returns the same uploads until the channel posts again, so without
          // the second check every run pays to re-price videos it already has.
          const known = new Set(out.map((c) => c.externalId));
          const stored = ctx.knownIds(ids);
          const fresh = ids.filter((id) => !known.has(id) && !stored.has(id));
          if (fresh.length > 0) {
            ctx.logger.info('watched channels', {
              channels: watched.length,
              seen: ids.length,
              fresh: fresh.length,
            });
          }
          for (const v of await priceVideos(ctx, fresh)) {
            // Tagged with the region being collected for, not left null.
            // Untagged items were measurably the worst-performing slice of the
            // corpus, and an untagged region is a missing fact rather than a
            // meaningful one.
            const c = toContent(v, ctx.regions[0] ?? null);
            if (c !== null) out.push(c);
          }
        } catch (e) {
          ctx.logger.warn('watched channels failed', { error: (e as Error).message });
        }
      }

      await attachSubscriberCounts(out, ctx);
      ctx.logger.debug('collected', { items: out.length, regions: regions.length });
      return out;
    },

    creatorHistory(ctx: PluginContext, creatorIds: readonly string[]): Promise<readonly CreatorSample[]> {
      return fetchCreatorHistory(ctx, creatorIds);
    },

    async refresh(_ctx: PluginContext, items: readonly RefreshRequest[]): Promise<readonly RefreshResult[]> {
      const videos = await fetchVideos(items.map((i) => i.externalId));
      return videos.map((v) => ({
        externalId: v.id,
        metrics: metricsOf({
          views: intOrNull(v.statistics?.viewCount),
          likes: intOrNull(v.statistics?.likeCount),
          comments: intOrNull(v.statistics?.commentCount),
        }),
      }));
    },

    async healthCheck(): Promise<ValidationResult> {
      const invalid = this.validate();
      if (!invalid.ok) return invalid;
      try {
        await getJson<YtListResponse<YtVideo>>(
          apiUrl('videos', { part: 'id', chart: 'mostPopular', maxResults: '1' }),
          { context: 'youtube', rps: 3, retries: 0 },
        );
        return VALID;
      } catch (e) {
        const explained = explain(e) as Error;
        return { ok: false, status: 'ERROR', message: explained.message };
      }
    },
  };
}

/**
 * Subscriber counts turn "800K views" into "800K views from a 2K-subscriber
 * channel", which is the difference between a big number and a story.
 */
async function attachSubscriberCounts(items: RawContent[], ctx: PluginContext): Promise<void> {
  const channelIds = [...new Set(items.map((i) => i.authorId).filter((id): id is string => id !== null))];
  if (channelIds.length === 0) return;

  const chunks: string[][] = [];
  for (let i = 0; i < channelIds.length; i += 50) chunks.push(channelIds.slice(i, i + 50));

  const followers = new Map<string, number>();
  const settled = await mapLimit(chunks, 2, async (chunk) => {
    const res = await getJson<YtListResponse<YtChannel>>(
      apiUrl('channels', { part: 'statistics', id: chunk.join(','), maxResults: '50' }),
      { context: 'youtube', rps: 3 },
    );
    return res.items ?? [];
  });

  for (const r of settled) {
    if (r.status !== 'fulfilled') {
      ctx.logger.debug('subscriber lookup failed for a chunk');
      continue;
    }
    for (const channel of r.value) {
      const subs = intOrNull(channel.statistics?.subscriberCount);
      if (subs !== null) followers.set(channel.id, subs);
    }
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i] as RawContent;
    const subs = item.authorId === null ? undefined : followers.get(item.authorId as string);
    if (subs !== undefined) items[i] = { ...item, authorFollowers: subs };
  }
}
