/**
 * Telegram public channel previews (t.me/s/<channel>).
 *
 * Telegram publishes a plain HTML preview of every *public* channel - the same
 * page anyone gets by opening the link in a browser without an account. It
 * carries a per-post view counter, which makes it one of the few sources
 * besides YouTube with a real reach number attached to each item.
 *
 * Scope, deliberately:
 *   - public channels only, listed explicitly by the user in TELEGRAM_CHANNELS
 *   - no login, no session, no MTProto, no private or restricted content
 *   - one request per channel per cycle, rate limited well below one per second
 *
 * If a channel is private or Telegram serves a challenge page, the adapter
 * raises a manual-intervention record instead of trying anything clever.
 */
import { config } from '../config.ts';
import { getText, mapLimit } from '../net/fetcher.ts';
import { isRadarError } from '../errors.ts';
import { decodeEntities } from '../core/xml.ts';
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
  contentTypes: ['text', 'image', 'video'],
  metrics: ['views'],
  primaryMetric: 'views',
  engagementReference: 0.05,
  hasAuthor: true,
  hasHashtags: true,
  hasCountry: false,
  supportsRefresh: true,
  supportsTrending: false,
  supportsSearch: false,
  supportsHistoricalMetrics: false,
  baseReliability: 0.8,
};

/** "14.7M" / "1.2K" / "938" -> a number. */
export function parseCompactCount(raw: string | null): number | null {
  if (raw === null) return null;
  const m = raw.trim().replace(/,/g, '').match(/^(\d+(?:\.\d+)?)\s*([KMB])?$/i);
  if (m === null) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (m[2] ?? '').toUpperCase();
  const factor = unit === 'B' ? 1e9 : unit === 'M' ? 1e6 : unit === 'K' ? 1e3 : 1;
  return Math.round(value * factor);
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n'),
  ).trim();
}

function attr(block: string, name: string): string | null {
  const m = block.match(new RegExp(`${name}="([^"]*)"`, 'i'));
  return m === null ? null : decodeEntities(m[1] as string);
}

function classify(block: string): ContentType {
  if (block.includes('tgme_widget_message_video')) return 'video';
  if (block.includes('tgme_widget_message_photo')) return 'image';
  return 'text';
}

export interface TelegramPost {
  readonly postId: string;
  readonly channel: string;
  readonly text: string;
  readonly views: number | null;
  readonly publishedAt: number | null;
  readonly author: string | null;
  readonly contentType: ContentType;
  readonly photo: string | null;
}

/** Exported so the parser can be tested against a saved fixture. */
export function parseChannelPage(html: string): TelegramPost[] {
  const posts: TelegramPost[] = [];
  const blocks = html.split('tgme_widget_message_wrap').slice(1);

  for (const block of blocks) {
    const post = attr(block, 'data-post');
    if (post === null || !post.includes('/')) continue;
    const [channel = '', postId = ''] = post.split('/');
    if (channel === '' || postId === '') continue;

    const textMatch = block.match(
      /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    );
    const text = textMatch === null ? '' : stripTags(textMatch[1] as string);

    const viewsMatch = block.match(/tgme_widget_message_views">([^<]*)</i);
    const timeMatch = block.match(/<time datetime="([^"]+)"/i);
    const authorMatch = block.match(/tgme_widget_message_from_author"[^>]*>([^<]*)</i);
    const photoMatch = block.match(/tgme_widget_message_photo_wrap[^"]*"[^>]*style="[^"]*url\('([^']+)'/i);

    const publishedAt =
      timeMatch === null ? null : Math.floor(Date.parse(timeMatch[1] as string) / 1000);

    posts.push({
      postId,
      channel,
      text,
      views: parseCompactCount(viewsMatch?.[1] ?? null),
      publishedAt: Number.isFinite(publishedAt) ? publishedAt : null,
      author: authorMatch === null ? null : decodeEntities(authorMatch[1] as string).trim(),
      contentType: classify(block),
      photo: photoMatch?.[1] ?? null,
    });
  }
  return posts;
}

function hashtagsOf(text: string): string[] {
  return [...new Set([...text.matchAll(/#([\p{L}\p{N}_]{2,40})/gu)].map((m) => (m[1] as string).toLowerCase()))];
}

async function readChannel(channel: string, ctx: PluginContext): Promise<RawContent[]> {
  const html = await getText(`https://t.me/s/${encodeURIComponent(channel)}`, {
    context: 'telegram',
    rps: 0.4,
  });
  const posts = parseChannelPage(html);
  if (posts.length === 0) {
    ctx.logger.warn('no posts parsed - channel may be private or empty', { channel });
    return [];
  }

  return posts
    .filter((p) => p.text.length > 0 || p.contentType !== 'text')
    .map((p) => ({
      sourceId: 'telegram',
      externalId: `${p.channel}/${p.postId}`,
      url: `https://t.me/${p.channel}/${p.postId}`,
      title: p.text.split('\n')[0]?.slice(0, 200) || `${p.channel} post ${p.postId}`,
      body: p.text.slice(0, 1200) || null,
      contentType: p.contentType,
      authorId: p.channel,
      authorName: p.author ?? p.channel,
      authorUrl: `https://t.me/${p.channel}`,
      thumbnailUrl: p.photo,
      publishedAt: p.publishedAt,
      publishedAtSource: 'feed' as const,
      metrics: metricsOf({ views: p.views }),
      hashtags: hashtagsOf(p.text),
    }));
}

export function createTelegramSource(): SourcePlugin {
  return {
    id: 'telegram',
    name: 'Telegram (public channels)',
    version: '1.0.0',
    capabilities: CAPABILITIES,

    validate(): ValidationResult {
      if (config.telegram.channels.length === 0) {
        return configurationRequired(
          'Set TELEGRAM_CHANNELS in .env to a comma-separated list of public channel usernames (no @).',
        );
      }
      return VALID;
    },

    async discover(ctx: PluginContext): Promise<readonly RawContent[]> {
      const settled = await mapLimit(config.telegram.channels, 2, (channel) => readChannel(channel, ctx));
      const out: RawContent[] = [];

      for (const [i, result] of settled.entries()) {
        const channel = config.telegram.channels[i] as string;
        if (result.status === 'fulfilled') {
          out.push(...result.value);
          continue;
        }
        const reason = result.reason;
        if (isRadarError(reason) && reason.kind === 'CAPTCHA_REQUIRED') {
          ctx.requireHuman(
            'CAPTCHA',
            `Telegram served a verification page for @${channel}. Open the link in a browser, complete it yourself, then re-enable the source.`,
            `https://t.me/s/${channel}`,
          );
        }
        ctx.logger.warn('channel failed', { channel, error: String(reason) });
      }
      return out;
    },

    /** The preview page always shows current view counts, so a re-read is the refresh. */
    async refresh(ctx: PluginContext) {
      const items = await this.discover(ctx);
      return items.map((i) => ({ externalId: i.externalId, metrics: i.metrics }));
    },
  };
}
