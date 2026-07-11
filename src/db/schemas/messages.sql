CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  channelName TEXT,
  user TEXT,
  userName TEXT,
  text TEXT NOT NULL DEFAULT '',
  ts TEXT NOT NULL,
  threadTs TEXT,
  mentioned INTEGER DEFAULT 0,
  receivedAt INTEGER NOT NULL,
  prompt_context TEXT,
  llm_metadata TEXT,
  subtype TEXT
);

CREATE TABLE IF NOT EXISTS annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  annotation_type TEXT NOT NULL CHECK(annotation_type IN ('note', 'pin', 'flag', 'bookmark')),
  content TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  FOREIGN KEY (message_id) REFERENCES messages(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (channel);
CREATE INDEX IF NOT EXISTS idx_messages_receivedAt ON messages (receivedAt DESC);
CREATE INDEX IF NOT EXISTS idx_annotations_message ON annotations(message_id);
CREATE INDEX IF NOT EXISTS idx_annotations_type ON annotations(annotation_type);

CREATE TABLE IF NOT EXISTS identity_proposals (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL CHECK(filename IN ('IDENTITY.md', 'SOUL.md', 'USER.md')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  reason TEXT NOT NULL,
  normalized_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT,
  rejected_at TEXT,
  applied_hash TEXT
);

CREATE TABLE IF NOT EXISTS identity_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  filename TEXT,
  proposal_id TEXT,
  normalized_hash TEXT,
  preview TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  metadata TEXT,
  FOREIGN KEY (proposal_id) REFERENCES identity_proposals(id)
);

CREATE INDEX IF NOT EXISTS idx_identity_proposals_status_created ON identity_proposals(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_identity_proposals_hash ON identity_proposals(normalized_hash);
CREATE INDEX IF NOT EXISTS idx_identity_events_created ON identity_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_identity_events_type ON identity_events(event_type);

-- Rolling per-conversation digest of turns that fell out of the sliding
-- history window. One row per (channel, channelName) scope; covered_until_ms
-- is the receivedAt watermark of the newest summarized message.
CREATE TABLE IF NOT EXISTS conversation_summaries (
  channel TEXT NOT NULL,
  channelName TEXT NOT NULL,
  summary TEXT NOT NULL,
  covered_until_ms INTEGER NOT NULL,
  updated TEXT NOT NULL,
  PRIMARY KEY (channel, channelName)
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text,
  userName,
  channelName,
  id,
  channel,
  ts,
  receivedAt
);

DROP TRIGGER IF EXISTS messages_fts_insert;
DROP TRIGGER IF EXISTS messages_fts_delete;
DROP TRIGGER IF EXISTS messages_fts_update;

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(text, userName, channelName, id, channel, ts, receivedAt)
  VALUES (new.text, new.userName, new.channelName, new.id, new.channel, new.ts, new.receivedAt);
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE id = old.id;
END;

CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages BEGIN
  DELETE FROM messages_fts WHERE id = old.id;
  INSERT INTO messages_fts(text, userName, channelName, id, channel, ts, receivedAt)
  VALUES (new.text, new.userName, new.channelName, new.id, new.channel, new.ts, new.receivedAt);
END;
