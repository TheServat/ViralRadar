-- ---------------------------------------------------------------------------
-- 001_init - Trend Radar core schema
--
-- Bounded contexts kept apart by table-name prefix (SQLite has no schemas):
--   content_*   discovered items and their metric history
--   creator_*   per-author baselines
--   cluster_*   cross-source topic clusters
--   source_*    per-source health + statistical baselines
--   sys_*       operational tables (events, interventions, key-value)
--
-- All timestamps are UNIX epoch SECONDS (integer, UTC). A metric a platform
-- does not expose is stored as NULL, never as 0.
-- ---------------------------------------------------------------------------

CREATE TABLE content (
  id                   TEXT    PRIMARY KEY,          -- <source>:<stable hash of external id>
  source               TEXT    NOT NULL,
  external_id          TEXT    NOT NULL,
  url                  TEXT    NOT NULL,
  canonical_url        TEXT,
  title                TEXT    NOT NULL,
  body                 TEXT,
  content_type         TEXT    NOT NULL,             -- video|short_video|image|text|link|topic|audio|unknown
  author_id            TEXT,                         -- creator key inside the source
  author_name          TEXT,
  thumbnail_url        TEXT,

  lang                 TEXT,                         -- ISO-639-1, NULL when unknown
  lang_confidence      REAL,
  country              TEXT,                         -- ISO-3166-1 alpha-2, NULL when unknown
  country_confidence   REAL,
  country_source       TEXT,                         -- region_param|author|feed|language

  published_at         INTEGER,                      -- NULL when the source does not say
  published_at_source  TEXT,                         -- api|feed|estimated
  first_seen_at        INTEGER NOT NULL,
  last_seen_at         INTEGER NOT NULL,

  region               TEXT,                         -- collection context that found it
  keywords             TEXT,                         -- JSON array of extracted keywords
  hashtags             TEXT,                         -- JSON array
  simhash              TEXT,                         -- 64-bit SimHash of normalised text, hex
  raw                  TEXT,                         -- JSON, trimmed source payload for provenance

  UNIQUE (source, external_id)
);

CREATE INDEX content_source_seen_idx  ON content (source, first_seen_at DESC);
CREATE INDEX content_first_seen_idx   ON content (first_seen_at DESC);
CREATE INDEX content_author_idx       ON content (source, author_id) WHERE author_id IS NOT NULL;
CREATE INDEX content_simhash_idx      ON content (simhash) WHERE simhash IS NOT NULL;
CREATE INDEX content_lang_idx         ON content (lang) WHERE lang IS NOT NULL;

-- Time series. One row per observation. This is what makes velocity and
-- acceleration possible at all, so it is never derived and never faked.
CREATE TABLE content_metrics (
  content_id   TEXT    NOT NULL REFERENCES content (id) ON DELETE CASCADE,
  ts           INTEGER NOT NULL,
  views        INTEGER,
  likes        INTEGER,
  comments     INTEGER,
  shares       INTEGER,
  reactions    INTEGER,
  native_score INTEGER,                              -- upvotes / points / approx traffic
  PRIMARY KEY (content_id, ts)
) WITHOUT ROWID;

CREATE INDEX content_metrics_ts_idx ON content_metrics (ts DESC);

-- Current computed state of one item. Recomputed by the analyse pass and always
-- reproducible from content_metrics plus scoring_version.
CREATE TABLE content_scores (
  content_id        TEXT    PRIMARY KEY REFERENCES content (id) ON DELETE CASCADE,
  source            TEXT    NOT NULL,
  score             REAL    NOT NULL,                -- 0..100 universal score
  confidence        REAL    NOT NULL,                -- 0..1, how much data backs the score
  state             TEXT    NOT NULL,                -- NEW|EMERGING|RISING|HOT|VIRAL|PEAK|DECLINING|DEAD
  primary_metric    TEXT    NOT NULL,                -- which metric drives this source
  primary_value     INTEGER,
  velocity          REAL,                            -- primary metric per hour
  acceleration      REAL,                            -- change in velocity per hour
  engagement_rate   REAL,
  creator_anomaly   REAL,                            -- current / creator median
  source_percentile REAL,                            -- 0..1 vs the source own recent distribution
  freshness         REAL,                            -- 0..1
  cross_source      REAL,                            -- 0..1
  observations      INTEGER NOT NULL,
  age_hours         REAL,
  peak_score        REAL,
  peak_at           INTEGER,
  state_changed_at  INTEGER,
  scoring_version   INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX content_scores_rank_idx  ON content_scores (score DESC);
CREATE INDEX content_scores_state_idx ON content_scores (state, score DESC);

-- Per-creator baselines. "500K views" only means something next to what this
-- account normally gets.
CREATE TABLE creators (
  id             TEXT    PRIMARY KEY,                -- <source>:<author_id>
  source         TEXT    NOT NULL,
  external_id    TEXT    NOT NULL,
  name           TEXT,
  url            TEXT,
  followers      INTEGER,
  median_metric  REAL,
  p90_metric     REAL,
  p99_metric     REAL,
  sample_count   INTEGER NOT NULL DEFAULT 0,
  first_seen_at  INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (source, external_id)
);

-- Detected creator breakouts, kept as history so the dashboard can look back.
CREATE TABLE creator_breakouts (
  id            TEXT    PRIMARY KEY,
  creator_id    TEXT    NOT NULL REFERENCES creators (id) ON DELETE CASCADE,
  content_id    TEXT    NOT NULL REFERENCES content  (id) ON DELETE CASCADE,
  anomaly_ratio REAL    NOT NULL,
  baseline      REAL    NOT NULL,
  observed      REAL    NOT NULL,
  detected_at   INTEGER NOT NULL,
  UNIQUE (creator_id, content_id)
);

CREATE INDEX creator_breakouts_time_idx ON creator_breakouts (detected_at DESC);

-- Rolling statistical baselines per source, so a YouTube view and a Reddit
-- upvote are never compared as raw numbers.
CREATE TABLE source_baselines (
  source       TEXT    NOT NULL,
  metric       TEXT    NOT NULL,
  bucket       TEXT    NOT NULL,                     -- all | h00..h23 | dow0..dow6
  p50          REAL,
  p75          REAL,
  p90          REAL,
  p99          REAL,
  mad          REAL,
  sample_count INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (source, metric, bucket)
) WITHOUT ROWID;

CREATE TABLE source_health (
  source               TEXT    PRIMARY KEY,
  status               TEXT    NOT NULL,             -- UP|DEGRADED|RATE_LIMITED|AUTH_REQUIRED|CONFIGURATION_REQUIRED|CAPTCHA_REQUIRED|BLOCKED|ERROR|DISABLED
  last_run_at          INTEGER,
  last_ok_at           INTEGER,
  last_error           TEXT,
  last_error_kind      TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  items_last_run       INTEGER NOT NULL DEFAULT 0,
  total_items          INTEGER NOT NULL DEFAULT 0,
  total_runs           INTEGER NOT NULL DEFAULT 0,
  failed_runs          INTEGER NOT NULL DEFAULT 0,
  reliability          REAL    NOT NULL DEFAULT 1.0, -- 0..1, feeds trend confidence
  updated_at           INTEGER NOT NULL
);

-- Cross-source topic clusters: the answer to "what should I make today".
CREATE TABLE clusters (
  id               TEXT    PRIMARY KEY,
  label            TEXT    NOT NULL,
  label_source     TEXT    NOT NULL DEFAULT 'keywords',  -- keywords|ai
  keywords         TEXT    NOT NULL,                     -- JSON array
  first_seen_at    INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  item_count       INTEGER NOT NULL,
  source_count     INTEGER NOT NULL,
  sources          TEXT    NOT NULL,                     -- JSON array
  languages        TEXT,                                 -- JSON [{code,pct}]
  countries        TEXT,                                 -- JSON [{code,pct}]
  score            REAL    NOT NULL,
  confidence       REAL    NOT NULL,
  velocity         REAL,
  acceleration     REAL,
  state            TEXT    NOT NULL,
  total_views      INTEGER,
  total_engagement INTEGER,
  explanation      TEXT,                                 -- optional AI text, NULL when AI is off
  updated_at       INTEGER NOT NULL
);

CREATE INDEX clusters_rank_idx ON clusters (score DESC);
CREATE INDEX clusters_seen_idx ON clusters (last_seen_at DESC);

CREATE TABLE cluster_items (
  cluster_id TEXT NOT NULL REFERENCES clusters (id) ON DELETE CASCADE,
  content_id TEXT NOT NULL REFERENCES content  (id) ON DELETE CASCADE,
  similarity REAL NOT NULL,
  PRIMARY KEY (cluster_id, content_id)
) WITHOUT ROWID;

CREATE INDEX cluster_items_content_idx ON cluster_items (content_id);

-- Cluster score over time, so a trend has a visible life story.
CREATE TABLE cluster_snapshots (
  cluster_id   TEXT    NOT NULL REFERENCES clusters (id) ON DELETE CASCADE,
  ts           INTEGER NOT NULL,
  score        REAL    NOT NULL,
  item_count   INTEGER NOT NULL,
  source_count INTEGER NOT NULL,
  total_metric INTEGER,
  PRIMARY KEY (cluster_id, ts)
) WITHOUT ROWID;

-- Keyword / hashtag growth, bucketed per hour.
CREATE TABLE keyword_stats (
  keyword         TEXT    NOT NULL,
  hour_bucket     INTEGER NOT NULL,                  -- epoch seconds truncated to the hour
  mentions        INTEGER NOT NULL,
  unique_creators INTEGER NOT NULL,
  source_count    INTEGER NOT NULL,
  total_metric    INTEGER NOT NULL,
  PRIMARY KEY (keyword, hour_bucket)
) WITHOUT ROWID;

CREATE INDEX keyword_stats_bucket_idx ON keyword_stats (hour_bucket DESC);

-- Things only a human can clear: a login, a consent screen, a challenge page.
-- The system never tries to solve these itself.
CREATE TABLE sys_interventions (
  id          TEXT    PRIMARY KEY,
  source      TEXT    NOT NULL,
  type        TEXT    NOT NULL,                      -- CAPTCHA|LOGIN|MFA|CONSENT|SESSION_EXPIRED|CONFIGURATION
  message     TEXT    NOT NULL,
  url         TEXT,
  status      TEXT    NOT NULL,                      -- OPEN|RESOLVED|DISMISSED
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE INDEX sys_interventions_open_idx ON sys_interventions (status, created_at DESC);

CREATE TABLE sys_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  type    TEXT    NOT NULL,                          -- content.discovered|trend.detected|creator.breakout|source.error
  source  TEXT,
  ref_id  TEXT,
  payload TEXT
);

CREATE INDEX sys_events_ts_idx   ON sys_events (ts DESC);
CREATE INDEX sys_events_type_idx ON sys_events (type, ts DESC);

CREATE TABLE sys_kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
