-- The creator history query filters by (source, author_id) and orders by
-- first_seen_at. Without this index SQLite has only (source, first_seen_at),
-- which satisfies the ordering and then tests author_id as a residual on every
-- row of the source — a full scan of the source per creator, 1,462 times per
-- analysis pass.
--
-- Measured on a 198 MB live database: 28,340 ms for one pass before, 180 ms
-- after. The statistics alone are enough to flip the plan, but a decision this
-- expensive should not depend on them being fresh, and this index is picked
-- unconditionally because it serves both the equality and the ORDER BY.
CREATE INDEX IF NOT EXISTS content_author_seen_idx
  ON content (source, author_id, first_seen_at DESC);
