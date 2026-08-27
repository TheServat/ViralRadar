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
  const orderBy = (['score', 'acceleration', 'velocity', 'recent', 'creator_anomaly'] as const).find((o) => o === orderRaw) ?? 'score';

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
  readonly notifyStatus: () => unknown;
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
