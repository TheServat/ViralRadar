/**
 * Reddit.
 *
 * Two acquisition strategies, tried in the order the platform prefers:
 *
 *   1. Official OAuth (application-only token from a free "script" app).
 *   2. The public .json endpoints, anonymously.
 *
 * Reddit now refuses anonymous JSON from many networks, so strategy 2 fails
 * with 403 more often than not. That is not something to work around - the
 * adapter reports AUTH_REQUIRED and points at the two-minute fix, and the rest
 * of the system carries on without it.
 */
import { config } from '../config.ts';
import { getJson, request } from '../net/fetcher.ts';
import { isRadarError } from '../errors.ts';
import {
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
import type { ContentType, RawContent } from '../core/types.ts';

const HELP_URL = 'https://www.reddit.com/prefs/apps';

const CAPABILITIES: SourceCapabilities = {
  contentTypes: ['link', 'text', 'image', 'video'],
  metrics: ['nativeScore', 'comments', 'shares'],
  primaryMetric: 'nativeScore',
  // comments per upvote; 25% is a very talkative thread.
  engagementReference: 0.25,
  hasAuthor: true,
  hasHashtags: false,
  hasCountry: false,
  supportsRefresh: true,
  supportsTrending: true,
  supportsSearch: true,
  supportsHistoricalMetrics: false,
  baseReliability: 0.9,
};

interface RedditPost {
  readonly id: string;
  readonly name?: string;
  readonly title?: string;
  readonly selftext?: string;
  readonly subreddit?: string;
  readonly author?: string;
  readonly permalink?: string;
  readonly url?: string;
  readonly created_utc?: number;
  readonly score?: number;
  readonly ups?: number;
  readonly num_comments?: number;
  readonly num_crossposts?: number;
  readonly upvote_ratio?: number;
  readonly is_video?: boolean;
  readonly is_self?: boolean;
  readonly post_hint?: string;
  readonly over_18?: boolean;
  readonly stickied?: boolean;
  readonly thumbnail?: string;
  readonly preview?: { images?: { source?: { url?: string } }[] };
}

interface RedditListing {
  readonly data?: { children?: { data?: RedditPost }[] };
}

// ── Authentication ─────────────────────────────────────────────────────────

let token: { value: string; expiresAt: number } | null = null;

function hasCredentials(): boolean {
  return config.reddit.clientId !== '' && config.reddit.clientSecret !== '';
}

async function accessToken(ctx: PluginContext): Promise<string | null> {
  if (!hasCredentials()) return null;
  const now = Date.now();
  if (token !== null && token.expiresAt > now + 60_000) return token.value;

  const basic = Buffer.from(`${config.reddit.clientId}:${config.reddit.clientSecret}`).toString('base64');
  const res = await request('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': config.reddit.userAgent,
    },
    body: 'grant_type=client_credentials',
    context: 'reddit-auth',
    rps: 0.5,
    retries: 1,
  });

  const parsed = JSON.parse(res.body) as { access_token?: string; expires_in?: number };
  if (parsed.access_token === undefined) {
    ctx.logger.warn('token response had no access_token');
    return null;
  }
  token = {
    value: parsed.access_token,
    expiresAt: now + (parsed.expires_in ?? 3600) * 1000,
  };
  return token.value;
}

// ── Fetching ───────────────────────────────────────────────────────────────

/** "r/all/rising" or "r/all/top?t=hour" -> a full URL for the chosen strategy. */
function feedUrl(feed: string, authed: boolean, limit: number): string {
  const [path = '', query = ''] = feed.split('?');
  const base = authed ? 'https://oauth.reddit.com' : 'https://www.reddit.com';
  const suffix = authed ? '' : '.json';
  const params = new URLSearchParams(query);
  params.set('limit', String(limit));
  params.set('raw_json', '1');
  return `${base}/${path.replace(/^\/+/, '')}${suffix}?${params.toString()}`;
}

async function fetchListing(feed: string, bearer: string | null, limit = 100): Promise<RedditPost[]> {
  const url = feedUrl(feed, bearer !== null, limit);
  const listing = await getJson<RedditListing>(url, {
    context: 'reddit',
    rps: bearer !== null ? 1 : 0.5,
    headers: {
      'User-Agent': config.reddit.userAgent,
      ...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }),
    },
  });
  return (listing.data?.children ?? []).map((c) => c.data).filter((p): p is RedditPost => p !== undefined);
}

function classify(post: RedditPost): ContentType {
  if (post.is_video === true) return 'video';
  if (post.post_hint === 'image' || /\.(jpg|jpeg|png|gif|webp)$/i.test(post.url ?? '')) return 'image';
  if (post.is_self === true) return 'text';
  return 'link';
}

function thumbnailOf(post: RedditPost): string | null {
  const preview = post.preview?.images?.[0]?.source?.url;
  if (preview !== undefined) return preview.replace(/&amp;/g, '&');
  const thumb = post.thumbnail;
  return thumb !== undefined && thumb.startsWith('http') ? thumb : null;
}

function toContent(post: RedditPost): RawContent | null {
  if (post.title === undefined || post.stickied === true) return null;
  return {
    sourceId: 'reddit',
    externalId: post.id,
    url: post.permalink === undefined ? (post.url ?? '') : `https://www.reddit.com${post.permalink}`,
    title: post.title,
    body: post.selftext?.slice(0, 1000) ?? null,
    contentType: classify(post),
    authorId: post.author ?? null,
    authorName: post.author ?? null,
    authorUrl: post.author === undefined ? null : `https://www.reddit.com/user/${post.author}`,
    thumbnailUrl: thumbnailOf(post),
    publishedAt: post.created_utc === undefined ? null : Math.floor(post.created_utc),
    publishedAtSource: 'api',
    metrics: metricsOf({
      nativeScore: intOrNull(post.score ?? post.ups),
      comments: intOrNull(post.num_comments),
      shares: intOrNull(post.num_crossposts),
    }),
    raw: {
      subreddit: post.subreddit ?? null,
      upvoteRatio: post.upvote_ratio ?? null,
      nsfw: post.over_18 ?? false,
      targetUrl: post.url ?? null,
    },
  };
}

export function createRedditSource(): SourcePlugin {
  return {
    id: 'reddit',
    name: 'Reddit',
    version: '1.0.0',
    capabilities: CAPABILITIES,

    validate(): ValidationResult {
      if (!hasCredentials()) {
        // Not fatal: the anonymous strategy may still work from a home network.
        return {
          ok: true,
          status: 'DEGRADED',
          message:
            'No REDDIT_CLIENT_ID/SECRET: falling back to anonymous public JSON, which Reddit blocks from many networks. Create a free "script" app to make this reliable.',
          helpUrl: HELP_URL,
        };
      }
      return VALID;
    },

    async discover(ctx: PluginContext): Promise<readonly RawContent[]> {
      let bearer: string | null = null;
      try {
        bearer = await accessToken(ctx);
      } catch (e) {
        ctx.logger.warn('oauth failed, falling back to anonymous', { error: (e as Error).message });
      }

      const seen = new Set<string>();
      const out: RawContent[] = [];
      let lastError: unknown = null;

      for (const feed of config.reddit.feeds) {
        try {
          for (const post of await fetchListing(feed, bearer)) {
            const content = toContent(post);
            if (content === null || seen.has(content.externalId)) continue;
            seen.add(content.externalId);
            out.push(content);
          }
        } catch (e) {
          lastError = e;
          ctx.logger.warn('feed failed', { feed, error: (e as Error).message });
        }
      }

      if (out.length === 0 && lastError !== null) {
        if (isRadarError(lastError) && lastError.kind === 'AUTH_REQUIRED' && bearer === null) {
          ctx.requireHuman(
            'CONFIGURATION',
            'Reddit refused anonymous access from this network. Create a free "script" app at reddit.com/prefs/apps and set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in .env.',
            HELP_URL,
          );
        }
        throw lastError;
      }

      ctx.logger.debug('collected', { items: out.length, authenticated: bearer !== null });
      return out;
    },

    async refresh(ctx: PluginContext, items: readonly RefreshRequest[]): Promise<readonly RefreshResult[]> {
      if (items.length === 0) return [];
      const bearer = await accessToken(ctx).catch(() => null);
      const results: RefreshResult[] = [];

      // /api/info takes up to 100 fullnames in one request.
      for (let i = 0; i < items.length; i += 100) {
        const chunk = items.slice(i, i + 100);
        const names = chunk.map((c) => `t3_${c.externalId}`).join(',');
        const base = bearer !== null ? 'https://oauth.reddit.com' : 'https://www.reddit.com';
        const suffix = bearer !== null ? '' : '.json';
        try {
          const listing = await getJson<RedditListing>(
            `${base}/api/info${suffix}?id=${names}&raw_json=1`,
            {
              context: 'reddit',
              rps: 1,
              headers: {
                'User-Agent': config.reddit.userAgent,
                ...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }),
              },
            },
          );
          for (const child of listing.data?.children ?? []) {
            const post = child.data;
            if (post === undefined) continue;
            results.push({
              externalId: post.id,
              metrics: metricsOf({
                nativeScore: intOrNull(post.score ?? post.ups),
                comments: intOrNull(post.num_comments),
                shares: intOrNull(post.num_crossposts),
              }),
            });
          }
        } catch (e) {
          ctx.logger.warn('refresh chunk failed', { error: (e as Error).message });
        }
      }
      return results;
    },
  };
}
