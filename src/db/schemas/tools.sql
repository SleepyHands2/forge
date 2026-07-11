CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name TEXT NOT NULL,
  permission TEXT NOT NULL,
  args_summary TEXT NOT NULL DEFAULT '',
  allowed INTEGER NOT NULL,
  denied_reason TEXT,
  ok INTEGER,
  error TEXT,
  duration_ms INTEGER,
  iteration INTEGER,
  message_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_created ON tool_calls (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls (tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_calls_allowed ON tool_calls (allowed);

-- Durable log of every scheduled job run (ok, error, or skipped-for-overlap).
CREATE TABLE IF NOT EXISTS scheduler_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ok', 'error', 'skipped')),
  detail TEXT,
  duration_ms INTEGER,
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_scheduler_runs_created ON scheduler_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduler_runs_job ON scheduler_runs (job_name);

-- One-shot reminders created in chat (set_reminder) and delivered by the
-- scheduler tick: always into the messages feed, plus Telegram when configured.
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  due_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','sent','cancelled','error')) DEFAULT 'pending',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (status, due_at_ms);
