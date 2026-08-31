-- The scoring pass reads every item seen inside its window, ordered by when it
-- was last seen. Without an index that is a full scan of `content` plus a
-- temporary B-tree to sort it, over rows carrying `body` and `raw`, every ten
-- minutes.
--
-- Measured on a 198 MB live database: 270 ms for the first 4,000 rows before,
-- 103 ms for all 9,022 after. Reading twice as much, faster.
CREATE INDEX IF NOT EXISTS content_last_seen_idx ON content (last_seen_at DESC);
