-- Items the user is done with.
--
-- Once you have made a video about something, it should stop competing for
-- your attention — but deleting it would be wrong twice over: the metric
-- history is what the trend engine learns baselines from, and a thing you
-- covered is exactly the thing you want to find again when asking what you
-- already did.
--
-- So it is a mark, not a deletion. Hidden items keep being measured and keep
-- contributing to baselines and clusters; they simply stop appearing in the
-- lists unless asked for.
CREATE TABLE content_archive (
  content_id  TEXT    PRIMARY KEY REFERENCES content (id) ON DELETE CASCADE,
  reason      TEXT    NOT NULL DEFAULT 'used',   -- used | not_relevant
  note        TEXT,
  archived_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX content_archive_time_idx ON content_archive (archived_at DESC);
