/**
 * Imgur, through the official gallery API.
 *
 * The closest thing to a pure virality source in this system. Imgur's gallery
 * is where an image either takes off within hours or disappears, and unlike
 * most platforms it publishes a real view counter per post alongside votes and
 * comments - so velocity here measures actual watching, not reactions.
 *
 * Needs a free Client ID: no account review, no billing, about two minutes.
 */
import { config } from '../config.ts';
import { getJson } from '../net/fetcher.ts';
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
import type { ContentType, RawContent } from '../core/types.ts';

const API = 'https://api.imgur.com/3';
const HELP_URL = 'https://api.imgur.com/oauth2/addclient';

const CAPABILITIES: SourceCapabilities = {
  contentTypes: ['image', 'video'],
  metrics: ['views', 'likes', 'comments', 'nativeScore'],
  primaryMetric: 'views',
  // (ups + comments) per view; 3% is very high for an image gallery.
  engagementReference: 0.03,
  hasAuthor: true,
  hasHashtags: true,
  hasCountry: false,
  supportsRefresh: true,
  supportsTrending: true,
  supportsSearch: false,
  supportsHistoricalMetrics: false,
  baseReliability: 0.9,
};

interface GalleryItem {
  id: string;
  title?: string | null;
  description?: string | null;
  link?: string;
  datetime?: number;
  account_url?: string | null;
  views?: number;
  ups?: number;
  downs?: number;
  score?: number;
  points?: number;
  comment_count?: number;
  is_album?: boolean;
  animated?: boolean;
  nsfw?: boolean | null;
  cover?: string;
  type?: string;
  tags?: { name?: string; display_name?: string }[];
  images?: { link?: string; animated?: boolean; type?: string }[];
}

function headers(): Record<string, string> {
  return { Authorization: `Client-ID ${config.imgur.clientId}` };
}

function classify(item: GalleryItem): ContentType {
  const first = item.images?.[0];
  if (item.animated === true || first?.animated === true) return 'video';
  if ((item.type ?? first?.type ?? '').startsWith('video')) return 'video';
  return 'image';
}

function thumbnailOf(item: GalleryItem): string | null {
  if (item.cover !== undefined) return `https://i.imgur.com/${item.cover}m.jpg`;
  const link = item.images?.[0]?.link;
  return link ?? null;
}

function toContent(item: GalleryItem): RawContent | null {
  const title = item.title ?? item.description ?? null;
  if (title === null || title.trim().length === 0) return null;

  return {
    sourceId: 'imgur',
    externalId: item.id,
    url: item.link ?? `https://imgur.com/gallery/${item.id}`,
    title: title.slice(0, 300),
    body: item.description?.slice(0, 800) ?? null,
    contentType: classify(item),
    authorId: item.account_url ?? null,
    authorName: item.account_url ?? null,
    authorUrl: item.account_url === null || item.account_url === undefined
      ? null
      : `https://imgur.com/user/${item.account_url}`,
    thumbnailUrl: thumbnailOf(item),
    publishedAt: item.datetime ?? null,
    publishedAtSource: 'api',
    metrics: metricsOf({
      views: intOrNull(item.views),
      likes: intOrNull(item.ups),
      comments: intOrNull(item.comment_count),
      nativeScore: intOrNull(item.points ?? item.score),
    }),
    hashtags: (item.tags ?? [])
      .map((t) => (t.name ?? '').toLowerCase())
      .filter((t) => t.length > 0)
      .slice(0, 8),
    raw: { downs: item.downs ?? null, isAlbum: item.is_album ?? false, nsfw: item.nsfw ?? null },
  };
}

export function createImgurSource(): SourcePlugin {
  return {
    id: 'imgur',
    name: 'Imgur',
    version: '1.0.0',
    capabilities: CAPABILITIES,

    validate(): ValidationResult {
      if (config.imgur.clientId === '') {
        return configurationRequired(
          'Set IMGUR_CLIENT_ID in .env. Register a free application at api.imgur.com — choose "anonymous usage without user authorisation" and copy the Client ID.',
          HELP_URL,
        );
      }
      return VALID;
    },

    async discover(ctx: PluginContext): Promise<readonly RawContent[]> {
      const out: RawContent[] = [];
      const seen = new Set<string>();

      // Two sections: `viral` is what the gallery is promoting, `rising` is
      // what is climbing but has not arrived yet - the second is where a post
      // can still be caught early.
      for (const section of config.imgur.sections) {
        try {
          const response = await getJson<{ data?: GalleryItem[] }>(
            `${API}/gallery/${section}/0.json?showViral=true&mature=${config.imgur.includeMature}`,
            { context: 'imgur', rps: 1, headers: headers() },
          );
          for (const item of response.data ?? []) {
            const content = toContent(item);
            if (content === null || seen.has(content.externalId)) continue;
            seen.add(content.externalId);
            out.push(content);
          }
        } catch (e) {
          ctx.logger.warn('section failed', { section, error: (e as Error).message });
        }
      }

      ctx.logger.debug('collected', { items: out.length });
      return out;
    },

    async refresh(ctx: PluginContext, items: readonly RefreshRequest[]): Promise<readonly RefreshResult[]> {
      const results: RefreshResult[] = [];
      // No batch endpoint, so this is one request per item and therefore
      // deliberately capped: the scheduler prioritises the fastest movers.
      for (const item of items.slice(0, 40)) {
        try {
          const response = await getJson<{ data?: GalleryItem }>(`${API}/gallery/${item.externalId}`, {
            context: 'imgur',
            rps: 2,
            retries: 0,
            headers: headers(),
          });
          const data = response.data;
          if (data === undefined) continue;
          results.push({
            externalId: item.externalId,
            metrics: metricsOf({
              views: intOrNull(data.views),
              likes: intOrNull(data.ups),
              comments: intOrNull(data.comment_count),
              nativeScore: intOrNull(data.points ?? data.score),
            }),
          });
        } catch {
          // A post removed from the gallery simply stops updating.
        }
      }
      if (results.length > 0) ctx.logger.debug('refreshed', { items: results.length });
      return results;
    },
  };
}
