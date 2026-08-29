/**
 * REST handlers and the row -> DTO mapping.
 *
 * Filters are parsed here and applied by the repository *after* detection.
 * Nothing in this file can narrow what the radar looks at; the defaults are
 * all sources, all languages, all countries, all topics.
 */
import { config } from '../config.ts';
import * as repo from '../db/repo.ts';
import { allPlugins, statusOf } from '../sources/registry.ts';
import { collectOne } from '../pipeline/collect.ts';
import { analyze } from '../pipeline/analyze.ts';
import { networkState } from '../net/fetcher.ts';
import { dbStats } from '../db/repo.ts';
import { hourBucket, nowSec, TREND_STATES, type TrendState } from '../core/types.ts';
import type { Scheduler } from '../pipeline/scheduler.ts';
import { envFileExists, readSettings, writeSettings } from '../settings.ts';
import { analyzeFormats } from '../core/format.ts';
import { exportFilename, toCsv, toJson } from './export.ts';
import { analyzeTiming } from '../core/timing.ts';
import { analyzeThumbnails } from '../core/thumbnail.ts';
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

function page(rows: repo.RankedRow[], q: repo.RankedQuery): { items: TrendItemDto[]; nextOffset: number | null } {
  return {
    items: rows.map(toTrendItem),
    nextOffset: rows.length === q.limit ? q.offset + q.limit : null,
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
  readonly interests: () => unknown;
  readonly notifyStatus: () => unknown;
  readonly embeddingStatus: () => Promise<unknown>;
  readonly notifyTest: () => Promise<unknown>;
}

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

    interventions() {
      return { items: repo.listInterventions('OPEN') };
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
      return { windowHours: hours, minConfidence, coverage, ...analyzeThumbnails(samples) };
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
      // Configuration is read once at startup and frozen, so this is honest
      // rather than pretending the change is already live.
      return { applied, restartRequired: applied.length > 0 };
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
