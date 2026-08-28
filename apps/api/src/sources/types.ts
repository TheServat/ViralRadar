/**
 * The source plugin contract.
 *
 * The core knows this file and nothing else about where data comes from.
 * Adding Bluesky or a news site means writing one module that satisfies
 * `SourcePlugin` and registering it - no change to the pipeline, the scoring
 * engine, the API or the dashboard.
 */
import type { ContentType, MetricName, Metrics, RawContent, SourceStatus } from '../core/types.ts';
import type { Logger } from '../logger.ts';
import type { InterventionType } from '../core/types.ts';

/**
 * What a platform can actually give us. The pipeline reads this instead of
 * assuming every source has views, likes and shares - most do not.
 */
export interface SourceCapabilities {
  readonly contentTypes: readonly ContentType[];
  /** Metrics this source can ever populate. Anything else stays NULL. */
  readonly metrics: readonly MetricName[];
  /** The metric that best represents "how much attention" on this platform. */
  readonly primaryMetric: MetricName;
  /** Engagement rate that counts as excellent here; used to normalise. */
  readonly engagementReference: number;
  readonly hasAuthor: boolean;
  readonly hasHashtags: boolean;
  readonly hasCountry: boolean;
  /** Can we ask for fresh metrics on items we already know? */
  readonly supportsRefresh: boolean;
  /** Does the platform expose a trending / popular listing? */
  readonly supportsTrending: boolean;
  readonly supportsSearch: boolean;
  /** Does the source hand us historical metrics, or only a current snapshot? */
  readonly supportsHistoricalMetrics: boolean;
  /** How much to trust its numbers, 0..1. Feeds trend confidence. */
  readonly baseReliability: number;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly status: SourceStatus;
  /** Human-readable, shown verbatim in the dashboard. */
  readonly message: string;
  /** Set when a person has to do something before this source can work. */
  readonly interventionType?: InterventionType;
  /** Where to go to fix it, e.g. the page that issues an API key. */
  readonly helpUrl?: string;
}

export const VALID: ValidationResult = Object.freeze({
  ok: true,
  status: 'UP' as SourceStatus,
  message: 'ready',
});

export function configurationRequired(message: string, helpUrl?: string): ValidationResult {
  return {
    ok: false,
    status: 'CONFIGURATION_REQUIRED',
    message,
    interventionType: 'CONFIGURATION',
    ...(helpUrl === undefined ? {} : { helpUrl }),
  };
}

export function disabled(message = 'not enabled in SOURCES_ENABLED'): ValidationResult {
  return { ok: false, status: 'DISABLED', message };
}

/**
 * Everything a plugin is allowed to touch. Passing this in - rather than
 * letting plugins import the database or the logger directly - is what keeps a
 * misbehaving source from reaching the rest of the application.
 */
/**
 * Small durable key-value store, namespaced per plugin.
 *
 * An adapter that has to remember something between runs - a rotation cursor,
 * an API quota already spent today - needs somewhere to put it. Handing it a
 * scoped store keeps that possible without handing it the database, and one
 * plugin cannot read or clobber another's keys.
 */
export interface PluginState {
  get(key: string): string | null;
  set(key: string, value: string): void;
  getNumber(key: string, fallback: number): number;
  setNumber(key: string, value: number): void;
}

export interface PluginContext {
  readonly logger: Logger;
  /** Epoch seconds. Injected so tests can freeze time. */
  readonly now: () => number;
  /** Regions the user cares about, e.g. ['US', 'DE']. May be empty. */
  readonly regions: readonly string[];
  /** Languages the user cares about; may be empty, meaning all of them. */
  readonly languages: readonly string[];
  readonly state: PluginState;
  /**
   * Creators this source has found that are measurably worth following.
   *
   * A fact about the system, handed over the same way `regions` is - not a
   * database handle. A source that can read a creator's new posts cheaply can
   * use this to stop paying for discovery it has already learned how to do.
   *
   * A function rather than an array because it costs a query, and a source that
   * has no cheap way to follow a creator should not pay for the answer.
   */
  readonly provenCreators: (limit: number) => readonly string[];
  /**
   * Which of these ids this source has already stored.
   *
   * For sources whose listing is free but whose detail call is not: a feed that
   * returns the same items until something changes should not be paid for twice.
   */
  readonly knownIds: (externalIds: readonly string[]) => ReadonlySet<string>;
  /** Raise a manual-intervention record. Never called to bypass anything. */
  readonly requireHuman: (type: InterventionType, message: string, url?: string) => void;
}

export interface RefreshRequest {
  readonly externalId: string;
  readonly url: string;
}

export interface RefreshResult {
  readonly externalId: string;
  readonly metrics: Metrics;
  /** Present when the refresh also learned a better follower count etc. */
  readonly authorFollowers?: number | null;
}

/**
 * One past post by a creator, used only to establish what is normal for them.
 *
 * Deliberately not `RawContent`: these are never scored, refreshed, clustered
 * or shown. Giving them a different type is what keeps a backfill of old
 * uploads from leaking into the trend feed.
 */
export interface CreatorSample {
  /** The creator's id inside the source, as it appears on their content. */
  readonly creatorExternalId: string;
  readonly itemExternalId: string;
  readonly metric: MetricName;
  readonly value: number;
  readonly publishedAt: number | null;
}

export interface SourcePlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly capabilities: SourceCapabilities;

  /** Checked before every run; cheap, no network. */
  validate(): ValidationResult;

  /**
   * Find candidates. Never takes a topic: discovery must work with no input at
   * all, which is the entire point of the product.
   */
  discover(ctx: PluginContext): Promise<readonly RawContent[]>;

  /** Re-read metrics for items already known. Optional; see capabilities. */
  refresh?(ctx: PluginContext, items: readonly RefreshRequest[]): Promise<readonly RefreshResult[]>;

  /**
   * Recent posts by these creators, for baselines only.
   *
   * Optional, and expected to be cheap: a source that can only answer this by
   * spending its whole quota should not implement it at all. Returning fewer
   * creators than asked for is normal and never an error.
   */
  creatorHistory?(ctx: PluginContext, creatorIds: readonly string[]): Promise<readonly CreatorSample[]>;

  /** Optional live check that actually touches the network. */
  healthCheck?(ctx: PluginContext): Promise<ValidationResult>;
}

/** Convenience for adapters: a metrics object with only what was measured. */
export function metricsOf(partial: Partial<Metrics>): Metrics {
  return {
    views: partial.views ?? null,
    likes: partial.likes ?? null,
    comments: partial.comments ?? null,
    shares: partial.shares ?? null,
    reactions: partial.reactions ?? null,
    nativeScore: partial.nativeScore ?? null,
  };
}

/** Parses an integer that an API may return as a string, or not at all. */
export function intOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  return null;
}

export type { RawContent };
