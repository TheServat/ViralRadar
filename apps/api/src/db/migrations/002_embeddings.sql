-- Cached embeddings.
--
-- Embedding is the slowest thing in the pipeline by a wide margin, and the
-- vector for a title never changes, so it is computed once and kept. The model
-- name is part of the key: swapping models produces vectors that cannot be
-- compared with the old ones, and silently mixing the two would quietly corrupt
-- every similarity in the system.
--
-- Nothing here is required. With no embedding model configured this table stays
-- empty and clustering works exactly as it did before.
CREATE TABLE content_embeddings (
  content_id TEXT    NOT NULL REFERENCES content (id) ON DELETE CASCADE,
  model      TEXT    NOT NULL,
  dims       INTEGER NOT NULL,
  -- Float32 little-endian, already L2-normalised so similarity is a dot
  -- product rather than a division per comparison.
  vec        BLOB    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (content_id, model)
) WITHOUT ROWID;

CREATE INDEX content_embeddings_model_idx ON content_embeddings (model);
