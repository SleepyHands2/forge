import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createReminderTools } from './reminders.ts';
import { ReminderService } from '../scheduler/reminders.ts';
import type { ForgeConfig, ToolDef } from '../../types.ts';

const TOOLS_SCHEMA = fs.readFileSync(new URL('../../db/schemas/tools.sql', import.meta.url), 'utf-8');

function config(telegramChatIds?: Array<string | number>): ForgeConfig {
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
    memory: { retention_days: 30 },
    ...(telegramChatIds ? {
      channels: {
        telegram: {
          enabled: true,
          token_env: 'FORGE_TELEGRAM_TOKEN',
          api_base_url: 'https://api.telegram.org',
          poll_timeout_s: 30,
          allowed_chat_ids: telegramChatIds,
        },
      },
    } : {}),
  };
}

function setup(telegramChatIds?: Array<string | number>) {
  const db = new Database(':memory:');
  db.exec(TOOLS_SCHEMA);
  const reminders = new ReminderService({ db });
  const tools = createReminderTools({ config: config(telegramChatIds), reminders });
  const byName = new Map<string, ToolDef>(tools.map(tool => [tool.name, tool]));
  return { db, reminders, byName };
}

// --- set_reminder --------------------------------------------------------------------

test('set_reminder requires exactly one of at and in_minutes', async () => {
  const { db, byName } = setup();
  const tool = byName.get('set_reminder')!;
  assert.equal(tool.permission, 'sensitive');

  await assert.rejects(
    Promise.resolve(tool.handler({ message: 'x' })),
    /exactly one of 'at'.*'in_minutes'/,
  );
  await assert.rejects(
    Promise.resolve(tool.handler({ message: 'x', at: '2099-01-01T09:00', in_minutes: 5 })),
    /exactly one of 'at'.*'in_minutes'/,
  );
  db.close();
});

test('set_reminder rejects unparseable and past date-times with clear errors', async () => {
  const { db, byName } = setup();
  const tool = byName.get('set_reminder')!;

  await assert.rejects(
    Promise.resolve(tool.handler({ message: 'x', at: 'tomorrow-ish' })),
    /'tomorrow-ish' is not a valid ISO 8601 date-time/,
  );
  await assert.rejects(
    Promise.resolve(tool.handler({ message: 'x', at: '2001-01-01T09:00' })),
    /parsed to .*2001.*in the past/,
  );
  db.close();
});

test('set_reminder creates a pending reminder from in_minutes and reports the delivery route', async () => {
  const { db, reminders, byName } = setup();
  const tool = byName.get('set_reminder')!;

  const before = Date.now();
  const result = await tool.handler({ message: 'stretch your legs', in_minutes: 30 }) as {
    id: string; message: string; due_at: string; delivery: string;
  };

  assert.equal(result.message, 'stretch your legs');
  assert.equal(result.delivery, 'web feed');
  const pending = reminders.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, result.id);
  assert.ok(pending[0].dueAtMs >= before + 30 * 60_000);
  assert.ok(pending[0].dueAtMs <= Date.now() + 30 * 60_000);
  db.close();
});

test('set_reminder accepts a future ISO date-time and reports telegram when configured', async () => {
  const { db, reminders, byName } = setup(['777']);
  const tool = byName.get('set_reminder')!;

  const at = new Date(Date.now() + 60 * 60_000).toISOString();
  const result = await tool.handler({ message: 'call the dentist', at }) as { id: string; delivery: string };

  assert.equal(result.delivery, 'telegram + web feed');
  assert.equal(reminders.listPending()[0].dueAtMs, new Date(at).getTime());
  db.close();
});

// --- list_reminders / cancel_reminder ------------------------------------------------

test('list_reminders returns pending reminders and an empty list without throwing', async () => {
  const { db, reminders, byName } = setup();
  const list = byName.get('list_reminders')!;
  assert.equal(list.permission, 'safe');

  assert.deepEqual(await list.handler({}), { reminders: [] });

  const created = reminders.create({ message: 'water plants', dueAtMs: Date.now() + 60_000 });
  const result = await list.handler({}) as { reminders: Array<{ id: string; message: string; due_at: string; status: string }> };
  assert.equal(result.reminders.length, 1);
  assert.equal(result.reminders[0].id, created.id);
  assert.equal(result.reminders[0].status, 'pending');
  db.close();
});

test('cancel_reminder cancels pending reminders and throws for unknown ids', async () => {
  const { db, reminders, byName } = setup();
  const cancel = byName.get('cancel_reminder')!;
  assert.equal(cancel.permission, 'sensitive');

  const created = reminders.create({ message: 'meeting', dueAtMs: Date.now() + 60_000 });
  const result = await cancel.handler({ id: created.id }) as { id: string; cancelled: boolean };
  assert.deepEqual(result, { id: created.id, cancelled: true });
  assert.equal(reminders.listPending().length, 0);

  await assert.rejects(
    Promise.resolve(cancel.handler({ id: created.id })),
    /No pending reminder with that id\./,
  );
  db.close();
});
