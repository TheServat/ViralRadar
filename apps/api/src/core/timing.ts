/**
 * When to post.
 *
 * The same question as the format analysis, on a different axis: does the hour
 * something was published show up in how well it did.
 *
 * This one has a trap the format analysis does not, and it is large enough to
 * invalidate the whole answer if ignored. **Rank falls steeply with age.** On
 * the database this was built against, items 24-48 hours old averaged the 39th
 * percentile of their own sources, those 48-96 hours old the 32nd, and those
 * over ten days old the 18th — a 21-point spread from age alone, wider than
 * any real finding here. Publish hours are not evenly spread across those age
 * bands, so comparing raw ranks per hour would largely be measuring *when the
 * collector happened to be running*, dressed up as advice about posting.
 *
 * The fix is stratification: every item is compared against other items of the
 * same age, and only that residual is aggregated by hour. An hour cannot win
 * by being recent, because being recent is subtracted first.
 *
 * Two more rules keep it honest:
 *
 *   - **Estimated publish times are excluded upstream.** Using a timestamp the
 *     system guessed to analyse publish timing would be circular.
 *   - **Items must have settled.** Anything younger than a day has not had the
 *     same chance to prove itself as the rest, so it is left out entirely
 *     rather than competing on unequal terms.
 */
import { bucketBy, controlDiscoveryRate, findingsOf, mean, round, stratify, summarise, MIN_SAMPLE } from './lift.ts';
import type { Finding, LiftBucket } from './lift.ts';

export interface TimingSample {
  /**
   * Which source it came from — part of the stratum, not a filter.
   *
   * Sources sit at very different ranks: on a real corpus, charts and
   * wikipedia average 0.000, googletrends 0.133, youtube 0.383, bluesky 0.450.
   * That is a 45-point spread, twice the age effect this module was rewritten
   * to remove, and publish hours are not evenly distributed across sources.
   */
  readonly source: string;
  /** Hour of the day, 0-23, already in the user's timezone. */
  readonly hour: number;
  /** Day of the week, 0 = Sunday, already in the user's timezone. */
  readonly weekday: number;
  /** Hours between publication and now. */
  readonly ageHours: number;
  /** 0..1, this item's rank inside its own source's recent distribution. */
  readonly percentile: number;
  readonly score: number;
}

/**
 * Age bands for stratification.
 *
 * Chosen to match where rank actually changes rather than to be round numbers:
 * the first two days move fastest, and past ten days everything has settled to
 * roughly the same low rank.
 */
const AGE_BANDS: readonly number[] = [48, 96, 240, Infinity];

function ageBandOf(ageHours: number): number {
  for (let i = 0; i < AGE_BANDS.length; i++) {
    if (ageHours < (AGE_BANDS[i] ?? Infinity)) return i;
  }
  return AGE_BANDS.length - 1;
}

/**
 * Parts of the day.
 *
 * Twenty-four buckets is usually more resolution than the data supports — a
 * few hundred items spread over 24 hours leaves almost every hour too thin to
 * judge. These four are coarse enough to actually answer, and are reported
 * alongside the hourly view rather than instead of it, so the resolution the
 * data can support is always available.
 */
const DAY_PARTS: readonly { key: string; from: number; to: number }[] = [
  { key: 'night', from: 0, to: 6 },
  { key: 'morning', from: 6, to: 12 },
  { key: 'afternoon', from: 12, to: 18 },
  { key: 'evening', from: 18, to: 24 },
];

export function dayPartOf(hour: number): string {
  for (const part of DAY_PARTS) {
    if (hour >= part.from && hour < part.to) return part.key;
  }
  return 'night';
}

/**
 * Which bucket of a group a sample falls into, or null for a group that does
 * not exist.
 *
 * Shared with the drill-down for the same reason as the format version: the
 * examples behind a bar must be the items that bar was computed from, and two
 * copies of the rule would drift without anything failing visibly.
 */
export function assignTimingBucket(
  groupKey: string,
  sample: { readonly hour: number; readonly weekday: number },
): string | null {
  if (groupKey === 'dayPart') return dayPartOf(sample.hour);
  if (groupKey === 'weekday') return String(sample.weekday);
  if (groupKey === 'hour') return String(sample.hour);
  return null;
}

export interface TimingGroup {
  readonly key: string;
  readonly buckets: readonly LiftBucket[];
}

export interface TimingAnalysis {
  readonly n: number;
  /**
   * Mean of the age-adjusted measure, as a percentile. Sits at the overall
   * mean by construction, since the adjustment is centred - it is reported so
   * the numbers on the page can be read against something.
   */
  readonly baseline: number;
  readonly groups: readonly TimingGroup[];
  /** Flattened across groups, each carrying the group it came from. */
  readonly findings: readonly Finding[];
  readonly minSample: number;
  /** How much of the raw spread was age rather than timing. */
  readonly ageSpread: number;
  /** And how much was the source. On real data this is the larger of the two. */
  readonly sourceSpread: number;
  readonly timezone: string;
}

/**
 * Removes the age effect by centring each item within its own age band.
 *
 * Returns values still on a 0..1 scale, re-centred on the overall mean so the
 * numbers stay readable as percentiles rather than becoming signed residuals
 * around zero — the interface shows these to people, and "the 41st percentile"
 * is a thing someone can hold in their head where "+0.07" is not.
 */
/**
 * Removes both confounds at once: how old an item is, and where it came from.
 *
 * The stratum is the pair. Age alone was the original fix (ADR-022) and it left
 * the larger of the two in place — sources span 45 points against age's 22 —
 * so an hour could still win by being the hour a high-ranking source publishes
 * in. Both spreads are returned so the page can say which correction did the
 * work, and if either is bigger than the finding, the reader is looking at the
 * correction.
 */
export function ageAdjusted(samples: readonly TimingSample[]): {
  values: number[];
  ageSpread: number;
  sourceSpread: number;
} {
  // Measured separately purely to report them; the adjustment uses the pair.
  const age = stratify(samples, (s) => String(ageBandOf(s.ageHours)), (s) => s.percentile);
  const source = stratify(samples, (s) => s.source, (s) => s.percentile);
  const both = stratify(
    samples,
    (s) => `${s.source}|${ageBandOf(s.ageHours)}`,
    (s) => s.percentile,
  );
  return { values: both.values, ageSpread: age.spread, sourceSpread: source.spread };
}

function group(
  key: string,
  samples: readonly TimingSample[],
  values: readonly number[],
  baseline: number,
  assign: (sample: TimingSample) => string | null,
  order?: readonly string[],
): TimingGroup {
  // The adjusted value travels with its sample, so bucketing stays a plain
  // index lookup rather than a second parallel pass that could drift.
  const paired = samples.map((sample, i) => ({ sample, value: values[i] ?? 0 }));
  const byKey = bucketBy(
    paired,
    (p) => assign(p.sample),
    (p) => p.value,
    (p) => p.sample.score,
  );

  const buckets = [...byKey].map(([k, v]) => summarise(k, v.values, v.scores, baseline));
  buckets.sort(
    order === undefined
      ? (a, b) => Number(a.key) - Number(b.key)
      : (a, b) => order.indexOf(a.key) - order.indexOf(b.key),
  );
  return { key, buckets };
}

export function analyzeTiming(samples: readonly TimingSample[], timezone: string): TimingAnalysis {
  if (samples.length === 0) {
    return {
      n: 0,
      baseline: 0,
      groups: [],
      findings: [],
      minSample: MIN_SAMPLE,
      ageSpread: 0,
      sourceSpread: 0,
      timezone,
    };
  }

  const { values, ageSpread, sourceSpread } = ageAdjusted(samples);
  const baseline = mean(values);

  const groups: TimingGroup[] = [
    group(
      'dayPart',
      samples,
      values,
      baseline,
      (s) => assignTimingBucket('dayPart', s),
      DAY_PARTS.map((p) => p.key),
    ),
    group('weekday', samples, values, baseline, (s) => assignTimingBucket('weekday', s)),
    group('hour', samples, values, baseline, (s) => assignTimingBucket('hour', s)),
  ];

  const corrected = controlDiscoveryRate(groups);
  const findings = findingsOf(corrected);

  return {
    n: samples.length,
    baseline: round(baseline * 100),
    groups: corrected,
    findings,
    minSample: MIN_SAMPLE,
    ageSpread,
    sourceSpread,
    timezone,
  };
}
