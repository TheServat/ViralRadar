# Database

SQLite via Node's built-in `node:sqlite`. One file, no server, no native module
to compile, no ORM. Every statement lives in
[`src/db/repo.ts`](../src/db/repo.ts) or in a migration.

```
PRAGMA journal_mode = WAL      readers never block the writer
PRAGMA synchronous = NORMAL    the right trade-off for derived data
PRAGMA foreign_keys = ON
PRAGMA busy_timeout = 5000
```

## Migrations

Numbered SQL files in `src/db/migrations/`, applied in order inside a
transaction, tracked with `PRAGMA user_version`. To change the schema, add
`002_something.sql`. There is no other mechanism, and no way to change the shape
of the data from application code.

## Conventions

- All timestamps are **UNIX epoch seconds, UTC**, integer.
- A metric the platform does not expose is `NULL`. Never `0`. "Zero shares" and
  "this platform has no concept of shares" are different facts and the scoring
  engine must be able to tell them apart.
- Derived values carry their provenance: `lang_confidence`, `country_source`,
  `published_at_source`, `scoring_version`.
- Table prefixes stand in for the schemas SQLite does not have: `content_*`,
  `creator_*`, `cluster_*`, `source_*`, `sys_*`.

## Tables

```
content ──────────────┬── content_metrics      time series, the raw evidence
   │                  ├── content_scores       current derived state
   │                  └── cluster_items ── clusters ── cluster_snapshots
   ├── creators ────────── creator_breakouts
   └── keyword_stats                            hashtag growth per hour

source_baselines      per-source distributions, pooled and per hour of day
source_health         status, reliability, failure counts
sys_interventions     things only a human can clear
sys_events            durable event log; the SSE stream tails this
sys_kv                small operational state
```

### content

Identity is `(source, external_id)` with a unique constraint; the primary key is
`<source>:<hash of external id>`, short and stable.

Fields that carry provenance are never overwritten with a weaker guess. The
upsert uses `COALESCE(content.lang, excluded.lang)` — once a language has been
determined from a full first observation, a later partial refresh cannot
downgrade it.

### content_metrics

`WITHOUT ROWID`, keyed `(content_id, ts)`. This is the only non-derived table
that matters: everything in `content_scores` can be recomputed from it. Nothing
here is ever inferred or backfilled.

Snapshots are bucketed to the minute. Two refreshes seconds apart would
otherwise produce a near-zero time delta and a meaningless velocity.

### content_scores

Recomputed every analysis pass. `peak_score` is a high-water mark — it only ever
moves up, which is what makes `PEAK` and `DECLINING` detectable:

```sql
peak_score = MAX(COALESCE(content_scores.peak_score, 0), excluded.score),
peak_at    = CASE WHEN excluded.score > COALESCE(content_scores.peak_score, 0)
                  THEN excluded.updated_at ELSE content_scores.peak_at END,
state_changed_at = CASE WHEN content_scores.state != excluded.state
                        THEN excluded.updated_at ELSE content_scores.state_changed_at END
```

### source_baselines

Keyed `(source, metric, bucket)` where bucket is `all` or `h00`–`h23`. This is
the machinery that lets a YouTube view and a Reddit upvote be compared at all,
and that stops predictable evening traffic from reading as a breakout.

### clusters

Rebuilt wholesale each pass but keeping their identity — and therefore their
score history in `cluster_snapshots` — as long as their strongest keywords are
stable. A name given by the optional AI plugin survives the rebuild:

```sql
label = CASE WHEN clusters.label_source = 'ai' THEN clusters.label ELSE excluded.label END
```

## Query patterns and indexes

Indexes exist for queries that are actually made, not speculatively.

| Query | Index |
| --- | --- |
| ranked lists | `content_scores_rank_idx (score DESC)` |
| dashboard sections | `content_scores_state_idx (state, score DESC)` |
| refresh candidates | `content_source_seen_idx (source, first_seen_at DESC)` |
| creator history | `content_author_idx (source, author_id)` partial, `WHERE author_id IS NOT NULL` |
| repost detection | `content_simhash_idx` partial, `WHERE simhash IS NOT NULL` |
| retention sweep | `content_metrics_ts_idx (ts DESC)` |

Partial indexes are used where a column is often `NULL` — there is no reason to
index rows that can never match.

The ranked read is one query with a `ROW_NUMBER()` window to pick each item's
latest metrics, joined to its score and its creator. Filters are appended as
optional `WHERE` clauses, which is what makes "all sources, all languages, all
countries" the natural default rather than a special case.

## Retention

```
RETENTION_DAYS       30    content and its metric history
TREND_HISTORY_DAYS  365    events, cluster snapshots, keyword stats
```

`ON DELETE CASCADE` means removing content removes its metrics, scores and
cluster membership together. Source identifiers are dropped only with the
content itself, so deduplication never silently degrades while an item is still
in the window.

## Size

Roughly 2 KB per item plus about 60 bytes per metric snapshot. Six sources at a
20-minute discovery cycle with hot refreshes lands around **100–300 MB per
month** before retention. The default 30-day window keeps a running instance in
the low hundreds of megabytes.
