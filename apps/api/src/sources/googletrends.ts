/**
 * Google Trends - the daily trending-searches RSS feed.
 *
 * This is the one source that answers "what are people looking for right now"
 * rather than "what did people post". It needs no key and no account, which
 * makes it the source that guarantees the dashboard is never empty.
 *
 * What it gives us is an *approximate* traffic band ("50K+"), not a real
 * counter, so it is stored as nativeScore and its reliability is set below the
 * API-backed sources rather than pretending the number is exact.
 */
import { getText } from '../net/fetcher.ts';
import { parseFeed, tagText, tagTexts } from '../core/xml.ts';
import { metricsOf, VALID, type PluginContext, type SourceCapabilities, type SourcePlugin, type ValidationResult } from './types.ts';
import type { RawContent } from '../core/types.ts';

const CAPABILITIES: SourceCapabilities = {
  contentTypes: ['topic'],
  metrics: ['nativeScore'],
  primaryMetric: 'nativeScore',
  engagementReference: 0.1,
  hasAuthor: false,
  hasHashtags: false,
  hasCountry: true,
  supportsRefresh: true,
  supportsTrending: true,
  supportsSearch: false,
  supportsHistoricalMetrics: false,
  baseReliability: 0.75,
};

/** "20K+" / "1M+" / "500+" -> a number. Returns null for anything unexpected. */
export function parseApproxTraffic(raw: string | null): number | null {
  if (raw === null) return null;
  const m = raw.replace(/[,\s+]/g, '').match(/^(\d+(?:\.\d+)?)([KMB])?$/i);
  if (m === null) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (m[2] ?? '').toUpperCase();
  const factor = unit === 'B' ? 1e9 : unit === 'M' ? 1e6 : unit === 'K' ? 1e3 : 1;
  return Math.round(value * factor);
}

async function fetchRegion(region: string, ctx: PluginContext): Promise<RawContent[]> {
  const url = `https://trends.google.com/trending/rss?geo=${encodeURIComponent(region)}`;
  const xml = await getText(url, { context: 'googletrends', rps: 0.5 });
  const items = parseFeed(xml);
  const out: RawContent[] = [];

  for (const item of items) {
    const traffic = parseApproxTraffic(tagText(item.raw, 'approx_traffic'));
    const headlines = tagTexts(item.raw, 'news_item_title');
    const firstStory = tagTexts(item.raw, 'news_item_url')[0] ?? null;

    out.push({
      sourceId: 'googletrends',
      // Region-scoped: the same term trending in two countries is two facts.
      externalId: `${region}:${item.title.toLowerCase()}`,
      url: `https://trends.google.com/trends/explore?q=${encodeURIComponent(item.title)}&geo=${region}`,
      title: item.title,
      body: headlines.slice(0, 4).join(' · ') || null,
      contentType: 'topic',
      authorId: null,
      authorName: null,
      thumbnailUrl: item.thumbnail,
      publishedAt: item.publishedAt,
      publishedAtSource: 'feed',
      metrics: metricsOf({ nativeScore: traffic }),
      region,
      country: { value: region, confidence: 1, source: 'region_param' },
      raw: {
        headlines: headlines.slice(0, 5),
        firstStoryUrl: firstStory,
        approxTraffic: tagText(item.raw, 'approx_traffic'),
      },
    });
  }

  ctx.logger.debug('region collected', { region, items: out.length });
  return out;
}

export function createGoogleTrendsSource(): SourcePlugin {
  return {
    id: 'googletrends',
    name: 'Google Trends',
    version: '1.0.0',
    capabilities: CAPABILITIES,

    validate(): ValidationResult {
      return VALID;
    },

    async discover(ctx: PluginContext): Promise<readonly RawContent[]> {
      const regions = ctx.regions.length > 0 ? ctx.regions : ['US'];
      const results: RawContent[] = [];
      for (const region of regions) {
        try {
          results.push(...(await fetchRegion(region, ctx)));
        } catch (e) {
          // One bad region must not lose the others.
          ctx.logger.warn('region failed', { region, error: (e as Error).message });
        }
      }
      return results;
    },

    /**
     * The feed always carries current values, so "refresh" is just another
     * read. Repeated reads are what build the time series that velocity and
     * acceleration are computed from.
     */
    async refresh(ctx: PluginContext) {
      const items = await this.discover(ctx);
      return items.map((i) => ({ externalId: i.externalId, metrics: i.metrics }));
    },
  };
}
