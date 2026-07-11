CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  confidence REAL NOT NULL DEFAULT 1.0,
  importance REAL NOT NULL DEFAULT 0.5,
  accessCount INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  supersededBy TEXT
);

CREATE TABLE IF NOT EXISTS memory_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL,
  change_type TEXT NOT NULL,
  old_content TEXT,
  old_status TEXT,
  old_confidence REAL,
  old_tags TEXT,
  new_content TEXT,
  new_status TEXT,
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  changed_by TEXT DEFAULT 'system',
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_memories_type ON memories (type);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories (status);
CREATE INDEX IF NOT EXISTS idx_memories_type_status ON memories (type, status);
CREATE INDEX IF NOT EXISTS idx_history_memory ON memory_history(memory_id);
CREATE INDEX IF NOT EXISTS idx_history_type ON memory_history(change_type);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id,
  content,
  tags,
  tokenize='porter'
);

-- Audit log for automatic memory capture. Every extraction outcome is
-- recorded (created, duplicate, invalid, error) so a small local model's
-- mistakes are easy to review and prune.
CREATE TABLE IF NOT EXISTS memory_captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT,
  action TEXT NOT NULL CHECK(action IN ('created', 'duplicate', 'invalid', 'error')),
  content TEXT NOT NULL DEFAULT '',
  reason TEXT,
  similarity REAL,
  duplicate_of TEXT,
  source_message_id TEXT,
  source_preview TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_memory_captures_created ON memory_captures (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_captures_memory ON memory_captures (memory_id);

CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id TEXT NOT NULL,
  model TEXT NOT NULL,
  model_revision TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector BLOB NOT NULL,
  created TEXT NOT NULL,
  PRIMARY KEY (memory_id, model, model_revision),
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_embeddings_model
  ON memory_embeddings (model, model_revision, memory_id);
