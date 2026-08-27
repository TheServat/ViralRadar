/**
 * The trend engine.
 *
 * Pure functions over a metric time series. No I/O, no database, no clock of
 * its own - `now` is always passed in, which is what makes the whole engine
 * deterministically testable.
 *
 * The two ideas that carry the system:
 *   1. Never compare raw numbers across platforms. Every raw value is first
 *      turned into a rank against that platform's own recent distribution.
 *   2. Growth behaviour beats size. Acceleration is weighted as heavily as
 *      velocity, which is what surfaces a 1,200-follower account before it has
 *      finished exploding rather than a day later.
 */
import type {
  CreatorBaseline,
  MetricName,
  MetricSnapshot,
  Metrics,
  TrendScore,
  TrendSignals,
  TrendState,
} from './types.ts';
import { anomalyRatio, clamp, decay, isNum, linearSlope, logNormalise } from './stats.ts';

// ── Inputs ─────────────────────────────────────────────────────────────────

/** Quantiles of one source's own recent distribution, used for normalisation. */
export interface Quantiles {
  readonly p50: number | null;
  readonly p75: number | null;
  readonly p90: number | null;
  readonly p99: number | null;
  readonly sampleCount: number;
}

export interface ScoringWeights {
  readonly velocity: number;
  readonly acceleration: number;
  readonly anomaly: number;
  readonly engagement: number;
  readonly crossSource: number;
  readonly freshness: number;
}

export interface ScoringOptions {
  readonly weights: ScoringWeights;
  readonly maxAgeHours: number;
  readonly freshnessHalfLifeHours: number;
  readonly version: number;
}

export interface ScoreInput {
  /** Epoch seconds. Passed in, never read from the system clock. */
  readonly now: number;
  readonly publishedAt: number | null;
  readonly firstSeenAt: number;
  /** Ascending by ts. Fewer than two points means growth is simply unknown. */
  readonly snapshots: readonly MetricSnapshot[];
  /** Which metric this platform actually leads with. */
  readonly primaryMetric: MetricName;
  /**
   * Engagement rate that counts as excellent on this platform. YouTube likes
   * per view peak around 8%; Reddit comments per upvote run far higher.
   */
  readonly engagementReference: number;
  readonly creator: CreatorBaseline | null;
  /** Distribution of *velocity* across this source's recent items. */
  readonly velocityQuantiles: Quantiles | null;
  /** Distribution of the *absolute primary metric* across this source. */
  readonly valueQuantiles: Quantiles | null;
  /** How many distinct sources currently carry the same story (1 = only this). */
  readonly crossSourceCount: number;
  /** 0..1 health of the source, folded into confidence but never into score. */
  readonly sourceReliability: number;
  /** Highest score this item has ever reached, for PEAK / DECLINING detection. */
  readonly previousPeakScore: number | null;
  readonly options: ScoringOptions;
}

// ── Metric series helpers ──────────────────────────────────────────────────

interface Point {
  readonly hours: number;
  readonly value: number;
}

function seriesOf(snapshots: readonly MetricSnapshot[], metric: MetricName, now: number): Point[] {
  const pts: Point[] = [];
  for (const s of snapshots) {
    const v = s[metric];
    if (isNum(v)) pts.push({ hours: (s.ts - now) / 3600, value: v });
  }
  return pts.sort((a, b) => a.hours - b.hours);
}

/**
 * Growth of the primary metric per hour.
 *
 * Uses a least-squares slope over the most recent points rather than a single
 * last-minus-previous delta: platform counters are noisy and often update in
 * steps, and one lagging refresh should not read as a stall.
 */
export function velocityOf(points: readonly Point[], window = 5): number | null {
  if (points.length < 2) return null;
  const recent = points.slice(-window);
  const slope = linearSlope(
    recent.map((p) => p.hours),
    recent.map((p) => p.value),
  );
  if (slope !== null) return slope;
  const a = recent[recent.length - 2] as Point;
  const b = recent[recent.length - 1] as Point;
  const dt = b.hours - a.hours;
  return dt > 0 ? (b.value - a.value) / dt : null;
}

export interface AccelerationResult {
  /** Change in velocity per hour, in raw metric units. */
  readonly perHour: number | null;
  /** Recent velocity divided by earlier velocity. 4 means "4x faster now". */
  readonly ratio: number | null;
  readonly recentVelocity: number | null;
  readonly earlierVelocity: number | null;
}

/**
 * Split the series in half and compare the two growth rates. This is what turns
 * 2K -> 8K -> 35K -> 180K into a signal instead of just a big number.
 */
export function accelerationOf(points: readonly Point[]): AccelerationResult {
  const none: AccelerationResult = {
    perHour: null,
    ratio: null,
    recentVelocity: null,
    earlierVelocity: null,
  };
  if (points.length < 3) return none;

  const mid = Math.floor(points.length / 2);
  const earlier = points.slice(0, mid + 1);
  const recent = points.slice(mid);
  const v1 = velocityOf(earlier, earlier.length);
  const v2 = velocityOf(recent, recent.length);
  if (v1 === null || v2 === null) return none;

  const midEarlier = ((earlier[0] as Point).hours + (earlier[earlier.length - 1] as Point).hours) / 2;
  const midRecent = ((recent[0] as Point).hours + (recent[recent.length - 1] as Point).hours) / 2;
  const dt = midRecent - midEarlier;

  return {
    perHour: dt > 0 ? (v2 - v1) / dt : null,
    // +1 keeps the ratio defined when an item starts from a standstill.
    ratio: (v2 + 1) / (Math.max(v1, 0) + 1),
    recentVelocity: v2,
    earlierVelocity: v1,
  };
}

/**
 * Engagement relative to reach. Only computed from metrics the platform
 * actually exposes; a missing metric yields `null`, never a fabricated 0.
 */
export function engagementRateOf(latest: Metrics | null, primaryMetric: MetricName): number | null {
  if (latest === null) return null;
  const interactions = [latest.likes, latest.comments, latest.shares, latest.reactions].filter(isNum);
  if (interactions.length === 0) return null;
  const total = interactions.reduce((a, b) => a + b, 0);

  const base = isNum(latest.views)
    ? latest.views
    : primaryMetric !== 'views' && isNum(latest[primaryMetric])
      ? (latest[primaryMetric] as number)
      : null;

  if (base === null || base <= 0) return null;
  return total / base;
}

/** Rank a value inside a distribution described only by its quantiles. */
export function percentileFromQuantiles(value: number, q: Quantiles | null): number | null {
  if (q === null || q.sampleCount < 8 || !isNum(value)) return null;
  const points: readonly (readonly [number, number])[] = [
    [0, 0],
    [q.p50 ?? 0, 0.5],
    [q.p75 ?? q.p50 ?? 0, 0.75],
    [q.p90 ?? q.p75 ?? 0, 0.9],
    [q.p99 ?? q.p90 ?? 0, 0.99],
  ];
  if (value <= 0) return 0;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1] as readonly [number, number];
    const [x1, y1] = points[i] as readonly [number, number];
    if (value <= x1) {
      if (x1 === x0) return y1;
      return clamp(y0 + ((value - x0) / (x1 - x0)) * (y1 - y0), 0, 1);
    }
  }
  // Above p99: approach 1 asymptotically instead of saturating instantly.
  const top = q.p99 ?? q.p90 ?? 1;
  return clamp(0.99 + 0.01 * (1 - 1 / (1 + Math.log1p(value / Math.max(top, 1)))), 0, 1);
}

// ── Normalisation of each signal into 0..1 ─────────────────────────────────

/** log2(ratio)/3: 2x faster -> 0.33, 4x -> 0.67, 8x or more -> 1. */
export function normaliseAcceleration(ratio: number | null): number | null {
  if (ratio === null || !isNum(ratio) || ratio <= 0) return null;
  return clamp(Math.log2(ratio) / 3, 0, 1);
}

/** log10(ratio)/2: 10x a creator's normal -> 0.5, 100x -> 1. */
export function normaliseAnomaly(ratio: number | null): number | null {
  if (ratio === null || !isNum(ratio) || ratio <= 0) return null;
  return clamp(Math.log10(ratio) / 2, 0, 1);
}

export function normaliseEngagement(rate: number | null, reference: number): number | null {
  if (rate === null || !isNum(rate) || rate < 0) return null;
  const ref = reference > 0 ? reference : 0.05;
  return clamp(rate / ref, 0, 1);
}

/** 1 source -> 0, 2 -> 0.33, 3 -> 0.67, 4 or more -> 1. */
export function normaliseCrossSource(count: number): number {
  if (!isNum(count) || count <= 1) return 0;
  return clamp((count - 1) / 3, 0, 1);
}

// ── The score ──────────────────────────────────────────────────────────────

interface Component {
  readonly weight: number;
  readonly value: number | null;
}

/**
 * Weighted mean over the signals that are actually available.
 *
 * Renormalising over present signals matters: Reddit exposes no view count, so
 * an engagement rate is often unknowable there. Treating that as a zero would
 * quietly punish an entire platform for what its API does not return.
 */
function combine(components: readonly Component[]): { value: number; coverage: number } {
  let weighted = 0;
  let available = 0;
  let total = 0;
  for (const c of components) {
    total += c.weight;
    if (c.value !== null) {
      weighted += c.weight * clamp(c.value, 0, 1);
      available += c.weight;
    }
  }
  if (available === 0) return { value: 0, coverage: 0 };
  return { value: weighted / available, coverage: total === 0 ? 0 : available / total };
}

export function scoreContent(input: ScoreInput): TrendScore {
  const { options } = input;
  const points = seriesOf(input.snapshots, input.primaryMetric, input.now);
  const latest = input.snapshots.length > 0 ? (input.snapshots[input.snapshots.length - 1] as Metrics) : null;
  const primaryValue = points.length > 0 ? (points[points.length - 1] as Point).value : null;

  const referenceTime = input.publishedAt ?? input.firstSeenAt;
  const ageHours = isNum(referenceTime) ? Math.max((input.now - referenceTime) / 3600, 0) : null;

  const velocity = velocityOf(points);
  const accel = accelerationOf(points);
  const engagementRate = engagementRateOf(latest, input.primaryMetric);

  const creatorAnomaly =
    primaryValue !== null && input.creator !== null
      ? anomalyRatio(primaryValue, input.creator.medianMetric)
      : null;

  const sourcePercentile =
    velocity !== null ? percentileFromQuantiles(velocity, input.velocityQuantiles) : null;
  const popularity =
    primaryValue !== null ? percentileFromQuantiles(primaryValue, input.valueQuantiles) : null;

  const freshness = ageHours === null ? 0.5 : decay(ageHours, options.freshnessHalfLifeHours);
  const crossSource = normaliseCrossSource(input.crossSourceCount);

  // Velocity normalisation: prefer the platform's own distribution; fall back to
  // a log curve anchored on its median when there is not enough history yet.
  const nVelocity =
    sourcePercentile !== null
      ? sourcePercentile
      : velocity !== null && velocity > 0
        ? logNormalise(velocity, input.velocityQuantiles?.p50 ?? Math.max(velocity, 1))
        : velocity !== null
          ? 0
          : null;

  const nAcceleration = normaliseAcceleration(accel.ratio);
  const nAnomaly =
    normaliseAnomaly(creatorAnomaly) ??
    // No creator baseline: fall back to how big this is for the platform.
    (popularity !== null ? clamp((popularity - 0.5) * 2, 0, 1) : null);
  const nEngagement = normaliseEngagement(engagementRate, input.engagementReference);

  const combined = combine([
    { weight: options.weights.velocity, value: nVelocity },
    { weight: options.weights.acceleration, value: nAcceleration },
    { weight: options.weights.anomaly, value: nAnomaly },
    { weight: options.weights.engagement, value: nEngagement },
    { weight: options.weights.crossSource, value: crossSource },
    { weight: options.weights.freshness, value: freshness },
  ]);

  // Past the configured horizon an item is history, not a trend.
  const ageGate = ageHours !== null && ageHours > options.maxAgeHours ? 0.35 : 1;
  // Thin evidence lowers the score itself, not just the confidence. An RSS
  // headline exposes no metrics at all; without this it would ride freshness
  // alone to the top of a chart next to a video with a real view counter.
  const evidenceGate = 0.55 + 0.45 * clamp(combined.coverage, 0, 1);
  const score = clamp(combined.value * 100 * ageGate * evidenceGate, 0, 100);

  const signals: TrendSignals = {
    velocity,
    acceleration: accel.perHour,
    engagementRate,
    creatorAnomaly,
    sourcePercentile,
    popularity,
    freshness,
    crossSource,
  };

  const confidence = confidenceOf({
    observations: points.length,
    spanHours: points.length >= 2 ? Math.abs((points[0] as Point).hours) : 0,
    lastObservationAgeHours:
      points.length > 0 ? Math.abs((points[points.length - 1] as Point).hours) : null,
    coverage: combined.coverage,
    sourceReliability: input.sourceReliability,
    crossSourceCount: input.crossSourceCount,
  });

  const state = classifyState({
    score,
    popularity,
    velocity,
    accelerationRatio: accel.ratio,
    normalisedAcceleration: nAcceleration,
    observations: points.length,
    ageHours,
    maxAgeHours: options.maxAgeHours,
    previousPeakScore: input.previousPeakScore,
  });

  return {
    score,
    confidence,
    state,
    signals,
    primaryMetric: input.primaryMetric,
    primaryValue,
    observations: points.length,
    ageHours,
    scoringVersion: options.version,
  };
}

// ── Confidence ─────────────────────────────────────────────────────────────

export interface ConfidenceInput {
  readonly observations: number;
  readonly spanHours: number;
  readonly lastObservationAgeHours: number | null;
  readonly coverage: number;
  readonly sourceReliability: number;
  readonly crossSourceCount: number;
}

/**
 * How much the score can be trusted - deliberately unrelated to how big the
 * numbers are. A 40M-view video observed once has a high score and low
 * confidence, and the dashboard should be able to say so.
 */
export function confidenceOf(c: ConfidenceInput): number {
  const observations = clamp(c.observations / 6, 0, 1);
  const span = clamp(c.spanHours / 6, 0, 1);
  const staleness =
    c.lastObservationAgeHours === null ? 0.5 : clamp(1 - c.lastObservationAgeHours / 6, 0, 1);
  const corroboration = clamp((c.crossSourceCount - 1) / 3, 0, 1);

  const value =
    0.3 * observations +
    0.2 * span +
    0.2 * staleness +
    0.15 * clamp(c.coverage, 0, 1) +
    0.15 * corroboration;

  return clamp(value * clamp(c.sourceReliability, 0.2, 1) + 0.05, 0, 1);
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

export interface ClassifyInput {
  readonly score: number;
  readonly popularity: number | null;
  readonly velocity: number | null;
  readonly accelerationRatio: number | null;
  readonly normalisedAcceleration: number | null;
  readonly observations: number;
  readonly ageHours: number | null;
  readonly maxAgeHours: number;
  readonly previousPeakScore: number | null;
}

/**
 * Lifecycle state.
 *
 * Score answers "how remarkable is the growth"; `popularity` answers "how big is
 * it in absolute terms for this platform". Keeping the two apart is what lets
 * EMERGING mean *small but exploding* rather than *slightly less viral*.
 */
export function classifyState(c: ClassifyInput): TrendState {
  const pop = c.popularity;
  const growing = c.velocity !== null && c.velocity > 0;
  const decelerating = c.accelerationRatio !== null && c.accelerationRatio < 0.6;

  if (c.ageHours !== null && c.ageHours > c.maxAgeHours && c.score < 40) return 'DEAD';

  // Not enough history to say anything about growth yet.
  if (c.observations < 2 || c.velocity === null) {
    return pop !== null && pop >= 0.95 ? 'HOT' : 'NEW';
  }

  if (!growing || decelerating) {
    const peak = c.previousPeakScore;

    // Measured twice with no change at all. That is "has not started moving",
    // not "is dying" - counters on several platforms only tick in steps, and
    // calling a ten-minute-old post DECLINING would be plainly wrong.
    const flat = c.velocity === 0;
    const neverPeaked = peak === null || peak <= c.score + 1;
    if (flat && neverPeaked) return (pop ?? 0) >= 0.9 ? 'PEAK' : 'NEW';

    if (c.score < 15) return 'DEAD';
    if (peak !== null && c.score < peak * 0.6) return 'DECLINING';
    if (peak !== null && c.score >= peak * 0.85 && (pop ?? 0) >= 0.75) return 'PEAK';
    return c.score >= 45 ? 'PEAK' : 'DECLINING';
  }

  const accelerating = (c.normalisedAcceleration ?? 0) >= 0.35;

  // Small but exploding: checked before the size-based states on purpose.
  if (accelerating && (pop === null || pop < 0.8) && c.score >= 45) return 'EMERGING';

  if (c.score >= 78 && (pop ?? 0) >= 0.9) return 'VIRAL';
  if (c.score >= 62 && (pop ?? 0) >= 0.7) return 'HOT';
  if (c.score >= 40) return 'RISING';
  return 'NEW';
}

// ── Creator breakout ───────────────────────────────────────────────────────

export interface BreakoutVerdict {
  readonly isBreakout: boolean;
  readonly ratio: number | null;
  readonly baseline: number | null;
}

/**
 * A creator breakout is an item performing far above what this account normally
 * does. Requires a real baseline: with three prior videos, "10x normal" is
 * noise, so a minimum sample is enforced rather than assumed.
 */
export function detectCreatorBreakout(
  observed: number | null,
  creator: CreatorBaseline | null,
  opts: { minSamples?: number; minRatio?: number } = {},
): BreakoutVerdict {
  const minSamples = opts.minSamples ?? 5;
  const minRatio = opts.minRatio ?? 5;
  if (observed === null || creator === null || creator.sampleCount < minSamples) {
    return { isBreakout: false, ratio: null, baseline: creator?.medianMetric ?? null };
  }
  const baseline = creator.medianMetric;
  const ratio = anomalyRatio(observed, baseline);
  if (ratio === null || baseline === null) {
    return { isBreakout: false, ratio: null, baseline };
  }
  // Also require clearing the creator's own p90, so a lucky spread of small
  // numbers around a tiny median cannot masquerade as a breakout.
  const clearsP90 = creator.p90Metric === null || observed >= creator.p90Metric;
  return { isBreakout: ratio >= minRatio && clearsP90, ratio, baseline };
}
