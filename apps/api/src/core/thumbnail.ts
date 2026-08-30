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
import { MIN_SAMPLE, bucketBy, mean, round, summarise } from './lift.ts';
import type { LiftBucket } from './lift.ts';

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
}

export interface ThumbnailAnalysis {
  readonly n: number;
  readonly baseline: number;
  readonly groups: readonly ThumbnailGroup[];
  readonly findings: readonly LiftBucket[];
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
 */
function formatAdjusted(samples: readonly ThumbnailSample[]): { values: number[]; formatSpread: number } {
  const overall = mean(samples.map((s) => s.percentile));

  const byFormat = new Map<string, number[]>();
  for (const sample of samples) {
    const list = byFormat.get(sample.contentType);
    if (list === undefined) byFormat.set(sample.contentType, [sample.percentile]);
    else list.push(sample.percentile);
  }

  const formatMean = new Map<string, number>();
  for (const [format, values] of byFormat) formatMean.set(format, mean(values));

  // Reported rather than hidden. If the correction is bigger than the finding,
  // the reader is looking at the correction.
  const means = [...formatMean.values()];
  const formatSpread = means.length < 2 ? 0 : (Math.max(...means) - Math.min(...means)) * 100;

  const values = samples.map((sample) => {
    const centre = formatMean.get(sample.contentType) ?? overall;
    return sample.percentile - centre + overall;
  });

  return { values, formatSpread: round(formatSpread) };
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

function group(
  key: string,
  samples: readonly ThumbnailSample[],
  values: readonly number[],
  baseline: number,
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

  const buckets = [...byKey].map(([k, v]) => summarise(k, v.values, v.scores, baseline));
  const order = bands.map((b) => b.key);
  buckets.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  return { key, buckets };
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
    group(m.key, samples, values, baseline, m.bands),
  ).filter((g) => g.buckets.length > 0);

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
    withPixels,
    formatSpread,
    formats,
  };
}
