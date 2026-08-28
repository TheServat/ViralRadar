/**
 * The repository layer: every SQL statement in the application lives here or in
 * a migration. No ORM, no query builder, no generated accessors - the queries
 * are the data model's public surface and they are meant to be read.
 */
import { all, fromJson, get, run, toInt, toJson, toReal, tx } from './db.ts';
import { hash64 } from '../core/text.ts';
import type {
  ContentType,
  ManualIntervention,
  MetricSnapshot,
  Metrics,
  SourceHealth,
  SourceStatus,
  TrendState,
} from '../core/types.ts';
import type { CreatorBaseline } from '../core/types.ts';
import type { Quantiles } from '../core/score.ts';

// ── Identity ───────────────────────────────────────────────────────────────

/** Stable, short, collision-resistant enough for a single-user corpus. */
export function contentIdOf(source: string, externalId: string): string {
  return `${source}:${hash64(externalId).toString(36)}`;
}

export function creatorIdOf(source: string, authorId: string): string {
  return `${source}:${authorId}`;
}

// ── Content ────────────────────────────────────────────────────────────────

export interface ContentRow {
  id: string;
  source: string;
  external_id: string;
  url: string;
  canonical_url: string | null;
  title: string;
  body: string | null;
  content_type: string;
  author_id: string | null;
  author_name: string | null;
  thumbnail_url: string | null;
  lang: string | null;
  lang_confidence: number | null;
  country: string | null;
  country_confidence: number | null;
  country_source: string | null;
  published_at: number | null;
  published_at_source: string | null;
  first_seen_at: number;
  last_seen_at: number;
  region: string | null;
  keywords: string | null;
  hashtags: string | null;
  simhash: string | null;
  raw: string | null;
}

export interface UpsertContentInput {
  readonly id: string;
  readonly source: string;
  readonly externalId: string;
  readonly url: string;
  readonly canonicalUrl: string | null;
  readonly title: string;
  readonly body: string | null;
  readonly contentType: ContentType;
  readonly authorId: string | null;
  readonly authorName: string | null;
  readonly thumbnailUrl: string | null;
  readonly lang: string | null;
  readonly langConfidence: number | null;
  readonly country: string | null;
  readonly countryConfidence: number | null;
  readonly countrySource: string | null;
  readonly publishedAt: number | null;
  readonly publishedAtSource: string | null;
  readonly seenAt: number;
  readonly region: string | null;
  readonly discoveryTerm: string | null;
  readonly keywords: readonly string[];
  readonly hashtags: readonly string[];
  readonly simhash: string | null;
  readonly raw: unknown;
}

const UPSERT_CONTENT = `
INSERT INTO content (
  id, source, external_id, url, canonical_url, title, body, content_type,
  author_id, author_name, thumbnail_url,
  lang, lang_confidence, country, country_confidence, country_source,
  published_at, published_at_source, first_seen_at, last_seen_at,
  region, discovery_term, keywords, hashtags, simhash, raw
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT (source, external_id) DO UPDATE SET
  title        = excluded.title,
  body         = COALESCE(excluded.body, content.body),
  url          = excluded.url,
  thumbnail_url= COALESCE(excluded.thumbnail_url, content.thumbnail_url),
  author_name  = COALESCE(excluded.author_name, content.author_name),
  last_seen_at = excluded.last_seen_at,
  keywords     = excluded.keywords,
  hashtags     = excluded.hashtags,
  simhash      = COALESCE(excluded.simhash, content.simhash),
  -- Provenance-bearing fields are never overwritten with a weaker guess. The
  -- term that first surfaced an item is one of them: re-finding it later under
  -- a different word does not change which word did the finding.
  discovery_term = COALESCE(content.discovery_term, excluded.discovery_term),
  lang         = COALESCE(content.lang, excluded.lang),
  lang_confidence = COALESCE(content.lang_confidence, excluded.lang_confidence),
  country      = COALESCE(content.country, excluded.country),
  published_at = COALESCE(content.published_at, excluded.published_at)
`;

/** Returns true when this is the first time the item has been seen. */
export function upsertContent(input: UpsertContentInput): boolean {
  const existing = get<{ id: string }>('SELECT id FROM content WHERE id = ?', input.id);
  run(
    UPSERT_CONTENT,
    input.id,
    input.source,
    input.externalId,
    input.url,
    input.canonicalUrl,
    input.title,
    input.body,
    input.contentType,
    input.authorId,
    input.authorName,
    input.thumbnailUrl,
    input.lang,
    toReal(input.langConfidence),
    input.country,
    toReal(input.countryConfidence),
    input.countrySource,
    toInt(input.publishedAt),
    input.publishedAtSource,
    input.seenAt,
    input.seenAt,
    input.region,
    input.discoveryTerm,
    toJson(input.keywords),
    toJson(input.hashtags),
    input.simhash,
    toJson(input.raw),
  );
  return existing === undefined;
}

export function getContent(id: string): ContentRow | undefined {
  return get<ContentRow>('SELECT * FROM content WHERE id = ?', id);
}

/**
 * Rewrites the derived fields of a stored item.
 *
 * The normal upsert deliberately refuses to overwrite language and country, so
 * a partial refresh cannot downgrade a good reading. That protection also means
 * an improved detector would never reach rows already stored - which is what
 * this exists for, and why it is a separate, explicit operation.
 */
export function updateEnrichment(input: {
  id: string;
  lang: string | null;
  langConfidence: number | null;
  country: string | null;
  countryConfidence: number | null;
  countrySource: string | null;
  keywords: readonly string[];
  hashtags: readonly string[];
  simhash: string | null;
}): void {
  run(
    `UPDATE content SET lang = ?, lang_confidence = ?, country = ?, country_confidence = ?,
            country_source = ?, keywords = ?, hashtags = ?, simhash = ?
     WHERE id = ?`,
    input.lang,
    toReal(input.langConfidence),
    input.country,
    toReal(input.countryConfidence),
    input.countrySource,
    toJson(input.keywords),
    toJson(input.hashtags),
    input.simhash,
    input.id,
  );
}

/** Everything currently stored, oldest first, for a re-enrichment sweep. */
export function allContent(limit = 200_000): ContentRow[] {
  return all<ContentRow>('SELECT * FROM content ORDER BY first_seen_at ASC LIMIT ?', limit);
}

// ── Metrics ────────────────────────────────────────────────────────────────

const INSERT_METRIC = `
INSERT INTO content_metrics (content_id, ts, views, likes, comments, shares, reactions, native_score)
VALUES (?,?,?,?,?,?,?,?)
ON CONFLICT (content_id, ts) DO UPDATE SET
  views        = COALESCE(excluded.views,        content_metrics.views),
  likes        = COALESCE(excluded.likes,        content_metrics.likes),
  comments     = COALESCE(excluded.comments,     content_metrics.comments),
  shares       = COALESCE(excluded.shares,       content_metrics.shares),
  reactions    = COALESCE(excluded.reactions,    content_metrics.reactions),
  native_score = COALESCE(excluded.native_score, content_metrics.native_score)
`;

/**
 * Snapshots are bucketed to the minute. Two refreshes seconds apart would
 * otherwise produce a near-zero time delta and a meaningless velocity.
 */
export function insertMetricSnapshot(contentId: string, ts: number, m: Metrics): void {
  const bucket = Math.floor(ts / 60) * 60;
  run(
    INSERT_METRIC,
    contentId,
    bucket,
    toInt(m.views),
    toInt(m.likes),
    toInt(m.comments),
    toInt(m.shares),
    toInt(m.reactions),
    toInt(m.nativeScore),
  );
}

export function getSnapshots(contentId: string, limit = 60): MetricSnapshot[] {
  const rows = all<{
    ts: number;
    views: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    reactions: number | null;
    native_score: number | null;
  }>(
    'SELECT ts, views, likes, comments, shares, reactions, native_score FROM content_metrics WHERE content_id = ? ORDER BY ts DESC LIMIT ?',
    contentId,
    limit,
  );
  return rows
    .map((r) => ({
      contentId,
      ts: r.ts,
      views: r.views,
      likes: r.likes,
      comments: r.comments,
      shares: r.shares,
      reactions: r.reactions,
      nativeScore: r.native_score,
    }))
    .reverse();
}

// ── Scores ─────────────────────────────────────────────────────────────────

export interface ScoreRow {
  content_id: string;
  source: string;
  score: number;
  confidence: number;
  state: string;
  primary_metric: string;
  primary_value: number | null;
  velocity: number | null;
  acceleration: number | null;
  engagement_rate: number | null;
  creator_anomaly: number | null;
  source_percentile: number | null;
  freshness: number | null;
  cross_source: number | null;
  observations: number;
  age_hours: number | null;
  peak_score: number | null;
  peak_at: number | null;
  state_changed_at: number | null;
  scoring_version: number;
  updated_at: number;
}

const UPSERT_SCORE = `
INSERT INTO content_scores (
  content_id, source, score, confidence, state, primary_metric, primary_value,
  velocity, acceleration, engagement_rate, creator_anomaly, source_percentile,
  freshness, cross_source, observations, age_hours,
  peak_score, peak_at, state_changed_at, scoring_version, updated_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT (content_id) DO UPDATE SET
  score = excluded.score, confidence = excluded.confidence, state = excluded.state,
  primary_metric = excluded.primary_metric, primary_value = excluded.primary_value,
  velocity = excluded.velocity, acceleration = excluded.acceleration,
  engagement_rate = excluded.engagement_rate, creator_anomaly = excluded.creator_anomaly,
  source_percentile = excluded.source_percentile, freshness = excluded.freshness,
  cross_source = excluded.cross_source, observations = excluded.observations,
  age_hours = excluded.age_hours, scoring_version = excluded.scoring_version,
  updated_at = excluded.updated_at,
  -- The peak is a high-water mark: it only ever moves up.
  peak_score = MAX(COALESCE(content_scores.peak_score, 0), excluded.score),
  peak_at = CASE WHEN excluded.score > COALESCE(content_scores.peak_score, 0)
                 THEN excluded.updated_at ELSE content_scores.peak_at END,
  state_changed_at = CASE WHEN content_scores.state != excluded.state
                          THEN excluded.updated_at ELSE content_scores.state_changed_at END
`;

export interface SaveScoreInput {
  readonly contentId: string;
  readonly source: string;
  readonly score: number;
  readonly confidence: number;
  readonly state: TrendState;
  readonly primaryMetric: string;
  readonly primaryValue: number | null;
  readonly velocity: number | null;
  readonly acceleration: number | null;
  readonly engagementRate: number | null;
  readonly creatorAnomaly: number | null;
  readonly sourcePercentile: number | null;
  readonly freshness: number | null;
  readonly crossSource: number | null;
  readonly observations: number;
  readonly ageHours: number | null;
  readonly scoringVersion: number;
  readonly now: number;
}

export function saveScore(input: SaveScoreInput): void {
  run(
    UPSERT_SCORE,
    input.contentId,
    input.source,
    input.score,
    input.confidence,
    input.state,
    input.primaryMetric,
    toInt(input.primaryValue),
    toReal(input.velocity),
    toReal(input.acceleration),
    toReal(input.engagementRate),
    toReal(input.creatorAnomaly),
    toReal(input.sourcePercentile),
    toReal(input.freshness),
    toReal(input.crossSource),
    input.observations,
    toReal(input.ageHours),
    input.score,
    input.now,
    input.now,
    input.scoringVersion,
    input.now,
  );
}

export function getScore(contentId: string): ScoreRow | undefined {
  return get<ScoreRow>('SELECT * FROM content_scores WHERE content_id = ?', contentId);
}

export interface RefreshTarget {
  id: string;
  external_id: string;
  url: string;
  score: number | null;
  state: string | null;
  last_metric_at: number | null;
  /** How many times this item has actually been measured. */
  measurements: number;
}

/**
 * How the refresh budget is divided.
 *
 * Ordering by score alone was a mistake with a measurable cost: it spent the
 * budget re-measuring known winners — some reached thirty-five observations —
 * while 27% of everything under twelve hours old never got a *second*
 * measurement at all, and therefore no velocity, and therefore stayed `NEW`
 * for ever. Those are exactly the small, early items the product exists to
 * catch, so the queue was structurally blind to its own purpose.
 *
 * Priority follows information gain instead of popularity:
 *
 *   BOOTSTRAP  1 measurement  -> a 2nd one creates velocity where there was none
 *   SHAPE      2 measurements -> a 3rd one creates acceleration
 *   TRACK      already moving -> keep following what is going somewhere
 *   REFINE     everything else -> sharpen an estimate that already exists
 *
 * Quotas rather than a strict ladder, because a backlog of new items would
 * otherwise starve tracking entirely. Unused quota spills to the next tier, so
 * once the backlog clears the whole budget flows to depth.
 */
const REFRESH_TIERS = [
  { name: 'bootstrap', share: 0.55, having: 'measurements < 2', order: 'c.first_seen_at DESC' },
  { name: 'shape', share: 0.25, having: 'measurements = 2', order: 'c.first_seen_at DESC' },
  {
    name: 'track',
    share: 0.2,
    having: "measurements > 2 AND s.state IN ('VIRAL','HOT','EMERGING','RISING')",
    order: 'COALESCE(s.score, 0) DESC',
  },
  { name: 'refine', share: 1, having: 'measurements > 2', order: 'COALESCE(s.score, 0) DESC' },
] as const;

/**
 * Which items to ask a source about again, and in what order.
 *
 * Adaptive by design: something already climbing is worth a request every few
 * minutes, while a flat item from yesterday is not worth the platform's
 * bandwidth or ours. `minGapSec` prevents burning a refresh on an item that was
 * just measured.
 */
export function refreshTargets(input: {
  source: string;
  now: number;
  windowSec: number;
  minGapSec: number;
  limit: number;
}): RefreshTarget[] {
  const picked: RefreshTarget[] = [];
  const seen = new Set<string>();

  for (const tier of REFRESH_TIERS) {
    const startedAt = picked.length;
    const remaining = input.limit - startedAt;
    if (remaining <= 0) break;

    // The tier's share of the *whole* budget, but never more than is left, and
    // always at least one so a small budget still reaches every tier.
    const quota = Math.max(1, Math.min(remaining, Math.round(input.limit * tier.share)));

    const rows = all<RefreshTarget>(
      `SELECT c.id, c.external_id, c.url, s.score, s.state,
              m.last_metric_at, COALESCE(m.measurements, 0) AS measurements
       FROM content c
       LEFT JOIN content_scores s ON s.content_id = c.id
       LEFT JOIN (
         SELECT content_id, MAX(ts) AS last_metric_at, COUNT(*) AS measurements
         FROM content_metrics GROUP BY content_id
       ) m ON m.content_id = c.id
       WHERE c.source = ?
         AND c.first_seen_at >= ?
         AND (m.last_metric_at IS NULL OR m.last_metric_at <= ?)
         AND ${tier.having.replace(/measurements/g, 'COALESCE(m.measurements, 0)')}
       ORDER BY ${tier.order}
       LIMIT ?`,
      input.source,
      input.now - input.windowSec,
      input.now - input.minGapSec,
      // Over-fetch: the last two tiers overlap, so some rows are already held.
      quota + startedAt,
    );

    for (const row of rows) {
      if (picked.length >= input.limit) break;
      if (picked.length - startedAt >= quota) break;
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      picked.push(row);
    }
  }

  return picked;
}

/**
 * How much of a source has been measured enough to have growth at all.
 *
 * Only meaningful for sources that can be re-read. RSS and Google News expose
 * no metrics and are collected once, so counting them here would hold the
 * number permanently short of complete and make it useless as a signal that
 * the queue is keeping up.
 */
export function refreshCoverage(source: string, sinceTs: number): {
  total: number;
  unmeasured: number;
  shaped: number;
  deep: number;
} {
  const row = get<{ total: number; unmeasured: number; shaped: number; deep: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN n < 2 THEN 1 ELSE 0 END) AS unmeasured,
            SUM(CASE WHEN n >= 3 THEN 1 ELSE 0 END) AS shaped,
            SUM(CASE WHEN n >= 10 THEN 1 ELSE 0 END) AS deep
     FROM (
       SELECT (SELECT COUNT(*) FROM content_metrics m WHERE m.content_id = c.id) AS n
       FROM content c WHERE c.source = ? AND c.first_seen_at >= ?
     )`,
    source,
    sinceTs,
  );
  return {
    total: row?.total ?? 0,
    unmeasured: row?.unmeasured ?? 0,
    shaped: row?.shaped ?? 0,
    deep: row?.deep ?? 0,
  };
}

/** Items worth re-scoring: seen recently, or still young enough to move. */
export function contentToScore(sinceTs: number, limit = 4000): ContentRow[] {
  return all<ContentRow>(
    'SELECT * FROM content WHERE last_seen_at >= ? ORDER BY last_seen_at DESC LIMIT ?',
    sinceTs,
    limit,
  );
}

// ── Ranked reads (what the dashboard actually calls) ───────────────────────

export interface RankedRow extends ContentRow {
  score: number;
  confidence: number;
  state: string;
  velocity: number | null;
  acceleration: number | null;
  engagement_rate: number | null;
  creator_anomaly: number | null;
  source_percentile: number | null;
  freshness: number | null;
  cross_source: number | null;
  primary_metric: string;
  primary_value: number | null;
  observations: number;
  age_hours: number | null;
  author_followers: number | null;
  creator_url: string | null;
  creator_median: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  native_score: number | null;
  /** Present on the retrospective read; null elsewhere. */
  peak_score: number | null;
  peak_at: number | null;
}

/**
 * The one ranked read, shared by every list endpoint.
 *
 * Latest metrics come from correlated lookups rather than a window function
 * over the whole time series: `content_metrics` is by far the largest table,
 * and a ROW_NUMBER() across all of it would be paid on every dashboard load.
 * Each lookup here is an index seek on the primary key, run only for the rows
 * actually returned.
 */
const LATEST = (column: string): string =>
  `(SELECT ${column} FROM content_metrics WHERE content_id = c.id AND ${column} IS NOT NULL ORDER BY ts DESC LIMIT 1)`;

const RANKED_BASE = `
SELECT c.*, s.score, s.confidence, s.state, s.velocity, s.acceleration,
       s.engagement_rate, s.creator_anomaly, s.source_percentile, s.freshness,
       s.cross_source, s.primary_metric, s.primary_value, s.observations, s.age_hours,
       s.peak_score, s.peak_at,
       cr.followers AS author_followers, cr.url AS creator_url,
       cr.median_metric AS creator_median,
       ${LATEST('views')} AS views,
       ${LATEST('likes')} AS likes,
       ${LATEST('comments')} AS comments,
       ${LATEST('shares')} AS shares,
       ${LATEST('native_score')} AS native_score
FROM content_scores s
JOIN content c ON c.id = s.content_id
LEFT JOIN creators cr ON cr.id = c.source || ':' || c.author_id
`;

export interface RankedQuery {
  /** Specific items by id, for looking up what an event refers to. */
  readonly ids?: readonly string[];
  readonly states?: readonly string[];
  readonly sources?: readonly string[];
  readonly languages?: readonly string[];
  readonly countries?: readonly string[];
  readonly contentTypes?: readonly string[];
  readonly minScore?: number;
  readonly maxAgeHours?: number;
  readonly creator?: string;
  readonly hashtag?: string;
  readonly query?: string;
  readonly limit: number;
  readonly offset: number;
  readonly orderBy?: 'score' | 'acceleration' | 'velocity' | 'recent' | 'creator_anomaly';
  /**
   * What to do about items the user has marked as dealt with.
   *
   * `hide` is the default everywhere a list is shown: something you have
   * already made a video about should stop competing for your attention. `only`
   * is what answers "what have I already covered".
   */
  readonly archived?: 'hide' | 'only' | 'include';
}

/**
 * One query builder, used by every ranked endpoint. Filters are all optional
 * and all applied *after* detection - the product promise is that discovery
 * works with everything set to "all".
 */
export function rankedContent(q: RankedQuery): RankedRow[] {
  const where: string[] = [];
  const params: unknown[] = [];

  // Hidden by default. The archive is a mark, never a deletion: these items
  // are still measured and still feed baselines and clusters, they just stop
  // appearing in the lists.
  const archived = q.archived ?? 'hide';
  if (archived === 'hide') {
    where.push('NOT EXISTS (SELECT 1 FROM content_archive a WHERE a.content_id = c.id)');
  } else if (archived === 'only') {
    where.push('EXISTS (SELECT 1 FROM content_archive a WHERE a.content_id = c.id)');
  }

  if (q.ids !== undefined && q.ids.length > 0) {
    where.push(`c.id IN (${q.ids.map(() => '?').join(',')})`);
    params.push(...q.ids);
  }
  if (q.states !== undefined && q.states.length > 0) {
    where.push(`s.state IN (${q.states.map(() => '?').join(',')})`);
    params.push(...q.states);
  }
  if (q.sources !== undefined && q.sources.length > 0) {
    where.push(`c.source IN (${q.sources.map(() => '?').join(',')})`);
    params.push(...q.sources);
  }
  if (q.languages !== undefined && q.languages.length > 0) {
    // Items whose language could not be determined are kept. Losing a genuinely
    // viral post to a four-word title the detector could not classify is a far
    // worse failure than showing one extra unknown item.
    where.push(`(c.lang IN (${q.languages.map(() => '?').join(',')}) OR c.lang IS NULL)`);
    params.push(...q.languages);
  }
  if (q.countries !== undefined && q.countries.length > 0) {
    where.push(`c.country IN (${q.countries.map(() => '?').join(',')})`);
    params.push(...q.countries);
  }
  if (q.contentTypes !== undefined && q.contentTypes.length > 0) {
    where.push(`c.content_type IN (${q.contentTypes.map(() => '?').join(',')})`);
    params.push(...q.contentTypes);
  }
  if (q.minScore !== undefined) {
    where.push('s.score >= ?');
    params.push(q.minScore);
  }
  if (q.maxAgeHours !== undefined) {
    where.push('(s.age_hours IS NULL OR s.age_hours <= ?)');
    params.push(q.maxAgeHours);
  }
  if (q.creator !== undefined && q.creator !== '') {
    where.push('(c.author_id = ? OR c.author_name = ?)');
    params.push(q.creator, q.creator);
  }
  if (q.hashtag !== undefined && q.hashtag !== '') {
    where.push('c.hashtags LIKE ?');
    params.push(`%"${q.hashtag.replace(/^#/, '').toLowerCase()}"%`);
  }
  if (q.query !== undefined && q.query !== '') {
    where.push('(LOWER(c.title) LIKE ? OR LOWER(c.body) LIKE ?)');
    const like = `%${q.query.toLowerCase()}%`;
    params.push(like, like);
  }

  const order =
    q.orderBy === 'acceleration'
      ? 's.acceleration DESC NULLS LAST, s.score DESC'
      : q.orderBy === 'velocity'
        ? 's.velocity DESC NULLS LAST, s.score DESC'
        : q.orderBy === 'creator_anomaly'
          ? 's.creator_anomaly DESC NULLS LAST, s.score DESC'
          : q.orderBy === 'recent'
            ? 'c.first_seen_at DESC'
            : 's.score DESC';

  const sql = `${RANKED_BASE}${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ? OFFSET ?`;
  return all<RankedRow>(sql, ...params, q.limit, q.offset);
}

// ── Creators ───────────────────────────────────────────────────────────────

const UPSERT_CREATOR = `
INSERT INTO creators (id, source, external_id, name, url, followers, first_seen_at, updated_at, sample_count)
VALUES (?,?,?,?,?,?,?,?,0)
ON CONFLICT (source, external_id) DO UPDATE SET
  name       = COALESCE(excluded.name, creators.name),
  url        = COALESCE(excluded.url, creators.url),
  followers  = COALESCE(excluded.followers, creators.followers),
  updated_at = excluded.updated_at
`;

export function upsertCreator(input: {
  source: string;
  externalId: string;
  name: string | null;
  url: string | null;
  followers: number | null;
  now: number;
}): string {
  const id = creatorIdOf(input.source, input.externalId);
  run(
    UPSERT_CREATOR,
    id,
    input.source,
    input.externalId,
    input.name,
    input.url,
    toInt(input.followers),
    input.now,
    input.now,
  );
  return id;
}

export function getCreator(id: string): CreatorBaseline | undefined {
  const row = get<{
    id: string;
    source: string;
    external_id: string;
    name: string | null;
    followers: number | null;
    median_metric: number | null;
    p90_metric: number | null;
    p99_metric: number | null;
    sample_count: number;
  }>('SELECT * FROM creators WHERE id = ?', id);
  if (row === undefined) return undefined;
  return {
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    name: row.name,
    followers: row.followers,
    medianMetric: row.median_metric,
    p90Metric: row.p90_metric,
    p99Metric: row.p99_metric,
    sampleCount: row.sample_count,
  };
}

/** Only these columns may be interpolated into the query below. */
const METRIC_COLUMNS = new Set(['views', 'likes', 'comments', 'shares', 'reactions', 'native_score']);

/**
 * A creator's baseline is the distribution of their other items.
 *
 * Read straight from the measured metrics rather than from computed scores: a
 * creator has a history the moment their posts have been measured, and making
 * this depend on scoring order would mean the first analysis pass after a fresh
 * start could never detect a breakout.
 */
/**
 * Creators worth backfilling, best first.
 *
 * "Best" is the strongest score anything of theirs has reached. Effort goes
 * where a breakout would actually matter: a channel whose one video reached 70
 * is worth knowing the normal for, a channel whose one video reached 4 is not.
 *
 * Creators already backfilled recently are skipped, so a run spends its budget
 * on new ground instead of re-asking the same channels.
 */
export function creatorsNeedingHistory(
  source: string,
  minSamples: number,
  staleBefore: number,
  limit: number,
): { creatorId: string; externalId: string }[] {
  return all<{ creatorId: string; externalId: string }>(
    `WITH per AS (
       SELECT c.author_id AS external_id,
              COUNT(DISTINCT c.id) AS n,
              MAX(COALESCE(s.score, 0)) AS best
       FROM content c
       JOIN content_metrics m ON m.content_id = c.id
       LEFT JOIN content_scores s ON s.content_id = c.id
       WHERE c.source = ? AND c.author_id IS NOT NULL
       GROUP BY c.author_id
     )
     SELECT ? || ':' || per.external_id AS creatorId, per.external_id AS externalId
     FROM per
     LEFT JOIN creators cr ON cr.id = ? || ':' || per.external_id
     LEFT JOIN (
       SELECT creator_id, COUNT(*) AS h FROM creator_history GROUP BY creator_id
     ) hist ON hist.creator_id = ? || ':' || per.external_id
     WHERE per.n + COALESCE(hist.h, 0) < ?
       AND COALESCE(cr.history_fetched_at, 0) < ?
     ORDER BY per.best DESC
     LIMIT ?`,
    source,
    source,
    source,
    source,
    minSamples,
    staleBefore,
    limit,
  );
}

/**
 * Makes sure a creator row exists, so a history row has something to reference.
 *
 * The id carries the source and the external id already, so the row can be
 * reconstructed from it alone. Splitting it here rather than requiring callers
 * to have created the creator first removes an ordering rule that is invisible
 * at the call site and fails as a foreign-key error much later.
 */
function ensureCreator(creatorId: string, now: number): void {
  const at = creatorId.indexOf(':');
  if (at <= 0) return;
  run(
    `INSERT INTO creators (id, source, external_id, first_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
    creatorId,
    creatorId.slice(0, at),
    creatorId.slice(at + 1),
    now,
    now,
  );
}

export function saveCreatorHistory(
  samples: readonly {
    creatorId: string;
    externalId: string;
    metric: string;
    value: number;
    publishedAt: number | null;
  }[],
  now: number,
): void {
  if (samples.length === 0) return;
  tx(() => {
    for (const id of new Set(samples.map((s) => s.creatorId))) ensureCreator(id, now);
    for (const s of samples) {
      run(
        `INSERT INTO creator_history (creator_id, external_id, metric, value, published_at, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (creator_id, external_id) DO UPDATE SET
           value = excluded.value, fetched_at = excluded.fetched_at`,
        s.creatorId,
        s.externalId,
        s.metric,
        s.value,
        s.publishedAt,
        now,
      );
    }
  });
}

/** Marks creators as looked at, whether or not anything came back. */
export function markHistoryFetched(creatorIds: readonly string[], now: number): void {
  if (creatorIds.length === 0) return;
  tx(() => {
    for (const id of creatorIds) {
      ensureCreator(id, now);
      run('UPDATE creators SET history_fetched_at = ? WHERE id = ?', now, id);
    }
  });
}

export function creatorHistoryCoverage(source: string): { withHistory: number; total: number } {
  const row = get<{ withHistory: number; total: number }>(
    `SELECT
       (SELECT COUNT(DISTINCT creator_id) FROM creator_history
        WHERE creator_id LIKE ? || ':%') AS withHistory,
       (SELECT COUNT(DISTINCT author_id) FROM content
        WHERE source = ? AND author_id IS NOT NULL) AS total`,
    source,
    source,
  );
  return { withHistory: row?.withHistory ?? 0, total: row?.total ?? 0 };
}

export function creatorSamples(source: string, authorId: string, metricColumn: string): number[] {
  if (!METRIC_COLUMNS.has(metricColumn)) {
    throw new Error(`Refusing to query unknown metric column "${metricColumn}"`);
  }
  // A correlated lookup, exactly like LATEST above and for exactly the same
  // reason. The window-function version of this query computed
  // ROW_NUMBER() over the *whole* of content_metrics before filtering to one
  // creator, and then did it again for the next creator: 123ms per call, which
  // was the single largest cost in the analysis pass. This filters the
  // creator's own rows first and seeks the primary key for each one.
  const rows = all<{ v: number | null }>(
    `SELECT (SELECT m.${metricColumn} FROM content_metrics m
             WHERE m.content_id = c.id AND m.${metricColumn} IS NOT NULL
             ORDER BY m.ts DESC LIMIT 1) AS v
     FROM content c
     WHERE c.source = ? AND c.author_id = ?
     ORDER BY c.first_seen_at DESC LIMIT 200`,
    source,
    authorId,
  );
  // Items with no measurement of this metric yield null and are dropped here
  // rather than in SQL, so the correlated lookup stays a plain index seek.
  const tracked = rows.map((r) => r.v).filter((v): v is number => v !== null);

  // Backfilled reference posts count towards the baseline. They are what makes
  // a creator judgeable at all when discovery only ever found one of their
  // items - which is the overwhelming majority of them.
  const history = all<{ v: number }>(
    `SELECT value AS v FROM creator_history
     WHERE creator_id = ? AND metric = ?
     ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT 200`,
    creatorIdOf(source, authorId),
    metricColumn,
  );

  return history.length === 0 ? tracked : [...tracked, ...history.map((r) => r.v)];
}

/** Maps a domain metric name to its column. */
export function metricColumn(metric: string): string {
  return metric === 'nativeScore' ? 'native_score' : metric;
}

export function saveCreatorBaseline(
  id: string,
  stats: { p50: number | null; p90: number | null; p99: number | null; count: number },
  now: number,
): void {
  run(
    'UPDATE creators SET median_metric = ?, p90_metric = ?, p99_metric = ?, sample_count = ?, updated_at = ? WHERE id = ?',
    toReal(stats.p50),
    toReal(stats.p90),
    toReal(stats.p99),
    stats.count,
    now,
    id,
  );
}

export function recordBreakout(b: {
  creatorId: string;
  contentId: string;
  ratio: number;
  baseline: number;
  observed: number;
  now: number;
}): boolean {
  const existing = get<{ id: string }>(
    'SELECT id FROM creator_breakouts WHERE creator_id = ? AND content_id = ?',
    b.creatorId,
    b.contentId,
  );
  if (existing !== undefined) return false;
  run(
    `INSERT INTO creator_breakouts (id, creator_id, content_id, anomaly_ratio, baseline, observed, detected_at)
     VALUES (?,?,?,?,?,?,?)`,
    `${b.creatorId}#${b.contentId}`,
    b.creatorId,
    b.contentId,
    b.ratio,
    b.baseline,
    b.observed,
    b.now,
  );
  return true;
}

export function listBreakouts(limit: number, sinceTs: number): RankedRow[] {
  return all<RankedRow>(
    `${RANKED_BASE}
     JOIN creator_breakouts b ON b.content_id = c.id
     WHERE b.detected_at >= ?
     ORDER BY b.anomaly_ratio DESC LIMIT ?`,
    sinceTs,
    limit,
  );
}

// ── Source baselines ───────────────────────────────────────────────────────

export function saveBaseline(
  source: string,
  metric: string,
  bucket: string,
  stats: { p50: number | null; p75: number | null; p90: number | null; p99: number | null; mad: number | null; count: number },
  now: number,
): void {
  run(
    `INSERT INTO source_baselines (source, metric, bucket, p50, p75, p90, p99, mad, sample_count, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (source, metric, bucket) DO UPDATE SET
       p50 = excluded.p50, p75 = excluded.p75, p90 = excluded.p90, p99 = excluded.p99,
       mad = excluded.mad, sample_count = excluded.sample_count, updated_at = excluded.updated_at`,
    source,
    metric,
    bucket,
    toReal(stats.p50),
    toReal(stats.p75),
    toReal(stats.p90),
    toReal(stats.p99),
    toReal(stats.mad),
    stats.count,
    now,
  );
}

export function getBaseline(source: string, metric: string, bucket = 'all'): Quantiles | null {
  const row = get<{ p50: number | null; p75: number | null; p90: number | null; p99: number | null; sample_count: number }>(
    'SELECT p50, p75, p90, p99, sample_count FROM source_baselines WHERE source = ? AND metric = ? AND bucket = ?',
    source,
    metric,
    bucket,
  );
  if (row === undefined) return null;
  return { p50: row.p50, p75: row.p75, p90: row.p90, p99: row.p99, sampleCount: row.sample_count };
}

export interface BaselineSample {
  velocity: number | null;
  primary_value: number | null;
  /** Hour of day (UTC) the item was first seen, for time-of-day normalisation. */
  hour: number;
}

/**
 * Raw samples used to rebuild the baselines for one source, tagged with the
 * hour they were seen. Platforms are busier at some hours than others, and a
 * baseline that ignores that reads normal evening traffic as a breakout.
 */
export function baselineSamples(source: string, sinceTs: number): BaselineSample[] {
  return all<BaselineSample>(
    `SELECT s.velocity, s.primary_value,
            CAST(strftime('%H', c.first_seen_at, 'unixepoch') AS INTEGER) AS hour
     FROM content_scores s
     JOIN content c ON c.id = s.content_id
     WHERE c.source = ? AND c.first_seen_at >= ?`,
    source,
    sinceTs,
  );
}

// ── Source health ──────────────────────────────────────────────────────────

export function recordRun(input: {
  source: string;
  status: SourceStatus;
  items: number;
  ok: boolean;
  error: string | null;
  errorKind: string | null;
  now: number;
}): void {
  run(
    `INSERT INTO source_health (
       source, status, last_run_at, last_ok_at, last_error, last_error_kind,
       consecutive_failures, items_last_run, total_items, total_runs, failed_runs, reliability, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?)
     ON CONFLICT (source) DO UPDATE SET
       status = excluded.status,
       last_run_at = excluded.last_run_at,
       last_ok_at = COALESCE(excluded.last_ok_at, source_health.last_ok_at),
       last_error = excluded.last_error,
       last_error_kind = excluded.last_error_kind,
       consecutive_failures = CASE WHEN ? THEN 0 ELSE source_health.consecutive_failures + 1 END,
       items_last_run = excluded.items_last_run,
       total_items = source_health.total_items + excluded.items_last_run,
       total_runs = source_health.total_runs + 1,
       failed_runs = source_health.failed_runs + CASE WHEN ? THEN 0 ELSE 1 END,
       updated_at = excluded.updated_at`,
    input.source,
    input.status,
    input.now,
    input.ok ? input.now : null,
    input.error,
    input.errorKind,
    input.ok ? 0 : 1,
    input.items,
    input.items,
    input.ok ? 0 : 1,
    input.ok ? 1 : 0.5,
    input.now,
    input.ok ? 1 : 0,
    input.ok ? 1 : 0,
  );
  recomputeReliability(input.source);
}

/**
 * Reliability blends the plugin's declared trust with its observed behaviour.
 * A source that fails a third of its runs should not lend full confidence to
 * the trends it reports.
 */
function recomputeReliability(source: string): void {
  run(
    `UPDATE source_health SET reliability = MAX(0.1, MIN(1.0,
       1.0 - (CAST(failed_runs AS REAL) / MAX(total_runs, 1)) * 0.7
       - CASE WHEN consecutive_failures > 0 THEN MIN(consecutive_failures, 5) * 0.05 ELSE 0 END
     )) WHERE source = ?`,
    source,
  );
}

export function getHealth(source: string): SourceHealth | undefined {
  const row = get<{
    source: string;
    status: string;
    last_run_at: number | null;
    last_ok_at: number | null;
    last_error: string | null;
    last_error_kind: string | null;
    consecutive_failures: number;
    items_last_run: number;
    total_items: number;
    reliability: number;
  }>('SELECT * FROM source_health WHERE source = ?', source);
  if (row === undefined) return undefined;
  return {
    source: row.source,
    status: row.status as SourceStatus,
    lastRunAt: row.last_run_at,
    lastOkAt: row.last_ok_at,
    lastError: row.last_error,
    lastErrorKind: row.last_error_kind,
    consecutiveFailures: row.consecutive_failures,
    itemsLastRun: row.items_last_run,
    totalItems: row.total_items,
    reliability: row.reliability,
  };
}

export function allHealth(): SourceHealth[] {
  return all<{ source: string }>('SELECT source FROM source_health')
    .map((r) => getHealth(r.source))
    .filter((h): h is SourceHealth => h !== undefined);
}

// ── Interventions ──────────────────────────────────────────────────────────

export function openIntervention(input: {
  source: string;
  type: string;
  message: string;
  url: string | null;
  now: number;
}): void {
  // One open record per (source, type): a failing source must not spam the UI.
  const existing = get<{ id: string }>(
    "SELECT id FROM sys_interventions WHERE source = ? AND type = ? AND status = 'OPEN'",
    input.source,
    input.type,
  );
  if (existing !== undefined) return;
  run(
    `INSERT INTO sys_interventions (id, source, type, message, url, status, created_at)
     VALUES (?,?,?,?,?,'OPEN',?)`,
    `${input.source}:${input.type}:${input.now}`,
    input.source,
    input.type,
    input.message,
    input.url,
    input.now,
  );
}

export function listInterventions(status = 'OPEN'): ManualIntervention[] {
  return all<{
    id: string;
    source: string;
    type: string;
    message: string;
    url: string | null;
    status: string;
    created_at: number;
    resolved_at: number | null;
  }>('SELECT * FROM sys_interventions WHERE status = ? ORDER BY created_at DESC LIMIT 100', status).map(
    (r) => ({
      id: r.id,
      source: r.source,
      type: r.type as ManualIntervention['type'],
      message: r.message,
      url: r.url,
      status: r.status as ManualIntervention['status'],
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
    }),
  );
}

export function resolveIntervention(id: string, status: 'RESOLVED' | 'DISMISSED', now: number): boolean {
  const existing = get<{ id: string }>('SELECT id FROM sys_interventions WHERE id = ?', id);
  if (existing === undefined) return false;
  run('UPDATE sys_interventions SET status = ?, resolved_at = ? WHERE id = ?', status, now, id);
  return true;
}

// ── Events ─────────────────────────────────────────────────────────────────

export function appendEvent(type: string, source: string | null, refId: string | null, payload?: unknown): void {
  run(
    'INSERT INTO sys_events (ts, type, source, ref_id, payload) VALUES (?,?,?,?,?)',
    Math.floor(Date.now() / 1000),
    type,
    source,
    refId,
    toJson(payload ?? null),
  );
}

export function listEvents(limit: number, type?: string): { ts: number; type: string; source: string | null; ref_id: string | null; payload: unknown }[] {
  const rows =
    type === undefined
      ? all<{ ts: number; type: string; source: string | null; ref_id: string | null; payload: string | null }>(
          'SELECT ts, type, source, ref_id, payload FROM sys_events ORDER BY ts DESC LIMIT ?',
          limit,
        )
      : all<{ ts: number; type: string; source: string | null; ref_id: string | null; payload: string | null }>(
          'SELECT ts, type, source, ref_id, payload FROM sys_events WHERE type = ? ORDER BY ts DESC LIMIT ?',
          type,
          limit,
        );
  return rows.map((r) => ({ ...r, payload: fromJson<unknown>(r.payload, null) }));
}

/** Events newer than `afterId`, oldest first - the feed behind the SSE stream. */
export function eventsSince(afterId: number, limit = 50): { id: number; ts: number; type: string; source: string | null; ref_id: string | null; payload: unknown }[] {
  return all<{ id: number; ts: number; type: string; source: string | null; ref_id: string | null; payload: string | null }>(
    'SELECT id, ts, type, source, ref_id, payload FROM sys_events WHERE id > ? ORDER BY id ASC LIMIT ?',
    afterId,
    limit,
  ).map((r) => ({ ...r, payload: fromJson<unknown>(r.payload, null) }));
}

export function latestEventId(): number {
  return get<{ id: number | null }>('SELECT MAX(id) AS id FROM sys_events')?.id ?? 0;
}

// ── Clusters ───────────────────────────────────────────────────────────────

export interface ClusterRow {
  id: string;
  label: string;
  label_source: string;
  keywords: string;
  first_seen_at: number;
  last_seen_at: number;
  item_count: number;
  source_count: number;
  sources: string;
  languages: string | null;
  countries: string | null;
  score: number;
  confidence: number;
  velocity: number | null;
  acceleration: number | null;
  state: string;
  total_views: number | null;
  total_engagement: number | null;
  explanation: string | null;
  updated_at: number;
}

export interface SaveClusterInput {
  readonly id: string;
  readonly label: string;
  readonly keywords: readonly string[];
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly sources: readonly string[];
  readonly languages: readonly { code: string; pct: number }[];
  readonly countries: readonly { code: string; pct: number }[];
  readonly score: number;
  readonly confidence: number;
  readonly velocity: number | null;
  readonly acceleration: number | null;
  readonly state: TrendState;
  readonly totalViews: number | null;
  readonly totalEngagement: number | null;
  readonly members: readonly { id: string; similarity: number }[];
  readonly now: number;
}

/**
 * Clusters are rebuilt wholesale every analysis pass, but keep their identity
 * (and therefore their score history) as long as their keywords are stable.
 */
export function saveClusters(clusters: readonly SaveClusterInput[]): void {
  tx(() => {
    const keep = new Set(clusters.map((c) => c.id));
    for (const row of all<{ id: string }>('SELECT id FROM clusters')) {
      if (!keep.has(row.id)) run('DELETE FROM clusters WHERE id = ?', row.id);
    }

    for (const c of clusters) {
      run(
        `INSERT INTO clusters (
           id, label, label_source, keywords, first_seen_at, last_seen_at, item_count,
           source_count, sources, languages, countries, score, confidence, velocity,
           acceleration, state, total_views, total_engagement, updated_at
         ) VALUES (?,?,'keywords',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (id) DO UPDATE SET
           -- A name a model already gave this cluster survives the rebuild.
           label = CASE WHEN clusters.label_source = 'ai' THEN clusters.label ELSE excluded.label END,
           keywords = excluded.keywords,
           last_seen_at = excluded.last_seen_at, item_count = excluded.item_count,
           source_count = excluded.source_count, sources = excluded.sources,
           languages = excluded.languages, countries = excluded.countries,
           score = excluded.score, confidence = excluded.confidence,
           velocity = excluded.velocity, acceleration = excluded.acceleration,
           state = excluded.state, total_views = excluded.total_views,
           total_engagement = excluded.total_engagement, updated_at = excluded.updated_at,
           first_seen_at = MIN(clusters.first_seen_at, excluded.first_seen_at)`,
        c.id,
        c.label,
        toJson(c.keywords),
        c.firstSeenAt,
        c.lastSeenAt,
        c.members.length,
        c.sources.length,
        toJson(c.sources),
        toJson(c.languages),
        toJson(c.countries),
        c.score,
        c.confidence,
        toReal(c.velocity),
        toReal(c.acceleration),
        c.state,
        toInt(c.totalViews),
        toInt(c.totalEngagement),
        c.now,
      );

      run('DELETE FROM cluster_items WHERE cluster_id = ?', c.id);
      for (const m of c.members) {
        run('INSERT OR REPLACE INTO cluster_items (cluster_id, content_id, similarity) VALUES (?,?,?)', c.id, m.id, m.similarity);
      }
      run(
        `INSERT INTO cluster_snapshots (cluster_id, ts, score, item_count, source_count, total_metric)
         VALUES (?,?,?,?,?,?) ON CONFLICT (cluster_id, ts) DO UPDATE SET score = excluded.score`,
        c.id,
        Math.floor(c.now / 300) * 300,
        c.score,
        c.members.length,
        c.sources.length,
        toInt(c.totalViews),
      );
    }
  });
}

/**
 * Applies an AI-generated name. Marked as `ai` so a later rebuild does not
 * silently overwrite it, and so the UI can say where the name came from.
 */
export function setClusterNarrative(id: string, label: string, explanation: string, now: number): void {
  run(
    "UPDATE clusters SET label = ?, label_source = 'ai', explanation = ?, updated_at = ? WHERE id = ?",
    label,
    explanation === '' ? null : explanation,
    now,
    id,
  );
}

export interface ClusterQuery {
  readonly limit: number;
  readonly minSources?: number;
  readonly minScore?: number;
  readonly languages?: readonly string[];
  readonly countries?: readonly string[];
  readonly sources?: readonly string[];
  readonly maxAgeHours?: number;
  readonly orderBy?: 'score' | 'recent' | 'platforms' | 'velocity';
}

/**
 * Topics, filtered by what the posts inside them actually are.
 *
 * The filters test membership rather than the cluster's own summary: a topic
 * counts as Persian because a Persian post is in it, not because Persian
 * happens to be the majority. Asking "does this topic reach my audience"
 * deserves a yes when any of it does.
 */
export function listClusters(query: ClusterQuery): ClusterRow[] {
  const where: string[] = ['cl.source_count >= ?', 'cl.score >= ?'];
  const params: unknown[] = [query.minSources ?? 1, query.minScore ?? 0];

  const member = (column: 'lang' | 'country' | 'source', values: readonly string[]): void => {
    where.push(
      `EXISTS (SELECT 1 FROM cluster_items ci JOIN content c ON c.id = ci.content_id
               WHERE ci.cluster_id = cl.id AND c.${column} IN (${values.map(() => '?').join(',')}))`,
    );
    params.push(...values);
  };

  if (query.languages !== undefined && query.languages.length > 0) member('lang', query.languages);
  if (query.countries !== undefined && query.countries.length > 0) member('country', query.countries);
  if (query.sources !== undefined && query.sources.length > 0) member('source', query.sources);

  if (query.maxAgeHours !== undefined) {
    where.push('cl.last_seen_at >= ?');
    params.push(Math.floor(Date.now() / 1000) - query.maxAgeHours * 3600);
  }

  const order =
    query.orderBy === 'recent'
      ? 'cl.last_seen_at DESC'
      : query.orderBy === 'platforms'
        ? 'cl.source_count DESC, cl.score DESC'
        : query.orderBy === 'velocity'
          ? 'cl.velocity DESC, cl.score DESC'
          : 'cl.score DESC';

  return all<ClusterRow>(
    `SELECT cl.* FROM clusters cl WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`,
    ...params,
    query.limit,
  );
}

export function getCluster(id: string): ClusterRow | undefined {
  return get<ClusterRow>('SELECT * FROM clusters WHERE id = ?', id);
}

export function clusterMembers(id: string, limit = 50): RankedRow[] {
  return all<RankedRow>(
    `${RANKED_BASE} JOIN cluster_items ci ON ci.content_id = c.id
     WHERE ci.cluster_id = ? ORDER BY s.score DESC LIMIT ?`,
    id,
    limit,
  );
}

export function clusterHistory(id: string, limit = 200): { ts: number; score: number; item_count: number }[] {
  return all<{ ts: number; score: number; item_count: number }>(
    'SELECT ts, score, item_count FROM cluster_snapshots WHERE cluster_id = ? ORDER BY ts DESC LIMIT ?',
    id,
    limit,
  ).reverse();
}

/** How many distinct sources currently carry the story this item belongs to. */
export function crossSourceCounts(): Map<string, number> {
  const rows = all<{ content_id: string; n: number }>(
    `SELECT ci.content_id, cl.source_count AS n
     FROM cluster_items ci JOIN clusters cl ON cl.id = ci.cluster_id`,
  );
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.content_id, Math.max(map.get(r.content_id) ?? 1, r.n));
  return map;
}

export function clusterOfContent(contentId: string): ClusterRow | undefined {
  return get<ClusterRow>(
    'SELECT cl.* FROM clusters cl JOIN cluster_items ci ON ci.cluster_id = cl.id WHERE ci.content_id = ? LIMIT 1',
    contentId,
  );
}

// ── Keyword statistics ─────────────────────────────────────────────────────

export function bumpKeyword(
  keyword: string,
  hourBucketTs: number,
  delta: { mentions: number; creators: number; sources: number; metric: number },
): void {
  run(
    `INSERT INTO keyword_stats (keyword, hour_bucket, mentions, unique_creators, source_count, total_metric)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT (keyword, hour_bucket) DO UPDATE SET
       mentions = excluded.mentions,
       unique_creators = excluded.unique_creators,
       source_count = excluded.source_count,
       total_metric = excluded.total_metric`,
    keyword,
    hourBucketTs,
    delta.mentions,
    delta.creators,
    delta.sources,
    delta.metric,
  );
}

export interface KeywordTrend {
  keyword: string;
  mentions: number;
  previous: number;
  unique_creators: number;
  source_count: number;
  total_metric: number;
  growth: number;
}

/** Hashtags and keywords whose mention count jumped in the latest hour. */
export function keywordBreakouts(currentBucket: number, limit = 40): KeywordTrend[] {
  return all<KeywordTrend>(
    `SELECT k.keyword,
            k.mentions,
            COALESCE(p.mentions, 0) AS previous,
            k.unique_creators, k.source_count, k.total_metric,
            (k.mentions - COALESCE(p.mentions, 0)) * 1.0 / MAX(COALESCE(p.mentions, 0), 1) AS growth
     FROM keyword_stats k
     LEFT JOIN keyword_stats p ON p.keyword = k.keyword AND p.hour_bucket = k.hour_bucket - 3600
     WHERE k.hour_bucket = ? AND k.mentions >= 2
     ORDER BY growth DESC, k.mentions DESC
     LIMIT ?`,
    currentBucket,
    limit,
  );
}

// ── Key-value + retention ──────────────────────────────────────────────────

export function kvGet(key: string): string | null {
  return get<{ value: string }>('SELECT value FROM sys_kv WHERE key = ?', key)?.value ?? null;
}

export function kvSet(key: string, value: string): void {
  run(
    'INSERT INTO sys_kv (key, value, updated_at) VALUES (?,?,?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    key,
    value,
    Math.floor(Date.now() / 1000),
  );
}

export interface CleanupResult {
  readonly content: number;
  readonly metrics: number;
  readonly events: number;
  readonly clusterSnapshots: number;
}

/**
 * Retention. Content identifiers are dropped only with the content itself, so
 * deduplication never silently degrades while an item is still in the window.
 */
export function cleanup(now: number, retentionDays: number, historyDays: number): CleanupResult {
  const contentCutoff = now - retentionDays * 86400;
  const historyCutoff = now - historyDays * 86400;

  return tx(() => {
    const doomed = all<{ id: string }>(
      'SELECT id FROM content WHERE last_seen_at < ? LIMIT 20000',
      contentCutoff,
    );
    for (const row of doomed) run('DELETE FROM content WHERE id = ?', row.id);

    const metrics = get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM content_metrics WHERE ts < ?',
      contentCutoff,
    )?.n ?? 0;
    run('DELETE FROM content_metrics WHERE ts < ?', contentCutoff);

    const events = get<{ n: number }>('SELECT COUNT(*) AS n FROM sys_events WHERE ts < ?', historyCutoff)?.n ?? 0;
    run('DELETE FROM sys_events WHERE ts < ?', historyCutoff);

    const snaps = get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM cluster_snapshots WHERE ts < ?',
      historyCutoff,
    )?.n ?? 0;
    run('DELETE FROM cluster_snapshots WHERE ts < ?', historyCutoff);
    run('DELETE FROM keyword_stats WHERE hour_bucket < ?', historyCutoff);

    return { content: doomed.length, metrics, events, clusterSnapshots: snaps };
  });
}

// ── Reports ────────────────────────────────────────────────────────────────

export interface Bucketed {
  key: string;
  n: number;
}

/** Counts of stored content grouped by one column, largest first. */
export function distribution(column: 'source' | 'lang' | 'country' | 'content_type', sinceTs: number, limit = 40): Bucketed[] {
  const allowed = new Set(['source', 'lang', 'country', 'content_type']);
  if (!allowed.has(column)) throw new Error(`Refusing to group by "${column}"`);
  return all<Bucketed>(
    `SELECT COALESCE(${column}, 'unknown') AS key, COUNT(*) AS n
     FROM content WHERE first_seen_at >= ?
     GROUP BY key ORDER BY n DESC LIMIT ?`,
    sinceTs,
    limit,
  );
}

export function stateDistribution(): Bucketed[] {
  return all<Bucketed>(
    'SELECT state AS key, COUNT(*) AS n FROM content_scores GROUP BY state ORDER BY n DESC',
  );
}

export interface TimelinePoint {
  hour: number;
  source: string;
  n: number;
}

/** Items discovered per hour per source - the shape of the collection itself. */
export function discoveryTimeline(sinceTs: number): TimelinePoint[] {
  return all<TimelinePoint>(
    `SELECT (first_seen_at / 3600) * 3600 AS hour, source, COUNT(*) AS n
     FROM content WHERE first_seen_at >= ?
     GROUP BY hour, source ORDER BY hour ASC`,
    sinceTs,
  );
}

export interface SourceReport {
  source: string;
  items: number;
  scored: number;
  avg_score: number | null;
  max_score: number | null;
  with_velocity: number;
  median_observations: number | null;
}

/** Per-source quality: how much was collected and how well it is measured. */
export function sourceReport(sinceTs: number): SourceReport[] {
  return all<SourceReport>(
    `SELECT c.source,
            COUNT(*) AS items,
            SUM(CASE WHEN s.content_id IS NOT NULL THEN 1 ELSE 0 END) AS scored,
            AVG(s.score) AS avg_score,
            MAX(s.score) AS max_score,
            SUM(CASE WHEN s.velocity IS NOT NULL THEN 1 ELSE 0 END) AS with_velocity,
            AVG(s.observations) AS median_observations
     FROM content c LEFT JOIN content_scores s ON s.content_id = c.id
     WHERE c.first_seen_at >= ?
     GROUP BY c.source ORDER BY items DESC`,
    sinceTs,
  );
}

export interface CreatorReport {
  id: string;
  source: string;
  external_id: string;
  name: string | null;
  url: string | null;
  followers: number | null;
  median_metric: number | null;
  sample_count: number;
  items: number;
  best_score: number | null;
  avg_score: number | null;
  breakouts: number;
}

/** Creators ranked by how well their content actually performs here. */
export function topCreators(limit: number, sinceTs: number, orderBy: 'best' | 'breakouts' | 'items'): CreatorReport[] {
  const order =
    orderBy === 'breakouts'
      ? 'breakouts DESC, best_score DESC'
      : orderBy === 'items'
        ? 'items DESC, best_score DESC'
        : 'best_score DESC';
  return all<CreatorReport>(
    `SELECT cr.id, cr.source, cr.external_id, cr.name, cr.url, cr.followers,
            cr.median_metric, cr.sample_count,
            COUNT(c.id) AS items,
            MAX(s.score) AS best_score,
            AVG(s.score) AS avg_score,
            (SELECT COUNT(*) FROM creator_breakouts b WHERE b.creator_id = cr.id) AS breakouts
     FROM creators cr
     JOIN content c ON c.source = cr.source AND c.author_id = cr.external_id
     LEFT JOIN content_scores s ON s.content_id = c.id
     WHERE c.first_seen_at >= ?
     GROUP BY cr.id
     HAVING items > 0
     ORDER BY ${order}
     LIMIT ?`,
    sinceTs,
    limit,
  );
}

export interface ActivityCell {
  dow: number;
  hour: number;
  n: number;
}

/**
 * When content actually appears, by weekday and hour of day.
 *
 * The same grid the scoring engine normalises against, exposed so it can be
 * looked at: a platform that is reliably busy at 20:00 should not read as a
 * breakout every evening, and this is where that becomes visible.
 */
export function activityGrid(sinceTs: number): ActivityCell[] {
  return all<ActivityCell>(
    `SELECT CAST(strftime('%w', first_seen_at, 'unixepoch') AS INTEGER) AS dow,
            CAST(strftime('%H', first_seen_at, 'unixepoch') AS INTEGER) AS hour,
            COUNT(*) AS n
     FROM content WHERE first_seen_at >= ?
     GROUP BY dow, hour`,
    sinceTs,
  );
}

/** Score distribution in ten-point buckets. */
export function scoreHistogram(): { bucket: number; n: number }[] {
  return all<{ bucket: number; n: number }>(
    `SELECT MIN(CAST(score / 10 AS INTEGER) * 10, 90) AS bucket, COUNT(*) AS n
     FROM content_scores GROUP BY bucket ORDER BY bucket ASC`,
  );
}

export interface ScatterPoint {
  id: string;
  source: string;
  state: string;
  title: string;
  score: number;
  velocity: number | null;
  value: number | null;
  followers: number | null;
  anomaly: number | null;
  engagement: number | null;
  age_hours: number | null;
}

/**
 * The raw material behind the ranking, as points rather than a list.
 *
 * Reach against growth against creator size is where the interesting cases
 * live - a small account far above its own normal sits visibly apart from the
 * crowd, in a way no sorted table shows.
 */
export function scatterSample(sinceTs: number, limit = 500): ScatterPoint[] {
  return all<ScatterPoint>(
    `SELECT c.id, c.source, s.state, c.title, s.score, s.velocity,
            s.primary_value AS value, cr.followers,
            s.creator_anomaly AS anomaly, s.engagement_rate AS engagement, s.age_hours
     FROM content_scores s
     JOIN content c ON c.id = s.content_id
     LEFT JOIN creators cr ON cr.id = c.source || ':' || c.author_id
     WHERE c.first_seen_at >= ?
     ORDER BY s.score DESC LIMIT ?`,
    sinceTs,
    limit,
  );
}

// ── Format analysis ────────────────────────────────────────────────────────

export interface PeakedQuery {
  readonly sinceTs: number;
  readonly languages?: readonly string[];
  readonly countries?: readonly string[];
  readonly sources?: readonly string[];
  readonly minPeak: number;
  readonly limit: number;
}

/**
 * What peaked while nobody was looking.
 *
 * A different question from "what is hot", and ordered differently because of
 * it: by the height it reached, not by where it is now. Anything still rising
 * is excluded on purpose — a retrospective that includes things which have not
 * finished happening is just the dashboard with an older start date.
 */
export function peakedWithin(q: PeakedQuery): RankedRow[] {
  const where: string[] = [
    's.peak_at IS NOT NULL',
    's.peak_at >= ?',
    'COALESCE(s.peak_score, 0) >= ?',
    // Already over: still-climbing items belong on the dashboard.
    "s.state IN ('PEAK', 'DECLINING', 'DEAD')",
    'NOT EXISTS (SELECT 1 FROM content_archive a WHERE a.content_id = c.id)',
  ];
  const params: unknown[] = [q.sinceTs, q.minPeak];

  const inClause = (column: string, values: readonly string[] | undefined): void => {
    if (values === undefined || values.length === 0) return;
    where.push(`${column} IN (${values.map(() => '?').join(',')})`);
    params.push(...values);
  };
  inClause('c.lang', q.languages);
  inClause('c.country', q.countries);
  inClause('c.source', q.sources);

  params.push(q.limit);
  return all<RankedRow>(
    `${RANKED_BASE} WHERE ${where.join(' AND ')}
     ORDER BY s.peak_score DESC
     LIMIT ?`,
    ...params,
  );
}

/**
 * Creators from one source that have proved worth following, best first.
 *
 * This is what turns discovery from something bought into something learned.
 * A `search.list` call costs 100 quota units and returns whatever matches; a
 * channel's public feed costs nothing and returns the new uploads of a channel
 * already measured as good. The list of good channels is not guesswork - it is
 * sitting in `content_scores`, and this reads it.
 *
 * Two guards against promoting a fluke: a creator needs several measured items,
 * not one lucky video, and the bar is their *average*, so a single hit does not
 * carry a channel that is otherwise quiet.
 */
/**
 * Which of these external ids this source has already stored.
 *
 * Exists to stop a source paying to re-read what it already has. A channel
 * feed returns the same fifteen uploads until the channel posts again, so
 * without this every run re-prices the same videos - measured at about 13
 * quota units per run against a feed list of sixty channels, for nothing.
 */
export function knownExternalIds(source: string, externalIds: readonly string[]): Set<string> {
  const known = new Set<string>();
  if (externalIds.length === 0) return known;

  const CHUNK = 400;
  for (let i = 0; i < externalIds.length; i += CHUNK) {
    const slice = externalIds.slice(i, i + CHUNK);
    const rows = all<{ external_id: string }>(
      `SELECT external_id FROM content
       WHERE source = ? AND external_id IN (${slice.map(() => '?').join(',')})`,
      source,
      ...slice,
    );
    for (const row of rows) known.add(row.external_id);
  }
  return known;
}

export interface TermYield {
  term: string;
  found: number;
  /** Items that reached a state worth looking at. */
  moving: number;
  avgScore: number;
}

/**
 * What each seed word bought.
 *
 * Only items old enough to have been judged are counted: a word rotated an
 * hour ago has found nothing that could have taken off yet, and letting those
 * count would make the most recently used word always look the worst.
 */
export function termYield(source: string, settledBeforeTs: number): TermYield[] {
  return all<TermYield>(
    `SELECT c.discovery_term AS term,
            COUNT(*) AS found,
            SUM(CASE WHEN s.state IN ('VIRAL','HOT','EMERGING','RISING') THEN 1 ELSE 0 END) AS moving,
            ROUND(AVG(COALESCE(s.score, 0)), 1) AS avgScore
     FROM content c
     LEFT JOIN content_scores s ON s.content_id = c.id
     WHERE c.source = ? AND c.discovery_term IS NOT NULL AND c.first_seen_at <= ?
     GROUP BY c.discovery_term
     ORDER BY moving DESC, avgScore DESC`,
    source,
    settledBeforeTs,
  );
}

export function provenCreators(
  source: string,
  minItems: number,
  minAvgScore: number,
  limit: number,
): string[] {
  const rows = all<{ author_id: string }>(
    `SELECT c.author_id
     FROM content c
     JOIN content_scores s ON s.content_id = c.id
     WHERE c.source = ? AND c.author_id IS NOT NULL
     GROUP BY c.author_id
     HAVING COUNT(*) >= ? AND AVG(s.score) >= ?
     ORDER BY AVG(s.score) DESC
     LIMIT ?`,
    source,
    minItems,
    minAvgScore,
    limit,
  );
  return rows.map((r) => r.author_id);
}

// ── Archive ────────────────────────────────────────────────────────────────

export function archiveContent(id: string, reason: string, note: string | null, now: number): void {
  run(
    `INSERT INTO content_archive (content_id, reason, note, archived_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (content_id) DO UPDATE SET
       reason = excluded.reason, note = excluded.note, archived_at = excluded.archived_at`,
    id,
    reason,
    note,
    now,
  );
}

export function unarchiveContent(id: string): void {
  run('DELETE FROM content_archive WHERE content_id = ?', id);
}

export function archivedIds(ids: readonly string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const rows = all<{ content_id: string }>(
    `SELECT content_id FROM content_archive WHERE content_id IN (${ids.map(() => '?').join(',')})`,
    ...ids,
  );
  return new Set(rows.map((r) => r.content_id));
}

export function archiveCount(): number {
  return get<{ n: number }>('SELECT COUNT(*) AS n FROM content_archive')?.n ?? 0;
}

export interface FormatQuery {
  readonly sinceTs: number;
  readonly languages?: readonly string[];
  readonly countries?: readonly string[];
  readonly sources?: readonly string[];
  readonly contentTypes?: readonly string[];
  readonly minConfidence: number;
  readonly limit: number;
}

export interface FormatRow {
  title: string;
  content_type: string;
  lang: string | null;
  percentile: number;
  score: number;
}

/**
 * Raw material for the format analysis.
 *
 * Deliberately returns rows rather than aggregates: every feature here needs
 * proper Unicode handling, and SQLite cannot do it. An emoji is a surrogate
 * pair it will not match and a character it miscounts, so a `LIKE '%emoji%'`
 * in SQL silently finds almost nothing - which looked like a real result until
 * it was checked against the titles by eye.
 *
 * `source_percentile` is required, not merely selected: it is the only reason
 * items from different platforms can be compared at all.
 */
export function formatSamples(q: FormatQuery): FormatRow[] {
  const where: string[] = [
    'c.first_seen_at >= ?',
    's.source_percentile IS NOT NULL',
    's.confidence >= ?',
    "TRIM(c.title) <> ''",
  ];
  const params: unknown[] = [q.sinceTs, q.minConfidence];

  const inClause = (column: string, values: readonly string[] | undefined): void => {
    if (values === undefined || values.length === 0) return;
    where.push(`${column} IN (${values.map(() => '?').join(',')})`);
    params.push(...values);
  };
  inClause('c.lang', q.languages);
  inClause('c.country', q.countries);
  inClause('c.source', q.sources);
  inClause('c.content_type', q.contentTypes);

  params.push(q.limit);
  return all<FormatRow>(
    `SELECT c.title, c.content_type, c.lang, s.source_percentile AS percentile, s.score
     FROM content_scores s
     JOIN content c ON c.id = s.content_id
     WHERE ${where.join(' AND ')}
     ORDER BY c.first_seen_at DESC
     LIMIT ?`,
    ...params,
  );
}

// ── Embeddings ─────────────────────────────────────────────────────────────

/**
 * Cached vectors for a set of items, for one model.
 *
 * Keyed by model because vectors from different models are not comparable, and
 * mixing them would silently corrupt every similarity in the system rather than
 * failing in any visible way.
 */
export function embeddingsFor(ids: readonly string[], model: string): Map<string, Uint8Array> {
  const found = new Map<string, Uint8Array>();
  if (ids.length === 0) return found;

  // Chunked: SQLite's default parameter ceiling is 999, and a busy database
  // has many more items than that.
  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const rows = all<{ content_id: string; vec: Uint8Array }>(
      `SELECT content_id, vec FROM content_embeddings
       WHERE model = ? AND content_id IN (${slice.map(() => '?').join(',')})`,
      model,
      ...slice,
    );
    for (const row of rows) found.set(row.content_id, row.vec);
  }
  return found;
}

/**
 * Items with no vector for this model, newest first.
 *
 * Newest first because clustering only looks at a recent window: embedding a
 * two-month-old item before today's would spend the run's budget on rows
 * nothing will compare.
 */
export function contentNeedingEmbedding(
  model: string,
  limit: number,
): { id: string; title: string; body: string | null }[] {
  return all<{ id: string; title: string; body: string | null }>(
    `SELECT c.id, c.title, c.body
     FROM content c
     LEFT JOIN content_embeddings e ON e.content_id = c.id AND e.model = ?
     WHERE e.content_id IS NULL
     ORDER BY c.first_seen_at DESC
     LIMIT ?`,
    model,
    limit,
  );
}

export function saveEmbeddings(
  model: string,
  vectors: ReadonlyMap<string, { dims: number; blob: Uint8Array }>,
  now: number,
): void {
  if (vectors.size === 0) return;
  const sql = `INSERT INTO content_embeddings (content_id, model, dims, vec, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (content_id, model) DO UPDATE SET
       dims = excluded.dims, vec = excluded.vec, created_at = excluded.created_at`;
  tx(() => {
    for (const [id, { dims, blob }] of vectors) run(sql, id, model, dims, blob, now);
  });
}

/** How much of the corpus has a vector, for the diagnostics page. */
export function embeddingCoverage(model: string): { embedded: number; total: number } {
  const row = get<{ embedded: number; total: number }>(
    `SELECT
       (SELECT COUNT(*) FROM content_embeddings WHERE model = ?) AS embedded,
       (SELECT COUNT(*) FROM content) AS total`,
    model,
  );
  return { embedded: row?.embedded ?? 0, total: row?.total ?? 0 };
}

/** Vectors from a model no longer in use are dead weight. */
export function deleteEmbeddingsExcept(model: string): number {
  const stale =
    get<{ n: number }>('SELECT COUNT(*) AS n FROM content_embeddings WHERE model <> ?', model)?.n ?? 0;
  if (stale > 0) run('DELETE FROM content_embeddings WHERE model <> ?', model);
  return stale;
}

export interface TimingQuery {
  readonly sinceTs: number;
  /** Nothing younger than this: it has not had a fair chance to prove itself. */
  readonly settledBeforeTs: number;
  readonly languages?: readonly string[];
  readonly countries?: readonly string[];
  readonly sources?: readonly string[];
  readonly contentTypes?: readonly string[];
  readonly minConfidence: number;
  readonly limit: number;
}

export interface TimingRow {
  published_at: number;
  percentile: number;
  score: number;
}

/**
 * Raw material for the timing analysis.
 *
 * Two filters here are load-bearing rather than tidy. `published_at_source`
 * must be a real one: the system estimates a publish time when a source does
 * not give one, and using an estimate to analyse publish timing would be
 * circular. And nothing newer than `settledBeforeTs` is included, because an
 * item published an hour ago has not had the same chance to prove itself as
 * one published yesterday, so letting it compete would measure recency.
 */
export function timingSamples(q: TimingQuery): TimingRow[] {
  const where: string[] = [
    'c.first_seen_at >= ?',
    'c.published_at IS NOT NULL',
    'c.published_at <= ?',
    "c.published_at_source IN ('api', 'feed')",
    's.source_percentile IS NOT NULL',
    's.confidence >= ?',
  ];
  const params: unknown[] = [q.sinceTs, q.settledBeforeTs, q.minConfidence];

  const inClause = (column: string, values: readonly string[] | undefined): void => {
    if (values === undefined || values.length === 0) return;
    where.push(`${column} IN (${values.map(() => '?').join(',')})`);
    params.push(...values);
  };
  inClause('c.lang', q.languages);
  inClause('c.country', q.countries);
  inClause('c.source', q.sources);
  inClause('c.content_type', q.contentTypes);

  params.push(q.limit);
  return all<TimingRow>(
    `SELECT c.published_at, s.source_percentile AS percentile, s.score
     FROM content_scores s
     JOIN content c ON c.id = s.content_id
     WHERE ${where.join(' AND ')}
     ORDER BY c.published_at DESC
     LIMIT ?`,
    ...params,
  );
}

export interface ClusterTrace {
  id: string;
  label: string;
  source_count: number;
  points: { ts: number; score: number; item_count: number }[];
}

/** Score history for the strongest topics, for a multi-series chart. */
export function clusterTraces(limit = 6): ClusterTrace[] {
  const clusters = all<{ id: string; label: string; source_count: number }>(
    'SELECT id, label, source_count FROM clusters ORDER BY score DESC LIMIT ?',
    limit,
  );
  return clusters.map((c) => ({
    ...c,
    points: all<{ ts: number; score: number; item_count: number }>(
      'SELECT ts, score, item_count FROM cluster_snapshots WHERE cluster_id = ? ORDER BY ts ASC LIMIT 200',
      c.id,
    ),
  }));
}

/** Where linked content actually points, read from stored provenance. */
export function topDomains(sinceTs: number, limit = 15): Bucketed[] {
  const rows = all<{ url: string | null; n: number }>(
    `SELECT json_extract(raw, '$.targetUrl') AS url, COUNT(*) AS n
     FROM content
     WHERE first_seen_at >= ? AND json_extract(raw, '$.targetUrl') IS NOT NULL
     GROUP BY url`,
    sinceTs,
  );

  // Grouping by host happens here rather than in SQL: SQLite has no URL parser,
  // and a stored host column would be one more thing to keep in step.
  const byHost = new Map<string, number>();
  for (const row of rows) {
    if (row.url === null) continue;
    try {
      const host = new URL(row.url).hostname.replace(/^www\./, '');
      byHost.set(host, (byHost.get(host) ?? 0) + row.n);
    } catch {
      // Not a URL; nothing to attribute.
    }
  }

  return [...byHost.entries()]
    .map(([key, n]) => ({ key, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, limit);
}

/** Every language and country actually present, so filters can show real options. */
export function availableFacets(): { languages: Bucketed[]; countries: Bucketed[]; sources: Bucketed[] } {
  return {
    languages: all<Bucketed>(
      "SELECT lang AS key, COUNT(*) AS n FROM content WHERE lang IS NOT NULL GROUP BY lang ORDER BY n DESC",
    ),
    countries: all<Bucketed>(
      "SELECT country AS key, COUNT(*) AS n FROM content WHERE country IS NOT NULL GROUP BY country ORDER BY n DESC",
    ),
    sources: all<Bucketed>('SELECT source AS key, COUNT(*) AS n FROM content GROUP BY source ORDER BY n DESC'),
  };
}

export interface DbStats {
  readonly content: number;
  readonly metrics: number;
  readonly clusters: number;
  readonly creators: number;
  readonly breakouts: number;
  readonly openInterventions: number;
}

/**
 * Counting rows in `content_metrics` is a scan, and the dashboard asks for
 * these on every load. A short memo keeps that off the hot path without ever
 * showing a number more than half a minute stale.
 */
let statsCache: { at: number; value: DbStats } | null = null;
const STATS_TTL_MS = 30_000;

export function dbStats(): DbStats {
  if (statsCache !== null && Date.now() - statsCache.at < STATS_TTL_MS) return statsCache.value;
  const value = computeStats();
  statsCache = { at: Date.now(), value };
  return value;
}

function computeStats(): DbStats {
  const one = (sql: string): number => get<{ n: number }>(sql)?.n ?? 0;
  return {
    content: one('SELECT COUNT(*) AS n FROM content'),
    metrics: one('SELECT COUNT(*) AS n FROM content_metrics'),
    clusters: one('SELECT COUNT(*) AS n FROM clusters'),
    creators: one('SELECT COUNT(*) AS n FROM creators'),
    breakouts: one('SELECT COUNT(*) AS n FROM creator_breakouts'),
    openInterventions: one("SELECT COUNT(*) AS n FROM sys_interventions WHERE status = 'OPEN'"),
  };
}
