/**
 * Bluesky, through its public read API.
 *
 * The AT Protocol serves feeds without authentication, which makes this the
 * one large microblogging network still readable the way the open web used to
 * be. Posts carry likes, reposts, replies and quotes, so it measures the same
 * things the other social sources do.
 *
 * Feeds are addressed by AT-URI. The defaults are Bluesky's own discovery
 * feeds; any public feed generator can be added instead.
 */
import { config } from '../config.ts';
import { getJson, mapLimit } from '../net/fetcher.ts';
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

const API = 'https://public.api.bsky.app/xrpc';

const CAPABILITIES: SourceCapabilities = {
  contentTypes: ['text', 'image', 'video', 'link'],
  metrics: ['likes', 'shares', 'comments', 'nativeScore'],
  primaryMetric: 'nativeScore',
  engagementReference: 0.35,
  hasAuthor: true,
  hasHashtags: true,
  hasCountry: false,
  supportsRefresh: true,
  supportsTrending: true,
  supportsSearch: false,
  supportsHistoricalMetrics: false,
  baseReliability: 0.85,
};

interface Post {
  uri: string;
  cid?: string;
  author?: { did?: string; handle?: string; displayName?: string; avatar?: string };
  record?: { text?: string; createdAt?: string; langs?: string[] };
  embed?: { $type?: string; images?: unknown[]; media?: { $type?: string } };
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  quoteCount?: number;
}

interface FeedResponse {
  feed?: { post?: Post }[];
  cursor?: string;
}

/** `at://did:plc:xxx/app.bsky.feed.post/3kabc` -> a web URL a person can open. */
function webUrl(uri: string, handle: string | undefined): string | null {
  const match = uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
  if (match === null) return null;
  const who = handle ?? match[1];
  return `https://bsky.app/profile/${who}/post/${match[2]}`;
}

function classify(post: Post): ContentType {
  const type = post.embed?.$type ?? '';
  if (type.includes('video')) return 'video';
  if (type.includes('images')) return 'image';
  if (type.includes('external')) return 'link';
  return 'text';
}

/** Combined attention: Bluesky publishes the parts, not a total. */
function nativeScore(post: Post): number | null {
  const parts = [post.likeCount, post.repostCount, post.replyCount, post.quoteCount].filter(
    (v): v is number => typeof v === 'number',
  );
  return parts.length === 0 ? null : parts.reduce((a, b) => a + b, 0);
}

function hashtagsOf(text: string): string[] {
  return [...new Set([...text.matchAll(/#([\p{L}\p{N}_]{2,40})/gu)].map((m) => (m[1] as string).toLowerCase()))];
}

function toContent(post: Post): RawContent | null {
  const text = post.record?.text ?? '';
  if (text.length === 0) return null;
  const url = webUrl(post.uri, post.author?.handle);
  if (url === null) return null;

  return {
    sourceId: 'bluesky',
    externalId: post.uri,
    url,
    title: text.split('\n')[0]?.slice(0, 200) || text.slice(0, 200),
    body: text.slice(0, 1200),
    contentType: classify(post),
    authorId: post.author?.handle ?? post.author?.did ?? null,
    authorName: post.author?.displayName || (post.author?.handle ?? null),
    authorUrl: post.author?.handle === undefined ? null : `https://bsky.app/profile/${post.author.handle}`,
    thumbnailUrl: null,
    publishedAt:
      post.record?.createdAt === undefined ? null : Math.floor(Date.parse(post.record.createdAt) / 1000),
    publishedAtSource: 'api',
    metrics: metricsOf({
      likes: intOrNull(post.likeCount),
      shares: intOrNull(post.repostCount),
      comments: intOrNull(post.replyCount),
      nativeScore: nativeScore(post),
    }),
    hashtags: hashtagsOf(text),
    raw: { langs: post.record?.langs ?? null, quotes: post.quoteCount ?? null },
  };
}

async function readFeed(feed: string, ctx: PluginContext): Promise<RawContent[]> {
  const url = `${API}/app.bsky.feed.getFeed?feed=${encodeURIComponent(feed)}&limit=100`;
  const response = await getJson<FeedResponse>(url, { context: 'bluesky', rps: 1 });
  const out: RawContent[] = [];

  for (const entry of response.feed ?? []) {
    if (entry.post === undefined) continue;
    const content = toContent(entry.post);
    if (content !== null) out.push(content);
  }
  ctx.logger.debug('feed read', { feed: feed.slice(-24), items: out.length });
  return out;
}

export function createBlueskySource(): SourcePlugin {
  return {
    id: 'bluesky',
    name: 'Bluesky',
    version: '1.0.0',
    capabilities: CAPABILITIES,

    validate(): ValidationResult {
      return VALID;
    },

    async discover(ctx: PluginContext): Promise<readonly RawContent[]> {
      const feeds = config.bluesky.feeds;
      const settled = await mapLimit(feeds, 2, (feed) => readFeed(feed, ctx));

      const seen = new Set<string>();
      const out: RawContent[] = [];
      for (const [i, result] of settled.entries()) {
        if (result.status !== 'fulfilled') {
          ctx.logger.warn('feed failed', { feed: feeds[i]?.slice(-24), error: String(result.reason) });
          continue;
        }
        // Feeds overlap heavily; the first sighting wins.
        for (const item of result.value) {
          if (seen.has(item.externalId)) continue;
          seen.add(item.externalId);
          out.push(item);
        }
      }
      return out;
    },

    async refresh(ctx: PluginContext, items: readonly RefreshRequest[]): Promise<readonly RefreshResult[]> {
      const results: RefreshResult[] = [];
      // getPosts takes 25 URIs at a time.
      for (let i = 0; i < items.length; i += 25) {
        const chunk = items.slice(i, i + 25);
        const params = chunk.map((c) => `uris=${encodeURIComponent(c.externalId)}`).join('&');
        try {
          const response = await getJson<{ posts?: Post[] }>(`${API}/app.bsky.feed.getPosts?${params}`, {
            context: 'bluesky',
            rps: 1,
          });
          for (const post of response.posts ?? []) {
            results.push({
              externalId: post.uri,
              metrics: metricsOf({
                likes: intOrNull(post.likeCount),
                shares: intOrNull(post.repostCount),
                comments: intOrNull(post.replyCount),
                nativeScore: nativeScore(post),
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

export { webUrl as blueskyWebUrl, nativeScore as blueskyNativeScore };
