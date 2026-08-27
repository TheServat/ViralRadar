/**
 * Configuration. Loaded once, validated once, frozen.
 * Fails fast and loudly on anything that cannot possibly work.
 */
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The repository root, not the app root: `.env` and `data/` are shared by the
 * whole project and stay at the top level, while the code lives in apps/api.
 */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const envFile = resolve(ROOT, '.env');
// Real environment variables always win over the file, so a test can pin the
// configuration it depends on by setting them before importing this module.
// RADAR_NO_ENV_FILE ignores the file entirely, which is what the test suite
// does: otherwise the developer's own .env would decide whether tests pass.
if (existsSync(envFile) && process.env['RADAR_NO_ENV_FILE'] !== '1') {
  process.loadEnvFile(envFile);
}

const problems: string[] = [];

function str(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function num(key: string, fallback: number, min = -Infinity, max = Infinity): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    problems.push(`${key}="${raw}" is not a number`);
    return fallback;
  }
  if (v < min || v > max) {
    problems.push(`${key}=${v} is outside the allowed range [${min}, ${max}]`);
    return fallback;
  }
  return v;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function list(key: string, fallback: string[]): string[] {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export const NETWORK_MODES = ['DIRECT', 'HTTP_PROXY', 'SOCKS5'] as const;
export type NetworkMode = (typeof NETWORK_MODES)[number];

const networkMode = str('NETWORK_MODE', 'DIRECT').toUpperCase() as NetworkMode;
if (!NETWORK_MODES.includes(networkMode)) {
  problems.push(`NETWORK_MODE must be one of ${NETWORK_MODES.join(' | ')}`);
}

const weights = {
  velocity: num('W_VELOCITY', 0.3, 0, 1),
  acceleration: num('W_ACCELERATION', 0.3, 0, 1),
  anomaly: num('W_ANOMALY', 0.15, 0, 1),
  engagement: num('W_ENGAGEMENT', 0.1, 0, 1),
  crossSource: num('W_CROSS_SOURCE', 0.1, 0, 1),
  freshness: num('W_FRESHNESS', 0.05, 0, 1),
};
const weightSum = Object.values(weights).reduce((a, b) => a + b, 0);
if (weightSum <= 0) problems.push('scoring weights (W_*) sum to zero — nothing could ever be scored');

/**
 * An IANA timezone name, verified against the platform's own database.
 *
 * A name the runtime does not know would otherwise throw once per formatted
 * timestamp, deep inside a report. Failing over to the machine zone here, with
 * a warning, keeps a typo from taking a page down.
 */
function resolveTimezone(name: string): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (name.trim() === '') return fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return name;
  } catch {
    process.emitWarning(`TIMEZONE "${name}" is not a known zone; using ${fallback}`);
    return fallback;
  }
}

export const config = Object.freeze({
  root: ROOT,

  server: Object.freeze({
    port: num('PORT', 7788, 1, 65535),
    host: str('HOST', '127.0.0.1'),
    apiToken: str('API_TOKEN', ''),
    /**
     * Gates the Settings screen only. Empty means open, which is the default
     * and what a single-user machine usually wants.
     */
    settingsPassword: str('SETTINGS_PASSWORD', ''),
  }),

  db: Object.freeze({
    path: resolve(ROOT, str('DB_PATH', './data/radar.db')),
    retentionDays: num('RETENTION_DAYS', 30, 1, 3650),
    trendHistoryDays: num('TREND_HISTORY_DAYS', 365, 1, 3650),
  }),

  regions: list('REGIONS', ['US']).map((r) => r.toUpperCase()),
  languages: list('LANGUAGES', []).map((l) => l.toLowerCase()),
  /**
   * The clock "best time to post" is expressed in.
   *
   * Defaults to the machine's own zone, which is often wrong — a server, a
   * VPS, or simply a laptop that was set up elsewhere. It is an IANA name
   * rather than an offset so that daylight saving is handled by the platform
   * instead of by arithmetic here, and the resolved value is shown on the page
   * so a wrong one is visible rather than silently shifting every hour.
   */
  timezone: resolveTimezone(str('TIMEZONE', '')),

  schedule: Object.freeze({
    discoveryMin: num('DISCOVERY_INTERVAL_MIN', 20, 1, 1440),
    hotRefreshMin: num('HOT_REFRESH_MIN', 5, 1, 1440),
    normalRefreshMin: num('NORMAL_REFRESH_MIN', 60, 1, 1440),
    analyzeMin: num('ANALYZE_INTERVAL_MIN', 10, 1, 1440),
    runOnStart: bool('RUN_ON_START', true),
  }),

  sourcesEnabled: list('SOURCES_ENABLED', [
    'googletrends',
    'hackernews',
    'rss',
    'youtube',
    'reddit',
    'telegram',
  ]),

  youtube: Object.freeze({
    apiKey: str('YOUTUBE_API_KEY', ''),
    watchChannels: list('YOUTUBE_WATCH_CHANNELS', []),
    /**
     * Broad seed words for open discovery. These are not topics to look for -
     * they are the widest net the API allows, since `search` requires some
     * query string. Any channel can turn up, which is the point.
     */
    searchTerms: list('YOUTUBE_SEARCH_TERMS', [
      'فارسی',
      'ایرانی',
      'کلیپ',
      'طنز',
      'ولاگ',
      'موزیک',
      'بازی',
      'آشپزی',
      'آموزش',
      'چالش',
      'ترفند',
      'مصاحبه',
    ]),
    searchesPerRun: num('YOUTUBE_SEARCHES_PER_RUN', 2, 0, 20),
    /** Search costs 100 units of the 10,000/day free quota; this caps the spend. */
    quotaBudget: num('YOUTUBE_QUOTA_BUDGET', 8000, 100, 1_000_000),
    searchWindowHours: num('YOUTUBE_SEARCH_WINDOW_HOURS', 48, 1, 720),
  }),

  reddit: Object.freeze({
    clientId: str('REDDIT_CLIENT_ID', ''),
    clientSecret: str('REDDIT_CLIENT_SECRET', ''),
    userAgent: str('REDDIT_USER_AGENT', 'viral-radar/1.0 (personal research)'),
    feeds: list('REDDIT_FEEDS', ['r/all/rising', 'r/popular/hot', 'r/all/top?t=hour']),
  }),

  mastodon: Object.freeze({
    /**
     * Servers to read trends from. Large, general-purpose instances see the
     * widest slice of the network; adding a topical one narrows the view.
     */
    hosts: list('MASTODON_HOSTS', ['mastodon.social', 'mstdn.social', 'fosstodon.org']),
  }),

  bluesky: Object.freeze({
    /** AT-URIs of public feed generators. The defaults are Bluesky's own. */
    feeds: list('BLUESKY_FEEDS', [
      'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot',
      'at://did:plc:qiknc4t5rq7yngvz7g4aezq7/app.bsky.feed.generator/hot-classic',
    ]),
  }),

  github: Object.freeze({
    /** Optional: raises the rate limit. Nothing here requires it. */
    token: str('GITHUB_TOKEN', ''),
    windowDays: list('GITHUB_WINDOW_DAYS', ['7', '30']).map(Number).filter((n) => Number.isFinite(n)),
    perPage: num('GITHUB_PER_PAGE', 40, 1, 100),
  }),

  charts: Object.freeze({
    steam: bool('CHARTS_STEAM', true),
    spotify: bool('CHARTS_SPOTIFY', true),
    /** Apple storefronts. Not every country has one. */
    appleCountries: list('APPLE_COUNTRIES', ['us']),
    /** media/chart pairs, e.g. podcasts/top or music/most-played. */
    appleCharts: list('APPLE_CHARTS', ['podcasts/top', 'music/most-played', 'apps/top-free']),
  }),

  notify: Object.freeze({
    /** Which channels to use. Empty means notifications are off. */
    channels: list('NOTIFY_CHANNELS', []),
    telegramBotToken: str('NOTIFY_TELEGRAM_BOT_TOKEN', ''),
    telegramChatId: str('NOTIFY_TELEGRAM_CHAT_ID', ''),
    webhookUrl: str('NOTIFY_WEBHOOK_URL', ''),
    /** Which kinds of event are worth interrupting for. */
    kinds: list('NOTIFY_KINDS', ['viral', 'breakout', 'intervention']),
    minScore: num('NOTIFY_MIN_SCORE', 65, 0, 100),
    /** A high score on one observation is not worth waking anyone for. */
    minConfidence: num('NOTIFY_MIN_CONFIDENCE', 0.5, 0, 1),
    maxPerRun: num('NOTIFY_MAX_PER_RUN', 8, 1, 50),
    intervalMin: num('NOTIFY_INTERVAL_MIN', 10, 1, 1440),
    /** Local hours [from, to). Equal values disable the window. */
    quietHours: (() => {
      const raw = list('NOTIFY_QUIET_HOURS', ['0', '0']).map(Number);
      const from = Number.isFinite(raw[0]) ? Math.min(23, Math.max(0, raw[0] as number)) : 0;
      const to = Number.isFinite(raw[1]) ? Math.min(23, Math.max(0, raw[1] as number)) : 0;
      return [from, to] as const;
    })(),
  }),

  imgur: Object.freeze({
    clientId: str('IMGUR_CLIENT_ID', ''),
    /** `viral` is what the gallery promotes; `rising` is what is climbing. */
    sections: list('IMGUR_SECTIONS', ['viral', 'rising']),
    includeMature: bool('IMGUR_INCLUDE_MATURE', false),
  }),

  twitch: Object.freeze({
    clientId: str('TWITCH_CLIENT_ID', ''),
    clientSecret: str('TWITCH_CLIENT_SECRET', ''),
    /** Extra language passes, so a local scene is not buried under the global top. */
    languages: list('TWITCH_LANGUAGES', []),
  }),

  tmdb: Object.freeze({
    apiKey: str('TMDB_API_KEY', ''),
    language: str('TMDB_LANGUAGE', 'en-US'),
  }),

  productHunt: Object.freeze({
    token: str('PRODUCTHUNT_TOKEN', ''),
    windowDays: num('PRODUCTHUNT_WINDOW_DAYS', 2, 1, 30),
  }),

  giphy: Object.freeze({
    apiKey: str('GIPHY_API_KEY', ''),
    /** g, pg, pg-13 or r. */
    rating: str('GIPHY_RATING', 'pg-13'),
  }),

  rss: Object.freeze({
    feeds: list('RSS_FEEDS', [
      'https://feeds.bbci.co.uk/news/rss.xml',
      'https://hnrss.org/frontpage',
      'https://www.theverge.com/rss/index.xml',
    ]),
  }),

  telegram: Object.freeze({
    channels: list('TELEGRAM_CHANNELS', []).map((c) => c.replace(/^@/, '')),
  }),

  net: Object.freeze({
    mode: networkMode,
    proxyUrl: str('PROXY_URL', ''),
    timeoutMs: num('HTTP_TIMEOUT_MS', 15_000, 1000, 120_000),
    maxRetries: num('HTTP_MAX_RETRIES', 3, 0, 10),
    hostRps: num('HOST_RATE_LIMIT_RPS', 1, 0.05, 50),
  }),

  scoring: Object.freeze({
    weights: Object.freeze(weights),
    maxAgeHours: num('MAX_AGE_HOURS', 72, 1, 720),
    freshnessHalfLifeHours: num('FRESHNESS_HALFLIFE_HOURS', 8, 0.25, 240),
    /** Bump when the formula changes so stored scores stay reproducible. */
    version: 1,
  }),

  ai: Object.freeze({
    provider: str('AI_PROVIDER', '').toLowerCase(),
    baseUrl: str('AI_BASE_URL', ''),
    apiKey: str('AI_API_KEY', ''),
    model: str('AI_MODEL', ''),
  }),
});

export type Config = typeof config;

if ((config.net.mode === 'HTTP_PROXY' || config.net.mode === 'SOCKS5') && !config.net.proxyUrl) {
  problems.push(`NETWORK_MODE=${config.net.mode} requires PROXY_URL to be set`);
}

if (problems.length > 0) {
  console.error('\n  Invalid configuration:\n');
  for (const p of problems) console.error(`   - ${p}`);
  console.error('\n  Fix .env (see .env.example) and start again.\n');
  process.exit(1);
}

/** True when the source id appears in SOURCES_ENABLED. */
export function isSourceEnabled(id: string): boolean {
  return config.sourcesEnabled.includes(id);
}
