/**
 * Robust statistics.
 *
 * Everything here prefers medians and MAD over means and standard deviation:
 * viral data is exactly the kind of heavy-tailed, outlier-dominated data that
 * makes a mean meaningless. One 40M-view video should not move the baseline
 * that every other video is judged against.
 */

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Finite values only, sorted ascending. */
export function cleanSorted(values: readonly number[]): number[] {
  return values.filter(isNum).sort((a, b) => a - b);
}

export function mean(values: readonly number[]): number | null {
  const v = values.filter(isNum);
  if (v.length === 0) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

/** Linear-interpolated quantile, `q` in 0..1. */
export function quantile(values: readonly number[], q: number): number | null {
  const s = cleanSorted(values);
  if (s.length === 0) return null;
  if (s.length === 1) return s[0] as number;
  const pos = clamp(q, 0, 1) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const w = pos - lo;
  return (s[lo] as number) * (1 - w) + (s[hi] as number) * w;
}

export function median(values: readonly number[]): number | null {
  return quantile(values, 0.5);
}

/** Median absolute deviation, the robust cousin of standard deviation. */
export function mad(values: readonly number[]): number | null {
  const m = median(values);
  if (m === null) return null;
  return median(values.filter(isNum).map((v) => Math.abs(v - m)));
}

export function stddev(values: readonly number[]): number | null {
  const v = values.filter(isNum);
  if (v.length < 2) return null;
  const m = mean(v) as number;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

export function zScore(value: number, values: readonly number[]): number | null {
  const m = mean(values);
  const sd = stddev(values);
  if (m === null || sd === null || sd === 0) return null;
  return (value - m) / sd;
}

/**
 * Robust z-score. 0.6745 is the constant that makes MAD a consistent estimator
 * of the standard deviation for normally distributed data.
 */
export function robustZScore(value: number, values: readonly number[]): number | null {
  const m = median(values);
  const d = mad(values);
  if (m === null || d === null || d === 0) return null;
  return (0.6745 * (value - m)) / d;
}

/** Fraction of `values` that `value` is greater than or equal to, 0..1. */
export function percentileRank(value: number, values: readonly number[]): number | null {
  const s = cleanSorted(values);
  if (s.length === 0) return null;
  let below = 0;
  let equal = 0;
  for (const v of s) {
    if (v < value) below++;
    else if (v === value) equal++;
  }
  return (below + equal / 2) / s.length;
}

/**
 * Compress a heavy-tailed positive number into 0..1.
 * `mid` is the value that maps to roughly 0.5, so callers pass a baseline
 * (e.g. the source's own median) rather than a magic constant.
 */
export function logNormalise(value: number, mid: number): number {
  if (!isNum(value) || value <= 0) return 0;
  const m = mid > 0 ? mid : 1;
  const ratio = Math.log1p(value) / Math.log1p(m * 2);
  return clamp(ratio, 0, 1);
}

/** Squash any real number into 0..1 with a configurable knee. */
export function sigmoid(value: number, knee = 1): number {
  if (!isNum(value)) return 0;
  return 1 / (1 + Math.exp(-value / (knee === 0 ? 1 : knee)));
}

/** Exponential decay, 1 at age 0. */
export function decay(ageHours: number, halfLifeHours: number): number {
  if (!isNum(ageHours) || ageHours < 0) return 1;
  const hl = halfLifeHours > 0 ? halfLifeHours : 1;
  return clamp(Math.pow(0.5, ageHours / hl), 0, 1);
}

/** Exponentially weighted moving average; `alpha` in 0..1, higher = more reactive. */
export function ewma(values: readonly number[], alpha = 0.4): number | null {
  const v = values.filter(isNum);
  if (v.length === 0) return null;
  let acc = v[0] as number;
  for (let i = 1; i < v.length; i++) acc = alpha * (v[i] as number) + (1 - alpha) * acc;
  return acc;
}

/**
 * Least-squares slope of y over x. Used to read a growth trend out of more than
 * two points, which is far less jumpy than a single last-minus-previous delta.
 */
export function linearSlope(xs: readonly number[], ys: readonly number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i] as number;
    sy += ys[i] as number;
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] as number) - mx;
    num += dx * ((ys[i] as number) - my);
    den += dx * dx;
  }
  if (den === 0) return null;
  return num / den;
}

/** Ratio against a baseline, guarding against a zero or missing baseline. */
export function anomalyRatio(observed: number, baseline: number | null): number | null {
  if (!isNum(observed) || baseline === null || !isNum(baseline)) return null;
  const b = Math.max(baseline, 1);
  return observed / b;
}

export interface Summary {
  readonly count: number;
  readonly p50: number | null;
  readonly p75: number | null;
  readonly p90: number | null;
  readonly p99: number | null;
  readonly mad: number | null;
}

export function summarise(values: readonly number[]): Summary {
  const v = values.filter(isNum);
  return {
    count: v.length,
    p50: quantile(v, 0.5),
    p75: quantile(v, 0.75),
    p90: quantile(v, 0.9),
    p99: quantile(v, 0.99),
    mad: mad(v),
  };
}
