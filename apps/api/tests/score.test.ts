/**
 * The trend engine, tested against fixtures that describe recognisable
 * situations rather than arbitrary numbers. If these break, the product is
 * wrong even when the code compiles.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  accelerationOf,
  classifyState,
  confidenceOf,
  detectCreatorBreakout,
  engagementRateOf,
  normaliseAcceleration,
  normaliseAnomaly,
  normaliseCrossSource,
  percentileFromQuantiles,
  scoreContent,
  velocityOf,
  type ScoreInput,
} from '../src/core/score.ts';
import {
  LARGE_CREATOR,
  NOW,
  OPTIONS,
  points,
  SMALL_CREATOR,
  TYPICAL_VALUE_QUANTILES,
  TYPICAL_VELOCITY_QUANTILES,
  views,
  viewsOnly,
} from './support/fixtures.ts';

function input(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return {
    now: NOW,
    publishedAt: NOW - 4 * 3600,
    firstSeenAt: NOW - 4 * 3600,
    snapshots: views([2_000, 8_000, 35_000, 180_000]),
    primaryMetric: 'views',
    engagementReference: 0.08,
    creator: null,
    velocityQuantiles: TYPICAL_VELOCITY_QUANTILES,
    valueQuantiles: TYPICAL_VALUE_QUANTILES,
    crossSourceCount: 1,
    sourceReliability: 1,
    previousPeakScore: null,
    options: OPTIONS,
    ...overrides,
  };
}

describe('velocity', () => {
  test('is null with a single observation - growth is unknown, not zero', () => {
    assert.equal(velocityOf([{ hours: 0, value: 1000 }]), null);
  });

  test('measures gain per hour', () => {
    const v = velocityOf([
      { hours: -2, value: 1_000 },
      { hours: -1, value: 3_000 },
      { hours: 0, value: 5_000 },
    ]);
    assert.equal(v, 2_000);
  });

  test('is negative when a counter goes backwards', () => {
    const v = velocityOf([
      { hours: -1, value: 5_000 },
      { hours: 0, value: 4_000 },
    ]);
    assert.ok(v !== null && v < 0);
  });
});

describe('acceleration', () => {
  test('reads 2K -> 8K -> 35K -> 180K as strongly accelerating', () => {
    const series = views([2_000, 8_000, 35_000, 180_000]).map((s) => ({
      hours: (s.ts - NOW) / 3600,
      value: s.views as number,
    }));
    const accel = accelerationOf(series);
    assert.ok(accel.ratio !== null && accel.ratio > 4, `expected a large ratio, got ${accel.ratio}`);
    assert.ok(accel.perHour !== null && accel.perHour > 0);
    assert.equal(normaliseAcceleration(accel.ratio), 1);
  });

  test('reads steady linear growth as not accelerating', () => {
    const series = [1, 2, 3, 4, 5].map((n) => ({ hours: n - 5, value: n * 10_000 }));
    const accel = accelerationOf(series);
    assert.ok(accel.ratio !== null && accel.ratio > 0.9 && accel.ratio < 1.1, `ratio was ${accel.ratio}`);
    assert.ok((normaliseAcceleration(accel.ratio) ?? 1) < 0.1);
  });

  test('needs three points before it says anything', () => {
    assert.equal(accelerationOf([{ hours: -1, value: 1 }, { hours: 0, value: 2 }]).ratio, null);
  });
});

describe('engagement rate', () => {
  test('uses views as the denominator when the platform has them', () => {
    const rate = engagementRateOf(
      { views: 1000, likes: 50, comments: 30, shares: 20, reactions: null, nativeScore: null },
      'views',
    );
    assert.equal(rate, 0.1);
  });

  test('is null when the platform exposes no interactions at all', () => {
    const rate = engagementRateOf(
      { views: 1000, likes: null, comments: null, shares: null, reactions: null, nativeScore: null },
      'views',
    );
    assert.equal(rate, null);
  });

  test('falls back to the primary metric when there is no view count', () => {
    const rate = engagementRateOf(
      { views: null, likes: null, comments: 40, shares: null, reactions: null, nativeScore: 200 },
      'nativeScore',
    );
    assert.equal(rate, 0.2);
  });
});

describe('normalisation', () => {
  test('percentile interpolates inside the known quantiles', () => {
    assert.equal(percentileFromQuantiles(10_000, TYPICAL_VALUE_QUANTILES), 0.5);
    const high = percentileFromQuantiles(900_000, TYPICAL_VALUE_QUANTILES);
    assert.ok(high !== null && high >= 0.98);
  });

  test('percentile refuses to rank against too few samples', () => {
    assert.equal(percentileFromQuantiles(100, { p50: 1, p75: 2, p90: 3, p99: 4, sampleCount: 3 }), null);
  });

  test('creator anomaly: 10x normal is halfway, 100x is the top', () => {
    assert.equal(normaliseAnomaly(10), 0.5);
    assert.equal(normaliseAnomaly(100), 1);
    assert.equal(normaliseAnomaly(1), 0);
  });

  test('cross-source rises with independent corroboration', () => {
    assert.equal(normaliseCrossSource(1), 0);
    assert.ok(Math.abs((normaliseCrossSource(4) ?? 0) - 1) < 1e-9);
  });
});

describe('scoring', () => {
  test('an accelerating item scores high and is not merely popular', () => {
    const result = scoreContent(input());
    assert.ok(result.score > 70, `score was ${result.score}`);
    assert.ok(result.signals.acceleration !== null && result.signals.acceleration > 0);
    assert.equal(result.primaryMetric, 'views');
    assert.equal(result.observations, 4);
  });

  test('a small creator with a huge video beats a big creator with a normal one', () => {
    const breakout = scoreContent(
      input({ snapshots: views([2_000, 20_000, 90_000, 500_000]), creator: SMALL_CREATOR }),
    );
    const routine = scoreContent(
      input({
        snapshots: views([3_500_000, 3_700_000, 3_900_000, 4_100_000]),
        creator: LARGE_CREATOR,
      }),
    );
    assert.ok(
      breakout.score > routine.score,
      `breakout ${breakout.score} should beat routine ${routine.score}`,
    );
    assert.ok((breakout.signals.creatorAnomaly ?? 0) > 100);
  });

  test('a flat item is not treated as a trend', () => {
    const result = scoreContent(input({ snapshots: views([9_000, 9_000, 9_000, 9_000]) }));
    assert.ok(result.score < 45, `score was ${result.score}`);
    assert.ok(['NEW', 'DECLINING', 'PEAK', 'DEAD'].includes(result.state));
  });

  test('an item with no metrics at all cannot ride freshness to the top', () => {
    const result = scoreContent(
      input({
        snapshots: [
          { contentId: 'x', ts: NOW - 600, views: null, likes: null, comments: null, shares: null, reactions: null, nativeScore: null },
        ],
        primaryMetric: 'nativeScore',
        valueQuantiles: null,
        velocityQuantiles: null,
        publishedAt: NOW - 600,
      }),
    );
    assert.ok(result.score < 40, `an RSS-style item scored ${result.score}`);
    assert.ok(result.confidence < 0.5);
  });

  test('missing metrics lower the score but do not zero it', () => {
    const withEngagement = scoreContent(input());
    const viewsOnlyResult = scoreContent(input({ snapshots: viewsOnly([2_000, 8_000, 35_000, 180_000]) }));
    assert.ok(viewsOnlyResult.score > 40);
    assert.ok(viewsOnlyResult.score <= withEngagement.score + 5);
  });

  test('cross-platform corroboration raises the score', () => {
    const alone = scoreContent(input({ crossSourceCount: 1 }));
    const everywhere = scoreContent(input({ crossSourceCount: 4 }));
    assert.ok(everywhere.score > alone.score);
  });

  test('scores are reproducible', () => {
    assert.deepEqual(scoreContent(input()), scoreContent(input()));
  });

  test('an upvote-based source is scored on its own scale', () => {
    const result = scoreContent(
      input({
        snapshots: points([10, 60, 220, 700]),
        primaryMetric: 'nativeScore',
        engagementReference: 0.6,
        valueQuantiles: { p50: 12, p75: 45, p90: 160, p99: 900, sampleCount: 400 },
        velocityQuantiles: { p50: 4, p75: 20, p90: 80, p99: 400, sampleCount: 400 },
      }),
    );
    assert.ok(result.score > 70, `score was ${result.score}`);
  });
});

describe('lifecycle', () => {
  const base = {
    popularity: 0.5,
    velocity: 1000,
    accelerationRatio: 2,
    normalisedAcceleration: 0.5,
    observations: 4,
    ageHours: 3,
    maxAgeHours: 72,
    previousPeakScore: null,
  };

  test('small but exploding is EMERGING, not merely RISING', () => {
    assert.equal(classifyState({ ...base, score: 60, popularity: 0.4 }), 'EMERGING');
  });

  test('big and still growing is VIRAL', () => {
    assert.equal(
      classifyState({ ...base, score: 85, popularity: 0.95, normalisedAcceleration: 0.2 }),
      'VIRAL',
    );
  });

  test('one observation cannot be more than NEW', () => {
    assert.equal(classifyState({ ...base, score: 90, observations: 1, velocity: null, popularity: 0.5 }), 'NEW');
  });

  test('past its peak is DECLINING', () => {
    assert.equal(
      classifyState({ ...base, score: 30, velocity: -50, accelerationRatio: 0.2, previousPeakScore: 90 }),
      'DECLINING',
    );
  });

  test('old and low is DEAD', () => {
    assert.equal(classifyState({ ...base, score: 10, ageHours: 200, velocity: -1 }), 'DEAD');
  });

  test('measured twice with no movement is NEW, not DECLINING', () => {
    assert.equal(classifyState({ ...base, score: 38, velocity: 0, accelerationRatio: 1, popularity: 0.3 }), 'NEW');
  });
});

describe('creator breakout', () => {
  test('fires when an item dwarfs the creator baseline', () => {
    const verdict = detectCreatorBreakout(1_200_000, SMALL_CREATOR);
    assert.equal(verdict.isBreakout, true);
    assert.ok((verdict.ratio ?? 0) > 200);
  });

  test('does not fire on a normal upload', () => {
    assert.equal(detectCreatorBreakout(3_400, SMALL_CREATOR).isBreakout, false);
  });

  test('refuses to judge without enough history', () => {
    const thin = { ...SMALL_CREATOR, sampleCount: 2 };
    assert.equal(detectCreatorBreakout(999_999, thin).isBreakout, false);
  });

  test('requires clearing the creator own p90, not just the median', () => {
    const spiky = { ...SMALL_CREATOR, medianMetric: 100, p90Metric: 500_000 };
    assert.equal(detectCreatorBreakout(20_000, spiky).isBreakout, false);
  });
});

describe('confidence', () => {
  test('is low for a single observation however big the number', () => {
    const c = confidenceOf({
      observations: 1,
      spanHours: 0,
      lastObservationAgeHours: 0,
      coverage: 1,
      sourceReliability: 1,
      crossSourceCount: 1,
    });
    assert.ok(c < 0.5, `confidence was ${c}`);
  });

  test('rises with observations, span and corroboration', () => {
    const c = confidenceOf({
      observations: 8,
      spanHours: 8,
      lastObservationAgeHours: 0.2,
      coverage: 1,
      sourceReliability: 1,
      crossSourceCount: 4,
    });
    assert.ok(c > 0.85, `confidence was ${c}`);
  });

  test('an unreliable source cannot produce a confident trend', () => {
    const c = confidenceOf({
      observations: 8,
      spanHours: 8,
      lastObservationAgeHours: 0.2,
      coverage: 1,
      sourceReliability: 0.3,
      crossSourceCount: 4,
    });
    assert.ok(c < 0.5, `confidence was ${c}`);
  });
});
