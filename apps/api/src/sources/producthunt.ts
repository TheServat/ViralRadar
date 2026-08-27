/**
 * Product Hunt, through the official GraphQL API.
 *
 * A launch either gathers votes in its first day or it does not, and the vote
 * count is public and moves by the hour - which makes this one of the cleaner
 * velocity signals available. Useful if you make anything about products,
 * tools or startups.
 *
 * Needs a developer token: create an application, then generate a token for
 * your own account. No review, no billing.
 */
import { config } from '../config.ts';
import { request } from '../net/fetcher.ts';
import { err } from '../errors.ts';
import {
  configurationRequired,
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

const API = 'https://api.producthunt.com/v2/api/graphql';
const HELP_URL = 'https://www.producthunt.com/v2/oauth/applications';

const CAPABILITIES: SourceCapabilities = {
  contentTypes: ['link'],
  metrics: ['nativeScore', 'comments'],
  primaryMetric: 'nativeScore',
  // comments per vote; 15% is a launch people are actually discussing.
  engagementReference: 0.15,
  hasAuthor: true,
  hasHashtags: true,
  hasCountry: false,
  supportsRefresh: true,
  supportsTrending: true,
  supportsSearch: false,
  supportsHistoricalMetrics: false,
  baseReliability: 0.9,
};

interface Post {
  id: string;
  name?: string;
  tagline?: string;
  description?: string | null;
  url?: string;
  website?: string | null;
  votesCount?: number;
  commentsCount?: number;
  createdAt?: string;
  thumbnail?: { url?: string } | null;
  user?: { name?: string; username?: string } | null;
  topics?: { edges?: { node?: { name?: string } }[] };
}

interface GraphQlResponse<T> {
  data?: T;
  errors?: { message?: string }[];
}

/**
 * One query, used for both discovery and refresh.
 *
 * `order: VOTES` with a date filter is what "trending today" actually means
 * here - the API has no trending endpoint of its own.
 */
const POSTS_QUERY = `
query Posts($postedAfter: DateTime, $first: Int!) {
  posts(order: VOTES, postedAfter: $postedAfter, first: $first) {
    edges {
      node {
        id name tagline description url website votesCount commentsCount createdAt
        thumbnail { url }
        user { name username }
        topics(first: 5) { edges { node { name } } }
      }
    }
  }
}`;

async function query<T>(graphql: string, variables: Record<string, unknown>): Promise<T> {
  const res = await request(API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.productHunt.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query: graphql, variables }),
    context: 'producthunt',
    rps: 0.5,
    retries: 1,
  });

  const parsed = JSON.parse(res.body) as GraphQlResponse<T>;
  // GraphQL answers 200 with an errors array, so a failure has to be read out
  // of the body rather than the status code.
  if (parsed.errors !== undefined && parsed.errors.length > 0) {
    throw err.unavailable(`Product Hunt: ${parsed.errors[0]?.message ?? 'query failed'}`);
  }
  if (parsed.data === undefined) throw err.parsing('Product Hunt returned no data');
  return parsed.data;
}

function toContent(post: Post): RawContent | null {
  if (post.name === undefined) return null;
  return {
    sourceId: 'producthunt',
    externalId: post.id,
    url: post.url ?? `https://www.producthunt.com/posts/${post.id}`,
    title: post.name,
    body: post.tagline ?? post.description?.slice(0, 600) ?? null,
    contentType: 'link',
    authorId: post.user?.username ?? null,
    authorName: post.user?.name ?? post.user?.username ?? null,
    authorUrl: post.user?.username === undefined
      ? null
      : `https://www.producthunt.com/@${post.user.username}`,
    thumbnailUrl: post.thumbnail?.url ?? null,
    publishedAt: post.createdAt === undefined ? null : Math.floor(Date.parse(post.createdAt) / 1000),
    publishedAtSource: 'api',
    metrics: metricsOf({
      nativeScore: intOrNull(post.votesCount),
      comments: intOrNull(post.commentsCount),
    }),
    hashtags: (post.topics?.edges ?? [])
      .map((e) => (e.node?.name ?? '').toLowerCase())
      .filter((t) => t.length > 0),
    raw: { website: post.website ?? null },
  };
}

export function createProductHuntSource(): SourcePlugin {
  return {
    id: 'producthunt',
    name: 'Product Hunt',
    version: '1.0.0',
    capabilities: CAPABILITIES,

    validate(): ValidationResult {
      if (config.productHunt.token === '') {
        return configurationRequired(
          'Set PRODUCTHUNT_TOKEN in .env. Create an application at producthunt.com/v2/oauth/applications, then use "Create developer token" on that page.',
          HELP_URL,
        );
      }
      return VALID;
    },

    async discover(ctx: PluginContext): Promise<readonly RawContent[]> {
      const postedAfter = new Date((ctx.now() - config.productHunt.windowDays * 86_400) * 1000).toISOString();

      const data = await query<{ posts?: { edges?: { node?: Post }[] } }>(POSTS_QUERY, {
        postedAfter,
        first: 50,
      });

      const out: RawContent[] = [];
      for (const edge of data.posts?.edges ?? []) {
        if (edge.node === undefined) continue;
        const content = toContent(edge.node);
        if (content !== null) out.push(content);
      }
      ctx.logger.debug('collected', { items: out.length, since: postedAfter.slice(0, 10) });
      return out;
    },

    async refresh(ctx: PluginContext, items: readonly RefreshRequest[]): Promise<readonly RefreshResult[]> {
      if (items.length === 0) return [];
      // The same ranked query returns current counts for everything recent, so
      // one request refreshes the whole set rather than one per item.
      try {
        const postedAfter = new Date((ctx.now() - config.productHunt.windowDays * 86_400) * 1000).toISOString();
        const data = await query<{ posts?: { edges?: { node?: Post }[] } }>(POSTS_QUERY, {
          postedAfter,
          first: 50,
        });

        const wanted = new Set(items.map((i) => i.externalId));
        const results: RefreshResult[] = [];
        for (const edge of data.posts?.edges ?? []) {
          const post = edge.node;
          if (post === undefined || !wanted.has(post.id)) continue;
          results.push({
            externalId: post.id,
            metrics: metricsOf({
              nativeScore: intOrNull(post.votesCount),
              comments: intOrNull(post.commentsCount),
            }),
          });
        }
        return results;
      } catch (e) {
        ctx.logger.warn('refresh failed', { error: (e as Error).message });
        return [];
      }
    },
  };
}
