-- Full-text search over titles and bodies.
--
-- The search was `LOWER(title) LIKE '%term%'`, which cannot use an index and
-- so scanned `content` in full — twice per request, because the count and the
-- page are built from the same WHERE clause. Measured on a 17,000-row
-- database: 278 ms for a search that matches nothing, and 852 ms of blocked
-- event loop to type "elections" one keystroke at a time, with no debounce
-- anywhere. `node:sqlite` is synchronous on the one thread, so that is the
-- API, the live stream and the scheduler all stopped, and the worse the search
-- term the longer the freeze.
--
-- FTS5 is built into SQLite, so this costs no dependency. External content:
-- the index stores only the tokens and points back at `content` by rowid,
-- rather than keeping a second copy of every title and body.
--
-- **The trigram tokenizer, not the default one.** That is the whole decision
-- here. A word tokenizer indexes words and matches them from the start, which
-- is faster and smaller and would have quietly broken search for this
-- application's audience: Arabic and Persian attach the article and most
-- prepositions to the following word, so `الانتخابات` is one token and a
-- search for `انتخابات` no longer finds it. Checked against the real database
-- — three of twenty-nine Arabic matches disappeared, and `trump` stopped
-- finding one item that had it inside a longer word.
--
-- Trigram indexes every three-character run, so `MATCH '"term"'` means exactly
-- what `LIKE '%term%'` meant. Same results, same case-insensitivity, without
-- the scan. It costs more disk than a word index, which is the right way round
-- for a tool that has to work in three languages.
CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(
  title,
  body,
  content = 'content',
  content_rowid = 'rowid',
  tokenize = "trigram remove_diacritics 1"
);

-- Kept in step by triggers rather than by remembering to write to both. The
-- 'delete' rows are how an external-content FTS5 table is told to forget: the
-- values must match what was indexed, which is why they read from `old`.
CREATE TRIGGER IF NOT EXISTS content_fts_insert AFTER INSERT ON content BEGIN
  INSERT INTO content_fts (rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS content_fts_delete AFTER DELETE ON content BEGIN
  INSERT INTO content_fts (content_fts, rowid, title, body)
    VALUES ('delete', old.rowid, old.title, old.body);
END;

CREATE TRIGGER IF NOT EXISTS content_fts_update AFTER UPDATE ON content BEGIN
  INSERT INTO content_fts (content_fts, rowid, title, body)
    VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO content_fts (rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

-- Everything already collected. 'rebuild' reads the content table itself, so
-- this is correct however much is already there.
INSERT INTO content_fts (content_fts) VALUES ('rebuild');
