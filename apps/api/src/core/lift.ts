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
  /**
   * Two-sided p-value against the baseline, for the multiplicity correction.
   *
   * Not shown anywhere. It exists because `significant` on its own is a claim
   * about one bucket, and the pages make dozens of them at once - see
   * `controlDiscoveryRate`.
   */
  readonly p: number;
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
 * Sample variance, Bessel-corrected, with the degenerate cases treated as
 * unmeasurable rather than as certainty. See the long note in `summarise`.
 */
function spreadOf(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return Infinity;
  const m = mean(values);
  const spread = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (n - 1);
  return spread <= NO_SPREAD ? Infinity : spread;
}

/**
 * Summarises one bucket against a baseline.
 *
 * `values` are on a 0..1 scale — a percentile, or a residual around one.
 *
 * **Two different comparisons live here, and they need different intervals.**
 *
 * Against a grand mean over every item, the interval on the bucket's own mean
 * is right: the baseline's own error is far smaller than any bucket's, because
 * it is computed from N rather than from n. Carrying both would cost more
 * clarity than it buys accuracy.
 *
 * Against another *sample* — "titles with an emoji" versus "titles without
 * one" — that reasoning does not hold, and using the one-sample interval
 * understates the uncertainty by as much as the complement is small. Pass
 * `against` in that case and the interval becomes the two-sample one,
 * `Z*sqrt(v1/n1 + v2/n2)`.
 *
 * It matters. On the live database, filtered to `lang=en country=IR
 * source=youtube` — reachable from the page's own controls — the title
 * features reported `number` +13.1 ±10.5 and `hashtag` +11.5 ±9.2 as proven;
 * the correct margins are 14.4 and 14.8, so both are noise. One filter gave
 * `emoji` +13.3 ±10.4 "proven" against a complement of seven items, where the
 * honest margin is 35.0. Because the p-value derives from the same margin,
 * those also survived the multiplicity correction.
 */
export function summarise(
  key: string,
  values: readonly number[],
  scores: readonly number[],
  baseline: number,
  against?: readonly number[],
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
  const variance = spreadOf(values);

  // Two samples when the baseline is one, otherwise the bucket's own error.
  // An unmeasurable complement makes the whole comparison unmeasurable, which
  // is the honest answer rather than falling back to the narrower interval.
  let margin: number;
  if (against === undefined) {
    margin = Number.isFinite(variance) ? Z * Math.sqrt(variance / n) : Infinity;
  } else {
    const otherVariance = spreadOf(against);
    margin =
      Number.isFinite(variance) && Number.isFinite(otherVariance) && against.length > 0
        ? Z * Math.sqrt(variance / n + otherVariance / against.length)
        : Infinity;
  }

  const lift = (m - baseline) * 100;
  const marginPoints = margin * 100;

  // The same quantity `significant` is a threshold on, kept as a number so a
  // correction across many buckets is possible at all. An unmeasurable bucket
  // gets 1: no evidence, rather than evidence of nothing.
  const z = Number.isFinite(margin) && margin > 0 ? (Math.abs(m - baseline) * Z) / margin : 0;
  const p = z === 0 ? 1 : twoSidedP(z);

  return {
    key,
    n,
    percentile: round(m * 100),
    lift: round(lift),
    margin: Number.isFinite(marginPoints) ? round(marginPoints) : 100,
    significant: n >= MIN_SAMPLE && Number.isFinite(margin) && Math.abs(lift) > marginPoints,
    p,
    thin: n < MIN_SAMPLE,
    medianScore: round(median(scores)),
  };
}

/**
 * Two-sided p for a z-score, via a standard rational approximation of the
 * normal tail.
 *
 * Accurate to about seven decimal places, which is far more than anything here
 * needs - the numbers it feeds are compared against thresholds around 0.05.
 * Written out rather than pulled in, because this project has no runtime
 * dependencies and one function is not a reason to start.
 */
function twoSidedP(z: number): number {
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return Math.min(1, 2 * d * poly);
}

/**
 * Withdraws the findings that a page full of tests would produce by chance.
 *
 * Every bucket is tested at 95% on its own, and the pages then flatten all of
 * them into one list headed "real differences". On one screen of the live
 * database that was 80 tests and 45 of them labelled real. At one in twenty
 * each, some of those are the price of asking eighty questions rather than
 * anything about the data - and the tag analysis is worse, because the number
 * of tests grows with the corpus rather than being fixed by the layout.
 *
 * Benjamini-Hochberg rather than Bonferroni. Bonferroni controls the chance of
 * *any* false finding, which is the wrong thing to protect here: it would throw
 * away most of a genuinely interesting page to avoid one mistake. BH controls
 * the share of the findings that are false, which is what a reader scanning a
 * list actually cares about, and it keeps far more of the real ones.
 *
 * Measured: over the 80 buckets of the formats page it withdraws two, both at
 * the visible knife edge. Over the tag analysis for the seed `shorts`, 88
 * tests, it withdraws nine of forty-six.
 *
 * Only buckets with enough data are counted, because the thin ones were never
 * eligible to be findings and including them in the denominator would make the
 * correction harsher for no reason.
 */
export function controlDiscoveryRate<T extends { key: string; buckets: readonly LiftBucket[] }>(
  groups: readonly T[],
  q = 0.05,
): T[] {
  const tested = groups
    .flatMap((g) => g.buckets)
    .filter((b) => !b.thin && Number.isFinite(b.p));
  const m = tested.length;
  if (m === 0) return [...groups];

  // The largest p that survives: BH keeps every test at or below it.
  const ascending = [...tested].sort((a, b) => a.p - b.p);
  let cutoff = 0;
  for (let i = 0; i < m; i++) {
    const candidate = ascending[i];
    if (candidate !== undefined && candidate.p <= ((i + 1) / m) * q) cutoff = candidate.p;
  }

  return groups.map((g) => ({
    ...g,
    buckets: g.buckets.map((b) => ({
      ...b,
      // Never promotes. A bucket the single test already declined stays
      // declined - the correction is there to withdraw, not to find.
      significant: b.significant && b.p <= cutoff,
    })),
  }));
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
