/**
 * Hacker News via the official Firebase API.
 *
 * No key, no account, no rate limit worth worrying about, and it exposes both
 * "top" and "new" - which means we can watch a story climb from nothing, the
 * exact behaviour the acceleration signal is built for.
 */
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

const API = 'https://hacker-news.firebaseio.com/v0';

const CAPABILITIES: SourceCapabilities = {
  contentTypes: ['link', 'text'],
  metrics: ['nativeScore', 'comments'],
  primaryMetric: 'nativeScore',
  // Comments per point runs high here; 60% is an exceptional discussion.
  engagementReference: 0.6,
  hasAuthor: true,
  hasHashtags: false,
  hasCountry: false,
  supportsRefresh: true,
  supportsTrending: true,
  supportsSearch: false,
  supportsHistoricalMetrics: false,
  baseReliability: 0.95,
};

interface HnItem {
  readonly id: number;
  readonly type?: string;
  readonly by?: string;
  readonly time?: number;
  readonly title?: string;
  readonly url?: string;
  readonly text?: string;
  readonly score?: number;
  readonly descendants?: number;
  readonly dead?: boolean;
  readonly deleted?: boolean;
}

async function fetchItem(id: number): Promise<HnItem | null> {
  const item = await getJson<HnItem | null>(`${API}/item/${id}.json`, {
    context: 'hackernews',
    rps: 8,
    retries: 1,
  });
  if (item === null || item.deleted === true || item.dead === true) return null;
  return item;
}

function toContent(item: HnItem): RawContent | null {
  if (item.title === undefined || item.type === 'comment') return null;
  const type: ContentType = item.url === undefined ? 'text' : 'link';
  return {
    sourceId: 'hackernews',
    externalId: String(item.id),
    url: `https://news.ycombinator.com/item?id=${item.id}`,
    title: item.title,
    body: item.url ?? (item.text ?? null),
    contentType: type,
    authorId: item.by ?? null,
    authorName: item.by ?? null,
    thumbnailUrl: null,
    publishedAt: item.time ?? null,
    publishedAtSource: 'api',
    metrics: metricsOf({
      nativeScore: intOrNull(item.score),
      comments: intOrNull(item.descendants),
    }),
    raw: { targetUrl: item.url ?? null },
  };
}

export function createHackerNewsSource(): SourcePlugin {
  return {
    id: 'hackernews',
    name: 'Hacker News',
    version: '1.0.0',
    capabilities: CAPABILITIES,

    validate(): ValidationResult {
      return VALID;
    },

    async discover(ctx: PluginContext): Promise<readonly RawContent[]> {
      // "new" matters as much as "top": a story that is not on the front page
      // yet but climbing fast is exactly what EMERGING is supposed to catch.
      const [top, latest] = await Promise.all([
        getJson<number[]>(`${API}/topstories.json`, { context: 'hackernews', rps: 4 }),
        getJson<number[]>(`${API}/newstories.json`, { context: 'hackernews', rps: 4 }),
      ]);

      const ids = [...new Set([...top.slice(0, 60), ...latest.slice(0, 60)])];
      const settled = await mapLimit(ids, 6, fetchItem);

      const out: RawContent[] = [];
      for (const result of settled) {
        if (result.status !== 'fulfilled' || result.value === null) continue;
        const content = toContent(result.value);
        if (content !== null) out.push(content);
      }
      ctx.logger.debug('collected', { items: out.length, requested: ids.length });
      return out;
    },

    async refresh(_ctx: PluginContext, items: readonly RefreshRequest[]): Promise<readonly RefreshResult[]> {
      const settled = await mapLimit(items, 6, async (item) => {
        const hn = await fetchItem(Number(item.externalId));
        if (hn === null) return null;
        return {
          externalId: item.externalId,
          metrics: metricsOf({
            nativeScore: intOrNull(hn.score),
            comments: intOrNull(hn.descendants),
          }),
        } satisfies RefreshResult;
      });

      const out: RefreshResult[] = [];
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value !== null) out.push(r.value);
      }
      return out;
    },
  };
}
