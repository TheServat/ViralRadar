/**
 * Twitch, through the official Helix API.
 *
 * The only source here that measures attention *as it happens*: viewer_count
 * is people watching right now, not a total accumulated since publication.
 * That makes velocity mean something different and useful - a stream going
 * from two hundred to nine thousand viewers in an hour is a live event, and
 * nothing else in this system can see that.
 *
 * Needs a free application: client id and secret, no review, no billing. The
 * token is the app-only client-credentials kind, so no user ever logs in.
 */
import { config } from '../config.ts';
import { getJson, request } from '../net/fetcher.ts';
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

const HELIX = 'https://api.twitch.tv/helix';
const HELP_URL = 'https://dev.twitch.tv/console/apps/create';

const CAPABILITIES: SourceCapabilities = {
  contentTypes: ['video'],
  metrics: ['views'],
  primaryMetric: 'views',
  engagementReference: 0.05,
  hasAuthor: true,
  hasHashtags: true,
  hasCountry: true,
  supportsRefresh: true,
  supportsTrending: true,
  supportsSearch: false,
  supportsHistoricalMetrics: false,
  baseReliability: 0.95,
};

interface Stream {
  id: string;
  user_id?: string;
  user_login?: string;
  user_name?: string;
  game_id?: string;
  game_name?: string;
  title?: string;
  viewer_count?: number;
  started_at?: string;
  language?: string;
  thumbnail_url?: string;
  tags?: string[];
  is_mature?: boolean;
}

// ── Authentication ─────────────────────────────────────────────────────────

let token: { value: string; expiresAt: number } | null = null;

async function accessToken(ctx: PluginContext): Promise<string> {
  const now = Date.now();
  if (token !== null && token.expiresAt > now + 60_000) return token.value;

  const body = new URLSearchParams({
    client_id: config.twitch.clientId,
    client_secret: config.twitch.clientSecret,
    grant_type: 'client_credentials',
  }).toString();

  const res = await request('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    context: 'twitch-auth',
    rps: 0.5,
    retries: 1,
  });

  const parsed = JSON.parse(res.body) as { access_token?: string; expires_in?: number };
  if (parsed.access_token === undefined) {
    throw new Error('Twitch returned no access token; check the client id and secret');
  }
  token = { value: parsed.access_token, expiresAt: now + (parsed.expires_in ?? 3600) * 1000 };
  ctx.logger.debug('token acquired');
  return token.value;
}

function headers(bearer: string): Record<string, string> {
  return { 'Client-Id': config.twitch.clientId, Authorization: `Bearer ${bearer}` };
}

// ── Mapping ────────────────────────────────────────────────────────────────

function thumbnailOf(stream: Stream): string | null {
  // Twitch returns a template with size placeholders.
  return stream.thumbnail_url?.replace('{width}', '440').replace('{height}', '248') ?? null;
}

function toContent(stream: Stream): RawContent | null {
  if (stream.user_login === undefined) return null;
  return {
    sourceId: 'twitch',
    // Keyed on the channel, not the stream: one channel's audience over time is
    // the series worth watching, and a new stream id every session would reset
    // it to nothing each time they go live.
    externalId: stream.user_login,
    url: `https://www.twitch.tv/${stream.user_login}`,
    title: stream.title ?? `${stream.user_name ?? stream.user_login} live`,
    body: stream.game_name ?? null,
    contentType: 'video',
    authorId: stream.user_login,
    authorName: stream.user_name ?? stream.user_login,
    authorUrl: `https://www.twitch.tv/${stream.user_login}`,
    thumbnailUrl: thumbnailOf(stream),
    publishedAt: stream.started_at === undefined ? null : Math.floor(Date.parse(stream.started_at) / 1000),
    publishedAtSource: 'api',
    // Concurrent viewers: people watching at this moment, not a running total.
    metrics: metricsOf({ views: intOrNull(stream.viewer_count) }),
    hashtags: [
      ...(stream.tags ?? []).slice(0, 6).map((t) => t.toLowerCase()),
      ...(stream.game_name === undefined ? [] : [stream.game_name.toLowerCase()]),
    ],
    raw: { game: stream.game_name ?? null, language: stream.language ?? null, streamId: stream.id },
  };
}

async function readStreams(bearer: string, language: string | null, ctx: PluginContext): Promise<Stream[]> {
  const params = new URLSearchParams({ first: '100' });
  if (language !== null) params.set('language', language);

  const response = await getJson<{ data?: Stream[] }>(`${HELIX}/streams?${params.toString()}`, {
    context: 'twitch',
    rps: 2,
    headers: headers(bearer),
  });
  ctx.logger.debug('streams read', { language: language ?? 'any', items: response.data?.length ?? 0 });
  return response.data ?? [];
}

export function createTwitchSource(): SourcePlugin {
  return {
    id: 'twitch',
    name: 'Twitch',
    version: '1.0.0',
    capabilities: CAPABILITIES,

    validate(): ValidationResult {
      if (config.twitch.clientId === '' || config.twitch.clientSecret === '') {
        return configurationRequired(
          'Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env. Register a free application at dev.twitch.tv — category "Application Integration", OAuth redirect http://localhost.',
          HELP_URL,
        );
      }
      return VALID;
    },

    async discover(ctx: PluginContext): Promise<readonly RawContent[]> {
      const bearer = await accessToken(ctx);
      const seen = new Set<string>();
      const out: RawContent[] = [];

      // The global top streams, plus the configured languages so a smaller
      // local scene is not buried under the English-speaking front page.
      const passes: (string | null)[] = [null, ...config.twitch.languages];

      for (const language of passes) {
        try {
          for (const stream of await readStreams(bearer, language, ctx)) {
            const content = toContent(stream);
            if (content === null || seen.has(content.externalId)) continue;
            seen.add(content.externalId);
            out.push(content);
          }
        } catch (e) {
          ctx.logger.warn('stream list failed', { language, error: (e as Error).message });
        }
      }
      return out;
    },

    async refresh(ctx: PluginContext, items: readonly RefreshRequest[]): Promise<readonly RefreshResult[]> {
      const bearer = await accessToken(ctx);
      const results: RefreshResult[] = [];

      // Helix takes 100 logins per request.
      for (let i = 0; i < items.length; i += 100) {
        const chunk = items.slice(i, i + 100);
        const params = chunk.map((c) => `user_login=${encodeURIComponent(c.externalId)}`).join('&');
        try {
          const response = await getJson<{ data?: Stream[] }>(`${HELIX}/streams?first=100&${params}`, {
            context: 'twitch',
            rps: 2,
            headers: headers(bearer),
          });
          const live = new Set<string>();
          for (const stream of response.data ?? []) {
            if (stream.user_login === undefined) continue;
            live.add(stream.user_login);
            results.push({
              externalId: stream.user_login,
              metrics: metricsOf({ views: intOrNull(stream.viewer_count) }),
            });
          }
          // A channel that has gone offline reports zero watching, which is a
          // real measurement - it is what makes the decline visible.
          for (const item of chunk) {
            if (!live.has(item.externalId)) {
              results.push({ externalId: item.externalId, metrics: metricsOf({ views: 0 }) });
            }
          }
        } catch (e) {
          ctx.logger.warn('refresh chunk failed', { error: (e as Error).message });
        }
      }
      return results;
    },
  };
}
