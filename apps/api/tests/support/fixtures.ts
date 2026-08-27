/**
 * Deterministic fixtures for the trend engine.
 *
 * Time is always explicit, so a test can describe "four hours of growth"
 * without waiting four hours or depending on when it runs.
 */
import type { MetricSnapshot, Metrics } from '../../src/core/types.ts';
import type { Quantiles, ScoringOptions } from '../../src/core/score.ts';

/** A fixed reference instant: 2026-01-01T12:00:00Z. */
export const NOW = 1_767_268_800;

export const OPTIONS: ScoringOptions = {
  weights: {
    velocity: 0.3,
    acceleration: 0.3,
    anomaly: 0.15,
    engagement: 0.1,
    crossSource: 0.1,
    freshness: 0.05,
  },
  maxAgeHours: 72,
  freshnessHalfLifeHours: 8,
  version: 1,
};

function metrics(partial: Partial<Metrics>): Metrics {
  return {
    views: partial.views ?? null,
    likes: partial.likes ?? null,
    comments: partial.comments ?? null,
    shares: partial.shares ?? null,
    reactions: partial.reactions ?? null,
    nativeScore: partial.nativeScore ?? null,
  };
}

/**
 * Builds a series ending at `now`, one point per hour, oldest first.
 * `series([2000, 8000, 35000, 180000])` is four hourly observations ending now.
 */
export function views(values: readonly number[], now = NOW, stepHours = 1): MetricSnapshot[] {
  const last = values.length - 1;
  return values.map((v, i) => ({
    contentId: 'fixture',
    ts: now - (last - i) * stepHours * 3600,
    ...metrics({ views: v, likes: Math.round(v * 0.04), comments: Math.round(v * 0.005) }),
  }));
}

/** A series with no engagement metrics at all, like a Telegram view counter. */
export function viewsOnly(values: readonly number[], now = NOW, stepHours = 1): MetricSnapshot[] {
  const last = values.length - 1;
  return values.map((v, i) => ({
    contentId: 'fixture',
    ts: now - (last - i) * stepHours * 3600,
    ...metrics({ views: v }),
  }));
}

/** Upvote-style series, like Reddit or Hacker News. */
export function points(values: readonly number[], now = NOW, stepHours = 1): MetricSnapshot[] {
  const last = values.length - 1;
  return values.map((v, i) => ({
    contentId: 'fixture',
    ts: now - (last - i) * stepHours * 3600,
    ...metrics({ nativeScore: v, comments: Math.round(v * 0.2) }),
  }));
}

/** A platform whose typical item gets ~10K views and grows ~2K/hour. */
export const TYPICAL_VALUE_QUANTILES: Quantiles = {
  p50: 10_000,
  p75: 40_000,
  p90: 120_000,
  p99: 900_000,
  sampleCount: 500,
};

export const TYPICAL_VELOCITY_QUANTILES: Quantiles = {
  p50: 2_000,
  p75: 8_000,
  p90: 25_000,
  p99: 150_000,
  sampleCount: 500,
};

/** A creator whose videos normally do 3,000 views. */
export const SMALL_CREATOR = {
  id: 'youtube:c1',
  source: 'youtube',
  externalId: 'c1',
  name: 'small channel',
  followers: 1_200,
  medianMetric: 3_000,
  p90Metric: 6_000,
  p99Metric: 9_000,
  sampleCount: 40,
};

/** A creator whose videos normally do 4,000,000 views. */
export const LARGE_CREATOR = {
  ...SMALL_CREATOR,
  id: 'youtube:c2',
  externalId: 'c2',
  name: 'large channel',
  followers: 40_000_000,
  medianMetric: 4_000_000,
  p90Metric: 9_000_000,
  p99Metric: 20_000_000,
};
