-- What a thumbnail looks like, as numbers.
--
-- Kept apart from content_scores because it describes the item's *image*, not
-- its performance, and because it is expensive to obtain: each row costs a
-- download and a decode, so it is written once and never recomputed unless the
-- thumbnail URL itself changes.
--
-- Every column is nullable on purpose. Dimensions and density come from the
-- file header and are always available; brightness and the rest need a decoder
-- that may not be installed. A row with half its columns filled is the normal
-- state on a machine without ffmpeg, and the analysis reports on whatever it
-- actually has.
CREATE TABLE content_media (
  content_id  TEXT    PRIMARY KEY REFERENCES content (id) ON DELETE CASCADE,
  -- The URL these numbers describe, so a changed thumbnail is re-read.
  source_url  TEXT    NOT NULL,
  width       INTEGER,
  height      INTEGER,
  bytes       INTEGER,
  density     REAL,                    -- compressed bytes per pixel: visual busyness
  brightness  REAL,
  contrast    REAL,
  saturation  REAL,
  warmth      REAL,
  skin        REAL,                    -- crude "is a person in frame"
  fetched_at  INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX content_media_fetched_idx ON content_media (fetched_at DESC);
