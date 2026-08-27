/**
 * Wikipedia pageviews, per language.
 *
 * What people are *reading*, which is a different question from what they are
 * posting or searching for. The Wikimedia REST API publishes the top articles
 * per language per day, with real view counts and no key.
 *
 * Two things this source needs care with:
 *   - Persian and English Wikipedia both have a permanent top ten that never
 *     changes. Those articles are background, not news, and the fact that they
 *     never move is precisely what the velocity signal is for - they score
 *     nothing because nothing about them is changing.
 *   - The figures are daily totals, published in arrears. Yesterday is the most
 *     recent complete day, so that is what gets read.
 */
import { getJson, mapLimit } from '../net/fetcher.ts';
import { isRadarError } from '../errors.ts';
import {
  metricsOf,
  VALID,
  type PluginContext,
  type SourceCapabilities,
  type SourcePlugin,
  type ValidationResult,
} from './types.ts';
import type { RawContent } from '../core/types.ts';

const API = 'https://wikimedia.org/api/rest_v1/metrics/pageviews/top';

const CAPABILITIES: SourceCapabilities = {
  contentTypes: ['text'],
  metrics: ['views'],
  primaryMetric: 'views',
  engagementReference: 0.02,
  hasAuthor: false,
  hasHashtags: false,
  hasCountry: false,
  supportsRefresh: true,
  supportsTrending: true,
  supportsSearch: false,
  supportsHistoricalMetrics: true,
  baseReliability: 0.9,
};

interface TopResponse {
  items?: { articles?: { article: string; views: number; rank: number }[] }[];
}

/**
 * Pages that are not articles.
 *
 * Namespace prefixes differ per language, so the check is on the colon plus a
 * known prefix in either the local language or English - a real article title
 * can contain a colon, and dropping all of those would lose real pages.
 */
const NAMESPACES = [
  'Special:', 'Category:', 'Template:', 'File:', 'Help:', 'Portal:', 'Talk:', 'User:', 'Wikipedia:',
  'ویژه:', 'رده:', 'الگو:', 'پرونده:', 'راهنما:', 'درگاه:', 'بحث:', 'کاربر:', 'ویکی‌پدیا:',
  'خاص:', 'تصنيف:', 'قالب:', 'ملف:', 'مساعدة:', 'بوابة:', 'نقاش:', 'مستخدم:', 'ويكيبيديا:',
];

const MAIN_PAGES = new Set([
  'Main_Page',
  'صفحه_اصلی',
  'صفحهٔ_اصلی',
  'الصفحة_الرئيسية',
  '-',
]);

function isArticle(title: string): boolean {
  if (MAIN_PAGES.has(title)) return false;
  return !NAMESPACES.some((prefix) => title.startsWith(prefix));
}

function readableTitle(article: string): string {
  return article.replace(/_/g, ' ');
}

/** Yesterday in UTC: the most recent day with a complete count. */
function completeDay(nowSec: number): { path: string; label: string } {
  const d = new Date((nowSec - 86_400) * 1000);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return { path: `${year}/${month}/${day}`, label: `${year}-${month}-${day}` };
}

async function readLanguage(language: string, ctx: PluginContext): Promise<RawContent[]> {
  const day = completeDay(ctx.now());
  const url = `${API}/${language}.wikipedia/all-access/${day.path}`;

  const response = await getJson<TopResponse>(url, { context: 'wikipedia', rps: 1 });
  const articles = response.items?.[0]?.articles ?? [];
  const out: RawContent[] = [];

  for (const entry of articles) {
    if (!isArticle(entry.article)) continue;
    if (out.length >= 60) break;

    out.push({
      sourceId: 'wikipedia',
      // Scoped per language and per day: the same article on two days is two
      // measurements, which is what makes day-over-day movement visible.
      externalId: `${language}:${day.label}:${entry.article}`,
      url: `https://${language}.wikipedia.org/wiki/${encodeURIComponent(entry.article)}`,
      title: readableTitle(entry.article),
      body: null,
      contentType: 'text',
      authorId: null,
      authorName: null,
      thumbnailUrl: null,
      // The day the views were counted, not the day the article was written.
      publishedAt: Math.floor(Date.parse(`${day.label}T00:00:00Z`) / 1000),
      publishedAtSource: 'api',
      metrics: metricsOf({ views: entry.views }),
      raw: { rank: entry.rank, language, day: day.label },
    });
  }

  ctx.logger.debug('language read', { language, day: day.label, items: out.length });
  return out;
}

export function createWikipediaSource(): SourcePlugin {
  return {
    id: 'wikipedia',
    name: 'Wikipedia',
    version: '1.0.0',
    capabilities: CAPABILITIES,

    validate(): ValidationResult {
      return VALID;
    },

    async discover(ctx: PluginContext): Promise<readonly RawContent[]> {
      // Follows the language preference, because what a Persian audience reads
      // is on fa.wikipedia, not en.
      const languages = ctx.languages.length > 0 ? ctx.languages.slice(0, 4) : ['en'];
      const settled = await mapLimit(languages, 2, (language) => readLanguage(language, ctx));

      const out: RawContent[] = [];
      for (const [i, result] of settled.entries()) {
        if (result.status === 'fulfilled') {
          out.push(...result.value);
          continue;
        }
        const reason = result.reason;
        // A language edition that does not exist is a configuration fact, not
        // an outage; say which one and carry on with the others.
        const missing = isRadarError(reason) && reason.details['status'] === 404;
        ctx.logger.warn(missing ? 'no Wikipedia edition for this language' : 'language failed', {
          language: languages[i],
          error: (reason as Error).message,
        });
      }
      return out;
    },

    async refresh(ctx: PluginContext) {
      // The daily totals only change when a new day is published, so a refresh
      // is simply another read.
      const items = await this.discover(ctx);
      return items.map((i) => ({ externalId: i.externalId, metrics: i.metrics }));
    },
  };
}

export { isArticle, completeDay };
