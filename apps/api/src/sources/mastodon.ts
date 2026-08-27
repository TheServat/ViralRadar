/**
 * Mastodon, through the public trending endpoints.
 *
 * A real social source with real engagement numbers - favourites, boosts,
 * replies - and no key, no account and no scraping. Every Mastodon server
 * publishes what is trending on it, and because servers federate, a large one
 * sees a wide slice of the network.
 *
 * Three separate signals are read, because they answer different questions:
 *   statuses - which individual posts are spreading
 *   tags     - which subjects are being talked about
 *   links    - which articles the network is sharing
 */
import { config } from '../config.ts';
import { getJson, mapLimit } from '../net/fetcher.ts';
import { hash64 } from '../core/text.ts';
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

const CAPABILITIES: SourceCapabilities = {
  contentTypes: ['text', 'image', 'video', 'link', 'topic'],
  metrics: ['likes', 'shares', 'comments', 'nativeScore'],
  primaryMetric: 'nativeScore',
  // (favourites + boosts + replies) against the combined score; 40% is lively.
  engagementReference: 0.4,
  hasAuthor: true,
  hasHashtags: true,
  hasCountry: false,
  supportsRefresh: true,
  supportsTrending: true,
  supportsSearch: false,
  supportsHistoricalMetrics: false,
  baseReliability: 0.85,
};

interface Status {
  id: string;
  url?: string | null;
  uri?: string;
  created_at?: string;
  content?: string;
  language?: string | null;
  favourites_count?: number;
  reblogs_count?: number;
  replies_count?: number;
  account?: { acct?: string; display_name?: string; url?: string; followers_count?: number };
  media_attachments?: { type?: string }[];
  tags?: { name?: string }[];
}

interface Tag {
  name: string;
  url?: string;
  history?: { day?: string; uses?: string; accounts?: string }[];
}

interface Link {
  url: string;
  title?: string;
  description?: string;
  provider_name?: string;
  image?: string | null;
  published_at?: string | null;
  history?: { day?: string; uses?: string; accounts?: string }[];
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function classify(status: Status): ContentType {
  const media = status.media_attachments ?? [];
  if (media.some((m) => m.type === 'video' || m.type === 'gifv')) return 'video';
  if (media.some((m) => m.type === 'image')) return 'image';
  return 'text';
}

/** Combined attention on a post: the platform has no single number of its own. */
function nativeScore(status: Status): number | null {
  const parts = [status.favourites_count, status.reblogs_count, status.replies_count].filter(
    (v): v is number => typeof v === 'number',
  );
  return parts.length === 0 ? null : parts.reduce((a, b) => a + b, 0);
}

/**
 * The canonical identity of a post, which is not its local one.
 *
 * The network federates: the same post appears on every server that has seen
 * it, each with a different local id. Keying on `host:id` therefore stores one
 * post several times, once per server read. The `uri` field is the origin
 * server's own address for it and is identical everywhere, so that is the
 * identity - and the local id is kept only so a refresh knows where to ask.
 */
function canonicalId(status: Status, host: string): string {
  return status.uri ?? status.url ?? `${host}:${status.id}`;
}

function statusToContent(status: Status, host: string): RawContent | null {
  const text = stripHtml(status.content ?? '');
  if (text.length === 0 && (status.media_attachments ?? []).length === 0) return null;

  return {
    sourceId: 'mastodon',
    externalId: canonicalId(status, host),
    url: status.url ?? status.uri ?? `https://${host}/@${status.account?.acct ?? ''}/${status.id}`,
    title: text.split('\n')[0]?.slice(0, 200) || `post by ${status.account?.acct ?? 'unknown'}`,
    body: text.slice(0, 1200) || null,
    contentType: classify(status),
    authorId: status.account?.acct ?? null,
    authorName: status.account?.display_name || (status.account?.acct ?? null),
    authorUrl: status.account?.url ?? null,
    authorFollowers: intOrNull(status.account?.followers_count),
    thumbnailUrl: null,
    publishedAt: status.created_at === undefined ? null : Math.floor(Date.parse(status.created_at) / 1000),
    publishedAtSource: 'api',
    metrics: metricsOf({
      likes: intOrNull(status.favourites_count),
      shares: intOrNull(status.reblogs_count),
      comments: intOrNull(status.replies_count),
      nativeScore: nativeScore(status),
    }),
    hashtags: (status.tags ?? []).map((t) => (t.name ?? '').toLowerCase()).filter((t) => t.length > 0),
    raw: { host, language: status.language ?? null, localId: status.id },
  };
}

/** Trend history is newest-first, one entry per day. */
function recentUses(history: { uses?: string }[] | undefined): number | null {
  if (history === undefined || history.length === 0) return null;
  const value = Number(history[0]?.uses ?? '');
  return Number.isFinite(value) ? value : null;
}

function recentAccounts(history: { accounts?: string }[] | undefined): number | null {
  if (history === undefined || history.length === 0) return null;
  const value = Number(history[0]?.accounts ?? '');
  return Number.isFinite(value) ? value : null;
}

function tagToContent(tag: Tag, host: string): RawContent | null {
  const uses = recentUses(tag.history);
  if (uses === null) return null;
  return {
    sourceId: 'mastodon',
    externalId: `${host}:tag:${tag.name.toLowerCase()}`,
    url: tag.url ?? `https://${host}/tags/${encodeURIComponent(tag.name)}`,
    title: `#${tag.name}`,
    body: null,
    contentType: 'topic',
    authorId: null,
    authorName: null,
    thumbnailUrl: null,
    publishedAt: null,
    metrics: metricsOf({
      nativeScore: uses,
      // Distinct accounts using a tag: many voices, not one loud one.
      comments: recentAccounts(tag.history),
    }),
    hashtags: [tag.name.toLowerCase()],
    raw: { host, kind: 'tag' },
  };
}

function linkToContent(link: Link, host: string): RawContent | null {
  const uses = recentUses(link.history);
  if (uses === null || link.title === undefined || link.title.length === 0) return null;
  return {
    sourceId: 'mastodon',
    externalId: `${host}:link:${hash64(link.url).toString(16)}`,
    url: link.url,
    title: link.title,
    body: link.description?.slice(0, 800) ?? null,
    contentType: 'link',
    authorId: link.provider_name ?? null,
    authorName: link.provider_name ?? null,
    thumbnailUrl: link.image ?? null,
    publishedAt:
      link.published_at === null || link.published_at === undefined
        ? null
        : Math.floor(Date.parse(link.published_at) / 1000),
    publishedAtSource: 'api',
    metrics: metricsOf({ nativeScore: uses, comments: recentAccounts(link.history) }),
    raw: { host, kind: 'link' },
  };
}

/** Pulls the origin server and status id back out of a canonical URI. */
export function originOf(uri: string): { host: string; id: string } | null {
  try {
    const url = new URL(uri);
    const id = url.pathname.split('/').filter((p) => p.length > 0).pop();
    if (id === undefined || !/^\d+$/.test(id)) return null;
    return { host: url.hostname, id };
  } catch {
    return null;
  }
}

async function readHost(host: string, ctx: PluginContext): Promise<RawContent[]> {
  const base = `https://${host}/api/v1/trends`;
  const out: RawContent[] = [];

  const [statuses, tags, links] = await Promise.allSettled([
    getJson<Status[]>(`${base}/statuses?limit=40`, { context: 'mastodon', rps: 1 }),
    getJson<Tag[]>(`${base}/tags?limit=20`, { context: 'mastodon', rps: 1 }),
    getJson<Link[]>(`${base}/links?limit=20`, { context: 'mastodon', rps: 1 }),
  ]);

  if (statuses.status === 'fulfilled') {
    for (const status of statuses.value) {
      const content = statusToContent(status, host);
      if (content !== null) out.push(content);
    }
  }
  if (tags.status === 'fulfilled') {
    for (const tag of tags.value) {
      const content = tagToContent(tag, host);
      if (content !== null) out.push(content);
    }
  }
  if (links.status === 'fulfilled') {
    for (const link of links.value) {
      const content = linkToContent(link, host);
      if (content !== null) out.push(content);
    }
  }

  ctx.logger.debug('host read', { host, items: out.length });
  return out;
}

export function createMastodonSource(): SourcePlugin {
  return {
    id: 'mastodon',
    name: 'Mastodon',
    version: '1.0.0',
    capabilities: CAPABILITIES,

    validate(): ValidationResult {
      return VALID;
    },

    async discover(ctx: PluginContext): Promise<readonly RawContent[]> {
      const hosts = config.mastodon.hosts;
      const settled = await mapLimit(hosts, 2, (host) => readHost(host, ctx));

      const seen = new Set<string>();
      const out: RawContent[] = [];
      for (const [i, result] of settled.entries()) {
        if (result.status !== 'fulfilled') {
          ctx.logger.warn('host failed', { host: hosts[i], error: String(result.reason) });
          continue;
        }
        for (const item of result.value) {
          if (seen.has(item.externalId)) continue;
          seen.add(item.externalId);
          out.push(item);
        }
      }
      return out;
    },

    async refresh(_ctx: PluginContext, items: readonly RefreshRequest[]): Promise<readonly RefreshResult[]> {
      // Individual statuses can be re-read directly; tags and links only appear
      // in the trending lists, so those come back through discovery.
      const statusIds = items
        .map((i) => i.externalId)
        .filter((id) => !id.includes(':tag:') && !id.includes(':link:'));

      const settled = await mapLimit(statusIds.slice(0, 60), 3, async (externalId) => {
        // The identity is the origin server's own URL for the post, so both the
        // server to ask and the id to ask for are read back out of it.
        const parsed = originOf(externalId);
        if (parsed === null) return null;
        const status = await getJson<Status>(
          `https://${parsed.host}/api/v1/statuses/${parsed.id}`,
          { context: 'mastodon', rps: 2, retries: 0 },
        );
        return {
          externalId,
          metrics: metricsOf({
            likes: intOrNull(status.favourites_count),
            shares: intOrNull(status.reblogs_count),
            comments: intOrNull(status.replies_count),
            nativeScore: nativeScore(status),
          }),
        } satisfies RefreshResult;
      });

      const out: RefreshResult[] = [];
      for (const r of settled) if (r.status === 'fulfilled' && r.value !== null) out.push(r.value);
      return out;
    },
  };
}

export { stripHtml, nativeScore as mastodonNativeScore };
