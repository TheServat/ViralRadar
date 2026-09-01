-- The FTS update trigger fired on every UPDATE of `content`, including the
-- ones that cannot change what it indexes.
--
-- Both hot writers are such updates. `updateEnrichment` touches lang, country,
-- keywords, hashtags and simhash and never the text; the upsert's conflict
-- branch rewrites `title` with the identical value every time an item is seen
-- again. Each firing deletes and reinserts the row's trigram postings, which
-- for a trigram index is the expensive kind of write.
--
-- Measured on a copy of a real database: a reclassify sweep 6,700 ms against
-- 480 ms, a one-minute collect batch of 4,302 re-seen rows 1,399 ms against
-- 77 ms, and `content_fts_data` growing by a thousand blocks in a pass that
-- changed no text at all. Migration 011 justified itself by calling 852 ms of
-- blocked event loop unacceptable, then put more than that back on the collect
-- path, on the same thread, recurring.
--
-- `AFTER UPDATE OF title, body` does not help: SQLite fires on a column
-- appearing in SET whether or not the value changed, and the upsert always
-- sets title. The guard has to compare the values.
--
-- IS NOT rather than <>, so a NULL title on either side is handled: `<>` is
-- NULL for those and the trigger would silently stop firing.
DROP TRIGGER IF EXISTS content_fts_update;

CREATE TRIGGER content_fts_update AFTER UPDATE ON content
  WHEN old.title IS NOT new.title OR old.body IS NOT new.body
BEGIN
  INSERT INTO content_fts (content_fts, rowid, title, body)
    VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO content_fts (rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
