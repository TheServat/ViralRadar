-- Which seed word found this item.
--
-- Open discovery needs *some* query string, so it uses a rotating list of very
-- broad seed words. Which of them actually surface things that go on to matter
-- was never recorded, so every word was rotated equally for ever and a dead one
-- kept costing 100 quota units a turn.
--
-- Recorded on the item rather than aggregated, because the yield of a word is
-- only knowable after the items it found have been scored - which happens
-- hours later, and against data this column is the only link back to.
ALTER TABLE content ADD COLUMN discovery_term TEXT;

CREATE INDEX content_discovery_term_idx
  ON content (source, discovery_term) WHERE discovery_term IS NOT NULL;
