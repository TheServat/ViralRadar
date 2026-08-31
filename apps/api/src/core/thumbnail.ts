/**
 * Which thumbnails performed, on the same terms as which titles performed.
 *
 * Deliberately the same machinery as the format analysis: rank inside the
 * item's own platform, a baseline computed from the filtered set rather than
 * assumed, and a confidence interval on every bucket so nothing gets called a
 * finding that the sample cannot support. An image analysis is exactly the kind
 * of feature that invites confident nonsense, and reusing `lift.ts` is what
 * stops this one from being it.
 *
 * The measurements underneath are crude — skin-toned pixels are not a face,
 * and compressed density is not "busyness" in any principled sense. That is
 * survivable precisely because the statistics are honest: a rough signal
 * measured across thousands of items and reported with its error bars is
 * useful, where a sophisticated one presented as certainty is not.
 */
import { MIN_SAMPLE, bucketBy, findingsOf, mean, round, stratify, summarise } from './lift.ts';
import type { Finding, LiftBucket } from './lift.ts';

export interface ThumbnailSample {
  readonly percentile: number;
  readonly score: number;
  /**
   * The format the item is in, which every pixel measure here is confounded by.
   * See `formatAdjusted` — this is not a filter, it is the stratum.
   */
  readonly contentType: string;
  readonly density: number | null;
  readonly brightness: number | null;
  readonly contrast: number | null;
  readonly saturation: number | null;
  readonly warmth: number | null;
  readonly skin: number | null;
}

export interface ThumbnailGroup {
  readonly key: string;
  readonly buckets: readonly LiftBucket[];
  /**
   * The mean of the items this measure could actually be read from.
   *
   * Per group rather than one for the analysis, because the groups do not
   * cover the same items — see `group`. Each measure's buckets are compared
   * against the population those buckets were drawn from.
   */
  readonly baseline: number;
  /** How many items this measure was missing on, and so could not place. */
  readonly unmeasured: number;
}

export interface ThumbnailAnalysis {
  readonly n: number;
  /**
   * The headline number over every item in the filtered set.
   *
   * Not what the bars are measured against — each group carries its own
   * baseline, because the groups do not cover the same items.
   */
  readonly baseline: number;
  readonly groups: readonly ThumbnailGroup[];
  /** Flattened across groups, each carrying the group it came from. */
  readonly findings: readonly Finding[];
  readonly minSample: number;
  /** How many had pixels measured, as opposed to only file-level numbers. */
  readonly withPixels: number;
  /** How much of the raw spread was format rather than image. */
  readonly formatSpread: number;
  /** The formats present, so the page can name what was adjusted for. */
  readonly formats: readonly { key: string; n: number }[];
}

/**
 * Removes the format effect by centring each item within its own content type.
 *
 * This exists because of a confound large enough to invert the answer, and the
 * cause is not in the images at all — it is in the frame around them.
 *
 * YouTube serves every thumbnail at 320x180. A short is filmed 9:16, so it
 * arrives fitted into that frame with black bars down both sides, and those
 * bars are measured along with the picture. On a real corpus of 8,469 YouTube
 * thumbnails: shorts averaged 0.219 brightness against 0.321 for ordinary
 * videos, and compressed to 6,953 bytes against 11,934 — a 42% difference in
 * the same pixel dimensions, which is the signature of large flat regions
 * rather than of darker photography.
 *
 * Pooled, that made "dim wins" the headline finding. Split by format, the
 * effect reverses: among shorts, dim was +2.7 and very bright -3.7; among
 * ordinary videos, very bright was +2.3 and dark -3.6. Two opposite truths,
 * and the pooled number was neither of them — it was the format mix.
 *
 * Padding contaminates brightness, saturation and density alike, so the
 * adjustment is applied to every measure rather than only to the one where it
 * was noticed.
 *
 * Exported because the drill-down has to rank examples by the same value the
 * bar was computed from. While this was private the endpoint could only reach
 * the raw percentile, so the twelve thumbnails offered as proof for a bar were
 * chosen by which format they were in — the confound this function removes,
 * reintroduced in the one place a reader goes to check the number.
 */
export function formatAdjusted(samples: readonly ThumbnailSample[]): { values: number[]; formatSpread: number } {
  const { values, spread } = stratify(samples, (s) => s.contentType, (s) => s.percentile);
  return { values, formatSpread: spread };
}

/**
 * The bands each measure is split into.
 *
 * Fixed boundaries rather than quantiles of whatever is in the database today,
 * so "bright" means the same thing next month as it does now. A quantile split
 * would keep every bucket equally full and every label meaningless.
 *
 * But they are *calibrated* boundaries, not guessed ones. The first attempt
 * used tidy round numbers and put 75% of real thumbnails in a single "dark"
 * band, which tells you nothing however carefully it is measured. These sit
 * near the quartiles of an actual corpus of a few thousand YouTube thumbnails,
 * which are much darker, punchier and warmer than an untrained guess expects.
 *
 * The labels therefore describe a position among thumbnails, not among all
 * possible images: "bright" means bright *for a thumbnail*.
 */
interface Band {
  readonly key: string;
  readonly max: number;
}

const BRIGHTNESS: readonly Band[] = [
  { key: 'dark', max: 0.2 },
  { key: 'dim', max: 0.3 },
  { key: 'bright', max: 0.4 },
  { key: 'veryBright', max: 1 },
];

const CONTRAST: readonly Band[] = [
  { key: 'flat', max: 0.3 },
  { key: 'moderate', max: 0.4 },
  { key: 'punchy', max: 1 },
];

const SATURATION: readonly Band[] = [
  { key: 'muted', max: 0.25 },
  { key: 'moderate', max: 0.45 },
  { key: 'vivid', max: 1 },
];

// Thumbnails are warm-shifted as a population — skin, daylight and orange
// graphics — so "cool" here means cool relative to other thumbnails, not
// relative to neutral grey.
const WARMTH: readonly Band[] = [
  { key: 'cool', max: 0.52 },
  { key: 'neutral', max: 0.58 },
  { key: 'warm', max: 1 },
];

/**
 * Skin coverage as a stand-in for "is a person in it".
 *
 * The first band is where the measure is most trustworthy: essentially no
 * skin-toned pixels is good evidence there is no face. The upper bands are
 * weaker, since sand and wood land there too, and the labels say "some" and
 * "a lot of" rather than claiming a person.
 */
const SKIN: readonly Band[] = [
  { key: 'none', max: 0.03 },
  { key: 'some', max: 0.15 },
  { key: 'lots', max: 1 },
];

/** Compressed bytes per pixel: how hard the image resisted compression. */
const DENSITY: readonly Band[] = [
  { key: 'simple', max: 0.11 },
  { key: 'moderate', max: 0.18 },
  { key: 'busy', max: Infinity },
];

function band(bands: readonly Band[], value: number): string {
  for (const b of bands) if (value <= b.max) return b.key;
  return bands[bands.length - 1]?.key ?? '';
}

/**
 * Every measure, in the order they are presented.
 *
 * A table rather than six call sites so that the analysis and the drill-down
 * that shows real thumbnails behind a bar read the same definition. The group
 * names are the interface's, not the column's: `people` is measured from skin
 * coverage, and calling the group `skin` would promise more than the measure
 * delivers.
 */
const MEASURES: readonly {
  readonly key: string;
  readonly pick: (s: ThumbnailSample) => number | null;
  readonly bands: readonly Band[];
}[] = [
  { key: 'brightness', pick: (s) => s.brightness, bands: BRIGHTNESS },
  { key: 'contrast', pick: (s) => s.contrast, bands: CONTRAST },
  { key: 'saturation', pick: (s) => s.saturation, bands: SATURATION },
  { key: 'warmth', pick: (s) => s.warmth, bands: WARMTH },
  { key: 'people', pick: (s) => s.skin, bands: SKIN },
  { key: 'busyness', pick: (s) => s.density, bands: DENSITY },
];

/**
 * Which band a thumbnail falls into for one measure.
 *
 * Null for an unknown group, and — importantly — null when the measure itself
 * is missing. An item whose pixels could not be read belongs in no band rather
 * than in the one nearest to zero.
 */
export function assignThumbnailBucket(groupKey: string, sample: ThumbnailSample): string | null {
  const measure = MEASURES.find((m) => m.key === groupKey);
  if (measure === undefined) return null;
  const value = measure.pick(sample);
  return value === null ? null : band(measure.bands, value);
}

/**
 * One measure's buckets, compared against the items that measure could be read
 * from rather than against every item.
 *
 * This is the one analysis where the two differ. The format and timing
 * analyses place every sample in some bucket, so a baseline over all of them
 * is the same population the buckets came from. Here a thumbnail that failed
 * to download, or that the decoder could not read, is still a row — the
 * pipeline records it deliberately, so the failure is visible rather than
 * silently retried — and `assignThumbnailBucket` returns null for it. Those
 * items were in the baseline and in no bucket.
 *
 * They are not a random sample of the rest. On a real corpus they sit at 28.0
 * adjusted percentile against 35.5 for the items with pixels, which pushed
 * every bucket in every group the same half-point in the same direction: a
 * measure of how often the decoder worked, wearing a brightness label. Half a
 * point is under every bucket's margin today, but nothing holds it there — the
 * shift is proportional to how much coverage is missing, and at 60% coverage
 * the same path moves every bucket by nearly three points.
 *
 * Per group rather than one shared correction because the groups lose
 * different items: `busyness` reads `density`, which is missing on more items
 * than `brightness` is.
 */
function group(
  key: string,
  samples: readonly ThumbnailSample[],
  values: readonly number[],
  bands: readonly Band[],
): ThumbnailGroup {
  // The adjusted value travels with its sample, so bucketing stays an index
  // lookup rather than a second pass that could fall out of step.
  const paired = samples.map((sample, i) => ({ sample, value: values[i] ?? 0 }));
  const byKey = bucketBy(
    paired,
    (p) => assignThumbnailBucket(key, p.sample),
    (p) => p.value,
    (p) => p.sample.score,
  );

  const placed = [...byKey.values()].flatMap((v) => v.values);
  const baseline = mean(placed);

  const buckets = [...byKey].map(([k, v]) => summarise(k, v.values, v.scores, baseline));
  const order = bands.map((b) => b.key);
  buckets.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  return { key, buckets, baseline: round(baseline * 100), unmeasured: samples.length - placed.length };
}

export function analyzeThumbnails(samples: readonly ThumbnailSample[]): ThumbnailAnalysis {
  if (samples.length === 0) {
    return {
      n: 0, baseline: 0, groups: [], findings: [], minSample: MIN_SAMPLE,
      withPixels: 0, formatSpread: 0, formats: [],
    };
  }

  const { values, formatSpread } = formatAdjusted(samples);
  const baseline = mean(values);
  const withPixels = samples.filter((s) => s.brightness !== null).length;

  const counts = new Map<string, number>();
  for (const sample of samples) counts.set(sample.contentType, (counts.get(sample.contentType) ?? 0) + 1);
  const formats = [...counts]
    .map(([key, n]) => ({ key, n }))
    .sort((a, b) => b.n - a.n);

  const groups: ThumbnailGroup[] = MEASURES.map((m) =>
    group(m.key, samples, values, m.bands),
  ).filter((g) => g.buckets.length > 0);

  const findings = findingsOf(groups);

  return {
    n: samples.length,
    baseline: round(baseline * 100),
    groups,
    findings,
    minSample: MIN_SAMPLE,
    withPixels,
    formatSpread,
    formats,
  };
}
