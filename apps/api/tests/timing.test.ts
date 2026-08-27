/**
 * The timing analysis.
 *
 * The age adjustment is what these tests are really for. Rank falls steeply
 * with age — on the database this was built against, by 21 points between the
 * newest and oldest bands — so an unadjusted analysis would report whichever
 * hours happened to hold the newest items as the best time to post. That is a
 * confident, plausible, completely wrong answer, and the only defence is
 * proving the adjustment actually removes it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env['RADAR_NO_ENV_FILE'] = '1';
process.env['LOG_LEVEL'] = 'error';

const { analyzeTiming, dayPartOf } = await import('../src/core/timing.ts');
import type { TimingSample } from '../src/core/timing.ts';

function at(hour: number, percentile: number, ageHours = 30, weekday = 1): TimingSample {
  return { hour, weekday, ageHours, percentile, score: percentile * 100 };
}

/** n items at one hour, with a little spread so variance is not zero. */
function many(n: number, hour: number, percentile: number, ageHours = 30, weekday = 1): TimingSample[] {
  return Array.from({ length: n }, (_, i) =>
    at(hour, percentile + (i % 2 === 0 ? 0.04 : -0.04), ageHours, weekday),
  );
}

describe('day parts', () => {
  test('cover the whole clock without a gap or an overlap', () => {
    const seen = new Set<string>();
    for (let hour = 0; hour < 24; hour++) seen.add(dayPartOf(hour));
    assert.deepEqual([...seen].sort(), ['afternoon', 'evening', 'morning', 'night']);
    assert.equal(dayPartOf(0), 'night');
    assert.equal(dayPartOf(6), 'morning');
    assert.equal(dayPartOf(12), 'afternoon');
    assert.equal(dayPartOf(18), 'evening');
    assert.equal(dayPartOf(23), 'evening');
  });
});

describe('the age confound', () => {
  test('an hour holding only fresh items is not called the best hour', () => {
    // The trap, built deliberately. Hour 9 holds only young items and hour 21
    // only old ones. Both are equally good *for their age* — the raw ranks
    // differ only because rank decays with age.
    const samples = [
      ...many(60, 9, 0.55, 30), // young band, typical for young
      ...many(60, 21, 0.2, 300), // old band, typical for old
    ];
    const result = analyzeTiming(samples, 'UTC');

    const hours = result.groups.find((g) => g.key === 'hour');
    const nine = hours?.buckets.find((b) => b.key === '9');
    const twentyOne = hours?.buckets.find((b) => b.key === '21');
    assert.ok(nine !== undefined && twentyOne !== undefined);

    // Without the adjustment nine would sit 35 points above twenty-one.
    assert.ok(
      Math.abs(nine.lift) < 3 && Math.abs(twentyOne.lift) < 3,
      `age leaked through: 9h=${nine.lift}, 21h=${twentyOne.lift}`,
    );
    assert.equal(result.findings.length, 0, 'a pure age effect must produce no findings');
  });

  test('the age spread that was removed is reported, not hidden', () => {
    const result = analyzeTiming([...many(60, 9, 0.55, 30), ...many(60, 21, 0.2, 300)], 'UTC');
    assert.ok(result.ageSpread > 30, `expected a large reported spread, got ${result.ageSpread}`);
  });

  test('a real hour effect still survives the adjustment', () => {
    // Both hours span both age bands equally, so age cannot explain the gap.
    const samples = [
      ...many(30, 9, 0.75, 30),
      ...many(30, 9, 0.5, 300),
      ...many(30, 21, 0.35, 30),
      ...many(30, 21, 0.1, 300),
    ];
    const result = analyzeTiming(samples, 'UTC');
    const hours = result.groups.find((g) => g.key === 'hour');
    const nine = hours?.buckets.find((b) => b.key === '9');
    assert.ok(nine !== undefined);
    assert.ok(nine.significant, 'a genuine 40-point gap should survive');
    assert.ok(nine.lift > 10, `lift was ${nine.lift}`);
    assert.ok(result.findings.some((f) => f.key === '9'));
  });
});

describe('the timing analysis', () => {
  test('an empty set produces nothing rather than dividing by zero', () => {
    const result = analyzeTiming([], 'UTC');
    assert.equal(result.n, 0);
    assert.deepEqual(result.findings, []);
    assert.equal(result.ageSpread, 0);
  });

  test('hours are ordered by the clock, not by strength', () => {
    const result = analyzeTiming(
      [...many(30, 21, 0.7), ...many(30, 3, 0.3), ...many(30, 14, 0.5)],
      'UTC',
    );
    const hours = result.groups.find((g) => g.key === 'hour');
    assert.deepEqual(hours?.buckets.map((b) => b.key), ['3', '14', '21']);
  });

  test('day parts read night to evening', () => {
    const result = analyzeTiming(
      [...many(30, 20, 0.6), ...many(30, 2, 0.4), ...many(30, 8, 0.5), ...many(30, 14, 0.5)],
      'UTC',
    );
    const parts = result.groups.find((g) => g.key === 'dayPart');
    assert.deepEqual(parts?.buckets.map((b) => b.key), [
      'night',
      'morning',
      'afternoon',
      'evening',
    ]);
  });

  test('a thin hour is shown but never a finding', () => {
    const result = analyzeTiming([...many(80, 9, 0.3), ...many(4, 21, 0.95)], 'UTC');
    const hours = result.groups.find((g) => g.key === 'hour');
    const twentyOne = hours?.buckets.find((b) => b.key === '21');
    assert.ok(twentyOne !== undefined);
    assert.equal(twentyOne.n, 4);
    assert.equal(twentyOne.thin, true);
    assert.equal(twentyOne.significant, false);
    assert.ok(!result.findings.some((f) => f.key === '21'));
  });

  test('weekdays are grouped separately from hours', () => {
    const samples = [
      ...many(40, 12, 0.7, 30, 5), // Friday
      ...many(40, 12, 0.3, 30, 1), // Monday
    ];
    const result = analyzeTiming(samples, 'UTC');
    const weekdays = result.groups.find((g) => g.key === 'weekday');
    const friday = weekdays?.buckets.find((b) => b.key === '5');
    assert.ok(friday !== undefined);
    assert.ok(friday.significant, 'a 40-point weekday gap should be found');
    assert.ok(friday.lift > 0);
    // The hour is identical for both, so the hour group must find nothing.
    const hours = result.groups.find((g) => g.key === 'hour');
    assert.equal(hours?.buckets.length, 1);
  });

  test('the timezone is carried through so the page can name it', () => {
    const result = analyzeTiming(many(30, 12, 0.5), 'Asia/Tehran');
    assert.equal(result.timezone, 'Asia/Tehran');
  });
});
