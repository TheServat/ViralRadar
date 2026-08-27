/**
 * Topic clustering without embeddings.
 *
 * Groups items that are telling the same story, across platforms, using
 * tf-idf cosine similarity with a rare-term inverted index for blocking, plus
 * SimHash for outright reposts. No model, no vector database, no network call.
 *
 * An optional embedding plugin can raise recall later; nothing here depends
 * on one existing.
 */
import { TfIdf, contentTokens, cosine, hammingDistance, jaccard, labelFromKeywords, stemTokens } from './text.ts';
import { clamp } from './stats.ts';
import { TREND_STATE_RANK, type TrendState } from './types.ts';

export interface ClusterableItem {
  readonly id: string;
  readonly source: string;
  /** Title plus a body snippet; what the clustering actually reads. */
  readonly text: string;
  readonly simhash: string | null;
  /** Creator key inside the source; used to count distinct authors. */
  readonly creatorId: string | null;
  readonly lang: string | null;
  readonly country: string | null;
  readonly hashtags: readonly string[];
  readonly score: number;
  readonly state: TrendState;
  readonly views: number | null;
  readonly engagement: number | null;
  /** Epoch seconds; used for the cluster's own growth rate. */
  readonly seenAt: number;
}

export interface ClusterMember {
  readonly id: string;
  readonly similarity: number;
}

export interface BuiltCluster {
  /** Stable across runs: derived from the cluster's strongest keywords. */
  readonly key: string;
  readonly label: string;
  readonly keywords: readonly string[];
  readonly members: readonly ClusterMember[];
  readonly sources: readonly string[];
  readonly languages: readonly { code: string; pct: number }[];
  readonly countries: readonly { code: string; pct: number }[];
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly score: number;
  readonly state: TrendState;
  /** New items joining this cluster per hour - comparable across platforms. */
  readonly velocity: number;
  readonly acceleration: number;
  readonly totalViews: number | null;
  readonly totalEngagement: number | null;
}

export interface ClusterOptions {
  /** Cosine similarity needed to join an existing cluster. */
  readonly similarityThreshold: number;
  /** SimHash bit distance below which two items are treated as the same post. */
  readonly duplicateBits: number;
  /** Terms appearing in more than this fraction of documents never block. */
  readonly maxDocumentFrequency: number;
  /** Terms kept per document vector. */
  readonly vectorSize: number;
  readonly minClusterSize: number;
  readonly now: number;
}

export const DEFAULT_CLUSTER_OPTIONS: Omit<ClusterOptions, 'now'> = {
  similarityThreshold: 0.34,
  duplicateBits: 6,
  maxDocumentFrequency: 0.25,
  vectorSize: 14,
  minClusterSize: 1,
};

interface WorkingCluster {
  centroid: Map<string, number>;
  members: { id: string; similarity: number }[];
  items: ClusterableItem[];
  terms: Set<string>;
}

/**
 * Similarity runs on stems, but a label made of stems reads like a ransom note.
 * This remembers the most common surface form behind each stem so the cluster
 * can be named in words a person actually wrote.
 */
class DisplayForms {
  private readonly counts = new Map<string, Map<string, number>>();

  learn(raw: readonly string[], stemmed: readonly string[]): void {
    for (let i = 0; i < stemmed.length; i++) {
      const key = stemmed[i] as string;
      const surface = raw[i] as string;
      let bucket = this.counts.get(key);
      if (bucket === undefined) {
        bucket = new Map();
        this.counts.set(key, bucket);
      }
      bucket.set(surface, (bucket.get(surface) ?? 0) + 1);
    }
  }

  /** Maps a stem, or a phrase of stems, back to readable text. */
  render(term: string): string {
    return term
      .split(' ')
      .map((part) => {
        const bucket = this.counts.get(part);
        if (bucket === undefined) return part;
        return [...bucket.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? part;
      })
      .join(' ');
  }
}

function vectorOf(tokens: readonly string[], idf: TfIdf, size: number): Map<string, number> {
  const top = idf.top(tokens, size);
  const v = new Map<string, number>();
  for (const { term, score } of top) v.set(term, score);
  return v;
}

function mergeCentroid(centroid: Map<string, number>, vector: ReadonlyMap<string, number>, n: number): void {
  for (const [term, weight] of vector) {
    const existing = centroid.get(term) ?? 0;
    centroid.set(term, (existing * n + weight) / (n + 1));
  }
}

function distribution(values: readonly (string | null)[]): { code: string; pct: number }[] {
  const known = values.filter((v): v is string => v !== null && v.length > 0);
  if (known.length === 0) return [];
  const counts = new Map<string, number>();
  for (const v of known) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .map(([code, n]) => ({ code, pct: Math.round((n / known.length) * 100) }))
    .sort((a, b) => b.pct - a.pct);
}

/**
 * Greedy single-pass agglomerative clustering.
 *
 * Items are processed strongest-first so the highest-signal item anchors each
 * cluster. Candidate clusters come from an inverted index of rare terms, which
 * keeps this near-linear instead of comparing every pair.
 */
export function buildClusters(
  items: readonly ClusterableItem[],
  options: ClusterOptions,
): BuiltCluster[] {
  if (items.length === 0) return [];

  const idf = new TfIdf();
  const tokensById = new Map<string, string[]>();
  const display = new DisplayForms();
  for (const item of items) {
    const raw = contentTokens(item.text);
    const tokens = stemTokens(raw);
    display.learn(raw, tokens);
    tokensById.set(item.id, tokens);
    idf.add(tokens);
  }

  const ordered = [...items].sort((a, b) => b.score - a.score);
  const clusters: WorkingCluster[] = [];
  /** rare term -> indexes of clusters containing it. */
  const index = new Map<string, Set<number>>();
  // Blocking exists to avoid comparing every pair in a large corpus. On a small
  // one there is nothing to save, and pruning aggressively there would leave a
  // handful of related items with no shared blocking term at all - so the cap
  // never drops below a floor.
  const maxDf = Math.max(8, Math.floor(idf.documents * options.maxDocumentFrequency));

  for (const item of ordered) {
    const tokens = tokensById.get(item.id) ?? [];
    const vector = vectorOf(tokens, idf, options.vectorSize);
    const tokenSet = new Set(tokens);

    const candidates = new Set<number>();
    for (const term of vector.keys()) {
      if (idf.documentFrequency(term) > maxDf) continue;
      for (const ci of index.get(term) ?? []) candidates.add(ci);
    }

    let bestIndex = -1;
    let bestSim = 0;
    for (const ci of candidates) {
      const cluster = clusters[ci] as WorkingCluster;
      let sim = cosine(cluster.centroid, vector);

      // A near-identical repost joins regardless of how thin its wording is.
      if (item.simhash !== null) {
        for (const other of cluster.items) {
          if (other.simhash === null) continue;
          if (hammingDistance(item.simhash, other.simhash) <= options.duplicateBits) {
            sim = Math.max(sim, 0.95);
            break;
          }
        }
      }
      // Short titles carry few tf-idf terms; token overlap rescues them.
      if (sim < options.similarityThreshold && tokenSet.size > 0) {
        for (const other of cluster.items) {
          const otherTokens = tokensById.get(other.id);
          if (otherTokens === undefined) continue;
          const j = jaccard(tokenSet, new Set(otherTokens));
          if (j >= 0.55) {
            sim = Math.max(sim, j);
            break;
          }
        }
      }
      if (sim > bestSim) {
        bestSim = sim;
        bestIndex = ci;
      }
    }

    if (bestIndex >= 0 && bestSim >= options.similarityThreshold) {
      const cluster = clusters[bestIndex] as WorkingCluster;
      mergeCentroid(cluster.centroid, vector, cluster.members.length);
      cluster.members.push({ id: item.id, similarity: Number(bestSim.toFixed(4)) });
      cluster.items.push(item);
      for (const term of vector.keys()) {
        if (idf.documentFrequency(term) > maxDf) continue;
        if (!cluster.terms.has(term)) {
          cluster.terms.add(term);
          let bucket = index.get(term);
          if (bucket === undefined) {
            bucket = new Set();
            index.set(term, bucket);
          }
          bucket.add(bestIndex);
        }
      }
    } else {
      const ci = clusters.length;
      const terms = new Set<string>();
      clusters.push({
        centroid: new Map(vector),
        members: [{ id: item.id, similarity: 1 }],
        items: [item],
        terms,
      });
      for (const term of vector.keys()) {
        if (idf.documentFrequency(term) > maxDf) continue;
        terms.add(term);
        let bucket = index.get(term);
        if (bucket === undefined) {
          bucket = new Set();
          index.set(term, bucket);
        }
        bucket.add(ci);
      }
    }
  }

  return clusters
    .filter((c) => c.items.length >= options.minClusterSize)
    .map((c) => finalise(c, options.now, display))
    .sort((a, b) => b.score - a.score);
}

function finalise(cluster: WorkingCluster, now: number, display: DisplayForms): BuiltCluster {
  const items = cluster.items;
  const keywords = [...cluster.centroid.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([term]) => display.render(term));

  const hashtagCounts = new Map<string, number>();
  for (const i of items) for (const h of i.hashtags) hashtagCounts.set(h, (hashtagCounts.get(h) ?? 0) + 1);
  const topHashtags = [...hashtagCounts.entries()]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([h]) => `#${h}`);

  const sources = [...new Set(items.map((i) => i.source))].sort();
  const seenTimes = items.map((i) => i.seenAt);
  const firstSeenAt = Math.min(...seenTimes);
  const lastSeenAt = Math.max(...seenTimes);

  // Growth measured in *items joining per hour*: the one growth number that
  // means the same thing on every platform.
  const lastHour = items.filter((i) => now - i.seenAt <= 3600).length;
  const prevHour = items.filter((i) => now - i.seenAt > 3600 && now - i.seenAt <= 7200).length;

  const scores = items.map((i) => i.score).sort((a, b) => b - a);
  const best = scores[0] ?? 0;
  const breadth = clamp((sources.length - 1) / 3, 0, 1);
  const volume = clamp(Math.log1p(items.length) / Math.log1p(12), 0, 1);
  const score = clamp(best * 0.62 + 100 * (0.24 * breadth + 0.14 * volume), 0, 100);

  const state = items
    .map((i) => i.state)
    .sort((a, b) => TREND_STATE_RANK[a] - TREND_STATE_RANK[b])[0] as TrendState;

  const views = items.map((i) => i.views).filter((v): v is number => v !== null);
  const engagement = items.map((i) => i.engagement).filter((v): v is number => v !== null);

  return {
    key: keywordKey(keywords),
    label: topHashtags.length > 0 ? topHashtags.join(' ') : labelFromKeywords(keywords),
    keywords,
    members: cluster.members,
    sources,
    languages: distribution(items.map((i) => i.lang)),
    countries: distribution(items.map((i) => i.country)),
    firstSeenAt,
    lastSeenAt,
    score,
    state,
    velocity: lastHour,
    acceleration: lastHour - prevHour,
    totalViews: views.length > 0 ? views.reduce((a, b) => a + b, 0) : null,
    totalEngagement: engagement.length > 0 ? engagement.reduce((a, b) => a + b, 0) : null,
  };
}

/**
 * A cluster identity that survives across analysis runs: the same story keeps
 * the same id as long as its strongest keywords are stable, so its score
 * history in `cluster_snapshots` stays continuous.
 */
export function keywordKey(keywords: readonly string[]): string {
  return keywords
    .slice(0, 4)
    .map((k) => k.replace(/\s+/g, '_'))
    .sort()
    .join('|');
}
