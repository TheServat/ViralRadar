/**
 * Generic RSS / Atom feeds.
 *
 * Feeds expose no popularity metric at all, so items from here rarely score
 * highly on their own - and they are not supposed to. Their job is
 * corroboration: when a story appears on Reddit, on YouTube and in three news
 * feeds within the same hour, that is a real event rather than one platform's
 * algorithm having a moment.
 *
 * Any Atom or RSS URL works, including YouTube channel feeds and site-specific
 * "popular" feeds.
 */
import { config } from '../config.ts';
import { getText, mapLimit } from '../net/fetcher.ts';
import { feedTitle, parseFeed } from '../core/xml.ts';
import { hash64 } from '../core/text.ts';
import {
  configurationRequired,
  metricsOf,
  VALID,
  type PluginContext,
  type SourceCapabilities,
  type SourcePlugin,
  type ValidationResult,
} from './types.ts';
import type { ContentType, RawContent } from '../core/types.ts';

const CAPABILITIES: SourceCapabilities = {
  contentTypes: ['link', 'text', 'video'],
  metrics: [],
  // Nothing is measurable here; the field still has to name something.
  primaryMetric: 'nativeScore',
  engagementReference: 0.1,
  hasAuthor: true,
  hasHashtags: false,
  hasCountry: false,
  supportsRefresh: false,
  supportsTrending: false,
  supportsSearch: false,
  supportsHistoricalMetrics: false,
  baseReliability: 0.6,
};

function stableId(link: string, guid: string | null, title: string): string {
  return hash64(guid ?? link ?? title).toString(16);
}

function classify(link: string | null): ContentType {
  if (link === null) return 'text';
  if (/youtube\.com\/watch|youtu\.be\//.test(link)) return 'video';
  return 'link';
}

async function readFeed(feedUrl: string, ctx: PluginContext): Promise<RawContent[]> {
  const xml = await getText(feedUrl, { context: 'rss', rps: 1 });
  const source = feedTitle(xml) ?? new URL(feedUrl).hostname;
  const items = parseFeed(xml);
  const out: RawContent[] = [];

  for (const item of items.slice(0, 60)) {
    const link = item.link;
    if (link === null) continue;
    let domain: string | null = null;
    try {
      domain = new URL(link).hostname.replace(/^www\./, '');
    } catch {
      continue;
    }

    out.push({
      sourceId: 'rss',
      externalId: stableId(link, item.guid, item.title),
      url: link,
      title: item.title,
      body: item.description?.slice(0, 800) ?? null,
      contentType: classify(link),
      // The publication is the closest thing a feed has to an author.
      authorId: domain,
      authorName: item.author ?? source,
      thumbnailUrl: item.thumbnail,
      publishedAt: item.publishedAt,
      publishedAtSource: 'feed',
      // Deliberately empty: inventing a 0 here would be a lie the scoring
      // engine could not distinguish from a real zero.
      metrics: metricsOf({}),
      raw: { feed: feedUrl, feedTitle: source, categories: item.categories.slice(0, 6) },
    });
  }

  ctx.logger.debug('feed read', { feed: source, items: out.length });
  return out;
}

export function createRssSource(): SourcePlugin {
  return {
    id: 'rss',
    name: 'RSS / Atom feeds',
    version: '1.0.0',
    capabilities: CAPABILITIES,

    validate(): ValidationResult {
      if (config.rss.feeds.length === 0) {
        return configurationRequired('Set RSS_FEEDS in .env to one or more feed URLs.');
      }
      return VALID;
    },

    async discover(ctx: PluginContext): Promise<readonly RawContent[]> {
      const settled = await mapLimit(config.rss.feeds, 4, (feed) => readFeed(feed, ctx));
      const out: RawContent[] = [];
      for (const [i, result] of settled.entries()) {
        if (result.status === 'fulfilled') out.push(...result.value);
        else ctx.logger.warn('feed failed', { feed: config.rss.feeds[i], error: String(result.reason) });
      }
      return out;
    },
  };
}
