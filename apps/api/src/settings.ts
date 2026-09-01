/**
 * The editable settings surface.
 *
 * The dashboard can write `.env`, which means this file decides exactly what a
 * browser is allowed to change. Everything is whitelisted and typed: a key that
 * is not described here cannot be written, whatever the request says.
 *
 * Secret values are never sent back to the client. The UI is told whether a
 * secret is set, never what it is.
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, reloadConfig } from './config.ts';
import { err } from './errors.ts';

const ENV_PATH = resolve(ROOT, '.env');

export type FieldKind = 'text' | 'number' | 'boolean' | 'secret' | 'list' | 'select';

export interface SettingField {
  readonly key: string;
  readonly kind: FieldKind;
  readonly group: string;
  /** Translation key; the UI holds the wording, not this file. */
  readonly label: string;
  readonly help: string;
  readonly placeholder?: string;
  readonly options?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  /** Where to go to obtain the value, for credentials. */
  readonly helpUrl?: string;
  /** Marks the fields the first-run wizard walks through. */
  readonly onboarding?: boolean;
  readonly defaultValue: string;
}

export const SETTING_FIELDS: readonly SettingField[] = [
  // ── What you follow ──────────────────────────────────────────────────────
  {
    key: 'REGIONS',
    kind: 'list',
    group: 'audience',
    label: 'settings.regions',
    help: 'settings.regionsHelp',
    placeholder: 'IR,US',
    defaultValue: 'US',
    onboarding: true,
  },
  {
    key: 'TRENDS_REGIONS',
    kind: 'list',
    group: 'audience',
    label: 'settings.trendsRegions',
    help: 'settings.trendsRegionsHelp',
    placeholder: 'all',
    defaultValue: '',
  },
  {
    key: 'LANGUAGES',
    kind: 'list',
    group: 'audience',
    label: 'settings.languages',
    help: 'settings.languagesHelp',
    placeholder: 'fa,en',
    defaultValue: '',
    onboarding: true,
  },
  {
    key: 'SOURCES_ENABLED',
    kind: 'list',
    group: 'audience',
    label: 'settings.sourcesEnabled',
    help: 'settings.sourcesEnabledHelp',
    // Must match `config.ts` and `.env.example`. See the note there: these
    // were three different lists, and the two install paths ran two different
    // sets of sources.
    defaultValue: 'googletrends,googlenews,wikipedia,hackernews,rss,youtube,reddit,telegram,mastodon,bluesky,github,charts',
    onboarding: true,
  },

  // ── Credentials ──────────────────────────────────────────────────────────
  {
    key: 'YOUTUBE_API_KEY',
    kind: 'secret',
    group: 'credentials',
    label: 'settings.youtubeKey',
    help: 'settings.youtubeKeyHelp',
    helpUrl: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com',
    defaultValue: '',
    onboarding: true,
  },
  {
    key: 'REDDIT_CLIENT_ID',
    kind: 'text',
    group: 'credentials',
    label: 'settings.redditId',
    help: 'settings.redditIdHelp',
    helpUrl: 'https://www.reddit.com/prefs/apps',
    defaultValue: '',
    onboarding: true,
  },
  {
    key: 'REDDIT_CLIENT_SECRET',
    kind: 'secret',
    group: 'credentials',
    label: 'settings.redditSecret',
    help: 'settings.redditSecretHelp',
    helpUrl: 'https://www.reddit.com/prefs/apps',
    defaultValue: '',
    onboarding: true,
  },

  {
    key: 'SETTINGS_PASSWORD',
    kind: 'secret',
    group: 'credentials',
    label: 'settings.settingsPassword',
    help: 'settings.settingsPasswordHelp',
    defaultValue: '',
  },
  {
    key: 'IMGUR_CLIENT_ID',
    kind: 'secret',
    group: 'credentials',
    label: 'settings.imgurId',
    help: 'settings.imgurIdHelp',
    helpUrl: 'https://api.imgur.com/oauth2/addclient',
    defaultValue: '',
  },
  {
    key: 'TWITCH_CLIENT_ID',
    kind: 'text',
    group: 'credentials',
    label: 'settings.twitchId',
    help: 'settings.twitchIdHelp',
    helpUrl: 'https://dev.twitch.tv/console/apps/create',
    defaultValue: '',
  },
  {
    key: 'TWITCH_CLIENT_SECRET',
    kind: 'secret',
    group: 'credentials',
    label: 'settings.twitchSecret',
    help: 'settings.twitchSecretHelp',
    helpUrl: 'https://dev.twitch.tv/console/apps/create',
    defaultValue: '',
  },
  {
    key: 'TMDB_API_KEY',
    kind: 'secret',
    group: 'credentials',
    label: 'settings.tmdbKey',
    help: 'settings.tmdbKeyHelp',
    helpUrl: 'https://www.themoviedb.org/settings/api',
    defaultValue: '',
  },
  {
    key: 'PRODUCTHUNT_TOKEN',
    kind: 'secret',
    group: 'credentials',
    label: 'settings.productHuntToken',
    help: 'settings.productHuntTokenHelp',
    helpUrl: 'https://www.producthunt.com/v2/oauth/applications',
    defaultValue: '',
  },
  {
    key: 'GIPHY_API_KEY',
    kind: 'secret',
    group: 'credentials',
    label: 'settings.giphyKey',
    help: 'settings.giphyKeyHelp',
    helpUrl: 'https://developers.giphy.com/dashboard/',
    defaultValue: '',
  },

  {
    key: 'TIMEZONE',
    kind: 'text',
    group: 'audience',
    label: 'settings.timezone',
    help: 'settings.timezoneHelp',
    placeholder: 'Asia/Tehran',
    defaultValue: '',
  },

  // ── Notifications ────────────────────────────────────────────────────────
  {
    key: 'NOTIFY_CHANNELS',
    kind: 'list',
    group: 'notify',
    label: 'settings.notifyChannels',
    help: 'settings.notifyChannelsHelp',
    placeholder: 'telegram,webhook',
    defaultValue: '',
  },
  {
    key: 'NOTIFY_TELEGRAM_BOT_TOKEN',
    kind: 'secret',
    group: 'notify',
    label: 'settings.notifyBotToken',
    help: 'settings.notifyBotTokenHelp',
    helpUrl: 'https://t.me/BotFather',
    defaultValue: '',
  },
  {
    key: 'NOTIFY_TELEGRAM_CHAT_ID',
    kind: 'text',
    group: 'notify',
    label: 'settings.notifyChatId',
    help: 'settings.notifyChatIdHelp',
    helpUrl: 'https://t.me/userinfobot',
    defaultValue: '',
  },
  {
    key: 'NOTIFY_WEBHOOK_URL',
    kind: 'secret',
    group: 'notify',
    label: 'settings.notifyWebhook',
    help: 'settings.notifyWebhookHelp',
    defaultValue: '',
  },
  {
    key: 'NOTIFY_KINDS',
    kind: 'list',
    group: 'notify',
    label: 'settings.notifyKinds',
    help: 'settings.notifyKindsHelp',
    defaultValue: 'viral,breakout,intervention',
  },
  {
    key: 'NOTIFY_MIN_SCORE',
    kind: 'number',
    group: 'notify',
    label: 'settings.notifyMinScore',
    help: 'settings.notifyMinScoreHelp',
    min: 0,
    max: 100,
    defaultValue: '65',
  },
  {
    key: 'NOTIFY_MIN_CONFIDENCE',
    kind: 'number',
    group: 'notify',
    label: 'settings.notifyMinConfidence',
    help: 'settings.notifyMinConfidenceHelp',
    min: 0,
    max: 1,
    defaultValue: '0.5',
  },
  {
    key: 'NOTIFY_QUIET_HOURS',
    kind: 'list',
    group: 'notify',
    label: 'settings.notifyQuietHours',
    help: 'settings.notifyQuietHoursHelp',
    placeholder: '23,8',
    defaultValue: '0,0',
  },
  {
    key: 'NOTIFY_INTERVAL_MIN',
    kind: 'number',
    group: 'notify',
    label: 'settings.notifyInterval',
    help: 'settings.notifyIntervalHelp',
    min: 1,
    max: 1440,
    defaultValue: '10',
  },
  {
    key: 'NOTIFY_MAX_PER_RUN',
    kind: 'number',
    group: 'notify',
    label: 'settings.notifyMaxPerRun',
    help: 'settings.notifyMaxPerRunHelp',
    min: 1,
    max: 50,
    defaultValue: '8',
  },

  // ── Sources ──────────────────────────────────────────────────────────────
  {
    key: 'RSS_FEEDS',
    kind: 'list',
    group: 'sources',
    label: 'settings.rssFeeds',
    help: 'settings.rssFeedsHelp',
    defaultValue: '',
  },
  {
    key: 'TELEGRAM_CHANNELS',
    kind: 'list',
    group: 'sources',
    label: 'settings.telegramChannels',
    help: 'settings.telegramChannelsHelp',
    defaultValue: '',
  },
  {
    key: 'YOUTUBE_SEARCH_TERMS',
    kind: 'list',
    group: 'sources',
    label: 'settings.youtubeTerms',
    help: 'settings.youtubeTermsHelp',
    defaultValue: '',
  },
  {
    key: 'YOUTUBE_WATCH_CHANNELS',
    kind: 'list',
    group: 'sources',
    label: 'settings.youtubeChannels',
    help: 'settings.youtubeChannelsHelp',
    defaultValue: '',
  },
  {
    key: 'MASTODON_HOSTS',
    kind: 'list',
    group: 'sources',
    label: 'settings.mastodonHosts',
    help: 'settings.mastodonHostsHelp',
    defaultValue: 'mastodon.social,mstdn.social,fosstodon.org',
  },
  {
    key: 'TWITCH_LANGUAGES',
    kind: 'list',
    group: 'sources',
    label: 'settings.twitchLanguages',
    help: 'settings.twitchLanguagesHelp',
    defaultValue: '',
  },
  {
    key: 'APPLE_COUNTRIES',
    kind: 'list',
    group: 'sources',
    label: 'settings.appleCountries',
    help: 'settings.appleCountriesHelp',
    defaultValue: 'us',
  },
  {
    key: 'REDDIT_FEEDS',
    kind: 'list',
    group: 'sources',
    label: 'settings.redditFeeds',
    help: 'settings.redditFeedsHelp',
    defaultValue: 'r/all/rising,r/popular/hot,r/all/top?t=hour',
  },

  // ── Timing ───────────────────────────────────────────────────────────────
  {
    key: 'DISCOVERY_INTERVAL_MIN',
    kind: 'number',
    group: 'timing',
    label: 'settings.discoveryInterval',
    help: 'settings.discoveryIntervalHelp',
    min: 1,
    max: 1440,
    defaultValue: '20',
  },
  {
    key: 'HOT_REFRESH_MIN',
    kind: 'number',
    group: 'timing',
    label: 'settings.hotRefresh',
    help: 'settings.hotRefreshHelp',
    min: 1,
    max: 1440,
    defaultValue: '5',
  },
  {
    key: 'NORMAL_REFRESH_MIN',
    kind: 'number',
    group: 'timing',
    label: 'settings.normalRefresh',
    help: 'settings.normalRefreshHelp',
    min: 1,
    max: 1440,
    defaultValue: '60',
  },
  {
    key: 'ANALYZE_INTERVAL_MIN',
    kind: 'number',
    group: 'timing',
    label: 'settings.analyzeInterval',
    help: 'settings.analyzeIntervalHelp',
    min: 1,
    max: 1440,
    defaultValue: '10',
  },
  {
    key: 'MAX_AGE_HOURS',
    kind: 'number',
    group: 'timing',
    label: 'settings.maxAge',
    help: 'settings.maxAgeHelp',
    min: 1,
    max: 720,
    defaultValue: '72',
  },
  {
    key: 'RETENTION_DAYS',
    kind: 'number',
    group: 'timing',
    label: 'settings.retention',
    help: 'settings.retentionHelp',
    min: 1,
    max: 3650,
    defaultValue: '30',
  },

  // ── Scoring ──────────────────────────────────────────────────────────────
  { key: 'W_VELOCITY', kind: 'number', group: 'scoring', label: 'settings.wVelocity', help: 'settings.wVelocityHelp', min: 0, max: 1, defaultValue: '0.30' },
  { key: 'W_ACCELERATION', kind: 'number', group: 'scoring', label: 'settings.wAcceleration', help: 'settings.wAccelerationHelp', min: 0, max: 1, defaultValue: '0.30' },
  { key: 'W_ANOMALY', kind: 'number', group: 'scoring', label: 'settings.wAnomaly', help: 'settings.wAnomalyHelp', min: 0, max: 1, defaultValue: '0.15' },
  { key: 'W_ENGAGEMENT', kind: 'number', group: 'scoring', label: 'settings.wEngagement', help: 'settings.wEngagementHelp', min: 0, max: 1, defaultValue: '0.10' },
  { key: 'W_CROSS_SOURCE', kind: 'number', group: 'scoring', label: 'settings.wCrossSource', help: 'settings.wCrossSourceHelp', min: 0, max: 1, defaultValue: '0.10' },
  { key: 'W_FRESHNESS', kind: 'number', group: 'scoring', label: 'settings.wFreshness', help: 'settings.wFreshnessHelp', min: 0, max: 1, defaultValue: '0.05' },
  {
    key: 'FRESHNESS_HALFLIFE_HOURS',
    kind: 'number',
    group: 'scoring',
    label: 'settings.halfLife',
    help: 'settings.halfLifeHelp',
    min: 0.25,
    max: 240,
    defaultValue: '8',
  },

  // ── Network ──────────────────────────────────────────────────────────────
  {
    key: 'NETWORK_MODE',
    kind: 'select',
    group: 'network',
    label: 'settings.networkMode',
    help: 'settings.networkModeHelp',
    options: ['DIRECT', 'HTTP_PROXY'],
    defaultValue: 'DIRECT',
  },
  {
    key: 'PROXY_URL',
    kind: 'text',
    group: 'network',
    label: 'settings.proxyUrl',
    help: 'settings.proxyUrlHelp',
    placeholder: 'http://127.0.0.1:10809',
    defaultValue: '',
  },
  {
    key: 'HTTP_TIMEOUT_MS',
    kind: 'number',
    group: 'network',
    label: 'settings.timeout',
    help: 'settings.timeoutHelp',
    min: 1000,
    max: 120_000,
    defaultValue: '15000',
  },
  {
    key: 'HOST_RATE_LIMIT_RPS',
    kind: 'number',
    group: 'network',
    label: 'settings.rps',
    help: 'settings.rpsHelp',
    min: 0.05,
    max: 50,
    defaultValue: '1',
  },

  // ── Optional AI ──────────────────────────────────────────────────────────
  {
    key: 'AI_PROVIDER',
    kind: 'select',
    group: 'ai',
    label: 'settings.aiProvider',
    help: 'settings.aiProviderHelp',
    options: ['', 'ollama', 'openai', 'anthropic'],
    defaultValue: '',
  },
  { key: 'AI_BASE_URL', kind: 'text', group: 'ai', label: 'settings.aiBaseUrl', help: 'settings.aiBaseUrlHelp', defaultValue: '' },
  { key: 'AI_API_KEY', kind: 'secret', group: 'ai', label: 'settings.aiKey', help: 'settings.aiKeyHelp', defaultValue: '' },
  { key: 'AI_MODEL', kind: 'text', group: 'ai', label: 'settings.aiModel', help: 'settings.aiModelHelp', defaultValue: '' },

  // ── What you make ────────────────────────────────────────────────────────
  //
  // The one setting that makes the answers personal, and until now the only
  // way to set it was editing .env by hand. That is backwards: everything
  // requiring a key from a third party was editable here, and the field that
  // needs nothing but a sentence from the user was not.
  {
    key: 'INTERESTS',
    kind: 'text',
    group: 'audience',
    label: 'settings.interests',
    help: 'settings.interestsHelp',
    placeholder: 'comedy clips and challenges for a Persian-speaking audience',
    defaultValue: '',
  },
  {
    key: 'EMBED_MODEL',
    kind: 'text',
    group: 'ai',
    label: 'settings.embedModel',
    help: 'settings.embedModelHelp',
    placeholder: 'paraphrase-multilingual',
    defaultValue: '',
  },
];

const BY_KEY = new Map(SETTING_FIELDS.map((f) => [f.key, f]));

// ── Reading ────────────────────────────────────────────────────────────────

/**
 * What the environment held before this program touched it.
 *
 * Startup precedence is: a real environment variable wins over `.env`, because
 * `process.loadEnvFile` does not overwrite what is already set. That held
 * until the first settings save, at which point `reloadSettings` cleared every
 * declared key the file did not mention - including ones the file never
 * mentioned because they came from the environment.
 *
 * `SETTINGS_PASSWORD` is the one that matters. Provided in the environment and
 * absent from `.env`, one save took it from set to empty, which turns the
 * settings lock off: `isSettingsProtected()` false, and the next visitor
 * admitted with no password. The response said `live: true, problems: []`, and
 * nothing anywhere said the gate had opened. An environment-provided
 * `YOUTUBE_API_KEY` went the same way and failed at the next collect with no
 * message.
 *
 * Captured once, at load, before anything can have written to it.
 */
const FROM_ENVIRONMENT: ReadonlyMap<string, string> = new Map(
  SETTING_FIELDS.flatMap((f) => {
    const value = process.env[f.key];
    return value === undefined || value === '' ? [] : [[f.key, value] as [string, string]];
  }),
);

/** Whether this setting's value comes from the environment rather than `.env`. */
export function isFromEnvironment(key: string): boolean {
  return FROM_ENVIRONMENT.has(key);
}

/**
 * Pushes the file into the environment and rebuilds the configuration.
 *
 * The two halves are split across the two modules on purpose: `config.ts` knows
 * how to read an environment and must not import this file, or the pair would
 * be circular. This knows where the file is and which keys are settings, which
 * is what makes removal work — a key deleted from `.env` is cleared rather than
 * left holding whatever it had at startup.
 *
 * Only declared setting keys are touched. Anything else in the process
 * environment was put there by whoever started the program, and overwriting it
 * from a file the program itself wrote would be a surprise — which is exactly
 * why keys that came from the environment are put back rather than cleared.
 */
export function reloadSettings(): { ok: boolean; problems: readonly string[] } {
  const values = readEnvFile();
  for (const field of SETTING_FIELDS) {
    const value = values.get(field.key);
    const fromEnv = FROM_ENVIRONMENT.get(field.key);
    if (value !== undefined && value !== '') process.env[field.key] = value;
    else if (fromEnv !== undefined) process.env[field.key] = fromEnv;
    else delete process.env[field.key];
  }
  return reloadConfig();
}

/**
 * One `.env` value, read the way Node reads it.
 *
 * This has to match `process.loadEnvFile`, which is what fills `process.env`
 * at startup - and did not. Startup used Node's parser and every settings save
 * used this one, so a file written with either convention Node accepts behaved
 * differently before and after the first save, in ways that are mostly silent:
 *
 *     SOURCES_ENABLED=googletrends,rss # only two
 *
 * read literally, `rss # only two` is not a source id, so a source stops
 * collecting while the screen reports the save as applied. `RUN_ON_START=true
 * # dev` becomes false with no complaint at all, and a quoted
 * `SETTINGS_PASSWORD` stops matching - locking the settings screen until a
 * restart. The loud case is the mildest: an inline comment on a number fails
 * validation and blames a line the user never touched.
 *
 * Verified against Node v24: a value wrapped in a matching pair of double,
 * single or back quotes keeps its contents verbatim, hash included; anything
 * else is cut at the first `#`, with or without a space before it.
 */
export function parseEnvValue(raw: string): string {
  const value = raw.trim();
  const quote = value[0];
  if (quote === '"' || quote === "'" || quote === '`') {
    // The FIRST matching quote, not the last. Node closes the value there and
    // discards the rest of the line, so `"comedy clips" # what I make "mostly"`
    // is `comedy clips` to the loader and was `comedy clips" # what I make
    // "mostly` here - a divergence that only shows up once someone writes a
    // comment after a quoted value, and then persists to disk.
    const close = value.indexOf(quote, 1);
    if (close > 0) return value.slice(1, close);
    // Unterminated. This is the one place the two deliberately differ: Node
    // treats the quote as opening a multi-line value and swallows the rest of
    // the file, which for a settings screen would mean one malformed line
    // silently eating every setting below it. Kept as written instead - the
    // value is wrong either way, and wrong on one line beats wrong on twenty.
    return value;
  }
  const hash = value.indexOf('#');
  return (hash === -1 ? value : value.slice(0, hash)).trim();
}

/** Parses `.env` into a map, ignoring comments and blank lines. */
export function readEnvFile(): Map<string, string> {
  const values = new Map<string, string>();
  if (!existsSync(ENV_PATH)) return values;

  for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    values.set(trimmed.slice(0, eq).trim(), parseEnvValue(trimmed.slice(eq + 1)));
  }
  return values;
}

export interface SettingValue {
  readonly key: string;
  readonly kind: FieldKind;
  readonly group: string;
  readonly label: string;
  readonly help: string;
  readonly placeholder: string | null;
  readonly options: readonly string[] | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly helpUrl: string | null;
  readonly onboarding: boolean;
  readonly defaultValue: string;
  /** Absent for secrets - a secret is never sent to a browser. */
  readonly value: string | null;
  /** For secrets: whether one is currently set. */
  readonly isSet: boolean;
  /** Set from the process environment, not from `.env`, and not editable here. */
  readonly fromEnvironment: boolean;
}

export function readSettings(): SettingValue[] {
  const env = readEnvFile();
  return SETTING_FIELDS.map((f) => {
    const raw = env.get(f.key) ?? '';
    const secret = f.kind === 'secret';
    return {
      key: f.key,
      kind: f.kind,
      group: f.group,
      label: f.label,
      help: f.help,
      placeholder: f.placeholder ?? null,
      options: f.options ?? null,
      min: f.min ?? null,
      max: f.max ?? null,
      helpUrl: f.helpUrl ?? null,
      onboarding: f.onboarding === true,
      defaultValue: f.defaultValue,
      value: secret ? null : raw,
      isSet: raw !== '' || isFromEnvironment(f.key),
      // A value the person who started the program put in the environment.
      // The box would otherwise look empty while the setting is in force, and
      // typing into it writes `.env` - which the environment then goes on
      // overriding at the next start.
      fromEnvironment: isFromEnvironment(f.key),
    };
  });
}

export function envFileExists(): boolean {
  return existsSync(ENV_PATH);
}

// ── Writing ────────────────────────────────────────────────────────────────

/** Values that would let a stored string escape its line and inject another. */
const FORBIDDEN = /[\r\n\0]/;

function validate(field: SettingField, raw: string): string {
  const value = raw.trim();
  if (FORBIDDEN.test(value)) throw err.validation(`${field.key} may not contain line breaks`);
  if (value.length > 4000) throw err.validation(`${field.key} is too long`);

  switch (field.kind) {
    case 'number': {
      if (value === '') return '';
      const n = Number(value);
      if (!Number.isFinite(n)) throw err.validation(`${field.key} must be a number`);
      if (field.min !== undefined && n < field.min) throw err.validation(`${field.key} must be at least ${field.min}`);
      if (field.max !== undefined && n > field.max) throw err.validation(`${field.key} must be at most ${field.max}`);
      return String(n);
    }
    case 'select': {
      if (field.options !== undefined && !field.options.includes(value)) {
        throw err.validation(`${field.key} must be one of: ${field.options.join(', ') || '(empty)'}`);
      }
      return value;
    }
    case 'boolean':
      return /^(1|true|yes|on)$/i.test(value) ? 'true' : 'false';
    case 'list':
      return value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .join(',');
    default:
      return value;
  }
}

/**
 * A value written so that reading it back returns exactly what was set.
 *
 * The parser was taught to match Node, which truncates an unquoted value at
 * the first `#`. The writer went on emitting bare `KEY=value`, so the two
 * disagreed about anything containing one: `SETTINGS_PASSWORD=pa#ssw0rd` was
 * written, read back as `pa`, and that is what the gate then compared against
 * - a credential silently shortened to a guessable prefix while the screen
 * reported the save applied. `process.loadEnvFile` parses it the same way, so
 * a restart did not recover it; the rest of the value was gone from disk.
 *
 * Quoted only when it has to be, because `.env` stays a file people edit by
 * hand and gratuitous quotes make it worse to read. Double quotes, since a
 * value containing one is refused rather than escaped - `validate` already
 * rejects newlines, and there is no legitimate setting that needs a literal
 * double quote in it.
 */
function envLiteral(value: string): string {
  // The whitespace arm never fires through `writeSettings`, because `validate`
  // trims first. It is here so the function is correct on its own terms rather
  // than only in the one path that calls it.
  const needsQuotes =
    value !== value.trim() ||
    value.includes('#') ||
    value.startsWith('"') ||
    value.startsWith("'") ||
    value.startsWith('`');
  if (!needsQuotes) return value;
  // Double quotes are the only style that works here - apostrophes are common
  // in this app's Persian and Arabic content, so single quoting would refuse
  // ordinary values - and inside them Node expands the two-character sequence
  // `\\n` into a real newline. So a password containing both a hash and a
  // backslash would be written correctly, round-trip correctly through the
  // parser, work for the rest of the process, and come back different after a
  // restart. Refusing beats writing something that changes underneath the user.
  if (value.includes('"') || value.includes('\\')) {
    throw err.validation('A value that needs quoting cannot contain a double quote or a backslash');
  }
  return `"${value}"`;
}

/**
 * Produces the new contents of `.env`.
 *
 * Pure, so the rewriting rules can be tested without a filesystem: comments,
 * ordering and untouched keys are preserved, because the file is a document the
 * user also edits by hand and a settings screen that flattened it into a
 * machine-generated blob would be a poor trade.
 */
export function applyToEnvContent(
  existing: string,
  updates: Readonly<Record<string, string>>,
): { content: string; applied: string[] } {
  const applied: string[] = [];
  const validated = new Map<string, string>();

  for (const [key, raw] of Object.entries(updates)) {
    const field = BY_KEY.get(key);
    // Unknown keys are refused outright rather than written and ignored.
    if (field === undefined) throw err.validation(`"${key}" is not an editable setting`);
    validated.set(key, validate(field, String(raw)));
  }

  const lines = existing === '' ? [] : existing.split(/\r?\n/);
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] as string).trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!validated.has(key)) continue;
    lines[i] = `${key}=${envLiteral(validated.get(key) as string)}`;
    seen.add(key);
    applied.push(key);
  }

  const missing = [...validated.entries()].filter(([key]) => !seen.has(key));
  if (missing.length > 0) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push('# Added from the settings screen');
    for (const [key, value] of missing) {
      lines.push(`${key}=${envLiteral(value)}`);
      applied.push(key);
    }
    lines.push('');
  }

  return { content: lines.join('\n'), applied };
}

export function writeSettings(updates: Readonly<Record<string, string>>): string[] {
  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const { content, applied } = applyToEnvContent(existing, updates);

  // Write beside the target and rename: a crash mid-write must not be able to
  // leave a half-written configuration behind.
  const temp = `${ENV_PATH}.tmp`;
  writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, ENV_PATH);

  return applied;
}
