/**
 * What *shape* of content wins.
 *
 * The rest of the system answers "what is spreading". This answers a different
 * question a creator actually acts on: given that you are going to make
 * something today, how long should the title be, should it ask a question,
 * should it be a short video or an image.
 *
 * Three things make this honest rather than decorative:
 *
 *   1. **Everything is measured as a rank inside its own platform.** A raw
 *      score cannot be compared across sources — Spotify's numbers and Reddit's
 *      are not the same units. `source_percentile` already normalises that, so
 *      it is what every comparison here is built on.
 *
 *   2. **The baseline is the filtered set, never 50.** Persian items average
 *      the 32nd percentile of their own sources, so calling a 49 "below
 *      average" would be exactly backwards. Whatever the user filtered to
 *      *is* the population, and lift is measured against its own mean.
 *
 *   3. **A difference that a sample this size cannot support is not a
 *      finding.** Every bucket carries a confidence interval, and only buckets
 *      whose interval clears the baseline are ever called a result.
 *
 * What it cannot do: separate correlated causes. Title length travels with
 * content type, which travels with platform. Normalising per source removes
 * most of the platform effect, and nothing here removes the rest — so this
 * says "these did better", never "this made them do better". That distinction
 * is carried through to the interface rather than quietly dropped.
 */
import type { FeatureKey } from './types.ts';

// ── Input ──────────────────────────────────────────────────────────────────

export interface FormatSample {
  readonly title: string;
  readonly contentType: string;
  readonly lang: string | null;
  /** 0..1, this item's rank inside its own source's recent distribution. */
  readonly percentile: number;
  readonly score: number;
}

// ── Feature detection ──────────────────────────────────────────────────────

/**
 * Digits in every script the sources actually produce. Latin, Persian and
 * Arabic-Indic are three different code ranges for the same idea, and a title
 * reading "۵ راه" is a listicle exactly as much as "5 ways" is.
 */
const DIGITS = /[0-9۰-۹٠-٩]/u;
const QUESTION = /[?？؟]/u;
const EXCLAIM = /[!！]/u;
const EMOJI = /\p{Extended_Pictographic}/u;
const HASHTAG = /(?:^|\s)#\S/u;
const BRACKET = /["'«»“”()[\]{}]/u;
/** Latin only: an all-caps run is not a thing Persian or Arabic script has. */
const SHOUT = /\b[A-Z]{3,}\b/u;

/**
 * Second person, per language.
 *
 * Addressing the viewer directly is one of the few title levers that is
 * supposed to work everywhere, so it is worth measuring rather than assuming.
 * Persian carries it in verb endings as often as in pronouns, hence the
 * suffixes.
 */
const YOU: Readonly<Record<string, RegExp>> = {
  en: /\b(you|your|yours|yourself)\b/iu,
  fa: /(^|\s)(شما|تو|شمارو|تورو|خودت|خودتان|خودتون)(\s|$)|(ید|تون|تان)(\s|$)/u,
  ar: /(^|\s)(أنت|أنتم|انت|انتم|لك|لكم|نفسك)(\s|$)/u,
};

/**
 * Listicle openers. A leading number is the universal form; the word forms
 * catch "چند روش" and "several ways", which behave the same way.
 */
const LIST_WORD: Readonly<Record<string, RegExp>> = {
  en: /\b(ways?|things?|tips?|reasons?|steps?|rules?|facts?)\b/iu,
  fa: /(روش|راه|نکته|دلیل|مورد|قدم|ترفند|چیز)/u,
  ar: /(طرق|طريقة|أشياء|نصائح|أسباب|خطوات|حقائق)/u,
};

function startsWithNumber(title: string): boolean {
  return /^\s*[0-9۰-۹٠-٩]/u.test(title);
}

/** Whether one title has each feature. Language decides which lists apply. */
export function featuresOf(title: string, lang: string | null): Set<FeatureKey> {
  const found = new Set<FeatureKey>();
  const key = lang ?? '';

  if (QUESTION.test(title)) found.add('question');
  if (EXCLAIM.test(title)) found.add('exclaim');
  if (DIGITS.test(title)) found.add('number');
  if (EMOJI.test(title)) found.add('emoji');
  if (HASHTAG.test(title)) found.add('hashtag');
  if (BRACKET.test(title)) found.add('bracket');
  if (SHOUT.test(title)) found.add('shout');

  const you = YOU[key];
  if (you !== undefined && you.test(title)) found.add('you');

  // A listicle is a number *and* the thing being counted, not a bare year.
  const listWord = LIST_WORD[key];
  if (startsWithNumber(title) || (listWord !== undefined && DIGITS.test(title) && listWord.test(title))) {
    found.add('listicle');
  }

  return found;
}

/**
 * Word count.
 *
 * Persian and Arabic separate words with spaces like Latin does, so splitting
 * on whitespace is right for all three. The zero-width non-joiner inside a
 * Persian word is deliberately *not* a separator - "می‌رود" is one word.
 */
export function wordCount(title: string): number {
  const trimmed = title.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/u).length;
}

/**
 * Character count in user-perceived characters.
 *
 * `String.length` counts UTF-16 units, so one emoji counts as two and a flag
 * as four. That would put every emoji title in a longer bucket than it belongs
 * in, which is exactly the kind of quiet error this whole feature exists to
 * avoid making.
 */
export function charCount(title: string): number {
  return [...title.trim()].length;
}

// ── Buckets ────────────────────────────────────────────────────────────────

interface Bucket {
  readonly key: string;
  readonly max: number;
}

const LENGTH_BUCKETS: readonly Bucket[] = [
  { key: '0-30', max: 30 },
  { key: '31-50', max: 50 },
  { key: '51-70', max: 70 },
  { key: '71-100', max: 100 },
  { key: '100+', max: Infinity },
];

const WORD_BUCKETS: readonly Bucket[] = [
  { key: '1-4', max: 4 },
  { key: '5-8', max: 8 },
  { key: '9-12', max: 12 },
  { key: '13-18', max: 18 },
  { key: '19+', max: Infinity },
];

function bucketFor(buckets: readonly Bucket[], value: number): string {
  for (const bucket of buckets) if (value <= bucket.max) return bucket.key;
  return buckets[buckets.length - 1]?.key ?? '';
}

// ── Output ─────────────────────────────────────────────────────────────────

export interface FormatBucket {
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

export interface FormatGroup {
  readonly key: string;
  readonly buckets: readonly FormatBucket[];
}

export interface FormatAnalysis {
  /** How many items the whole analysis rests on. */
  readonly n: number;
  /** Mean percentile of the filtered set. Every lift is measured from here. */
  readonly baseline: number;
  readonly groups: readonly FormatGroup[];
  /** The significant buckets, strongest first - the actual answer. */
  readonly findings: readonly FormatBucket[];
  readonly minSample: number;
}

/**
 * Below this a bucket is reported but never treated as a result. Twenty-five
 * is where the interval on a bounded 0..1 measure gets narrow enough to be
 * worth reading; below it almost nothing would clear the baseline anyway.
 */
const MIN_SAMPLE = 25;

/** 95%, two-sided. Normal rather than t: at n>=25 the difference is decoration. */
const Z = 1.96;

function median(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

function round(value: number, places = 1): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Summarises one bucket against the baseline.
 *
 * The interval is on the bucket's own mean. Comparing it to a fixed baseline
 * slightly understates the uncertainty, since the baseline is itself estimated
 * - but the baseline is computed from every item while a bucket is a slice of
 * them, so its own error is far smaller, and pretending otherwise would cost
 * more clarity than it buys accuracy.
 */
function summarise(key: string, percentiles: number[], scores: number[], baseline: number): FormatBucket {
  const n = percentiles.length;
  const mean = percentiles.reduce((a, b) => a + b, 0) / n;

  // Sample variance, Bessel-corrected. A single item has no spread to measure,
  // so its interval is infinite rather than zero - which correctly makes it
  // never significant instead of always significant.
  const variance =
    n < 2 ? Infinity : percentiles.reduce((sum, p) => sum + (p - mean) ** 2, 0) / (n - 1);
  const margin = n < 2 ? Infinity : Z * Math.sqrt(variance / n);

  const lift = (mean - baseline) * 100;
  const marginPoints = margin * 100;

  return {
    key,
    n,
    percentile: round(mean * 100),
    lift: round(lift),
    margin: Number.isFinite(marginPoints) ? round(marginPoints) : 100,
    significant: n >= MIN_SAMPLE && Number.isFinite(margin) && Math.abs(lift) > marginPoints,
    thin: n < MIN_SAMPLE,
    medianScore: round(median([...scores].sort((a, b) => a - b))),
  };
}

/** One group of buckets, from a function that assigns each sample to one. */
function group(
  key: string,
  samples: readonly FormatSample[],
  baseline: number,
  assign: (sample: FormatSample) => string | null,
  order?: readonly string[],
): FormatGroup {
  const byKey = new Map<string, { p: number[]; s: number[] }>();
  for (const sample of samples) {
    const bucket = assign(sample);
    if (bucket === null) continue;
    let entry = byKey.get(bucket);
    if (entry === undefined) {
      entry = { p: [], s: [] };
      byKey.set(bucket, entry);
    }
    entry.p.push(sample.percentile);
    entry.s.push(sample.score);
  }

  const buckets = [...byKey].map(([k, v]) => summarise(k, v.p, v.s, baseline));

  // A fixed order where one exists (short to long), otherwise strongest first.
  buckets.sort(
    order === undefined
      ? (a, b) => b.percentile - a.percentile
      : (a, b) => order.indexOf(a.key) - order.indexOf(b.key),
  );
  return { key, buckets };
}

/** Every feature worth measuring, in the order they are presented. */
export const FEATURE_KEYS: readonly FeatureKey[] = [
  'question',
  'number',
  'listicle',
  'emoji',
  'you',
  'hashtag',
  'exclaim',
  'bracket',
  'shout',
];

export function analyzeFormats(samples: readonly FormatSample[]): FormatAnalysis {
  if (samples.length === 0) {
    return { n: 0, baseline: 0, groups: [], findings: [], minSample: MIN_SAMPLE };
  }

  const baseline = samples.reduce((sum, s) => sum + s.percentile, 0) / samples.length;

  const groups: FormatGroup[] = [
    group('contentType', samples, baseline, (s) => s.contentType),
    group(
      'titleLength',
      samples,
      baseline,
      (s) => bucketFor(LENGTH_BUCKETS, charCount(s.title)),
      LENGTH_BUCKETS.map((b) => b.key),
    ),
    group(
      'titleWords',
      samples,
      baseline,
      (s) => bucketFor(WORD_BUCKETS, wordCount(s.title)),
      WORD_BUCKETS.map((b) => b.key),
    ),
  ];

  // Each feature is its own two-bucket comparison rather than one big group:
  // the features overlap, so "has an emoji" must be measured against
  // "does not have an emoji", not against the other features.
  const featureBuckets: FormatBucket[] = [];
  for (const feature of FEATURE_KEYS) {
    const withIt: { p: number[]; s: number[] } = { p: [], s: [] };
    for (const sample of samples) {
      if (!featuresOf(sample.title, sample.lang).has(feature)) continue;
      withIt.p.push(sample.percentile);
      withIt.s.push(sample.score);
    }
    // A feature nothing has is not a result and not a gap worth a row.
    if (withIt.p.length === 0) continue;
    featureBuckets.push(summarise(feature, withIt.p, withIt.s, baseline));
  }
  featureBuckets.sort((a, b) => b.lift - a.lift);
  groups.push({ key: 'titlePattern', buckets: featureBuckets });

  const findings = groups
    .flatMap((g) => g.buckets)
    .filter((b) => b.significant)
    .sort((a, b) => Math.abs(b.lift) - Math.abs(a.lift));

  return {
    n: samples.length,
    baseline: round(baseline * 100),
    groups,
    findings,
    minSample: MIN_SAMPLE,
  };
}
