import type BetterSqlite3 from 'better-sqlite3';
import type { ToolPermission } from '../../types.ts';

type Database = BetterSqlite3.Database;

const MAX_ARGS_SUMMARY = 500;
const MAX_ERROR_LENGTH = 500;

export interface ToolCallLogEntry {
  toolName: string;
  permission: ToolPermission | 'unknown';
  args: unknown;
  allowed: boolean;
  deniedReason?: string;
  ok?: boolean;
  error?: string;
  durationMs?: number;
  iteration?: number;
  messageId?: string;
}

/**
 * Audit log for every tool call the agent loop sees — allowed or denied,
 * successful or failed. Denials are the interesting audit signal, so they are
 * logged with the same fidelity as executions. Logging failures are swallowed
 * (warned) so a full disk can never take the chat path down.
 */
export class ToolCallLog {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  record(entry: ToolCallLogEntry): void {
    try {
      this.db.prepare(`
        INSERT INTO tool_calls (tool_name, permission, args_summary, allowed, denied_reason, ok, error, duration_ms, iteration, message_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.toolName,
        entry.permission,
        summarizeArgs(entry.args),
        entry.allowed ? 1 : 0,
        entry.deniedReason ?? null,
        entry.ok === undefined ? null : (entry.ok ? 1 : 0),
        entry.error === undefined ? null : entry.error.slice(0, MAX_ERROR_LENGTH),
        entry.durationMs ?? null,
        entry.iteration ?? null,
        entry.messageId ?? null,
      );
    } catch (err) {
      console.warn('[tools] Failed to write tool call log:', err instanceof Error ? err.message : String(err));
    }
  }
}

function summarizeArgs(args: unknown): string {
  if (args === undefined) return '';
  try {
    const json = JSON.stringify(args);
    if (typeof json !== 'string') return '';
    return json.length > MAX_ARGS_SUMMARY ? `${json.slice(0, MAX_ARGS_SUMMARY)}…` : json;
  } catch {
    return '[unserializable]';
  }
}
