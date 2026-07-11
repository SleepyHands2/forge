CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('pdf', 'md', 'txt', 'csv')),
  size INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('ready', 'failed')),
  error TEXT,
  created TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  embedding_model TEXT,
  embedding_revision TEXT NOT NULL DEFAULT '',
  dimensions INTEGER,
  vector BLOB,
  created TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_document_chunks_document ON document_chunks (document_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_documents_created ON documents (created DESC);
