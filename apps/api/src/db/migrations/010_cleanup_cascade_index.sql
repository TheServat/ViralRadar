-- Retention deletes from `content`, and every child table has to follow.
-- `creator_breakouts` could not: its only index on content_id is the second
-- column of UNIQUE (creator_id, content_id), which SQLite cannot seek on, so
-- the cascade scanned the whole table once per deleted row.
--
-- Harmless at today's thousand rows and not at the tens of thousands a full
-- retention window holds — and it is on the path that only ever runs when the
-- database has already grown, which is the worst time to discover it.
CREATE INDEX IF NOT EXISTS creator_breakouts_content_idx
  ON creator_breakouts (content_id);
