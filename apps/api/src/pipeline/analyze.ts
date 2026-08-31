/**
 * The analysis pass.
 *
 *   baselines -> score -> cluster -> re-score corroborated items -> keywords
 *
 * Everything here is derived. Nothing in this file talks to the network, and
 * every number it writes can be recomputed from `content_metrics` alone, which
 * is what makes a stored score reproducible from its scoring version.
 */
import { config } from '../config.ts';
import { createLogger } from '../logger.ts';
import * as repo from '../db/repo.ts';
import { tx, optimizeDb } from '../db/db.ts';
import { quantile, mad as medianAbsDev } from '../core/stats.ts';
import {
  detectCreatorBreakout,
  scoreContent,
  type Quantiles,
  type ScoreInput,
  type ScoringOptions,
} from '../core/score.ts';
import { buildClusters, DEFAULT_CLUSTER_OPTIONS, type ClusterableItem } from '../core/cluster.ts';
import { hourBucket, nowSec, type CreatorBaseline, type MetricName, type TrendState } from '../core/types.ts';
import { allPlugins } from '../sources/registry.ts';
import { fromBlob } from '../ai/embed.ts';
import type { SourceCapabilities } from '../sources/types.ts';

const log = createLogger('analyze');

/**
 * The scoring settings, read when they are used rather than when this file
 * loads.
 *
 * This was a constant, built at module scope, and `config.ts` warns about
 * precisely that: reloading replaces `config.scoring` wholesale, so anything
 * that copied a value out at load keeps the old one forever. Every weight on
 * the settings screen and in the tuning recipe in `docs/operations.md` was in
 * that copy — `W_ACCELERATION`, `W_VELOCITY`, `W_FRESHNESS`, `MAX_AGE_HOURS` —
 * and the screen answered "Saved and applied. No restart needed."
 *
 * `MAX_AGE_HOURS` was worse than inert. The scoring window is sized from the
 * live value, so raising it admitted older items, while the age gate inside
 * `scoreContent` still used the stale one and scored them at 0.35 — persisted
 * as DEAD. Raising the setting that says "look further back" buried what it
 * found.
 *
 * A function, not a cached object: `config` keeps its identity across a reload
 * and its contents do not.
 */
export function scoringOptions(): ScoringOptions {
  return {
    weights: config.scoring.weights,
    maxAgeHours: config.scoring.maxAgeHours,
    freshnessHalfLifeHours: config.scoring.freshnessHalfLifeHours,
    version: config.scoring.version,
  };
}

/** Hourly baselines need enough samples before they beat the pooled one. */
const MIN_HOURLY_SAMPLES = 20;
/** Below this, a creator has no baseline worth calling a baseline. */
const MIN_CREATOR_SAMPLES = 3;

// ── Baselines ──────────────────────────────────────────────────────────────

function quantilesOf(values: readonly number[]): {
  p50: number | null;
  p75: number | null;
  p90: number | null;
  p99: number | null;
  mad: number | null;
  count: number;
} {
  return {
    p50: quantile(values, 0.5),
    p75: quantile(values, 0.75),
    p90: quantile(values, 0.9),
    p99: quantile(values, 0.99),
    mad: medianAbsDev(values),
    count: values.length,
  };
}

/**
 * Rebuilds each source's own distribution of growth rates and absolute sizes,
 * pooled and per hour of day. This is the machinery that lets one score compare
 * a YouTube view count with a Reddit upvote count without either dominating.
 */
export function rebuildBaselines(now = nowSec()): void {
  const since = now - 7 * 86400;

  for (const plugin of allPlugins()) {
    const samples = repo.baselineSamples(plugin.id, since);
    if (samples.length === 0) continue;

    const velocities = samples.map((s) => s.velocity).filter((v): v is number => v !== null);
    const values = samples.map((s) => s.primary_value).filter((v): v is number => v !== null);

    repo.saveBaseline(plugin.id, 'velocity', 'all', quantilesOf(velocities), now);
    repo.saveBaseline(plugin.id, 'value', 'all', quantilesOf(values), now);

    for (let hour = 0; hour < 24; hour++) {
      const inHour = samples.filter((s) => s.hour === hour);
      if (inHour.length < MIN_HOURLY_SAMPLES) continue;
      const bucket = `h${String(hour).padStart(2, '0')}`;
      repo.saveBaseline(
        plugin.id,
        'velocity',
        bucket,
        quantilesOf(inHour.map((s) => s.velocity).filter((v): v is number => v !== null)),
        now,
      );
      repo.saveBaseline(
        plugin.id,
        'value',
        bucket,
        quantilesOf(inHour.map((s) => s.primary_value).filter((v): v is number => v !== null)),
        now,
      );
    }
  }
}

function pickQuantiles(source: string, metric: 'velocity' | 'value', hour: number): Quantiles | null {
  const bucket = `h${String(hour).padStart(2, '0')}`;
  const hourly = repo.getBaseline(source, metric, bucket);
  if (hourly !== null && hourly.sampleCount >= MIN_HOURLY_SAMPLES) return hourly;
  return repo.getBaseline(source, metric, 'all');
}

// ── Creator baselines ──────────────────────────────────────────────────────

class CreatorCache {
  private readonly samples = new Map<string, number[]>();
  private readonly baselines = new Map<string, CreatorBaseline | null>();
  private readonly now: number;

  constructor(now: number) {
    this.now = now;
  }

  /**
   * The creator's own history, with the item under judgement removed so a video
   * can never raise the bar it is being measured against.
   */
  for(source: string, authorId: string, metric: MetricName, currentValue: number | null): CreatorBaseline | null {
    const id = repo.creatorIdOf(source, authorId);
    let pool = this.samples.get(id);
    if (pool === undefined) {
      pool = repo.creatorSamples(source, authorId, repo.metricColumn(metric));
      this.samples.set(id, pool);
    }

    const others = [...pool];
    if (currentValue !== null) {
      const at = others.indexOf(currentValue);
      if (at >= 0) others.splice(at, 1);
    }
    if (others.length < MIN_CREATOR_SAMPLES) return null;

    const cached = this.baselines.get(id);
    if (cached !== undefined && currentValue === null) return cached;

    const stats = quantilesOf(others);
    repo.saveCreatorBaseline(id, stats, this.now);
    const record = repo.getCreator(id);
    const baseline: CreatorBaseline | null =
      record === undefined
        ? null
        : {
            ...record,
            medianMetric: stats.p50,
            p90Metric: stats.p90,
            p99Metric: stats.p99,
            sampleCount: others.length,
          };
    this.baselines.set(id, baseline);
    return baseline;
  }
}

// ── Scoring pass ───────────────────────────────────────────────────────────

interface Capability {
  readonly primaryMetric: MetricName;
  readonly engagementReference: number;
  readonly baseReliability: number;
}

function capabilities(): Map<string, Capability> {
  const map = new Map<string, Capability>();
  for (const plugin of allPlugins()) {
    const c: SourceCapabilities = plugin.capabilities;
    map.set(plugin.id, {
      primaryMetric: c.primaryMetric,
      engagementReference: c.engagementReference,
      baseReliability: c.baseReliability,
    });
  }
  return map;
}

export interface AnalyzeResult {
  readonly scored: number;
  readonly clusters: number;
  readonly crossSourceClusters: number;
  readonly breakouts: number;
  readonly viral: number;
  readonly emerging: number;
  readonly durationMs: number;
}

export function analyze(now = nowSec()): AnalyzeResult {
  const started = Date.now();
  // Read once per pass, so every item in it is scored on the same settings,
  // and the next pass picks up a change without a restart. The window below
  // reads the same value; they used to disagree, and the disagreement scored
  // the newly admitted items as DEAD.
  const scoring = scoringOptions();
  const windowSec = Math.max(scoring.maxAgeHours * 3600, 48 * 3600);

  rebuildBaselines(now);

  const caps = capabilities();
  const creators = new CreatorCache(now);
  const crossSource = repo.crossSourceCounts();
  const reliability = new Map<string, number>();
  for (const health of repo.allHealth()) reliability.set(health.source, health.reliability);

  const rows = repo.contentToScore(now - windowSec);
  if (rows.length === repo.SCORE_LIMIT) {
    // Truncation is not a tuning detail here. Anything cut keeps the score and
    // the age it had when it was last read, and the dashboard filters on that
    // stored age — so a silent cut shows stale items inside a "last 24 hours"
    // view. If this ever appears, raise the ceiling or shorten the window.
    log.warn('scoring window truncated: some items keep a stale score and a stale age', {
      limit: repo.SCORE_LIMIT,
      windowHours: Math.round(windowSec / 3600),
    });
  }
  const scorable: ClusterableItem[] = [];
  let breakouts = 0;
  let viral = 0;
  let emerging = 0;

  tx(() => {
    for (const row of rows) {
      const capability = caps.get(row.source);
      if (capability === undefined) continue;

      const snapshots = repo.getSnapshots(row.id);
      if (snapshots.length === 0) continue;

      const latest = snapshots[snapshots.length - 1];
      const currentValue = latest === undefined ? null : (latest[capability.primaryMetric] ?? null);
      const hour = new Date(row.first_seen_at * 1000).getUTCHours();

      const creator =
        row.author_id === null ? null : creators.for(row.source, row.author_id, capability.primaryMetric, currentValue);

      const previous = repo.getScore(row.id);

      const input: ScoreInput = {
        now,
        publishedAt: row.published_at,
        firstSeenAt: row.first_seen_at,
        snapshots,
        primaryMetric: capability.primaryMetric,
        engagementReference: capability.engagementReference,
        creator,
        velocityQuantiles: pickQuantiles(row.source, 'velocity', hour),
        valueQuantiles: pickQuantiles(row.source, 'value', hour),
        crossSourceCount: crossSource.get(row.id) ?? 1,
        sourceReliability: (reliability.get(row.source) ?? 1) * capability.baseReliability,
        previousPeakScore: previous?.peak_score ?? null,
        options: scoring,
      };

      const result = scoreContent(input);

      repo.saveScore({
        contentId: row.id,
        source: row.source,
        score: result.score,
        confidence: result.confidence,
        state: result.state,
        primaryMetric: result.primaryMetric,
        primaryValue: result.primaryValue,
        velocity: result.signals.velocity,
        acceleration: result.signals.acceleration,
        engagementRate: result.signals.engagementRate,
        creatorAnomaly: result.signals.creatorAnomaly,
        sourcePercentile: result.signals.sourcePercentile,
        freshness: result.signals.freshness,
        crossSource: result.signals.crossSource,
        observations: result.observations,
        ageHours: result.ageHours,
        scoringVersion: result.scoringVersion,
        now,
      });

      // A state promotion is worth an event; the same state again is not.
      if (previous?.state !== result.state) {
        if (result.state === 'VIRAL' || result.state === 'HOT') {
          repo.appendEvent('trend.detected', row.source, row.id, { state: result.state, score: result.score });
        } else if (result.state === 'PEAK') {
          repo.appendEvent('trend.peaked', row.source, row.id, { score: result.score });
        }
      }
      if (result.state === 'VIRAL') viral++;
      if (result.state === 'EMERGING') emerging++;

      // Creator breakout: judged against the creator's own history only.
      if (creator !== null && row.author_id !== null) {
        const verdict = detectCreatorBreakout(result.primaryValue, creator, { minSamples: 5, minRatio: 5 });
        if (verdict.isBreakout && verdict.ratio !== null && verdict.baseline !== null) {
          const recorded = repo.recordBreakout({
            creatorId: repo.creatorIdOf(row.source, row.author_id),
            contentId: row.id,
            ratio: verdict.ratio,
            baseline: verdict.baseline,
            observed: result.primaryValue ?? 0,
            now,
          });
          if (recorded) {
            breakouts++;
            repo.appendEvent('creator.breakout', row.source, row.id, {
              ratio: Number(verdict.ratio.toFixed(1)),
              creator: row.author_name,
            });
          }
        }
      }

      scorable.push({
        id: row.id,
        source: row.source,
        // Filled in after this loop, once the cached vectors are read in one go.
        embedding: null,
        text: `${row.title} ${row.body?.slice(0, 400) ?? ''}`,
        simhash: row.simhash,
        creatorId: row.author_id,
        lang: row.lang,
        country: row.country,
        hashtags: parseArray(row.hashtags),
        score: result.score,
        state: result.state,
        views: latest?.views ?? null,
        engagement: sumEngagement(latest),
        seenAt: row.published_at ?? row.first_seen_at,
      });
    }
  });

  // Vectors are read, never computed, here: the embedding job writes them on
  // its own schedule so a stopped model can never slow down or fail analysis.
  attachEmbeddings(scorable);

  const clusters = clusterPass(
    scorable.slice(0, CLUSTER_LIMIT),
    now,
    caps,
    creators,
    crossSource,
    reliability,
  );
  const keywords = keywordPass(scorable, now);

  // Rebuilt again now that this pass has written fresh velocities. Without the
  // second rebuild the very first analysis on an empty database would leave no
  // distribution behind at all, and percentile normalisation could never start.
  rebuildBaselines(now);

  const result: AnalyzeResult = {
    scored: scorable.length,
    clusters: clusters.total,
    crossSourceClusters: clusters.crossSource,
    breakouts,
    viral,
    emerging,
    durationMs: Date.now() - started,
  };
  log.info('analysed', { ...result, keywords });
  return result;
}

/**
 * Fills in each item's cached embedding, where one exists.
 *
 * Mutates in place because `scorable` is built once and handed straight to the
 * clustering; rebuilding the array to set one field would copy several thousand
 * objects for no benefit.
 */
function attachEmbeddings(items: ClusterableItem[]): void {
  const model = config.embed.model;
  if (model === '') return;

  const blobs = repo.embeddingsFor(items.map((i) => i.id), model);
  if (blobs.size === 0) return;

  let attached = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as ClusterableItem;
    const blob = blobs.get(item.id);
    if (blob === undefined) continue;
    (items[i] as { embedding: Float32Array | null }).embedding = fromBlob(blob);
    attached++;
  }
  log.debug('embeddings attached', { attached, of: items.length });
}

function parseArray(json: string | null): string[] {
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function sumEngagement(m: { likes: number | null; comments: number | null; shares: number | null } | undefined): number | null {
  if (m === undefined) return null;
  const parts = [m.likes, m.comments, m.shares].filter((v): v is number => v !== null);
  return parts.length === 0 ? null : parts.reduce((a, b) => a + b, 0);
}

// ── Clustering pass ────────────────────────────────────────────────────────

function clusterPass(
  items: readonly ClusterableItem[],
  now: number,
  caps: Map<string, Capability>,
  creators: CreatorCache,
  previousCrossSource: Map<string, number>,
  reliability: Map<string, number>,
): { total: number; crossSource: number } {
  if (items.length === 0) return { total: 0, crossSource: 0 };

  const built = buildClusters(items, {
    ...DEFAULT_CLUSTER_OPTIONS,
    now,
    minClusterSize: 2,
    // Zero when no model is configured, which switches the pass off entirely.
    semanticMergeThreshold: config.embed.model === '' ? 0 : config.embed.mergeThreshold,
  });

  const saved = built.map((c) => ({
    id: `cl_${c.key === '' ? c.members[0]?.id ?? 'unknown' : c.key}`,
    label: c.label,
    keywords: c.keywords,
    firstSeenAt: c.firstSeenAt,
    lastSeenAt: c.lastSeenAt,
    sources: c.sources,
    languages: c.languages,
    countries: c.countries,
    score: c.score,
    // A story on four platforms is better evidence than one on a single feed.
    confidence: Math.min(1, 0.35 + 0.2 * c.sources.length + 0.02 * c.members.length),
    velocity: c.velocity,
    acceleration: c.acceleration,
    state: c.state as TrendState,
    totalViews: c.totalViews,
    totalEngagement: c.totalEngagement,
    members: c.members,
    now,
  }));

  repo.saveClusters(saved);

  // Items that just gained corroboration are re-scored immediately rather than
  // waiting a cycle: cross-platform spread is most informative while it is new.
  const fresh = repo.crossSourceCounts();
  const changed: string[] = [];
  for (const [contentId, count] of fresh) {
    if (count > 1 && count !== (previousCrossSource.get(contentId) ?? 1)) changed.push(contentId);
  }
  if (changed.length > 0) rescore(changed, now, caps, creators, fresh, reliability);

  return { total: saved.length, crossSource: saved.filter((c) => c.sources.length > 1).length };
}

function rescore(
  contentIds: readonly string[],
  now: number,
  caps: Map<string, Capability>,
  creators: CreatorCache,
  crossSource: Map<string, number>,
  reliability: Map<string, number>,
): void {
  const scoring = scoringOptions();
  tx(() => {
    for (const id of contentIds) {
      const row = repo.getContent(id);
      if (row === undefined) continue;
      const capability = caps.get(row.source);
      if (capability === undefined) continue;

      const snapshots = repo.getSnapshots(id);
      if (snapshots.length === 0) continue;
      const latest = snapshots[snapshots.length - 1];
      const currentValue = latest === undefined ? null : (latest[capability.primaryMetric] ?? null);
      const hour = new Date(row.first_seen_at * 1000).getUTCHours();
      const previous = repo.getScore(id);

      const result = scoreContent({
        now,
        publishedAt: row.published_at,
        firstSeenAt: row.first_seen_at,
        snapshots,
        primaryMetric: capability.primaryMetric,
        engagementReference: capability.engagementReference,
        creator: row.author_id === null ? null : creators.for(row.source, row.author_id, capability.primaryMetric, currentValue),
        velocityQuantiles: pickQuantiles(row.source, 'velocity', hour),
        valueQuantiles: pickQuantiles(row.source, 'value', hour),
        crossSourceCount: crossSource.get(id) ?? 1,
        sourceReliability: (reliability.get(row.source) ?? 1) * capability.baseReliability,
        previousPeakScore: previous?.peak_score ?? null,
        options: scoring,
      });

      repo.saveScore({
        contentId: id,
        source: row.source,
        score: result.score,
        confidence: result.confidence,
        state: result.state,
        primaryMetric: result.primaryMetric,
        primaryValue: result.primaryValue,
        velocity: result.signals.velocity,
        acceleration: result.signals.acceleration,
        engagementRate: result.signals.engagementRate,
        creatorAnomaly: result.signals.creatorAnomaly,
        sourcePercentile: result.signals.sourcePercentile,
        freshness: result.signals.freshness,
        crossSource: result.signals.crossSource,
        observations: result.observations,
        ageHours: result.ageHours,
        scoringVersion: result.scoringVersion,
        now,
      });
    }
  });
}

// ── Keyword / hashtag breakout ─────────────────────────────────────────────

function keywordPass(items: readonly ClusterableItem[], now: number): number {
  const bucket = hourBucket(now);
  const stats = new Map<string, { mentions: number; creators: Set<string>; sources: Set<string>; metric: number }>();

  for (const item of items) {
    const terms = new Set<string>(item.hashtags.map((h) => `#${h}`));
    for (const term of terms) {
      let entry = stats.get(term);
      if (entry === undefined) {
        entry = { mentions: 0, creators: new Set(), sources: new Set(), metric: 0 };
        stats.set(term, entry);
      }
      entry.mentions++;
      entry.sources.add(item.source);
      // Distinct authors, not distinct posts: one account spamming a hashtag is
      // not the same event as fifty accounts picking it up.
      entry.creators.add(item.creatorId ?? item.id);
      entry.metric += item.views ?? 0;
    }
  }

  tx(() => {
    for (const [keyword, entry] of stats) {
      repo.bumpKeyword(keyword, bucket, {
        mentions: entry.mentions,
        creators: entry.creators.size,
        sources: entry.sources.size,
        metric: entry.metric,
      });
    }
  });
  return stats.size;
}

/**
 * How many items are clustered, as opposed to scored.
 *
 * Two different populations on purpose, and the reason is cost. Scoring is
 * linear and cheap — 10,653 items take 2.9 seconds. Clustering the same set
 * takes 47, because its blocking threshold is a fraction of the corpus size:
 * at ten thousand documents a term appearing in twenty-six hundred of them is
 * still used to find candidates, so the candidate sets grow with the corpus
 * and the work grows with the square of it.
 *
 * This is the number clustering was already getting, back when the scoring cap
 * was 4,000 and silently doubled as one. Raising the scoring cap to cover the
 * window would otherwise have taken the pass from 8 seconds to 51, and the
 * pass runs synchronously, holding a write lock, on the thread serving HTTP.
 *
 * Items are in last-seen order, so this is the most recent, which is the right
 * axis for the question clustering answers: which stories are appearing across
 * platforms right now. Making it scale is a change to `buildClusters`, not to
 * this number — see `docs/limitations.md`.
 */
const CLUSTER_LIMIT = 4000;

/** Retention sweep, run on the slow schedule. */
export function runCleanup(now = nowSec()): repo.CleanupResult {
  const result = repo.cleanup(now, config.db.retentionDays, config.db.trendHistoryDays);
  log.info('cleanup', { ...result });
  // The sweep is the largest change the database sees in a day, so it is also
  // when the query statistics are most likely to have stopped describing it.
  // SQLite decides whether anything actually needs re-analysing; on most days
  // this does nothing and costs nothing.
  optimizeDb();
  return result;
}
