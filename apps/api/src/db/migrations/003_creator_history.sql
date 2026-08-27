-- Reference observations of a creator's own past work.
--
-- "500K views" means nothing until you know whether this account normally gets
-- 5K or 5M. That comparison needs several of their previous posts, and open
-- discovery does not provide them: it finds one strong video from a channel and
-- never returns, so 2,189 of 2,770 creators had exactly one measured item and
-- could never be judged against themselves.
--
-- These rows are deliberately NOT content. They are never scored, never
-- refreshed, never shown as trends, and never enter a cluster — they exist only
-- to answer "what is normal for this account". Keeping them out of `content`
-- is what stops a backfill of old uploads from polluting the trend feed with
-- things that are not trending.
CREATE TABLE creator_history (
  creator_id   TEXT    NOT NULL REFERENCES creators (id) ON DELETE CASCADE,
  external_id  TEXT    NOT NULL,           -- the post's own id inside the source
  metric       TEXT    NOT NULL,           -- which metric `value` is
  value        INTEGER NOT NULL,
  published_at INTEGER,
  fetched_at   INTEGER NOT NULL,
  PRIMARY KEY (creator_id, external_id)
) WITHOUT ROWID;

CREATE INDEX creator_history_creator_idx ON creator_history (creator_id, metric);

-- When a creator was last backfilled, so the job can skip them for a while
-- rather than asking the same channel every run.
ALTER TABLE creators ADD COLUMN history_fetched_at INTEGER;
