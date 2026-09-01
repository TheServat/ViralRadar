/**
 * What people are looking for and nobody here has made.
 *
 * Two of the sources are different in kind, and that difference is the whole
 * feature. Google Trends items are *searches* — what an audience is asking
 * for. YouTube items are *videos* — what exists. Put them side by side in one
 * language and country and the interesting rows are the ones with demand on the
 * left and nothing on the right.
 *
 * The claim this makes has to be scoped precisely, and the page repeats it: a
 * gap means **nothing in what this radar has collected is about that topic**.
 * It is not "there are no videos about this on YouTube", which is a statement
 * about a platform this program has only ever seen a sample of. The value is
 * that it points somewhere worth checking, not that it settles the question.
 *
 * Matching is by meaning rather than by words, because a search reads "قیمت
 * طلا امروز" and a video reads "آموزش طلاسازی" — related, differently worded,
 * and in the case of those two, not actually the same subject. A word overlap
 * cannot tell those apart in either direction.
 */

/** A thing people searched for. */
export interface DemandTopic {
  readonly id: string;
  readonly title: string;
  /** How hard it is trending, on the same 0..100 scale as everything else. */
  readonly score: number;
  readonly lang: string | null;
  readonly country: string | null;
  readonly firstSeenAt: number;
  /**
   * How many countries are searching for it.
   *
   * One means local — a fixture, a politician, a regional celebrity — and
   * there are hundreds of those a day. Six means a phenomenon, and a
   * phenomenon transfers to an audience that has not been served it yet.
   */
  readonly countries: number;
  /** Null when the embedding job has not reached it, or is switched off. */
  readonly vector: Float32Array | null;
}

/** Something that exists, which might be about a topic. */
export interface SupplyItem {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  /** 0..1 rank inside its own source. Used to say how well the coverage did. */
  readonly percentile: number;
  readonly vector: Float32Array | null;
}

/**
 * How close a video has to be to count as being about a search.
 *
 * Deliberately far below the clustering threshold of 0.86, and for a different
 * question. Clustering asks "are these the same story", which two headlines
 * about one event pass and nothing else does. This asks "is this video about
 * that subject", which a two-word search and a forty-word title can satisfy
 * while sitting nowhere near each other in wording.
 *
 * Measured against a real Persian corpus: the one search topic with genuine
 * coverage scored 0.76, 0.75, 0.75 on its three best videos, while four topics
 * with no real coverage peaked at 0.63, 0.58, 0.56 and 0.53 — and those top
 * matches were plainly about something else. The bar sits in that gap.
 */
export const COVERED_AT = 0.7;

/**
 * Coverage below this is worth reporting as thin rather than as answered.
 *
 * One video about a subject people are searching for is not the subject being
 * served; it is one video.
 */
export const THIN_BELOW = 3;

export type Verdict = 'uncovered' | 'thin' | 'covered';

export interface GapMatch {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly similarity: number;
  readonly percentile: number;
}

export interface Gap {
  readonly id: string;
  readonly topic: string;
  readonly score: number;
  readonly lang: string | null;
  readonly country: string | null;
  readonly firstSeenAt: number;
  /** How many countries want it. The higher, the more it travels. */
  readonly countries: number;
  /** How many collected items are about it. */
  readonly covered: number;
  readonly verdict: Verdict;
  /** The closest things found, whether or not any cleared the bar. */
  readonly matches: readonly GapMatch[];
  /** False when the topic has no vector, so this row was matched on words. */
  readonly byMeaning: boolean;
}

export interface GapAnalysis {
  readonly topics: number;
  readonly supply: number;
  readonly gaps: readonly Gap[];
  readonly coveredAt: number;
  readonly thinBelow: number;
  /** How many of the topics nothing covers at all — the headline number. */
  readonly uncovered: number;
}

/** Cosine similarity. Vectors are stored normalised, so this is a dot product. */
function similarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += (a[i] as number) * (b[i] as number);
  return dot;
}

/**
 * Words worth matching on, when there is no vector to use.
 *
 * Crude and it says so: the fallback exists only to keep the page working with
 * `EMBED_MODEL` unset, and a row matched this way is flagged so the interface
 * can be less certain about it.
 */
function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s\p{P}]+/u)
      .filter((w) => [...w].length >= 3),
  );
}

function overlap(topic: string, title: string): number {
  const a = words(topic);
  if (a.size === 0) return 0;
  const b = words(title);
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / a.size;
}

/**
 * Ranks demand against supply.
 *
 * Sorted by how much the topic is trending rather than by how empty it is: a
 * gap nobody is searching for is not an opportunity, it is an absence. The
 * verdict column carries the emptiness.
 */
/** A kept match with the unrounded score it was ranked by. */
interface Ranked {
  readonly raw: number;
  readonly match: GapMatch;
}

export function findGaps(
  demand: readonly DemandTopic[],
  supply: readonly SupplyItem[],
  keep = 3,
): GapAnalysis {
  // One row has the whole page to itself and should show its working; sixty
  // rows each showing eight matches is a wall nobody reads.
  const show = demand.length === 1 ? Math.max(keep, 8) : keep;
  const gaps: Gap[] = [];

  for (const topic of demand) {
    const byMeaning = topic.vector !== null;
    // Only the closest few are ever shown, and only a count is needed for the
    // verdict — so nothing else is kept. Scoring every pair and sorting the
    // result was most of the cost of this page: sixty topics against ten
    // thousand items is six hundred thousand objects allocated and sorted to
    // read three of them. Keeping a short ranked list instead is what makes it
    // affordable to compare against the whole window rather than a slice.
    const best: Ranked[] = [];
    let covered = 0;

    for (const item of supply) {
      const score =
        byMeaning && item.vector !== null
          ? similarity(topic.vector as Float32Array, item.vector)
          : // The word fallback is on a different scale entirely, so it is
            // mapped onto the same one rather than compared against a bar it
            // was never calibrated for.
            overlap(topic.title, item.title) * COVERED_AT;

      if (score <= 0) continue;
      if (score >= COVERED_AT) covered++;

      // The comparison is between raw scores. `similarity` on the stored match
      // is rounded to three places for display, and reading it back to decide
      // what the list holds compares a raw score against a rounded one - so an
      // item a thousandth better than the one it should replace was sometimes
      // kept out, and one a thousandth worse let in. It only ever changed the
      // last slot, and never the verdict, which is computed from `score` above
      // - but a top-k that is not quite the top k is not worth keeping.
      const weakest = best.length < show ? -1 : (best[best.length - 1]?.raw ?? -1);
      if (best.length === show && score <= weakest) continue;

      const match: Ranked = {
        raw: score,
        match: {
          id: item.id,
          title: item.title,
          url: item.url,
          similarity: Math.round(score * 1000) / 1000,
          percentile: Math.round(item.percentile * 100),
        },
      };
      if (best.length < show) best.push(match);
      else best[best.length - 1] = match;
      best.sort((a, b) => b.raw - a.raw);
    }

    gaps.push({
      id: topic.id,
      topic: topic.title,
      score: topic.score,
      lang: topic.lang,
      country: topic.country,
      firstSeenAt: topic.firstSeenAt,
      countries: topic.countries,
      covered,
      verdict: covered === 0 ? 'uncovered' : covered < THIN_BELOW ? 'thin' : 'covered',
      // The closest few are kept even when none cleared the bar. "Nothing is
      // about this, and here is the nearest thing" is a far more useful answer
      // than an empty row, and it is also how a wrong threshold becomes
      // visible rather than silently producing gaps.
      matches: best.map((b) => b.match),
      byMeaning,
    });
  }

  // Reach across countries first, then how hard it is trending. A subject
  // eight countries are searching for is worth more than a slightly hotter one
  // that only one country has heard of, because only the first one transfers.
  gaps.sort((a, b) => (b.countries - a.countries) || (b.score - a.score));

  return {
    topics: demand.length,
    supply: supply.length,
    gaps,
    coveredAt: COVERED_AT,
    thinBelow: THIN_BELOW,
    uncovered: gaps.filter((g) => g.verdict === 'uncovered').length,
  };
}
