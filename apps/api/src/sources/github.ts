/**
 * GitHub, through the public search API.
 *
 * There is no official "trending" endpoint, so this asks the question trending
 * actually answers: which repositories created recently have gathered the most
 * stars. Stars are a real counter that moves, which makes velocity meaningful
 * here in a way a scraped trending page would not be.
 *
 * Unauthenticated search allows 10 requests a minute, which is far more than
 * this needs. A token raises that but is not required.
 */
import { getJson } from '../net/fetcher.ts';
import { config } from '../config.ts';
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
import type { RawContent } from '../core/types.ts';

const API = 'https://api.github.com';

const CAPABILITIES: SourceCapabilities = {
  contentTypes: ['link'],
  metrics: ['nativeScore', 'shares', 'comments'],
  primaryMetric: 'nativeScore',
  // forks per star; 20% is a heavily reused project.
  engagementReference: 0.2,
  hasAuthor: true,
  hasHashtags: true,
  hasCountry: false,
  supportsRefresh: true,
  supportsTrending: true,
  supportsSearch: true,
  supportsHistoricalMetrics: false,
  baseReliability: 0.95,
};

interface Repo {
  id: number;
  full_name: string;
  html_url: string;
  description?: string | null;
  language?: string | null;
  topics?: string[];
  created_at?: string;
  pushed_at?: string;
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  owner?: { login?: string; html_url?: string; avatar_url?: string };
}

function headers(): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(config.github.token === '' ? {} : { Authorization: `Bearer ${config.github.token}` }),
  };
}

function toContent(repo: Repo): RawContent {
  return {
    sourceId: 'github',
    externalId: String(repo.id),
    url: repo.html_url,
    title: repo.full_name,
    body: repo.description ?? null,
    contentType: 'link',
    authorId: repo.owner?.login ?? null,
    authorName: repo.owner?.login ?? null,
    authorUrl: repo.owner?.html_url ?? null,
    thumbnailUrl: repo.owner?.avatar_url ?? null,
    publishedAt: repo.created_at === undefined ? null : Math.floor(Date.parse(repo.created_at) / 1000),
    publishedAtSource: 'api',
    metrics: metricsOf({
      nativeScore: intOrNull(repo.stargazers_count),
      shares: intOrNull(repo.forks_count),
      comments: intOrNull(repo.open_issues_count),
    }),
    hashtags: [
      ...(repo.topics ?? []).slice(0, 8),
      ...(repo.language === null || repo.language === undefined ? [] : [repo.language.toLowerCase()]),
    ],
    raw: { language: repo.language ?? null, pushedAt: repo.pushed_at ?? null },
  };
}

/** ISO date `windowDays` ago, which is all the search query needs. */
function since(nowSec: number, windowDays: number): string {
  return new Date((nowSec - windowDays * 86_400) * 1000).toISOString().slice(0, 10);
}

export function createGitHubSource(): SourcePlugin {
  return {
    id: 'github',
    name: 'GitHub',
    version: '1.0.0',
    capabilities: CAPABILITIES,

    validate(): ValidationResult {
      return VALID;
    },

    async discover(ctx: PluginContext): Promise<readonly RawContent[]> {
      const out: RawContent[] = [];
      const seen = new Set<string>();

      // Two windows on purpose: the short one catches what is exploding this
      // week, the longer one catches a project that took a month to be noticed.
      for (const days of config.github.windowDays) {
        const query = `created:>${since(ctx.now(), days)}`;
        const url =
          `${API}/search/repositories?q=${encodeURIComponent(query)}` +
          `&sort=stars&order=desc&per_page=${config.github.perPage}`;
        try {
          const response = await getJson<{ items?: Repo[] }>(url, {
            context: 'github',
            rps: 0.2,
            headers: headers(),
          });
          for (const repo of response.items ?? []) {
            const content = toContent(repo);
            if (seen.has(content.externalId)) continue;
            seen.add(content.externalId);
            out.push(content);
          }
        } catch (e) {
          ctx.logger.warn('search failed', { days, error: (e as Error).message });
        }
      }

      ctx.logger.debug('collected', { items: out.length });
      return out;
    },

    async refresh(ctx: PluginContext, items: readonly RefreshRequest[]): Promise<readonly RefreshResult[]> {
      const results: RefreshResult[] = [];
      // Search is the cheapest way to re-read many at once: one request per
      // batch of ids rather than one request per repository.
      for (let i = 0; i < items.length; i += 40) {
        const chunk = items.slice(i, i + 40);
        const query = chunk.map((c) => `repo:${c.url.replace('https://github.com/', '')}`).join(' ');
        try {
          const response = await getJson<{ items?: Repo[] }>(
            `${API}/search/repositories?q=${encodeURIComponent(query)}&per_page=100`,
            { context: 'github', rps: 0.2, headers: headers() },
          );
          for (const repo of response.items ?? []) {
            results.push({
              externalId: String(repo.id),
              metrics: metricsOf({
                nativeScore: intOrNull(repo.stargazers_count),
                shares: intOrNull(repo.forks_count),
                comments: intOrNull(repo.open_issues_count),
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
