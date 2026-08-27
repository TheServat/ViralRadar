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
  const variance = n < 2 ? Infinity : values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (n - 1);
  const margin = n < 2 ? Infinity : Z * Math.sqrt(variance / n);

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
