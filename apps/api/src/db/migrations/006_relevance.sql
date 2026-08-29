-- How well an item matches what the user actually makes.
--
-- Stored rather than computed per request: the comparison itself is a dot
-- product and cheap, but doing it for every row of every page means loading
-- every vector on every page. Written once by the analysis pass, it becomes a
-- plain column the ranked query can filter and sort on like any other.
--
-- NULL means "not scored" and is never treated as zero: with no interests
-- configured, or before the item has a vector, the honest answer is that we do
-- not know rather than that it is irrelevant.
ALTER TABLE content_scores ADD COLUMN relevance REAL;

CREATE INDEX content_scores_relevance_idx
  ON content_scores (relevance DESC) WHERE relevance IS NOT NULL;
