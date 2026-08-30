/**
 * REST handlers and the row -> DTO mapping.
 *
 * Filters are parsed here and applied by the repository *after* detection.
 * Nothing in this file can narrow what the radar looks at; the defaults are
 * all sources, all languages, all countries, all topics.
 */
import { config, RESTART_REQUIRED } from '../config.ts';
import * as repo from '../db/repo.ts';
import { allPlugins, statusOf } from '../sources/registry.ts';
import { collectOne } from '../pipeline/collect.ts';
import { analyze } from '../pipeline/analyze.ts';
import { networkState } from '../net/fetcher.ts';
import { dbStats } from '../db/repo.ts';
import { hourBucket, nowSec, TREND_STATES, type TrendState } from '../core/types.ts';
import type { Scheduler } from '../pipeline/scheduler.ts';
import { envFileExists, readSettings, reloadSettings, writeSettings } from '../settings.ts';
import { analyzeFormats, matchesFormatBucket } from '../core/format.ts';
import { exportFilename, toCsv, toJson } from './export.ts';
import { ageAdjusted, analyzeTiming, assignTimingBucket } from '../core/timing.ts';
import { analyzeThumbnails, assignThumbnailBucket } from '../core/thumbnail.ts';
import { analyzeTags } from '../core/tags.ts';
import { findGaps } from '../core/gap.ts';
import type { TagSample } from '../core/tags.ts';
import type { TimingSample } from '../core/timing.ts';
import { err } from '../errors.ts';

// ── DTOs ───────────────────────────────────────────────────────────────────

export interface TrendItemDto {
  readonly id: string;
  readonly source: string;
  readonly url: string;
  readonly title: string;
  readonly contentType: string;
  readonly thumbnail: string | null;
  readonly creator: {
    id: string | null;
    name: string | null;
    /** The creator's own page on the platform, so it is one click away. */
    url: string | null;
    followers: number | null;
    baseline: number | null;
  };
  readonly language: { code: string | null; confidence: number | null };
  readonly country: { code: string | null; confidence: number | null; source: string | null };
  readonly publishedAt: number | null;
  readonly firstSeenAt: number;
  readonly ageHours: number | null;
  readonly state: TrendState;
  readonly score: number;
  readonly confidence: number;
  readonly metrics: {
    readonly primary: { name: string; value: number | null };
    readonly views: number | null;
    readonly likes: number | null;
    readonly comments: number | null;
    readonly shares: number | null;
    readonly nativeScore: number | null;
  };
  readonly signals: {
    readonly velocity: number | null;
    readonly acceleration: number | null;
    readonly engagementRate: number | null;
    readonly creatorAnomaly: number | null;
    readonly sourcePercentile: number | null;
    readonly freshness: number | null;
    readonly crossSource: number | null;
  };
  readonly observations: number;
  /** 0..1 closeness to what the user makes; null when not scored. */
  readonly relevance: number | null;
  readonly hashtags: readonly string[];
}

function jsonArray(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function round(v: number | null, digits = 2): number | null {
  return v === null || !Number.isFinite(v) ? null : Number(v.toFixed(digits));
}

export function toTrendItem(row: repo.RankedRow): TrendItemDto {
  return {
    id: row.id,
    source: row.source,
    url: row.url,
    title: row.title,
    contentType: row.content_type,
    thumbnail: row.thumbnail_url,
    creator: {
      id: row.author_id,
      name: row.author_name,
      url: row.creator_url,
      followers: row.author_followers,
      baseline: round(row.creator_median, 0),
    },
    language: { code: row.lang, confidence: round(row.lang_confidence) },
    country: { code: row.country, confidence: round(row.country_confidence), source: row.country_source },
    publishedAt: row.published_at,
    firstSeenAt: row.first_seen_at,
    ageHours: round(row.age_hours, 1),
    state: row.state as TrendState,
    score: round(row.score, 1) ?? 0,
    confidence: round(row.confidence, 2) ?? 0,
    metrics: {
      primary: { name: row.primary_metric, value: row.primary_value },
      views: row.views,
      likes: row.likes,
      comments: row.comments,
      shares: row.shares,
      nativeScore: row.native_score,
    },
    signals: {
      velocity: round(row.velocity, 1),
      acceleration: round(row.acceleration, 2),
      engagementRate: round(row.engagement_rate, 4),
      creatorAnomaly: round(row.creator_anomaly, 1),
      sourcePercentile: round(row.source_percentile, 3),
      freshness: round(row.freshness, 3),
      crossSource: round(row.cross_source, 2),
    },
    observations: row.observations,
    relevance: round(row.relevance, 3),
    hashtags: jsonArray(row.hashtags),
  };
}

export interface ClusterDto {
  readonly id: string;
  readonly label: string;
  readonly keywords: readonly string[];
  readonly state: TrendState;
  readonly score: number;
  readonly confidence: number;
  readonly itemCount: number;
  readonly platformCount: number;
  readonly sources: readonly string[];
  readonly languages: readonly { code: string; pct: number }[];
  readonly countries: readonly { code: string; pct: number }[];
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly velocity: number | null;
  readonly acceleration: number | null;
  readonly totalViews: number | null;
  readonly totalEngagement: number | null;
  readonly explanation: string | null;
}

export function toCluster(row: repo.ClusterRow): ClusterDto {
  const parse = <T>(raw: string | null, fallback: T): T => {
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  };
  return {
    id: row.id,
    label: row.label,
    keywords: parse<string[]>(row.keywords, []),
    state: row.state as TrendState,
    score: round(row.score, 1) ?? 0,
    confidence: round(row.confidence, 2) ?? 0,
    itemCount: row.item_count,
    platformCount: row.source_count,
    sources: parse<string[]>(row.sources, []),
    languages: parse<{ code: string; pct: number }[]>(row.languages, []),
    countries: parse<{ code: string; pct: number }[]>(row.countries, []),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    velocity: round(row.velocity, 2),
    acceleration: round(row.acceleration, 2),
    totalViews: row.total_views,
    totalEngagement: row.total_engagement,
    explanation: row.explanation,
  };
}

// ── Query parsing ──────────────────────────────────────────────────────────

function csv(params: URLSearchParams, key: string): string[] | undefined {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '' || raw.toLowerCase() === 'all') return undefined;
  const values = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return values.length > 0 ? values : undefined;
}

function int(params: URLSearchParams, key: string, fallback: number, min: number, max: number): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * The local hour and weekday of an instant, in a given zone.
 *
 * `Intl` rather than offset arithmetic, for two reasons that both bite in
 * practice: daylight saving means the offset is not a constant, and Iran,
 * India and Nepal are on half- and quarter-hour offsets that integer division
 * of epoch seconds gets wrong.
 */
function localParts(tsSec: number, timeZone: string): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hour12: false,
    weekday: 'short',
  }).formatToParts(new Date(tsSec * 1000));

  const hourRaw = parts.find((p) => p.type === 'hour')?.value ?? '0';
  const weekdayRaw = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  // hour12:false still renders midnight as 24 in some runtimes.
  const hour = Number(hourRaw) % 24;
  return { hour: Number.isFinite(hour) ? hour : 0, weekday: WEEKDAY_INDEX[weekdayRaw] ?? 0 };
}

/** The same, for a value that is genuinely fractional. */
function num(params: URLSearchParams, key: string, fallback: number, min: number, max: number): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * The language filter, resolved.
 *
 * `LANGUAGES` in .env is a standing preference, not a hard rule: an explicit
 * `lang` parameter always wins, and `lang=all` clears it entirely. Without the
 * parameter the configured preference applies, which is what makes the setting
 * mean something on the dashboard rather than only in the URL bar.
 */
/**
 * Whether items can be matched against what the user makes.
 *
 * Both halves are required and they fail differently: no description means
 * there is nothing to match against, and no embedding model means there is no
 * way to compare. One function so every caller agrees on the answer.
 */
function interestsOn(): boolean {
  return config.interests.trim() !== '' && config.embed.model !== '';
}

/**
 * How many of each value, biggest first.
 *
 * Used to put the demand and supply language mixes side by side. Comparing US
 * searches against Persian videos produces a page full of gaps that are really
 * a misconfiguration, and two small counts are how that becomes visible instead
 * of being read as a finding.
 */
function countBy(values: readonly (string | null)[]): { key: string; n: number }[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = value ?? '?';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .map(([key, n]) => ({ key, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 5);
}

function resolveLanguages(params: URLSearchParams): readonly string[] | undefined {
  if (params.has('lang')) return csv(params, 'lang');
  return config.languages.length > 0 ? config.languages : undefined;
}

export function parseQuery(params: URLSearchParams): repo.RankedQuery {
  const states = csv(params, 'state')?.filter((s): s is TrendState => (TREND_STATES as readonly string[]).includes(s));
  const orderRaw = params.get('sort') ?? 'score';
  const orderBy =
    (['score', 'acceleration', 'velocity', 'recent', 'creator_anomaly', 'relevance'] as const).find(
      (o) => o === orderRaw,
    ) ?? 'score';

  const query: repo.RankedQuery = {
    limit: int(params, 'limit', 40, 1, 200),
    offset: int(params, 'offset', 0, 0, 100_000),
    orderBy,
    ...(states !== undefined && states.length > 0 ? { states } : {}),
    ...(csv(params, 'source') !== undefined ? { sources: csv(params, 'source') } : {}),
    ...(resolveLanguages(params) !== undefined ? { languages: resolveLanguages(params) } : {}),
    ...(csv(params, 'country') !== undefined ? { countries: csv(params, 'country') } : {}),
    ...(csv(params, 'type') !== undefined ? { contentTypes: csv(params, 'type') } : {}),
    ...(params.has('minScore') ? { minScore: int(params, 'minScore', 0, 0, 100) } : {}),
    ...(params.has('maxAgeHours') ? { maxAgeHours: int(params, 'maxAgeHours', 72, 1, 8760) } : {}),
    ...(params.get('creator') !== null ? { creator: (params.get('creator') as string).slice(0, 120) } : {}),
    ...(params.get('hashtag') !== null ? { hashtag: (params.get('hashtag') as string).slice(0, 80) } : {}),
    ...(params.get('q') !== null ? { query: (params.get('q') as string).slice(0, 120) } : {}),
    ...(params.has('minRelevance') ? { minRelevance: num(params, 'minRelevance', 0, 0, 1) } : {}),
    // Hidden unless asked for. `only` is how the interface answers "what have
    // I already covered", which is the other half of being able to hide things.
    archived: params.get('archived') === 'only'
      ? 'only'
      : params.get('archived') === 'include'
        ? 'include'
        : 'hide',
  };
  return query;
}

/** Topic filters, parsed the same way the content filters are. */
function clusterQuery(params: URLSearchParams, defaultMinSources: number): repo.ClusterQuery {
  const orderRaw = params.get('sort') ?? 'score';
  const orderBy = (['score', 'recent', 'platforms', 'velocity'] as const).find((o) => o === orderRaw) ?? 'score';
  const languages = resolveLanguages(params);
  return {
    limit: int(params, 'limit', 40, 1, 200),
    minSources: int(params, 'minSources', defaultMinSources, 1, 10),
    minScore: int(params, 'minScore', 0, 0, 100),
    orderBy,
    ...(languages !== undefined ? { languages } : {}),
    ...(csv(params, 'country') !== undefined ? { countries: csv(params, 'country') } : {}),
    ...(csv(params, 'source') !== undefined ? { sources: csv(params, 'source') } : {}),
    ...(params.has('maxAgeHours') ? { maxAgeHours: int(params, 'maxAgeHours', 72, 1, 8760) } : {}),
  };
}

function page(
  rows: repo.RankedRow[],
  q: repo.RankedQuery,
): { items: TrendItemDto[]; nextOffset: number | null; total: number } {
  return {
    items: rows.map(toTrendItem),
    nextOffset: rows.length === q.limit ? q.offset + q.limit : null,
    // The whole matching set, not this page of it. A control that reports how
    // many items a filter leaves has to count the filter, not the page, or it
    // reports its own limit back and reads as "this changes nothing".
    total: repo.countRanked(q),
  };
}

// ── Handlers ───────────────────────────────────────────────────────────────

export interface Handlers {
  readonly dashboard: () => unknown;
  readonly trends: (p: URLSearchParams) => unknown;
  readonly viral: (p: URLSearchParams) => unknown;
  readonly emerging: (p: URLSearchParams) => unknown;
  readonly rising: (p: URLSearchParams) => unknown;
  readonly crossPlatform: (p: URLSearchParams) => unknown;
  readonly clusters: (p: URLSearchParams) => unknown;
  readonly cluster: (id: string) => unknown;
  readonly content: (id: string) => unknown;
  readonly breakouts: (p: URLSearchParams) => unknown;
  readonly hashtags: (p: URLSearchParams) => unknown;
  readonly sources: () => unknown;
  readonly runSource: (id: string) => Promise<unknown>;
  readonly health: () => unknown;
  readonly interventions: () => unknown;
  readonly resolveIntervention: (id: string) => unknown;
  readonly events: (p: URLSearchParams) => unknown;
  readonly reports: (p: URLSearchParams) => unknown;
  readonly facets: () => unknown;
  readonly creators: (p: URLSearchParams) => unknown;
  readonly settings: () => unknown;
  readonly saveSettings: (body: unknown) => unknown;
  readonly triggerAnalyze: () => unknown;
  readonly triggerCollect: () => unknown;
  readonly formats: (params: URLSearchParams) => unknown;
  readonly terms: (params: URLSearchParams) => unknown;
  readonly exportContent: (params: URLSearchParams) => { filename: string; type: string; body: string };
  readonly missed: (params: URLSearchParams) => unknown;
  readonly archive: (id: string, body: unknown) => unknown;
  readonly unarchive: (id: string) => unknown;
  readonly timing: (params: URLSearchParams) => unknown;
  readonly thumbnails: (params: URLSearchParams) => unknown;
  readonly examples: (params: URLSearchParams) => unknown;
  readonly tags: (params: URLSearchParams) => unknown;
  readonly gaps: (params: URLSearchParams) => Promise<unknown>;
  readonly interests: () => unknown;
  readonly notifyStatus: () => unknown;
  readonly embeddingStatus: () => Promise<unknown>;
  readonly notifyTest: () => Promise<unknown>;
}

/**
 * How close an item has to be to the channel description to count as a match.
 *
 * Not a percentile of whatever is in the database. A relative bar always
 * returns something — "the closest fifth of a bad match" looks exactly like a
 * finding — and this page would then claim a match on a day when nothing
 * matched. A fixed bar can come back empty, and empty is the honest answer.
 *
 * 0.5 against a real corpus: about a fifth of items clear it, and reading them
 * they are recognisably the subject rather than merely the same language.
 */
const RELEVANCE_FLOOR = 0.5;

const VIRAL_STATES: readonly string[] = ['VIRAL', 'HOT'];
const EMERGING_STATES: readonly string[] = ['EMERGING'];
const RISING_STATES: readonly string[] = ['RISING', 'NEW'];

export function createHandlers(scheduler: Scheduler | null): Handlers {
  return {
    /**
     * Everything the home page needs in one request. The page must answer
     * "what is exploding right now" without the user typing anything, so this
     * endpoint takes no required parameters at all.
     */
    dashboard() {
      // The configured language preference applies here too; otherwise the
      // setting would only affect explicitly filtered requests and not the one
      // page the user actually looks at.
      const base = {
        limit: 12,
        offset: 0,
        ...(config.languages.length > 0 ? { languages: config.languages } : {}),
      } as const;
      const viral = repo.rankedContent({ ...base, states: VIRAL_STATES, orderBy: 'score' });
      const emerging = repo.rankedContent({ ...base, states: EMERGING_STATES, orderBy: 'acceleration' });
      const rising = repo.rankedContent({ ...base, states: RISING_STATES, orderBy: 'acceleration', minScore: 25 });
      const breakouts = repo.listBreakouts(12, nowSec() - 48 * 3600);
      const languages = config.languages.length > 0 ? config.languages : undefined;

      /**
       * What is worth making *for this channel*.
       *
       * Filtered by closeness to the description, then ranked by score — never
       * sorted by closeness. The two are almost opposite: on a real database
       * the ten closest items to a channel description scored 2.7 to 29, because
       * the closest thing to a description of comedy clips is a hashtag-stuffed
       * clip nobody is watching. What is useful is the intersection: close to
       * what you make *and* actually moving.
       */
      const forYou = interestsOn()
        ? repo.rankedContent({
            ...base,
            orderBy: 'score',
            minRelevance: RELEVANCE_FLOOR,
            // A day, not the default window: this answers "today".
            maxAgeHours: 48,
          })
        : [];
      // Cross-platform topics are the strongest signal, but for a language whose
      // sources rarely share vocabulary there may be none. Rather than showing
      // an empty section - or quietly showing another language's topics - fall
      // back to single-platform topics in the language actually asked for.
      const crossPlatform = repo.listClusters({ limit: 12, minSources: 2, ...(languages ? { languages } : {}) });
      const clusters =
        crossPlatform.length >= 3
          ? crossPlatform
          : repo.listClusters({ limit: 12, minSources: 1, ...(languages ? { languages } : {}) });

      return {
        generatedAt: nowSec(),
        viral: viral.map(toTrendItem),
        breakingOut: breakouts.map(toTrendItem),
        rising: rising.map(toTrendItem),
        emerging: emerging.map(toTrendItem),
        crossPlatform: clusters.map(toCluster),
        forYou: forYou.map(toTrendItem),
        // Reported rather than assumed by the page, so the bar the list was
        // built with and the bar the page names cannot drift apart.
        forYouFloor: RELEVANCE_FLOOR,
        forYouEnabled: interestsOn(),
        hashtags: repo.keywordBreakouts(hourBucket(nowSec()), 12),
        stats: dbStats(),
      };
    },

    trends(params) {
      const q = parseQuery(params);
      return page(repo.rankedContent(q), q);
    },

    viral(params) {
      const q = { ...parseQuery(params), states: VIRAL_STATES };
      return page(repo.rankedContent(q), q);
    },

    emerging(params) {
      const q: repo.RankedQuery = { ...parseQuery(params), states: EMERGING_STATES, orderBy: 'acceleration' };
      return page(repo.rankedContent(q), q);
    },

    rising(params) {
      const q: repo.RankedQuery = { ...parseQuery(params), states: RISING_STATES, orderBy: 'acceleration' };
      return page(repo.rankedContent(q), q);
    },

    crossPlatform(params) {
      return { items: repo.listClusters(clusterQuery(params, 2)).map(toCluster) };
    },

    clusters(params) {
      return { items: repo.listClusters(clusterQuery(params, 1)).map(toCluster) };
    },

    cluster(id) {
      const row = repo.getCluster(id);
      if (row === undefined) return null;
      return {
        ...toCluster(row),
        items: repo.clusterMembers(id).map(toTrendItem),
        history: repo.clusterHistory(id),
      };
    },

    /** Full detail for one item, including the raw series behind its score. */
    content(id) {
      const row = repo.getContent(id);
      if (row === undefined) return null;
      const score = repo.getScore(id);
      const snapshots = repo.getSnapshots(id, 200);
      const creator =
        row.author_id === null ? null : repo.getCreator(repo.creatorIdOf(row.source, row.author_id));
      const cluster = repo.clusterOfContent(id);

      return {
        id: row.id,
        source: row.source,
        url: row.url,
        title: row.title,
        body: row.body,
        contentType: row.content_type,
        thumbnail: row.thumbnail_url,
        language: { code: row.lang, confidence: row.lang_confidence },
        country: { code: row.country, confidence: row.country_confidence, source: row.country_source },
        publishedAt: row.published_at,
        publishedAtSource: row.published_at_source,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        keywords: jsonArray(row.keywords),
        hashtags: jsonArray(row.hashtags),
        state: score?.state ?? 'NEW',
        score: round(score?.score ?? null, 1),
        confidence: round(score?.confidence ?? null, 2),
        signals: score === undefined
          ? null
          : {
              velocity: round(score.velocity, 2),
              acceleration: round(score.acceleration, 2),
              engagementRate: round(score.engagement_rate, 4),
              creatorAnomaly: round(score.creator_anomaly, 2),
              sourcePercentile: round(score.source_percentile, 3),
              freshness: round(score.freshness, 3),
              crossSource: round(score.cross_source, 2),
              primaryMetric: score.primary_metric,
              primaryValue: score.primary_value,
              observations: score.observations,
              peakScore: round(score.peak_score, 1),
              peakAt: score.peak_at,
              scoringVersion: score.scoring_version,
            },
        creator,
        cluster: cluster === undefined ? null : toCluster(cluster),
        history: snapshots.map((s) => ({
          ts: s.ts,
          views: s.views,
          likes: s.likes,
          comments: s.comments,
          shares: s.shares,
          nativeScore: s.nativeScore,
        })),
      };
    },

    breakouts(params) {
      const limit = int(params, 'limit', 40, 1, 200);
      const hours = int(params, 'hours', 48, 1, 720);
      return { items: repo.listBreakouts(limit, nowSec() - hours * 3600).map(toTrendItem) };
    },

    hashtags(params) {
      const limit = int(params, 'limit', 40, 1, 200);
      return { items: repo.keywordBreakouts(hourBucket(nowSec()), limit) };
    },

    /** Plugin inventory: capabilities, configuration status and live health. */
    sources() {
      return {
        items: allPlugins().map((plugin) => {
          const validation = statusOf(plugin);
          const health = repo.getHealth(plugin.id);
          return {
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            enabled: config.sourcesEnabled.includes(plugin.id),
            configured: validation.ok,
            status: health?.status ?? validation.status,
            message: validation.message,
            helpUrl: validation.helpUrl ?? null,
            capabilities: plugin.capabilities,
            health: health ?? null,
          };
        }),
      };
    },

    async runSource(id) {
      return collectOne(id);
    },

    health() {
      const stats = dbStats();
      return {
        status: 'ok',
        // Nothing collected yet: the settings wizard should greet the user
        // instead of an empty dashboard.
        firstRun: stats.content === 0,
        now: nowSec(),
        uptimeSec: Math.floor(process.uptime()),
        scoringVersion: config.scoring.version,
        regions: config.regions,
        db: dbStats(),
        sources: repo.allHealth(),
        jobs: scheduler?.status() ?? [],
        network: networkState(),
        lastDiscovery: Number(repo.kvGet('last_discovery') ?? 0) || null,
        lastAnalysis: Number(repo.kvGet('last_analysis') ?? 0) || null,
        ai: config.ai.provider === '' ? 'AI_DISABLED' : config.ai.provider,
      };
    },

    /**
     * Things needing a human, for sources that are actually running.
     *
     * An intervention raised by a source that has since been switched off is
     * unactionable: nothing the user does resolves it, because the source that
     * would clear it never runs. Left in, it sits on the System page forever
     * making a healthy system look broken — which is exactly what happened with
     * two Reddit warnings that outlived Reddit being enabled by two days.
     *
     * Filtered on read rather than deleted: the record is still history, and if
     * the source is switched back on the warning becomes relevant again without
     * having to be rediscovered.
     */
    interventions() {
      const enabled = new Set(config.sourcesEnabled);
      const open = repo.listInterventions('OPEN');
      const items = open.filter((i) => enabled.has(i.source));
      return {
        items,
        // Reported rather than hidden entirely, so "why am I not seeing this"
        // has an answer without reading the database.
        mutedForDisabledSources: open.length - items.length,
      };
    },

    resolveIntervention(id) {
      return { resolved: repo.resolveIntervention(id, 'RESOLVED', nowSec()) };
    },

    events(params) {
      const limit = int(params, 'limit', 60, 1, 500);
      const type = params.get('type');
      return { items: repo.listEvents(limit, type === null ? undefined : type) };
    },

    /** Everything the reports page charts, in one request. */
    reports(params) {
      const hours = int(params, 'hours', 72, 1, 8760);
      const since = nowSec() - hours * 3600;
      return {
        windowHours: hours,
        bySource: repo.distribution('source', since),
        byLanguage: repo.distribution('lang', since),
        byCountry: repo.distribution('country', since),
        byType: repo.distribution('content_type', since),
        byState: repo.stateDistribution(),
        timeline: repo.discoveryTimeline(since),
        sourceQuality: repo.sourceReport(since),
        hashtags: repo.keywordBreakouts(hourBucket(nowSec()), 25),
        activity: repo.activityGrid(since),
        scoreHistogram: repo.scoreHistogram(),
        scatter: repo.scatterSample(since, 400),
        clusterTraces: repo.clusterTraces(6),
        topDomains: repo.topDomains(since),
        stats: dbStats(),
      };
    },

    /**
     * What shape of content wins, for whatever slice the user filtered to.
     *
     * The confidence floor is the important parameter. Without it the set is
     * dominated by items measured once, whose percentile is mostly noise, and
     * every pattern washes out. It is exposed rather than fixed so a user with
     * a thin database can trade certainty for having any answer at all.
     */
    formats(params) {
      const hours = int(params, 'hours', 336, 1, 8760);
      const minConfidence = num(params, 'minConfidence', 0.4, 0, 1);
      const samples = repo.formatSamples({
        sinceTs: nowSec() - hours * 3600,
        languages: resolveLanguages(params),
        countries: csv(params, 'country'),
        sources: csv(params, 'source'),
        contentTypes: csv(params, 'type'),
        minConfidence,
        limit: 20000,
      });

      const analysis = analyzeFormats(
        samples.map((row) => ({
          title: row.title,
          contentType: row.content_type,
          lang: row.lang,
          percentile: row.percentile,
          score: row.score,
        })),
      );

      return { windowHours: hours, minConfidence, ...analysis };
    },

    /**
     * When to post.
     *
     * The window defaults wider than the format analysis because every item
     * has to be a day old before it counts, so a short window would throw away
     * most of what there is.
     */
    timing(params) {
      const hours = int(params, 'hours', 720, 24, 8760);
      const minConfidence = num(params, 'minConfidence', 0.4, 0, 1);
      const settleHours = int(params, 'settleHours', 24, 1, 168);
      const now = nowSec();

      const rows = repo.timingSamples({
        sinceTs: now - hours * 3600,
        settledBeforeTs: now - settleHours * 3600,
        languages: resolveLanguages(params),
        countries: csv(params, 'country'),
        sources: csv(params, 'source'),
        contentTypes: csv(params, 'type'),
        minConfidence,
        limit: 20000,
      });

      const samples: TimingSample[] = rows.map((row) => {
        const local = localParts(row.published_at, config.timezone);
        return {
          hour: local.hour,
          weekday: local.weekday,
          ageHours: (now - row.published_at) / 3600,
          percentile: row.percentile,
          score: row.score,
        };
      });

      return {
        windowHours: hours,
        minConfidence,
        settleHours,
        ...analyzeTiming(samples, config.timezone),
      };
    },

    /**
     * The current list, as a file.
     *
     * Takes exactly the same filters as the list it mirrors, so what is
     * exported is what was on screen — an export that quietly differs from the
     * view it came from is worse than none.
     */
    exportContent(params) {
      const format = params.get('format') === 'json' ? 'json' : 'csv';
      // The same parser every list endpoint uses, so the file matches the view.
      const rows = repo.rankedContent({
        ...parseQuery(params),
        limit: int(params, 'limit', 1000, 1, 5000),
        offset: 0,
      });
      return {
        filename: exportFilename(params.get('kind') ?? 'trends', format, nowSec()),
        type: format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
        body: format === 'json' ? toJson(rows) : toCsv(rows),
      };
    },

    /**
     * What peaked while you were not looking.
     *
     * Not the same question as "what is hot now", and the difference is the
     * point: these already peaked, so the window is judged by peak score rather
     * than by current score, and anything still rising is deliberately left out
     * — that belongs on the dashboard, not in a retrospective.
     */
    missed(params) {
      const hours = int(params, 'hours', 168, 1, 8760);
      const now = nowSec();
      const rows = repo.peakedWithin({
        sinceTs: now - hours * 3600,
        languages: resolveLanguages(params),
        countries: csv(params, 'country'),
        sources: csv(params, 'source'),
        minPeak: num(params, 'minPeak', 60, 0, 100),
        limit: int(params, 'limit', 60, 1, 200),
      });
      return {
        windowHours: hours,
        items: rows.map((row) => ({
          ...toTrendItem(row),
          peakScore: round(row.peak_score),
          peakedAt: row.peak_at,
        })),
      };
    },

    archive(id, body) {
      const input = (body ?? {}) as { reason?: string; note?: string };
      const reason = input.reason === 'not_relevant' ? 'not_relevant' : 'used';
      repo.archiveContent(id, reason, input.note ?? null, nowSec());
      return { archived: true, id, reason };
    },

    unarchive(id) {
      repo.unarchiveContent(id);
      return { archived: false, id };
    },

    /**
     * What each seed word bought.
     *
     * Only items a day old count: a word used an hour ago has found nothing
     * that could have taken off yet, and counting those would make whichever
     * word was used most recently always look like the worst.
     */
    terms(params) {
      const source = params.get('source') ?? 'youtube';
      const rows = repo.termYield(source, nowSec() - 86_400);
      return {
        source,
        minJudged: 40,
        items: rows.map((r) => ({
          ...r,
          hitRate: r.found === 0 ? 0 : round((r.moving / r.found) * 100),
        })),
      };
    },

    /** Which thumbnails performed, on the same terms as which titles did. */
    thumbnails(params) {
      const hours = int(params, 'hours', 336, 1, 8760);
      const minConfidence = num(params, 'minConfidence', 0.4, 0, 1);
      const samples = repo.mediaSamples({
        sinceTs: nowSec() - hours * 3600,
        languages: resolveLanguages(params),
        sources: csv(params, 'source'),
        minConfidence,
        limit: 20000,
      });
      const coverage = repo.mediaCoverage();
      const analysed = samples.map((row) => ({ ...row, contentType: row.content_type }));
      return { windowHours: hours, minConfidence, coverage, ...analyzeThumbnails(analysed) };
    },

    /**
     * The real items behind one bar.
     *
     * Every analysis on the "what works" page reduces thousands of items to a
     * number, and a number on its own is where trust runs out: "titles of
     * 31-50 characters rank six points higher" only becomes usable once you
     * can look at six of them. This re-runs the same query with the same
     * filters, puts every item through the same bucketing the chart used, and
     * hands back the strongest few.
     *
     * The bucketing is imported rather than repeated. That is the whole design
     * of this endpoint: if the examples were selected by a second copy of the
     * rule, the two would drift and the page would show items that are not
     * what the bar was measuring — a failure with no visible symptom.
     *
     * Ordering is by the measure the bar itself was computed from, never by
     * raw score. For timing that distinction is load-bearing: rank falls
     * steeply with age, so ordering by score would return the newest items
     * published in that hour rather than the ones that did best in it.
     */
    examples(params) {
      const group = params.get('group') ?? '';
      const bucket = params.get('bucket') ?? '';
      if (group === '' || bucket === '') {
        throw err.validation('Both group and bucket are required');
      }

      const dimension =
        (['format', 'timing', 'thumbnail'] as const).find((d) => d === params.get('dimension')) ??
        'format';
      const limit = int(params, 'limit', 6, 1, 24);
      const minConfidence = num(params, 'minConfidence', 0.4, 0, 1);
      const now = nowSec();
      const languages = resolveLanguages(params);
      const countries = csv(params, 'country');
      const sources = csv(params, 'source');
      const contentTypes = csv(params, 'type');

      /** Everything in the bucket, with the value the bar ranks it by. */
      let matched: { id: string; value: number }[] = [];

      /**
       * What was actually measured, for the thumbnail view.
       *
       * The measurements are already in hand — they are what put the item in
       * this band — so carrying them costs nothing and lets the page say why a
       * given image is here rather than asking the reader to take the band on
       * trust. Empty for the other two dimensions, which have no image to
       * explain.
       */
      const measured = new Map<string, Record<string, number | null>>();

      if (dimension === 'timing') {
        const hours = int(params, 'hours', 720, 24, 8760);
        const settleHours = int(params, 'settleHours', 24, 1, 168);
        const rows = repo.timingSamples({
          sinceTs: now - hours * 3600,
          settledBeforeTs: now - settleHours * 3600,
          languages,
          countries,
          sources,
          contentTypes,
          minConfidence,
          limit: 20000,
        });
        const samples: TimingSample[] = rows.map((row) => {
          const local = localParts(row.published_at, config.timezone);
          return {
            hour: local.hour,
            weekday: local.weekday,
            ageHours: (now - row.published_at) / 3600,
            percentile: row.percentile,
            score: row.score,
          };
        });
        // The same age adjustment the chart applied, so the examples are the
        // items that actually lifted the bar rather than the recent ones.
        const { values } = ageAdjusted(samples);
        matched = rows.flatMap((row, i) => {
          const sample = samples[i];
          if (sample === undefined || assignTimingBucket(group, sample) !== bucket) return [];
          return [{ id: row.id, value: values[i] ?? 0 }];
        });
      } else if (dimension === 'thumbnail') {
        const hours = int(params, 'hours', 336, 1, 8760);
        const samples = repo.mediaSamples({
          sinceTs: now - hours * 3600,
          languages,
          sources,
          minConfidence,
          limit: 20000,
        });
        matched = samples.flatMap((row) => {
          const sample = { ...row, contentType: row.content_type };
          if (assignThumbnailBucket(group, sample) !== bucket) return [];
          measured.set(sample.id, {
            brightness: sample.brightness,
            contrast: sample.contrast,
            saturation: sample.saturation,
            warmth: sample.warmth,
            skin: sample.skin,
            density: sample.density,
          });
          return [{ id: sample.id, value: sample.percentile }];
        });
      } else {
        const hours = int(params, 'hours', 336, 1, 8760);
        const rows = repo.formatSamples({
          sinceTs: now - hours * 3600,
          languages,
          countries,
          sources,
          contentTypes,
          minConfidence,
          limit: 20000,
        });
        matched = rows.flatMap((row) =>
          matchesFormatBucket(group, bucket, {
            title: row.title,
            contentType: row.content_type,
            lang: row.lang,
            percentile: row.percentile,
            score: row.score,
          })
            ? [{ id: row.id, value: row.percentile }]
            : [],
        );
      }

      // `n` is the whole bucket, not the page: "6 of 214" reads very
      // differently from a list that looks like the bucket held six items.
      const total = matched.length;
      if (total === 0) return { dimension, group, bucket, n: 0, items: [], measures: {} };

      matched.sort((a, b) => b.value - a.value);
      const top = matched.slice(0, limit);

      // Archived items count towards the bar, so they appear here too.
      // Examples that quietly leave out part of what was measured are not
      // examples of that measurement.
      const byId = new Map(
        repo
          .rankedContent({
            ids: top.map((m) => m.id),
            limit: top.length,
            offset: 0,
            archived: 'include',
          })
          .map((row) => [row.id, toTrendItem(row)] as const),
      );

      // Kept in the order the analysis ranks them, which is not the order the
      // ranked read returns.
      const items = top.flatMap((m) => {
        const item = byId.get(m.id);
        return item === undefined ? [] : [item];
      });

      return {
        dimension,
        group,
        bucket,
        n: total,
        items,
        // Only for what is actually shown. The map is keyed by id rather than
        // merged into the items so the item shape stays the one every other
        // endpoint returns.
        measures: Object.fromEntries(
          items.flatMap((item) => {
            const m = measured.get(item.id);
            return m === undefined ? [] : [[item.id, m] as const];
          }),
        ),
      };
    },

    /**
     * Which tags to put on a post about a given subject.
     *
     * The seed selects the posts; the answer is about their *other* tags. That
     * ordering is what stops it from reporting `#shorts` every time: popularity
     * is not the question, performance among posts about this subject is.
     *
     * A minimum is enforced on the matched set before anything is reported. A
     * word that found nine posts can produce a tag with a forty-point lift and
     * it would mean nothing, and a page that shows a number for every input
     * teaches people to trust numbers that were never earned.
     */
    tags(params) {
      const seed = (params.get('q') ?? '').trim();
      if (seed === '') throw err.validation('A word to search for is required');
      if (seed.length > 80) throw err.validation('That is too long to be a tag or a word');

      const hours = int(params, 'hours', 720, 1, 8760);
      const minConfidence = num(params, 'minConfidence', 0.3, 0, 1);
      const rows = repo.tagSamples({
        seed,
        sinceTs: nowSec() - hours * 3600,
        languages: resolveLanguages(params),
        countries: csv(params, 'country'),
        sources: csv(params, 'source'),
        minConfidence,
        limit: 20000,
      });

      const samples: TagSample[] = rows.map((row) => ({
        tags: jsonArray(row.hashtags),
        creatorId: row.author_id,
        percentile: row.percentile,
        score: row.score,
        views: row.views,
        carriesSeed: row.carries_seed === 1,
      }));

      const analysis = analyzeTags(seed, samples);

      // A search that found nothing usable should hand back a next step rather
      // than a dead end. Only computed when it is needed: on a normal search
      // this scan never runs.
      const suggestions =
        analysis.n < 40
          ? repo.tagSuggestions({
              seed,
              sinceTs: nowSec() - hours * 3600,
              languages: resolveLanguages(params),
              sources: csv(params, 'source'),
              limit: 12,
            })
          : { matching: [], popular: [] };

      // A word like this finds hundreds of tags, almost all of them used once
      // by one person. Those are not context, they are noise, and shipping
      // them makes the useful rows harder to find and the response large. The
      // floor and the count are both reported so the trim is visible rather
      // than looking like the whole answer.
      const minPosts = int(params, 'minPosts', 3, 1, 1000);
      const limit = int(params, 'limit', 40, 1, 200);
      const shown = analysis.tags.filter((t) => t.n >= minPosts).slice(0, limit);

      return {
        windowHours: hours,
        minConfidence,
        ...analysis,
        tags: shown,
        minPosts,
        /** Distinct tags found on the matched posts, before the floor. */
        totalTags: analysis.tags.length,
        // Which of the two lists is filled says what kind of miss this was:
        // a word written differently, or a word this database simply has
        // nothing about.
        suggestions,
        /** Below this, only an exact tag is matched — never a title. */
        minTextSearch: repo.MIN_TEXT_SEARCH,
      };
    },

    /**
     * What people are searching for and nothing here has covered.
     *
     * Two source groups are compared rather than one analysed: searches on one
     * side, things that exist on the other. Which sources count as which is a
     * parameter, because "demand" and "supply" are roles a source plays rather
     * than properties it has — Google Trends is a search feed here, and would
     * be supply to somebody studying search itself.
     *
     * The window is short by default. A gap from a month ago is not an
     * opportunity, it is a thing that has already been made or already passed.
     */
    async gaps(params) {
      const hours = int(params, 'hours', 168, 1, 8760);
      const since = nowSec() - hours * 3600;
      const languages = resolveLanguages(params);

      const demandSources = csv(params, 'demand') ?? ['googletrends'];
      const supplySources = csv(params, 'supply') ?? ['youtube'];

      // A typed subject replaces the trending feed as the demand side. The
      // trending list answers "what is hot and uncovered"; this answers "my
      // idea — has anyone here made it", which is the question somebody
      // actually arrives with.
      const asked = (params.get('q') ?? '').trim();
      if (asked.length > 200) throw err.validation('That is too long to search for');

      const demandRows = asked === ''
        ? repo.demandTopics({
            sinceTs: since,
            sources: demandSources,
            languages,
            countries: csv(params, 'country'),
            limit: int(params, 'topics', 60, 1, 200),
          })
        : [];

      // Capped hard. Every topic is compared against every item, so this is the
      // one number that decides whether the page answers in a moment or in a
      // minute; 4000 items against 60 topics is a few hundred million
      // multiply-adds, which is fine, and ten times that is not.
      const supplyRows = repo.supplyItems({
        sinceTs: since,
        sources: supplySources,
        languages,
        limit: int(params, 'supply_limit', 4000, 100, 20000),
      });

      const { fromBlob } = await import('../ai/embed.ts');
      const model = config.embed.model;
      const vectors =
        model === ''
          ? new Map<string, Uint8Array>()
          : repo.embeddingsFor(
              [...demandRows.map((r) => r.id), ...supplyRows.map((r) => r.id)],
              model,
            );
      const vectorOf = (id: string): Float32Array | null => {
        const blob = vectors.get(id);
        return blob === undefined ? null : fromBlob(blob);
      };

      /**
       * The vector for a subject nobody has stored one for.
       *
       * One short embedding call, made only when something was typed. It fails
       * to null rather than throwing: a model that is unreachable should drop
       * this search to word matching, which the page then says it did, not
       * turn a search box into an error.
       */
      let askedVector: Float32Array | null = null;
      if (asked !== '' && model !== '') {
        const { embedTexts } = await import('../ai/embed.ts');
        const vectors = await embedTexts([asked]);
        askedVector = vectors?.[0] ?? null;
      }

      const demand =
        asked === ''
          ? demandRows.map((row) => ({
              id: row.id,
              title: row.title,
              score: round(row.score, 1) ?? 0,
              lang: row.lang,
              country: row.country,
              firstSeenAt: row.first_seen_at,
              vector: vectorOf(row.id),
            }))
          : [
              {
                id: 'asked',
                title: asked,
                // No trending score exists for something a person typed, and
                // inventing one would put a made-up number on the page.
                score: 0,
                lang: null,
                country: null,
                firstSeenAt: nowSec(),
                vector: askedVector,
              },
            ];

      const analysis = findGaps(
        demand,
        supplyRows.map((row) => ({
          id: row.id,
          title: row.title,
          url: row.url,
          percentile: row.percentile,
          vector: vectorOf(row.id),
        })),
      );

      return {
        windowHours: hours,
        demandSources,
        supplySources,
        asked,
        // Reported so the page can say what a gap is a gap *in*. Comparing US
        // searches against Persian videos produces a page full of gaps that
        // are really a configuration mistake, and the numbers are how that
        // becomes visible.
        demandLanguages: countBy(demandRows.map((r) => r.lang)),
        supplyLanguages: countBy(supplyRows.map((r) => r.lang)),
        matchedByMeaning: asked === '' ? model !== '' : askedVector !== null,
        // "No model" and "a model that did not answer" are different problems
        // with different fixes, and only one of them is the user's setting.
        // The trending list works either way, because both sides' vectors were
        // computed earlier and stored; only a typed subject needs the model
        // running right now.
        wordsBecause:
          asked !== '' && askedVector === null
            ? model === ''
              ? 'no-model'
              : 'unreachable'
            : null,
        ...analysis,
      };
    },

    /** Distinct values actually present, so a filter never offers a dead end. */
    facets() {
      return repo.availableFacets();
    },

    creators(params) {
      const limit = int(params, 'limit', 50, 1, 200);
      const hours = int(params, 'hours', 168, 1, 8760);
      const orderRaw = params.get('sort') ?? 'best';
      const orderBy = (['best', 'breakouts', 'items'] as const).find((o) => o === orderRaw) ?? 'best';
      return { items: repo.topCreators(limit, nowSec() - hours * 3600, orderBy) };
    },

    settings() {
      return {
        envFileExists: envFileExists(),
        fields: readSettings(),
      };
    },

    saveSettings(body: unknown) {
      if (typeof body !== 'object' || body === null) {
        throw err.validation('Expected an object of setting keys and values');
      }
      const updates: Record<string, string> = {};
      for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
        if (value === null || value === undefined) continue;
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
          throw err.validation(`${key} must be a string, number or boolean`);
        }
        updates[key] = String(value);
      }
      const applied = writeSettings(updates);
      repo.appendEvent('settings.updated', null, null, { keys: applied });

      // Applied now, not at the next restart. Everything that reads
      // `config.x.y` when it needs it — which is everything — sees the new
      // value from here on, and the jobs are rebuilt so a changed interval
      // takes effect too.
      const reload = reloadSettings();
      if (!reload.ok) {
        // The file is written but the values do not validate, so the running
        // configuration was left alone. Saying so is the whole point: silently
        // keeping the old values would look like the save did nothing.
        return {
          applied,
          live: false,
          problems: reload.problems,
          restartRequired: [],
        };
      }
      scheduler?.reload();

      // Named individually rather than as a blanket warning. Telling someone
      // to restart after every change trains them to ignore the message; the
      // three that genuinely need it stay meaningful.
      const restartRequired = applied
        .filter((key) => key in RESTART_REQUIRED)
        .map((key) => ({ key, why: RESTART_REQUIRED[key] as string }));

      return { applied, live: true, problems: [], restartRequired };
    },

    /**
     * Whether semantic clustering is on, and whether it is trusted.
     *
     * "Configured" and "working" are different questions here, and the gap
     * between them is the whole reason the check exists: a model can load,
     * answer instantly, and still be useless in the user's language. Both
     * answers are reported.
     */
    async embeddingStatus() {
      const model = config.embed.model;
      if (model === '') {
        return { enabled: false, model: '', verified: false, dims: 0, languages: [], coverage: null };
      }

      const { verifyEmbedding } = await import('../ai/probe.ts');
      const verdict = await verifyEmbedding(config.languages);
      return {
        enabled: true,
        model,
        verified: verdict.ok,
        dims: verdict.dims,
        error: verdict.error,
        minSeparation: verdict.minSeparation,
        languages: verdict.languages,
        untested: verdict.untested,
        mergeThreshold: config.embed.mergeThreshold,
        coverage: repo.embeddingCoverage(model),
      };
    },

    /** Whether subject matching is on, and how much of the corpus it covers. */
    interests() {
      const text = config.interests.trim();
      if (text === '') {
        return { enabled: false, interests: '', reason: 'INTERESTS is empty', coverage: null };
      }
      if (config.embed.model === '') {
        return {
          enabled: false,
          interests: text,
          reason: 'matching needs an embedding model; set EMBED_MODEL',
          coverage: null,
        };
      }
      return { enabled: true, interests: text, reason: null, coverage: repo.relevanceCoverage() };
    },

    /** What the notifier would send right now, and where it would go. */
    notifyStatus() {
      const ready = (id: string): boolean =>
        id === 'telegram'
          ? config.notify.telegramBotToken !== '' && config.notify.telegramChatId !== ''
          : id === 'webhook'
            ? config.notify.webhookUrl !== ''
            : false;

      const configured = config.notify.channels.filter(ready);
      return {
        enabled: configured.length > 0,
        channels: configured,
        // Switched on but missing a token or a URL. Worth surfacing on its own:
        // otherwise this silently sends nothing and looks like it is working.
        incomplete: config.notify.channels.filter((id) => !ready(id)),
        kinds: config.notify.kinds,
        minScore: config.notify.minScore,
        minConfidence: config.notify.minConfidence,
        quietHours: config.notify.quietHours,
        intervalMin: config.notify.intervalMin,
      };
    },

    async notifyTest() {
      const { sendTest } = await import('../notify/index.ts');
      return sendTest();
    },

    triggerAnalyze() {
      if (scheduler !== null && scheduler.trigger('analyze')) return { queued: true };
      return analyze();
    },

    triggerCollect() {
      if (scheduler !== null && scheduler.trigger('discover')) return { queued: true };
      return { queued: false, reason: 'no scheduler running' };
    },
  };
}
