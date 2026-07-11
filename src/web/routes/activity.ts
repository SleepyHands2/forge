import { Router } from 'express';
import type { WebContext } from '../server.ts';

const MAX_LIST_LIMIT = 200;
const DEFAULT_TOOLS_LIMIT = 100;
const DEFAULT_RUNS_LIMIT = 50;
const RECENT_REMINDERS_LIMIT = 20;

interface ToolCallRow {
  id: number;
  tool_name: string;
  permission: string;
  args_summary: string;
  allowed: number;
  denied_reason: string | null;
  ok: number | null;
  error: string | null;
  duration_ms: number | null;
  iteration: number | null;
  message_id: string | null;
  created_at: string;
}

interface SchedulerRunRow {
  id: number;
  job_name: string;
  status: string;
  detail: string | null;
  duration_ms: number | null;
  delivered: number;
  created_at: string;
}

interface ReminderRow {
  id: string;
  message: string;
  due_at_ms: number;
  status: string;
  error: string | null;
  created_at: string;
  sent_at: string | null;
}

/**
 * Activity audit API: every tool call the agent made (allowed or denied),
 * every scheduled job run, and the reminder queue — a read-only window into
 * what the agent actually did.
 */
export function activityRoutes(ctx: WebContext): Router {
  const router = Router();

  router.get('/tools', (req, res) => {
    const limit = parseLimit(req.query.limit, DEFAULT_TOOLS_LIMIT);
    if (limit === null) {
      res.status(400).json({ error: `limit must be an integer between 1 and ${MAX_LIST_LIMIT}` });
      return;
    }
    const db = ctx.dbManager.get('tools');
    const rows = db.prepare(`
      SELECT * FROM tool_calls ORDER BY id DESC LIMIT ?
    `).all(limit) as ToolCallRow[];

    res.json({
      calls: rows.map(row => ({
        id: row.id,
        toolName: row.tool_name,
        permission: row.permission,
        argsSummary: row.args_summary,
        allowed: row.allowed === 1,
        deniedReason: row.denied_reason,
        ok: row.ok === null ? null : row.ok === 1,
        error: row.error,
        durationMs: row.duration_ms,
        iteration: row.iteration,
        messageId: row.message_id,
        createdAt: row.created_at,
      })),
    });
  });

  router.get('/runs', (req, res) => {
    const limit = parseLimit(req.query.limit, DEFAULT_RUNS_LIMIT);
    if (limit === null) {
      res.status(400).json({ error: `limit must be an integer between 1 and ${MAX_LIST_LIMIT}` });
      return;
    }
    const db = ctx.dbManager.get('tools');
    const rows = db.prepare(`
      SELECT * FROM scheduler_runs ORDER BY id DESC LIMIT ?
    `).all(limit) as SchedulerRunRow[];

    res.json({
      runs: rows.map(row => ({
        id: row.id,
        jobName: row.job_name,
        status: row.status,
        detail: row.detail,
        durationMs: row.duration_ms,
        delivered: row.delivered === 1,
        createdAt: row.created_at,
      })),
    });
  });

  router.get('/reminders', (_req, res) => {
    const db = ctx.dbManager.get('tools');
    const pending = db.prepare(`
      SELECT * FROM reminders WHERE status = 'pending' ORDER BY due_at_ms ASC
    `).all() as ReminderRow[];
    const recent = db.prepare(`
      SELECT * FROM reminders WHERE status != 'pending' ORDER BY created_at DESC LIMIT ?
    `).all(RECENT_REMINDERS_LIMIT) as ReminderRow[];

    res.json({
      pending: pending.map(mapReminder),
      recent: recent.map(mapReminder),
    });
  });

  return router;
}

function mapReminder(row: ReminderRow) {
  return {
    id: row.id,
    message: row.message,
    dueAt: new Date(row.due_at_ms).toISOString(),
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

function parseLimit(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= MAX_LIST_LIMIT ? parsed : null;
}
