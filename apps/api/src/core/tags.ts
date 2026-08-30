/**
 * Which tags to put on a post about a given subject.
 *
 * You type a word. It finds the posts about it, collects every tag those posts
 * carry, and reports how each tag's posts performed against the rest of that
 * set. So the question answered is not "which tags are popular" — that is
 * always `#shorts` — but "among posts about this subject, which tags travel
 * with the ones that did well".
 *
 * The same statistics as the format and timing analyses, from `lift.ts`, for
 * the same reason: one definition of what counts as a finding, so two pages
 * cannot disagree about it.
 *
 * There is one failure mode here that the other analyses do not have, and it is
 * severe enough to change the design. **A tag block is not a sample.** One
 * channel posting fifty-six videos with the same nine tags produces nine
 * buckets of fifty-six items each, all with identical means, every one of them
 * comfortably past a sample-size test. Measured on the first real database this
 * was run against, that was exactly the top of the list: nine tags about
 * meditation, from two accounts, sitting above every genuinely broad tag.
 *
 * Counting items cannot see that. Counting *distinct creators* can, so every
 * tag carries both, and a tag carried by too few accounts is shown with its
 * numbers and never called a finding — the same treatment a thin bucket gets.
 */
import { MIN_SAMPLE, bucketBy, mean, median, round, summarise } from './lift.ts';
import type { LiftBucket } from './lift.ts';

/**
 * How many distinct accounts a tag needs before its lift means anything.
 *
 * Deliberately not scaled to the sample: the question is whether more than a
 * handful of people independently chose this tag, and that is the same question
 * whether the set holds two hundred posts or two thousand.
 */
export const MIN_CREATORS = 5;

export interface TagSample {
  readonly tags: readonly string[];
  /** Null for sources that do not identify an author. */
  readonly creatorId: string | null;
  /** 0..1, this item's rank inside its own source's recent distribution. */
  readonly percentile: number;
  readonly score: number;
  readonly views: number | null;
  /** Whether the seed appears as a tag on this item, rather than in its text. */
  readonly carriesSeed: boolean;
}

export interface TagResult extends LiftBucket {
  /** Distinct accounts using it. The number that decides whether this is evidence. */
  readonly creators: number;
  /** Too few accounts to judge; shown, but never a finding. */
  readonly concentrated: boolean;
  /** Typical reach of posts carrying it, in the units the platform reports. */
  readonly medianViews: number | null;
  /** Share of the matched set carrying it, 0..100. */
  readonly share: number;
  /** How many of those posts also carry the seed as a tag of their own. */
  readonly withSeed: number;
}

export interface TagAnalysis {
  readonly seed: string;
  /** Posts about the subject, which everything below is measured within. */
  readonly n: number;
  /** Mean rank of that set. Every lift is measured from here, not from 50. */
  readonly baseline: number;
  readonly tags: readonly TagResult[];
  readonly minSample: number;
  readonly minCreators: number;
  /** How many tags cleared both bars — the actual answer. */
  readonly findings: number;
}

/**
 * Ranks the tags found on a set of posts about one subject.
 *
 * `samples` is the matched set; the seed itself is excluded from the results,
 * since "posts about this subject use this subject's tag" is not advice.
 */
export function analyzeTags(seed: string, samples: readonly TagSample[]): TagAnalysis {
  const needle = seed.trim().toLowerCase().replace(/^#/, '');
  if (samples.length === 0) {
    return { seed: needle, n: 0, baseline: 0, tags: [], minSample: MIN_SAMPLE, minCreators: MIN_CREATORS, findings: 0 };
  }

  const baseline = mean(samples.map((s) => s.percentile));

  // One pass to bucket by tag, using the shared helper so the values and scores
  // reaching `summarise` are collected the same way as everywhere else. A post
  // carrying a tag twice counts once: `expand` de-duplicates per item.
  const expand: { tag: string; sample: TagSample }[] = [];
  for (const sample of samples) {
    for (const tag of new Set(sample.tags.map((t) => t.toLowerCase()))) {
      if (tag === needle || tag === '') continue;
      expand.push({ tag, sample });
    }
  }

  const byTag = bucketBy(
    expand,
    (e) => e.tag,
    (e) => e.sample.percentile,
    (e) => e.sample.score,
  );

  // The per-tag facts `summarise` does not carry: who used it, how far it
  // reaches, and how much of the set it covers.
  const extra = new Map<string, { creators: Set<string>; views: number[]; withSeed: number; items: number }>();
  for (const { tag, sample } of expand) {
    let entry = extra.get(tag);
    if (entry === undefined) {
      entry = { creators: new Set(), views: [], withSeed: 0, items: 0 };
      extra.set(tag, entry);
    }
    entry.items++;
    if (sample.creatorId !== null) entry.creators.add(sample.creatorId);
    if (sample.views !== null) entry.views.push(sample.views);
    if (sample.carriesSeed) entry.withSeed++;
  }

  const tags: TagResult[] = [];
  for (const [tag, values] of byTag) {
    const bucket = summarise(tag, values.values, values.scores, baseline);
    const side = extra.get(tag);
    const creators = side?.creators.size ?? 0;
    const concentrated = creators < MIN_CREATORS;
    tags.push({
      ...bucket,
      creators,
      concentrated,
      // A block of tags from one account can clear every statistical bar there
      // is. Whatever the interval says, this is not evidence about the tag.
      significant: bucket.significant && !concentrated,
      medianViews: side !== undefined && side.views.length > 0 ? Math.round(median(side.views)) : null,
      share: round((bucket.n / samples.length) * 100),
      withSeed: side?.withSeed ?? 0,
    });
  }

  // Proven first, strongest within that, then everything else by lift — so the
  // answer is at the top and the rest stays readable as context.
  tags.sort((a, b) => {
    if (a.significant !== b.significant) return a.significant ? -1 : 1;
    return b.lift - a.lift;
  });

  return {
    seed: needle,
    n: samples.length,
    baseline: round(baseline * 100),
    tags,
    minSample: MIN_SAMPLE,
    minCreators: MIN_CREATORS,
    findings: tags.filter((t) => t.significant).length,
  };
}
