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
 * is specific here is which baseline, and that took four attempts.
 *
 *   1. **Views alone** ranks by channel size. Useless.
 *   2. **Views per subscriber** looked right and was measuring format. On a
 *      real corpus, shorts average 19.7 views per subscriber against 4.3 for
 *      ordinary videos — YouTube shows shorts to non-subscribers, so the top of
 *      that ranking was simply the subjects that happen to be shorts.
 *   3. **Views per subscriber against the format median** fixed that and left
 *      something eight times larger. Dividing by followers does not remove the
 *      size effect, it inverts it: after the format correction, accounts under
 *      a hundred subscribers still read 10.1x and accounts over a hundred
 *      thousand 0.27x — a 37-fold gradient against the 4.5-fold format one.
 *      The list was a ranking of which subjects very small accounts tag.
 *   4. **Views per subscriber against the median for that format *and* that
 *      size band**, which is what this computes.
 *
 * The correction is not a refinement. On the corpus this was built against it
 * replaced most of the top ten, and the two subjects this file previously cited
 * as its own validation — `قدیمی` at rank 1 and `rap` at rank 3 — fell to rank
 * 76 (1.4x) and rank 176 (0.9x, exactly ordinary for accounts that size).
 *
 * Neither confound is a quirk of this metric. Format has now appeared in the
 * thumbnail analysis, the title analysis and here; size is the second stratum
 * timing needed too, where the source effect turned out larger than the age
 * effect that module was written to remove.
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
 * Higher than the five the tag analysis uses, and the difference was measured
 * rather than guessed. At five, two subjects arrived with near-identical
 * figures — the signature of a tag block travelling together on the same
 * handful of accounts rather than of two independent findings.
 *
 * Re-derived against the size-corrected measure, since the first derivation
 * rested on the uncorrected one:
 *
 *     >=5    #بارسلونا #پوتک #خواهر #شطرنج #یوتوب_فارسی   367 subjects
 *     >=8    #خواهر #دوبله_فارسی #facts #sports            284
 *     >=10   #دوبله_فارسی #facts #دوربین_مخفی #نیما        240
 *
 * The answer still changes character between five and eight and then settles,
 * and eight still leaves 284 subjects, so the stricter bar costs nothing worth
 * having. It is a parameter rather than a constant because a thinner database
 * will want it lower and will have to accept what that means.
 */
export const MIN_CREATORS = 8;

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
  /** How many channel-size bands each format was split into. */
  readonly sizeBands: number;
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

/**
 * Channel size, in bands, as the second half of the stratum.
 *
 * Dividing by followers does not remove the size effect, it inverts it. Reach
 * per subscriber falls steeply as an account grows, because a channel's first
 * hundred subscribers are the least predictive of who sees a video and its
 * hundred-thousandth are the most. Measured on a real corpus, after the format
 * correction was already applied:
 *
 *     under 100 subs     10.12x       10k-100k     0.56x
 *     100-1k              2.02x       over 100k    0.27x
 *     1k-10k              1.03x
 *
 * That is a 37-fold gradient, against the 4.5-fold format gradient this module
 * was already correcting. Uncorrected, "where a small account can land" ranks
 * whichever subjects very small accounts happen to tag, which is a fact about
 * the accounts and not about the subject.
 *
 * Bands rather than a continuous adjustment: the relationship is not linear in
 * followers, and a band keeps the comparison to accounts of genuinely similar
 * size without asking the data to support a fitted curve it cannot.
 */
const SIZE_BANDS: readonly number[] = [100, 1_000, 10_000, 100_000, Infinity];

function sizeBandOf(followers: number): string {
  for (let i = 0; i < SIZE_BANDS.length; i++) {
    if (followers < (SIZE_BANDS[i] ?? Infinity)) return String(i);
  }
  return String(SIZE_BANDS.length - 1);
}

export function findNiches(
  items: readonly NicheItem[],
  minCreators: number = MIN_CREATORS,
): NicheAnalysis {
  // What is normal for an account of this size making this kind of thing.
  // Both halves are needed: format alone left a gradient eight times larger
  // than the one it removed.
  const stratumOf = (item: NicheItem): string =>
    `${item.contentType}|${sizeBandOf(item.followers ?? 0)}`;

  const byStratum = new Map<string, number[]>();
  const byFormat = new Map<string, number[]>();
  for (const item of items) {
    const ratio = perFollower(item);
    if (ratio === null) continue;
    const key = stratumOf(item);
    const list = byStratum.get(key);
    if (list === undefined) byStratum.set(key, [ratio]);
    else list.push(ratio);
    // Kept separately only so the page can still name the format normals,
    // which are the readable half of the correction.
    const formatList = byFormat.get(item.contentType);
    if (formatList === undefined) byFormat.set(item.contentType, [ratio]);
    else formatList.push(ratio);
  }

  const baseline = new Map<string, number>();
  for (const [key, ratios] of byStratum) {
    const m = median(ratios);
    // A stratum with no usable spread gets 1, which makes its items ordinary
    // rather than infinite.
    baseline.set(key, m > 0 ? m : 1);
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
    const relative = ratio / (baseline.get(stratumOf(item)) ?? 1);

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
    if (bucket.creators.size < minCreators) {
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
    formatBaselines: [...byFormat].map(([key, ratios]) => ({
      key,
      perFollower: round(median(ratios), 2),
      n: ratios.length,
    })),
    /** Bands of channel size are the other half of the stratum. */
    sizeBands: SIZE_BANDS.length,
    niches,
    minCreators,
    minItems: Math.max(MIN_ITEMS, 0),
    droppedForConcentration: dropped,
  };
}

/** Re-exported so callers can state the bar without importing two modules. */
export { MIN_SAMPLE };
