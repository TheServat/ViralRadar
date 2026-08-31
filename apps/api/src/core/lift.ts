/**
 * "Is this difference real?", answered once for everything that asks it.
 *
 * Both the format analysis and the timing analysis do the same thing: split
 * items into buckets, compare each bucket against a baseline, and decide which
 * differences the sample can actually support. That decision lives here rather
 * than in each of them, so there is exactly one definition of what counts as a
 * finding — two pages that disagree about it would be worse than either.
 *
 * The measure is always a rank inside the item's own platform, never a raw
 * score, because raw numbers from different sources are not the same units.
 */

/**
 * Below this a bucket is reported but never treated as a result. Twenty-five
 * is where the interval on a bounded 0..1 measure gets narrow enough to be
 * worth reading; below it almost nothing would clear the baseline anyway.
 */
export const MIN_SAMPLE = 25;

/** 95%, two-sided. Normal rather than t: at n>=25 the difference is decoration. */
const Z = 1.96;

/**
 * Variance at or below which a bucket is treated as having no spread at all.
 *
 * A standard deviation of one part in a million, on a measure that runs 0 to 1.
 * Nothing that produced these numbers resolves that finely, so this is the
 * floating-point residue of identical values rather than a real difference.
 */
const NO_SPREAD = 1e-12;

export interface LiftBucket {
  readonly key: string;
  readonly n: number;
  /** Mean rank inside its own platform, 0..100. */
  readonly percentile: number;
  /** Percentile points above or below the baseline. */
  readonly lift: number;
  /** Half-width of the 95% interval, in percentile points. */
  readonly margin: number;
  /** The interval clears the baseline: a real difference, not noise. */
  readonly significant: boolean;
  /** Below the minimum sample; shown, but never called a result. */
  readonly thin: boolean;
  readonly medianScore: number;
}

export function round(value: number, places = 1): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Summarises one bucket against a baseline.
 *
 * `values` are on a 0..1 scale — a percentile, or a residual around one. The
 * interval is on the bucket's own mean; comparing it to a baseline computed
 * from every item slightly understates the total uncertainty, but the
 * baseline's own error is far smaller than any bucket's, and carrying both
 * would cost more clarity than it buys accuracy.
 */
export function summarise(
  key: string,
  values: readonly number[],
  scores: readonly number[],
  baseline: number,
): LiftBucket {
  const n = values.length;
  const m = mean(values);

  // Sample variance, Bessel-corrected. A single item has no spread to measure,
  // so its interval is infinite rather than zero - which correctly makes it
  // never significant instead of always significant.
  //
  // A bucket whose values are all identical has the same problem and the
  // opposite arithmetic: variance 0, margin 0, and `|lift| > 0` true for any
  // lift at all, so the bucket carrying the least information becomes the most
  // confident claim on the page. That is not hypothetical — the `audio` bucket
  // on a real database held 127 items whose `source_percentile` was 0 for every
  // one of them, because `percentileFromQuantiles` returns 0 as a no-signal
  // sentinel for sources that never report velocity. It rendered as
  // "-34.1 +/- 0.0, real difference", first on the page.
  //
  // Identical values mean the measure did not vary, which is a reason to say
  // nothing rather than a reason for certainty. Treated like a single item:
  // unmeasurable.
  //
  // The test is a tolerance rather than `=== 0`, because the mean of sixty
  // identical values is not exactly that value: 0.2 summed sixty times and
  // divided back gives 0.20000000000000004, leaving a variance around 8e-34
  // and a margin of 7e-18 that rounds to a displayed 0.0 while still passing
  // `> 0`. Values are percentiles on 0..1, so a variance this small means every
  // item agrees to six decimal places — identical by any measurement that
  // produced them.
  const spread =
    n < 2 ? Infinity : values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (n - 1);
  const variance = spread <= NO_SPREAD ? Infinity : spread;
  const margin = Number.isFinite(variance) ? Z * Math.sqrt(variance / n) : Infinity;

  const lift = (m - baseline) * 100;
  const marginPoints = margin * 100;

  return {
    key,
    n,
    percentile: round(m * 100),
    lift: round(lift),
    margin: Number.isFinite(marginPoints) ? round(marginPoints) : 100,
    significant: n >= MIN_SAMPLE && Number.isFinite(margin) && Math.abs(lift) > marginPoints,
    thin: n < MIN_SAMPLE,
    medianScore: round(median(scores)),
  };
}

/**
 * Removes a confound by centring every item within its own stratum.
 *
 * This lives here rather than in one analysis because it has had to be
 * rediscovered three times, and each time the module next door kept the bug:
 * timing was measuring item age (ADR-022), the thumbnail analysis was measuring
 * YouTube's letterbox padding (ADR-036), and the opening analysis was measuring
 * which subjects are made as shorts. The correction is not specific to any of
 * them. Anything that buckets a mixed population by something other than what
 * varies most across it needs this, and the fourth instance was the title
 * analysis sitting on the same page as the second.
 *
 * The values come back on the original 0..1 scale, re-centred on the overall
 * mean rather than around zero, so they stay readable as percentiles. The mean
 * of the result equals the mean of the input exactly, which is why a caller can
 * keep using one baseline for both adjusted and raw groups.
 *
 * `spread` is how far apart the strata were, in percentile points. It is
 * returned rather than discarded because when the correction is larger than the
 * finding, the reader is looking at the correction and should be told.
 */
export function stratify<T>(
  samples: readonly T[],
  stratumOf: (sample: T) => string,
  valueOf: (sample: T) => number,
): { values: number[]; spread: number } {
  if (samples.length === 0) return { values: [], spread: 0 };

  const overall = mean(samples.map(valueOf));

  const byStratum = new Map<string, number[]>();
  for (const sample of samples) {
    const key = stratumOf(sample);
    const list = byStratum.get(key);
    if (list === undefined) byStratum.set(key, [valueOf(sample)]);
    else list.push(valueOf(sample));
  }

  const centre = new Map<string, number>();
  for (const [key, values] of byStratum) centre.set(key, mean(values));

  const means = [...centre.values()];
  const spread = means.length < 2 ? 0 : (Math.max(...means) - Math.min(...means)) * 100;

  return {
    values: samples.map((sample) => valueOf(sample) - (centre.get(stratumOf(sample)) ?? overall) + overall),
    spread: round(spread),
  };
}

/**
 * A bucket together with the group it belongs to.
 *
 * Findings are flattened across groups for the headline list, and a bucket key
 * is only unique *within* its group: timing has weekday '0'..'6' and hour
 * '0'..'23', so three of them collide. Recovering the group by searching for a
 * bucket with that key finds whichever group was pushed first, which mislabelled
 * 3am as Wednesday on a real database and then showed 1,169 Wednesday items as
 * the evidence for a number computed from 438 3am ones. Carrying the group is
 * the only way that cannot happen.
 */
export interface Finding extends LiftBucket {
  readonly group: string;
}

/** Flattens groups into the headline list, keeping each bucket's origin. */
export function findingsOf(
  groups: readonly { key: string; buckets: readonly LiftBucket[] }[],
): Finding[] {
  return groups
    .flatMap((g) => g.buckets.map((b) => ({ ...b, group: g.key })))
    .filter((b) => b.significant)
    .sort((a, b) => Math.abs(b.lift) - Math.abs(a.lift));
}

/** Collects values per bucket, for a function that assigns each item to one. */
export function bucketBy<T>(
  items: readonly T[],
  assign: (item: T) => string | null,
  valueOf: (item: T) => number,
  scoreOf: (item: T) => number,
): Map<string, { values: number[]; scores: number[] }> {
  const byKey = new Map<string, { values: number[]; scores: number[] }>();
  for (const item of items) {
    const key = assign(item);
    if (key === null) continue;
    let entry = byKey.get(key);
    if (entry === undefined) {
      entry = { values: [], scores: [] };
      byKey.set(key, entry);
    }
    entry.values.push(valueOf(item));
    entry.scores.push(scoreOf(item));
  }
  return byKey;
}
