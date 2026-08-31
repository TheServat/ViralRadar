/**
 * Subjects where small accounts beat their own format.
 *
 * The rest of the system answers "what is spreading", and the answer is
 * reliably news, politics and whatever is generically funny — because those are
 * what spread. This asks a different question: **where is a small account
 * getting numbers it has no business getting?** That is the shape of an
 * opening, and it is invisible to anything ranked by absolute size.
 *
 * The measure is the industry's, arrived at independently by every tool that
 * does this: performance against a baseline rather than in absolute terms. What
 * is specific here is which baseline, and that took three attempts to get
 * right.
 *
 *   1. **Views alone** ranks by channel size. Useless.
 *   2. **Views per subscriber** looked right and was measuring format. On a
 *      real corpus, shorts average 19.7 views per subscriber against 4.3 for
 *      ordinary videos — YouTube shows shorts to non-subscribers, so the top of
 *      that ranking was simply the subjects that happen to be shorts.
 *   3. **Views per subscriber, against the median for that format**, which is
 *      what this computes. Shorts are judged against shorts.
 *
 * That format confound is not a quirk of this one metric. It has now appeared
 * in the thumbnail analysis and here, and it will appear in anything that mixes
 * a nine-by-sixteen format with a sixteen-by-nine one.
 *
 * A subject also has to be carried by several accounts. One creator posting
 * thirty videos under their own tag is one sample however well it does, and
 * that failure mode has produced a plausible-looking top of the list twice in
 * this codebase already.
 */
import { MIN_SAMPLE, median, round } from './lift.ts';

/**
 * Distinct accounts a subject needs before its performance means anything.
 *
 * The same bar the tag analysis uses, for the same reason: the question is
 * whether several people independently found this, and that does not scale
 * with how many videos they made.
 */
export const MIN_CREATORS = 5;

/** Items below this are too small to say anything about a subject. */
export const MIN_ITEMS = 10;

export interface NicheItem {
  /** The subjects this item is about — its tags, lowercased by the caller. */
  readonly subjects: readonly string[];
  readonly contentType: string;
  readonly creatorId: string | null;
  /** Subscriber count of the account. Null or zero means it cannot be judged. */
  readonly followers: number | null;
  readonly views: number | null;
  readonly title: string;
  readonly url: string;
}

export interface Niche {
  readonly subject: string;
  /** Items about it. */
  readonly n: number;
  /** Distinct accounts. The number that decides whether this is evidence. */
  readonly creators: number;
  /**
   * Median reach against what that format normally gets per subscriber.
   * 1 is ordinary; 8 means eight times the reach its size would predict.
   */
  readonly lift: number;
  /** Typical size of the accounts covering it — how contested it is. */
  readonly medianFollowers: number;
  readonly medianViews: number;
  /** The formats it is made in, so a single-format subject is visible as one. */
  readonly formats: readonly { key: string; n: number }[];
  /** A few of the items, so the number can be checked against reality. */
  readonly examples: readonly { title: string; url: string; views: number | null }[];
}

export interface NicheAnalysis {
  readonly n: number;
  /** Median views per subscriber for each format — what each item is judged against. */
  readonly formatBaselines: readonly { key: string; perFollower: number; n: number }[];
  readonly niches: readonly Niche[];
  readonly minCreators: number;
  readonly minItems: number;
  /** Subjects dropped for resting on too few accounts, so the trim is visible. */
  readonly droppedForConcentration: number;
}

/**
 * How much reach an item got for the size of the account that posted it.
 *
 * Null when it cannot be judged: no views, no follower count, or an account
 * small enough that the ratio is division by nothing. A channel with two
 * subscribers and a thousand views is not a fifty-times outlier, it is a
 * channel nobody has subscribed to yet.
 */
const MIN_FOLLOWERS = 20;

function perFollower(item: NicheItem): number | null {
  if (item.views === null || item.followers === null) return null;
  if (item.followers < MIN_FOLLOWERS) return null;
  return item.views / item.followers;
}

export function findNiches(items: readonly NicheItem[]): NicheAnalysis {
  // What is normal, per format. Everything below is measured against this
  // rather than against the corpus, so a subject cannot win by being shorts.
  const byFormat = new Map<string, number[]>();
  for (const item of items) {
    const ratio = perFollower(item);
    if (ratio === null) continue;
    const list = byFormat.get(item.contentType);
    if (list === undefined) byFormat.set(item.contentType, [ratio]);
    else list.push(ratio);
  }

  const baseline = new Map<string, number>();
  for (const [format, ratios] of byFormat) {
    const m = median(ratios);
    // A format with no usable spread gets 1, which makes its items ordinary
    // rather than infinite.
    baseline.set(format, m > 0 ? m : 1);
  }

  interface Bucket {
    relative: number[];
    followers: number[];
    views: number[];
    creators: Set<string>;
    formats: Map<string, number>;
    examples: { title: string; url: string; views: number | null }[];
  }
  const bySubject = new Map<string, Bucket>();

  for (const item of items) {
    const ratio = perFollower(item);
    if (ratio === null) continue;
    const relative = ratio / (baseline.get(item.contentType) ?? 1);

    // A subject listed twice on one item counts once.
    for (const subject of new Set(item.subjects)) {
      if (subject.trim() === '') continue;
      let bucket = bySubject.get(subject);
      if (bucket === undefined) {
        bucket = { relative: [], followers: [], views: [], creators: new Set(), formats: new Map(), examples: [] };
        bySubject.set(subject, bucket);
      }
      bucket.relative.push(relative);
      if (item.followers !== null) bucket.followers.push(item.followers);
      if (item.views !== null) bucket.views.push(item.views);
      if (item.creatorId !== null) bucket.creators.add(item.creatorId);
      bucket.formats.set(item.contentType, (bucket.formats.get(item.contentType) ?? 0) + 1);
      if (bucket.examples.length < 4) {
        bucket.examples.push({ title: item.title, url: item.url, views: item.views });
      }
    }
  }

  const niches: Niche[] = [];
  let dropped = 0;

  for (const [subject, bucket] of bySubject) {
    if (bucket.relative.length < MIN_ITEMS) continue;
    if (bucket.creators.size < MIN_CREATORS) {
      dropped++;
      continue;
    }
    niches.push({
      subject,
      n: bucket.relative.length,
      creators: bucket.creators.size,
      // Median rather than mean throughout: one viral item in a subject would
      // otherwise speak for the whole subject.
      lift: round(median(bucket.relative), 1),
      medianFollowers: Math.round(median(bucket.followers)),
      medianViews: Math.round(median(bucket.views)),
      formats: [...bucket.formats]
        .map(([key, n]) => ({ key, n }))
        .sort((a, b) => b.n - a.n),
      examples: bucket.examples,
    });
  }

  niches.sort((a, b) => b.lift - a.lift);

  return {
    n: items.length,
    formatBaselines: [...baseline].map(([key, perFollowerValue]) => ({
      key,
      perFollower: round(perFollowerValue, 2),
      n: byFormat.get(key)?.length ?? 0,
    })),
    niches,
    minCreators: MIN_CREATORS,
    minItems: Math.max(MIN_ITEMS, 0),
    droppedForConcentration: dropped,
  };
}

/** Re-exported so callers can state the bar without importing two modules. */
export { MIN_SAMPLE };
