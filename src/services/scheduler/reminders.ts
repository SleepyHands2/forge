import crypto from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';

type Database = BetterSqlite3.Database;

const MAX_MESSAGE_CHARS = 500;
const MAX_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

export type ReminderStatus = 'pending' | 'sent' | 'cancelled' | 'error';

export interface Reminder {
  id: string;
  message: string;
  dueAtMs: number;
  status: ReminderStatus;
}

export interface ReminderServiceOptions {
  /** tools.db handle; the reminders table lives next to the scheduler_runs log. */
  db: Database;
  now?: () => number;
}

interface ReminderRow {
  id: string;
  message: string;
  due_at_ms: number;
  status: ReminderStatus;
}

/**
 * Durable one-shot reminders. Creation validates aggressively (non-empty,
 * bounded message; a due time in the future but no more than a year out) so a
 * confused model call cannot park garbage in the table. Delivery is the
 * scheduler's job: it polls duePending() every tick and moves each reminder
 * to 'sent' or 'error' exactly once.
 */
export class ReminderService {
  private readonly db: Database;
  private readonly now: () => number;

  constructor(options: ReminderServiceOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => Date.now());
  }

  create(input: { message: string; dueAtMs: number }): { id: string; message: string; dueAtMs: number } {
    const message = String(input.message ?? '').trim();
    if (!message) {
      throw new Error('Reminder message must not be empty.');
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      throw new Error(`Reminder message is too long (${message.length} chars; max ${MAX_MESSAGE_CHARS}).`);
    }
    const dueAtMs = input.dueAtMs;
    if (!Number.isFinite(dueAtMs)) {
      throw new Error('Reminder due time is not a valid timestamp.');
    }
    const nowMs = this.now();
    if (dueAtMs <= nowMs) {
      throw new Error(`Reminder due time ${new Date(dueAtMs).toString()} is in the past.`);
    }
    if (dueAtMs > nowMs + MAX_AHEAD_MS) {
      throw new Error('Reminder due time is more than 365 days ahead.');
    }

    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO reminders (id, message, due_at_ms) VALUES (?, ?, ?)
    `).run(id, message, Math.floor(dueAtMs));
    return { id, message, dueAtMs: Math.floor(dueAtMs) };
  }

  listPending(): Reminder[] {
    const rows = this.db.prepare(`
      SELECT id, message, due_at_ms, status FROM reminders
      WHERE status = 'pending' ORDER BY due_at_ms ASC
    `).all() as ReminderRow[];
    return rows.map(toReminder);
  }

  /** Cancels a pending reminder. Returns false when no pending row matched. */
  cancel(id: string): boolean {
    const result = this.db.prepare(`
      UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status = 'pending'
    `).run(id);
    return result.changes > 0;
  }

  duePending(nowMs: number): Reminder[] {
    const rows = this.db.prepare(`
      SELECT id, message, due_at_ms, status FROM reminders
      WHERE status = 'pending' AND due_at_ms <= ? ORDER BY due_at_ms ASC
    `).all(nowMs) as ReminderRow[];
    return rows.map(toReminder);
  }

  markSent(id: string): void {
    this.db.prepare(`
      UPDATE reminders SET status = 'sent', sent_at = ? WHERE id = ?
    `).run(new Date(this.now()).toISOString(), id);
  }

  markError(id: string, message: string): void {
    this.db.prepare(`
      UPDATE reminders SET status = 'error', error = ? WHERE id = ?
    `).run(message, id);
  }
}

function toReminder(row: ReminderRow): Reminder {
  return { id: row.id, message: row.message, dueAtMs: row.due_at_ms, status: row.status };
}
