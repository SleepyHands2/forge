import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3';
import { activityRoutes } from './activity.ts';
import type { ForgeConfig } from '../../types.ts';

const SCHEMA = fs.readFileSync(new URL('../../db/schemas/tools.sql', import.meta.url), 'utf-8');

function config(): ForgeConfig {
  return {
    forge: { name: 'forge-local', version: '0.1.0', root: '.' },
    user: { name: 'tester' },
    llm: {
      provider: 'ollama',
      model: 'local-model',
      ollama: { base_url: 'http://localhost:11434', keep_alive: '10m', options: {} },
    },
    paths: { dbs: './dbs', identity: './identity', logs: './logs' },
    services: { web: { host: '127.0.0.1', port: 6800, context_window_tokens: 80000, debug_prompt_context: false } },
    memory: {
      retention_days: 30,
      auto: { enabled: false, max_per_turn: 3, dedupe_similarity: 0.92 },
    },
  };
}

function setup() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  const app = express();
  app.use(express.json());
  app.use('/api/activity', activityRoutes({
    config: config(),
    dbManager: { get: () => db },
  } as never));
  return { db, app };
}

async function withServer(app: express.Express, fn: (url: string) => Promise<void>): Promise<void> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
}

test('GET /api/activity/tools lists tool calls newest-first with camelCase mapping and boolean coercion', async () => {
  const { db, app } = setup();
  const insert = db.prepare(`
    INSERT INTO tool_calls (tool_name, permission, args_summary, allowed, denied_reason, ok, error, duration_ms, iteration, message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('read_file', 'read', 'path=notes.md', 1, null, 1, null, 42, 1, 'web:assistant:1');
  insert.run('run_shell', 'execute', 'cmd=rm -rf /', 0, 'Denied by permission level', null, null, null, 2, 'web:assistant:1');
  insert.run('web_search', 'network', 'query=weather', 1, null, 0, 'timeout after 10s', 10000, 1, 'web:assistant:2');

  await withServer(app, async (url) => {
    const data = await (await fetch(`${url}/api/activity/tools`)).json() as {
      calls: Array<{
        id: number; toolName: string; permission: string; argsSummary: string;
        allowed: boolean; deniedReason: string | null; ok: boolean | null;
        error: string | null; durationMs: number | null; iteration: number | null;
        messageId: string | null; createdAt: string;
      }>;
    };
    assert.equal(data.calls.length, 3);
    // Newest first.
    assert.deepEqual(data.calls.map(c => c.toolName), ['web_search', 'run_shell', 'read_file']);

    const failed = data.calls[0];
    assert.equal(failed.allowed, true);
    assert.equal(failed.ok, false);
    assert.equal(failed.error, 'timeout after 10s');
    assert.equal(failed.durationMs, 10000);

    const denied = data.calls[1];
    assert.equal(denied.allowed, false);
    assert.equal(denied.deniedReason, 'Denied by permission level');
    assert.equal(denied.ok, null);
    assert.equal(denied.argsSummary, 'cmd=rm -rf /');
    assert.equal(denied.permission, 'execute');
    assert.equal(denied.iteration, 2);
    assert.equal(denied.messageId, 'web:assistant:1');

    const succeeded = data.calls[2];
    assert.equal(succeeded.allowed, true);
    assert.equal(succeeded.ok, true);
    assert.equal(succeeded.error, null);
    assert.equal(typeof succeeded.createdAt, 'string');
    assert.equal(typeof succeeded.id, 'number');
  });
  db.close();
});

test('GET /api/activity/tools rejects invalid limits and honors valid ones', async () => {
  const { db, app } = setup();
  const insert = db.prepare(`
    INSERT INTO tool_calls (tool_name, permission, allowed) VALUES (?, 'read', 1)
  `);
  insert.run('first');
  insert.run('second');

  await withServer(app, async (url) => {
    for (const bad of ['0', '-1', 'abc', '1.5', '201']) {
      const res = await fetch(`${url}/api/activity/tools?limit=${bad}`);
      assert.equal(res.status, 400, `limit=${bad} should be rejected`);
      const body = await res.json() as { error: string };
      assert.equal(body.error, 'limit must be an integer between 1 and 200');
    }

    const limited = await (await fetch(`${url}/api/activity/tools?limit=1`)).json() as { calls: Array<{ toolName: string }> };
    assert.deepEqual(limited.calls.map(c => c.toolName), ['second']);
  });
  db.close();
});

test('GET /api/activity/runs lists scheduler runs newest-first with delivered boolean', async () => {
  const { db, app } = setup();
  const insert = db.prepare(`
    INSERT INTO scheduler_runs (job_name, status, detail, duration_ms, delivered)
    VALUES (?, ?, ?, ?, ?)
  `);
  insert.run('morning-brief', 'ok', 'Sent summary.', 1200, 1);
  insert.run('morning-brief', 'skipped', 'Previous run still in progress.', null, 0);
  insert.run('nightly-reflect', 'error', 'LLM unreachable.', 300, 0);

  await withServer(app, async (url) => {
    const data = await (await fetch(`${url}/api/activity/runs`)).json() as {
      runs: Array<{
        id: number; jobName: string; status: string; detail: string | null;
        durationMs: number | null; delivered: boolean; createdAt: string;
      }>;
    };
    assert.equal(data.runs.length, 3);
    // Newest first.
    assert.deepEqual(data.runs.map(r => r.status), ['error', 'skipped', 'ok']);

    assert.equal(data.runs[0].jobName, 'nightly-reflect');
    assert.equal(data.runs[0].detail, 'LLM unreachable.');
    assert.equal(data.runs[0].durationMs, 300);
    assert.equal(data.runs[0].delivered, false);

    assert.equal(data.runs[1].delivered, false);
    assert.equal(data.runs[1].durationMs, null);

    assert.equal(data.runs[2].delivered, true);
    assert.equal(data.runs[2].jobName, 'morning-brief');
    assert.equal(typeof data.runs[2].createdAt, 'string');

    const bad = await fetch(`${url}/api/activity/runs?limit=999`);
    assert.equal(bad.status, 400);
  });
  db.close();
});

test('GET /api/activity/reminders splits pending (due ASC) from recent non-pending', async () => {
  const { db, app } = setup();
  const insert = db.prepare(`
    INSERT INTO reminders (id, message, due_at_ms, status, error, created_at, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const later = Date.UTC(2026, 6, 8, 15, 0, 0);
  const sooner = Date.UTC(2026, 6, 7, 9, 30, 0);
  insert.run('rem-later', 'Water the plants', later, 'pending', null, '2026-07-06T10:00:00.000Z', null);
  insert.run('rem-sooner', 'Stand-up meeting', sooner, 'pending', null, '2026-07-06T11:00:00.000Z', null);
  insert.run('rem-sent', 'Take out trash', Date.UTC(2026, 6, 5, 8, 0, 0), 'sent', null, '2026-07-04T08:00:00.000Z', '2026-07-05T08:00:01.000Z');
  insert.run('rem-cancelled', 'Old thing', Date.UTC(2026, 6, 4, 8, 0, 0), 'cancelled', null, '2026-07-03T08:00:00.000Z', null);
  insert.run('rem-error', 'Broken thing', Date.UTC(2026, 6, 6, 8, 0, 0), 'error', 'Telegram send failed', '2026-07-05T08:00:00.000Z', null);

  await withServer(app, async (url) => {
    const data = await (await fetch(`${url}/api/activity/reminders`)).json() as {
      pending: Array<{ id: string; message: string; dueAt: string; status: string; error: string | null; createdAt: string; sentAt: string | null }>;
      recent: Array<{ id: string; status: string; dueAt: string; error: string | null; sentAt: string | null }>;
    };

    // Pending ordered by due_at_ms ascending, regardless of insert order.
    assert.deepEqual(data.pending.map(r => r.id), ['rem-sooner', 'rem-later']);
    assert.equal(data.pending[0].message, 'Stand-up meeting');
    assert.equal(data.pending[0].dueAt, new Date(sooner).toISOString());
    assert.equal(data.pending[0].status, 'pending');
    assert.equal(data.pending[0].sentAt, null);
    assert.equal(data.pending[1].dueAt, new Date(later).toISOString());

    // Recent holds only non-pending rows.
    assert.equal(data.recent.length, 3);
    const recentIds = data.recent.map(r => r.id).sort();
    assert.deepEqual(recentIds, ['rem-cancelled', 'rem-error', 'rem-sent']);
    assert.ok(!data.recent.some(r => r.status === 'pending'));

    const sent = data.recent.find(r => r.id === 'rem-sent');
    assert.equal(sent?.sentAt, '2026-07-05T08:00:01.000Z');
    const errored = data.recent.find(r => r.id === 'rem-error');
    assert.equal(errored?.error, 'Telegram send failed');

    // Pending list excludes sent/cancelled rows even when their due time has passed.
    assert.ok(!data.pending.some(r => r.id === 'rem-sent' || r.id === 'rem-cancelled'));
  });
  db.close();
});
