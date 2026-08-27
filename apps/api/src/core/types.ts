/**
 * Domain model.
 *
 * Pure TypeScript: no framework, no SQL, no HTTP. Everything below describes
 * *what the system is about*, not how it is stored or fetched. Infrastructure
 * depends on this file; this file depends on nothing.
 */

// ── Content ────────────────────────────────────────────────────────────────

export const CONTENT_TYPES = [
  'video',
  'short_video',
  'image',
  'text',
  'link',
  'topic',
  'audio',
  'unknown',
] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

/**
 * A metric a platform does not expose is `null`. It is never 0: "zero shares"
 * and "this platform has no concept of shares" are different facts and the
 * scoring engine must be able to tell them apart.
 */
export interface Metrics {
  readonly views: number | null;
  readonly likes: number | null;
  readonly comments: number | null;
  readonly shares: number | null;
  readonly reactions: number | null;
  /** Platform-native popularity number: upvotes, points, approximate traffic. */
  readonly nativeScore: number | null;
}

export const EMPTY_METRICS: Metrics = Object.freeze({
  views: null,
  likes: null,
  comments: null,
  shares: null,
  reactions: null,
  nativeScore: null,
});

export type MetricName = keyof Metrics;

export interface MetricSnapshot extends Metrics {
  readonly contentId: string;
  /** Epoch seconds, UTC. */
  readonly ts: number;
}

/** Where a piece of derived information came from. Never guessed silently. */
export interface Provenance {
  readonly value: string | null;
  readonly confidence: number | null;
  readonly source: string | null;
}

/** One item as a source plugin hands it over, before the core touches it. */
export interface RawContent {
  readonly sourceId: string;
  readonly externalId: string;
  readonly url: string;
  readonly title: string;
  readonly body?: string | null;
  readonly contentType: ContentType;
  readonly authorId?: string | null;
  readonly authorName?: string | null;
  readonly authorFollowers?: number | null;
  readonly authorUrl?: string | null;
  readonly thumbnailUrl?: string | null;
  /** Epoch seconds. `null` when the platform does not say - do not invent it. */
  readonly publishedAt: number | null;
  readonly publishedAtSource?: 'api' | 'feed' | 'estimated' | null;
  readonly metrics: Metrics;
  readonly hashtags?: readonly string[];
  /** Collection context, e.g. the region parameter that surfaced this item. */
  readonly region?: string | null;
  readonly country?: Provenance | null;
  /** Extra payload kept for provenance; trimmed before storage. */
  readonly raw?: Record<string, unknown>;
}

/** A stored item, after normalisation and enrichment. */
export interface Content {
  readonly id: string;
  readonly source: string;
  readonly externalId: string;
  readonly url: string;
  readonly canonicalUrl: string | null;
  readonly title: string;
  readonly body: string | null;
  readonly contentType: ContentType;
  readonly authorId: string | null;
  readonly authorName: string | null;
  readonly thumbnailUrl: string | null;
  readonly lang: string | null;
  readonly langConfidence: number | null;
  readonly country: string | null;
  readonly countryConfidence: number | null;
  readonly countrySource: string | null;
  readonly publishedAt: number | null;
  readonly publishedAtSource: string | null;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly region: string | null;
  readonly keywords: readonly string[];
  readonly hashtags: readonly string[];
  readonly simhash: string | null;
}

// ── Trend lifecycle ────────────────────────────────────────────────────────

export const TREND_STATES = [
  'NEW',
  'EMERGING',
  'RISING',
  'HOT',
  'VIRAL',
  'PEAK',
  'DECLINING',
  'DEAD',
] as const;
export type TrendState = (typeof TREND_STATES)[number];

/** Display order, most interesting first. */
export const TREND_STATE_RANK: Record<TrendState, number> = {
  VIRAL: 0,
  HOT: 1,
  EMERGING: 2,
  RISING: 3,
  PEAK: 4,
  NEW: 5,
  DECLINING: 6,
  DEAD: 7,
};

/** The individual signals behind a score, kept separate so a score is explainable. */
export interface TrendSignals {
  /** Primary metric gained per hour. `null` until there are two observations. */
  readonly velocity: number | null;
  /** Change in velocity per hour. The single most informative signal. */
  readonly acceleration: number | null;
  readonly engagementRate: number | null;
  /** current / creator median. `null` without a creator baseline. */
  readonly creatorAnomaly: number | null;
  /** 0..1 rank of the *growth rate* against this source's own distribution. */
  readonly sourcePercentile: number | null;
  /** 0..1 rank of the *absolute size* against this source's own distribution. */
  readonly popularity: number | null;
  /** 0..1 time decay. */
  readonly freshness: number;
  /** 0..1, how many independent sources carry the same story. */
  readonly crossSource: number;
}

export interface TrendScore {
  /** 0..100, comparable across platforms because each part is normalised first. */
  readonly score: number;
  /** 0..1. How much evidence backs the score. Never confused with popularity. */
  readonly confidence: number;
  readonly state: TrendState;
  readonly signals: TrendSignals;
  readonly primaryMetric: MetricName;
  readonly primaryValue: number | null;
  readonly observations: number;
  readonly ageHours: number | null;
  readonly scoringVersion: number;
}

// ── Creators ───────────────────────────────────────────────────────────────

export interface CreatorBaseline {
  readonly id: string;
  readonly source: string;
  readonly externalId: string;
  readonly name: string | null;
  readonly followers: number | null;
  readonly medianMetric: number | null;
  readonly p90Metric: number | null;
  readonly p99Metric: number | null;
  readonly sampleCount: number;
}

export interface CreatorBreakout {
  readonly creatorId: string;
  readonly contentId: string;
  readonly anomalyRatio: number;
  readonly baseline: number;
  readonly observed: number;
  readonly detectedAt: number;
}

// ── Clusters ───────────────────────────────────────────────────────────────

export interface Cluster {
  readonly id: string;
  readonly label: string;
  readonly labelSource: 'keywords' | 'ai';
  readonly keywords: readonly string[];
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly itemCount: number;
  readonly sourceCount: number;
  readonly sources: readonly string[];
  readonly languages: readonly { code: string; pct: number }[];
  readonly countries: readonly { code: string; pct: number }[];
  readonly score: number;
  readonly confidence: number;
  readonly velocity: number | null;
  readonly acceleration: number | null;
  readonly state: TrendState;
  readonly totalViews: number | null;
  readonly totalEngagement: number | null;
  readonly explanation: string | null;
}

// ── Source health ──────────────────────────────────────────────────────────

export const SOURCE_STATUSES = [
  'UP',
  'DEGRADED',
  'RATE_LIMITED',
  'AUTH_REQUIRED',
  'CONFIGURATION_REQUIRED',
  'CAPTCHA_REQUIRED',
  'BLOCKED',
  'ERROR',
  'DISABLED',
] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export interface SourceHealth {
  readonly source: string;
  readonly status: SourceStatus;
  readonly lastRunAt: number | null;
  readonly lastOkAt: number | null;
  readonly lastError: string | null;
  readonly lastErrorKind: string | null;
  readonly consecutiveFailures: number;
  readonly itemsLastRun: number;
  readonly totalItems: number;
  readonly reliability: number;
}

// ── Manual intervention ────────────────────────────────────────────────────

export const INTERVENTION_TYPES = [
  'CAPTCHA',
  'LOGIN',
  'MFA',
  'CONSENT',
  'SESSION_EXPIRED',
  'CONFIGURATION',
] as const;
export type InterventionType = (typeof INTERVENTION_TYPES)[number];

export interface ManualIntervention {
  readonly id: string;
  readonly source: string;
  readonly type: InterventionType;
  readonly message: string;
  readonly url: string | null;
  readonly status: 'OPEN' | 'RESOLVED' | 'DISMISSED';
  readonly createdAt: number;
  readonly resolvedAt: number | null;
}

// ── Query filters (all optional - discovery never requires a topic) ────────

export interface TrendFilters {
  readonly sources?: readonly string[];
  readonly languages?: readonly string[];
  readonly countries?: readonly string[];
  readonly contentTypes?: readonly ContentType[];
  readonly states?: readonly TrendState[];
  readonly minScore?: number;
  readonly maxAgeHours?: number;
  readonly creator?: string;
  readonly hashtag?: string;
  /** Optional free-text narrowing. Never required. */
  readonly query?: string;
  readonly limit?: number;
  readonly cursor?: string | null;
}

// ── Small helpers used across layers ───────────────────────────────────────

/** Epoch seconds, UTC. The one clock the whole system agrees on. */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function hourBucket(tsSec: number): number {
  return Math.floor(tsSec / 3600) * 3600;
}
