/**
 * Google News, per topic and per region.
 *
 * The widest topical coverage available without a key. Google News publishes an
 * RSS feed for each of its sections - world, business, technology,
 * entertainment, sport, science, health - in whatever language and country you
 * ask for, which is the only source here that reaches every subject at once and
 * still speaks Persian.
 *
 * Each item is an aggregated story rather than a single article, so the feed
 * already carries a hint of how many outlets are covering it. There are no
 * popularity numbers, so like RSS these items score low on their own; their
 * value is corroborating a story the metric-bearing sources also see.
 */
import { getText, mapLimit } from '../net/fetcher.ts';
import { parseFeed, tagTexts } from '../core/xml.ts';
import { hash64 } from '../core/text.ts';
import {
  metricsOf,
  VALID,
  type PluginContext,
  type SourceCapabilities,
  type SourcePlugin,
  type ValidationResult,
} from './types.ts';
import type { RawContent } from '../core/types.ts';

const CAPABILITIES: SourceCapabilities = {
  contentTypes: ['link'],
  metrics: [],
  primaryMetric: 'nativeScore',
  engagementReference: 0.1,
  hasAuthor: true,
  hasHashtags: false,
  hasCountry: true,
  supportsRefresh: false,
  supportsTrending: true,
  supportsSearch: false,
  supportsHistoricalMetrics: false,
  baseReliability: 0.7,
};

/** Google's own section names. Together they cover essentially everything. */
const TOPICS = [
  'WORLD',
  'NATION',
  'BUSINESS',
  'TECHNOLOGY',
  'ENTERTAINMENT',
  'SPORTS',
  'SCIENCE',
  'HEALTH',
] as const;

type Topic = (typeof TOPICS)[number];

/**
 * Google News needs a language and a country together. The language comes from
 * the configured preference where there is one, because a Persian speaker in
 * Iran wants Persian headlines, not English ones about Iran.
 */
function feedUrl(topic: Topic | null, language: string, region: string): string {
  const ceid = `${region}:${language}`;
  const params = `hl=${language}&gl=${region}&ceid=${encodeURIComponent(ceid)}`;
  return topic === null
    ? `https://news.google.com/rss?${params}`
    : `https://news.google.com/rss/headlines/section/topic/${topic}?${params}`;
}

/** "Headline - Publisher" is Google's title format; the publisher is useful. */
function splitTitle(title: string): { headline: string; publisher: string | null } {
  const at = title.lastIndexOf(' - ');
  if (at <= 0 || title.length - at > 60) return { headline: title, publisher: null };
  return { headline: title.slice(0, at).trim(), publisher: title.slice(at + 3).trim() };
}

async function readSection(
  topic: Topic | null,
  language: string,
  region: string,
  ctx: PluginContext,
): Promise<RawContent[]> {
  const xml = await getText(feedUrl(topic, language, region), { context: 'googlenews', rps: 0.5 });
  const items = parseFeed(xml);
  const out: RawContent[] = [];

  for (const item of items.slice(0, 40)) {
    if (item.link === null) continue;
    const { headline, publisher } = splitTitle(item.title);

    // The description lists the other outlets carrying the same story, which is
    // a corroboration hint the clustering can use.
    const related = tagTexts(item.raw, 'title').slice(1, 6);

    out.push({
      sourceId: 'googlenews',
      externalId: hash64(item.guid ?? item.link).toString(16),
      url: item.link,
      title: headline,
      body: related.length > 0 ? related.join(' · ') : null,
      contentType: 'link',
      authorId: publisher,
      authorName: publisher,
      thumbnailUrl: item.thumbnail,
      publishedAt: item.publishedAt,
      publishedAtSource: 'feed',
      // Google News exposes no popularity figure at all. Inventing one would be
      // a lie the scoring engine could not tell from a real measurement.
      metrics: metricsOf({}),
      region,
      country: { value: region, confidence: 0.6, source: 'region_param' },
      raw: { topic: topic ?? 'TOP', language, outlets: related.length },
    });
  }

  ctx.logger.debug('section read', { topic: topic ?? 'TOP', region, language, items: out.length });
  return out;
}

export function createGoogleNewsSource(): SourcePlugin {
  return {
    id: 'googlenews',
    name: 'Google News',
    version: '1.0.0',
    capabilities: CAPABILITIES,

    validate(): ValidationResult {
      return VALID;
    },

    async discover(ctx: PluginContext): Promise<readonly RawContent[]> {
      // The wide list, not the paid one: a country costs a single RSS
      // request here, so watching thirty of them is free and is the whole
      // point of looking abroad for something nobody has covered at home.
      const regions = ctx.trendsRegions.length > 0 ? ctx.trendsRegions : ['US'];
      // One language per region: the configured preference if there is one,
      // otherwise English.
      const language = ctx.languages[0] ?? 'en';

      const jobs: { topic: Topic | null; region: string }[] = [];
      for (const region of regions) {
        jobs.push({ topic: null, region });
        for (const topic of TOPICS) jobs.push({ topic, region });
      }

      const settled = await mapLimit(jobs, 3, (job) =>
        readSection(job.topic, language, job.region, ctx),
      );

      const seen = new Set<string>();
      const out: RawContent[] = [];
      for (const [i, result] of settled.entries()) {
        if (result.status !== 'fulfilled') {
          ctx.logger.warn('section failed', { job: jobs[i]?.topic ?? 'TOP', error: String(result.reason) });
          continue;
        }
        // The top feed repeats what the sections carry; keep the first sighting.
        for (const item of result.value) {
          if (seen.has(item.externalId)) continue;
          seen.add(item.externalId);
          out.push(item);
        }
      }

      ctx.logger.debug('collected', { items: out.length, sections: jobs.length });
      return out;
    },
  };
}

export { TOPICS as GOOGLE_NEWS_TOPICS, splitTitle };
