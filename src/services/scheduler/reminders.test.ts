import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import Database from 'better-sqlite3';
import { ReminderService } from './reminders.ts';
import { SchedulerService } from './scheduler.ts';
import type { ForgeConfig } from '../../types.ts';
import type { CompletedTurn } from '../chat-turn.ts';

const TOOLS_SCHEMA = fs.readFileSync(new URL('../../db/schemas/tools.sql', import.meta.url), 'utf-8');
const MESSAGES_SCHEMA = fs.readFileSync(new URL('../../db/schemas/messages.sql', import.meta.url), 'utf-8');

const DAY_MS = 24 * 60 * 60 * 1000;

function config(options: { schedulerEnabled?: boolean; telegramChatIds?: Array<string | number> } = {}): ForgeConfig {
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
    scheduler: { enabled: options.schedulerEnabled ?? false, jobs: [] },
    ...(options.telegramChatIds ? {
      channels: {
        telegram: {
          enabled: true,
          token_env: 'FORGE_TELEGRAM_TOKEN',
          api_base_url: 'https://api.telegram.org',
          poll_timeout_s: 30,
          allowed_chat_ids: options.telegramChatIds,
        },
      },
    } : {}),
  };
}

function toolsDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(TOOLS_SCHEMA);
  return db;
}

function messagesDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(MESSAGES_SCHEMA);
  return db;
}

function completed(reply: string): CompletedTurn {
  return {
    reply,
    replyId: 'scheduler:assistant:x',
    replyTs: '1',
    response: { content: reply, provider: 'ollama', model: 'local-model', inputTokens: 1, outputTokens: 1 },
    sources: [],
    context: { estimatedPromptTokens: 10, promptBudgetTokens: 100, includedHistoryMessages: 0, omittedHistoryMessages: 0 },
    promptContext: null,
  };
}

function reminderRows(db: Database.Database): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM reminders ORDER BY due_at_ms').all() as Array<Record<string, unknown>>;
}

function runsIn(db: Database.Database): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM scheduler_runs ORDER BY id').all() as Array<Record<string, unknown>>;
}

const quietLogger = { log: () => {}, warn: () => {} };

// --- ReminderService ---------------------------------------------------------------

test('reminder create validates message and due time with clear errors', () => {
  const db = toolsDb();
  const now = 1_800_000_000_000;
  const service = new ReminderService({ db, now: () => now });

  assert.throws(() => service.create({ message: '   ', dueAtMs: now + 60_000 }), /must not be empty/);
  assert.throws(() => service.create({ message: 'x'.repeat(501), dueAtMs: now + 60_000 }), /too long/);
  assert.throws(() => service.create({ message: 'past', dueAtMs: now - 1000 }), /in the past/);
  assert.throws(() => service.create({ message: 'too far', dueAtMs: now + 366 * DAY_MS }), /more than 365 days/);
  assert.throws(() => service.create({ message: 'bad time', dueAtMs: Number.NaN }), /not a valid timestamp/);

  const created = service.create({ message: '  water the plants  ', dueAtMs: now + 60_000 });
  assert.ok(created.id.length > 0);
  assert.equal(created.message, 'water the plants');
  assert.equal(created.dueAtMs, now + 60_000);
  db.close();
});

test('listPending, duePending, cancel, markSent, and markError manage the lifecycle', () => {
  const db = toolsDb();
  const now = 1_800_000_000_000;
  const service = new ReminderService({ db, now: () => now });

  const later = service.create({ message: 'later', dueAtMs: now + 120_000 });
  const soon = service.create({ message: 'soon', dueAtMs: now + 30_000 });

  const pending = service.listPending();
  assert.deepEqual(pending.map(r => r.message), ['soon', 'later']); // ordered by due time
  assert.ok(pending.every(r => r.status === 'pending'));

  assert.deepEqual(service.duePending(now + 30_000).map(r => r.id), [soon.id]);
  assert.deepEqual(service.duePending(now).map(r => r.id), []);

  assert.equal(service.cancel(later.id), true);
  assert.equal(service.cancel(later.id), false, 'cancelling twice must fail');
  assert.equal(service.cancel('nonexistent'), false);

  service.markSent(soon.id);
  assert.deepEqual(service.listPending(), []);

  const third = service.create({ message: 'third', dueAtMs: now + 60_000 });
  service.markError(third.id, 'delivery exploded');

  const rows = reminderRows(db);
  const byId = new Map(rows.map(r => [r.id, r]));
  assert.equal(byId.get(soon.id)?.status, 'sent');
  assert.ok(byId.get(soon.id)?.sent_at);
  assert.equal(byId.get(later.id)?.status, 'cancelled');
  assert.equal(byId.get(third.id)?.status, 'error');
  assert.equal(byId.get(third.id)?.error, 'delivery exploded');
  db.close();
});

// --- scheduler delivery --------------------------------------------------------------

test('tick delivers a due reminder to the feed and Telegram even with the scheduler disabled', async () => {
  const db = toolsDb();
  const msgDb = messagesDb();
  const reminders = new ReminderService({ db });
  const created = reminders.create({ message: 'stand-up meeting', dueAtMs: Date.now() + 60_000 });

  const deliveries: Array<{ chatId?: string; text: string }> = [];
  const scheduler = new SchedulerService({
    config: config({ schedulerEnabled: false, telegramChatIds: ['777', '888'] }),
    chatTurn: { async runTurn() { throw new Error('cron must not fire'); } },
    deliveries: { telegram: async (chatId, text) => { deliveries.push({ chatId, text }); } },
    db,
    reminders,
    messagesDb: msgDb,
    logger: quietLogger,
  });
  scheduler.start();
  scheduler.stop(); // no live timer in tests; drive tick() directly

  // Before the due time: nothing happens.
  await scheduler.tick(new Date(Date.now() + 1000));
  assert.equal(deliveries.length, 0);
  assert.equal(reminders.listPending().length, 1);
  assert.equal(runsIn(db).length, 0);

  // After the due time: feed row + telegram to the first allowlisted chat + sent + run log.
  await scheduler.tick(new Date(Date.now() + 120_000));

  assert.deepEqual(deliveries, [{ chatId: '777', text: '⏰ Reminder: stand-up meeting' }]);
  assert.equal(reminders.listPending().length, 0);
  assert.equal(reminderRows(db)[0].status, 'sent');

  const messages = msgDb.prepare('SELECT * FROM messages').all() as Array<Record<string, unknown>>;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, `scheduler:reminder:${created.id}`);
  assert.equal(messages[0].channel, 'scheduler');
  assert.equal(messages[0].channelName, 'reminders');
  assert.equal(messages[0].userName, 'forge-local');
  assert.equal(messages[0].text, '⏰ Reminder: stand-up meeting');

  const runs = runsIn(db);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].job_name, 'reminder');
  assert.equal(runs[0].status, 'ok');
  assert.equal(runs[0].delivered, 1);
  assert.match(String(runs[0].detail), /stand-up meeting/);

  // Already sent: a later tick must not re-deliver.
  await scheduler.tick(new Date(Date.now() + 240_000));
  assert.equal(deliveries.length, 1);
  db.close();
  msgDb.close();
});

test('a reminder without Telegram still lands in the feed and is marked sent (not delivered)', async () => {
  const db = toolsDb();
  const msgDb = messagesDb();
  const reminders = new ReminderService({ db });
  reminders.create({ message: 'feed only', dueAtMs: Date.now() + 60_000 });

  const scheduler = new SchedulerService({
    config: config({ schedulerEnabled: false }),
    chatTurn: { async runTurn() { return completed('x'); } },
    db,
    reminders,
    messagesDb: msgDb,
    logger: quietLogger,
  });
  scheduler.start();
  scheduler.stop();

  await scheduler.tick(new Date(Date.now() + 120_000));

  assert.equal(reminderRows(db)[0].status, 'sent');
  const messages = msgDb.prepare('SELECT * FROM messages').all() as Array<Record<string, unknown>>;
  assert.equal(messages.length, 1);
  const [run] = runsIn(db);
  assert.equal(run.status, 'ok');
  assert.equal(run.delivered, 0);
  db.close();
  msgDb.close();
});

test('a failing Telegram delivery marks the reminder error and logs it, never throws', async () => {
  const db = toolsDb();
  const msgDb = messagesDb();
  const reminders = new ReminderService({ db });
  reminders.create({ message: 'doomed', dueAtMs: Date.now() + 60_000 });

  const scheduler = new SchedulerService({
    config: config({ schedulerEnabled: false, telegramChatIds: ['777'] }),
    chatTurn: { async runTurn() { return completed('x'); } },
    deliveries: { telegram: async () => { throw new Error('telegram is down'); } },
    db,
    reminders,
    messagesDb: msgDb,
    logger: quietLogger,
  });
  scheduler.start();
  scheduler.stop();

  await scheduler.tick(new Date(Date.now() + 120_000));

  const [row] = reminderRows(db);
  assert.equal(row.status, 'error');
  assert.match(String(row.error), /telegram is down/);
  const [run] = runsIn(db);
  assert.equal(run.job_name, 'reminder');
  assert.equal(run.status, 'error');
  assert.equal(run.delivered, 0);
  db.close();
  msgDb.close();
});

test('start begins ticking for reminders even when scheduler.enabled is false', () => {
  const db = toolsDb();
  const withReminders = new SchedulerService({
    config: config({ schedulerEnabled: false }),
    chatTurn: { async runTurn() { return completed('x'); } },
    db,
    reminders: new ReminderService({ db }),
    logger: quietLogger,
  });
  withReminders.start();
  assert.notEqual((withReminders as unknown as { timer: unknown }).timer, null, 'timer should run for reminders');
  withReminders.stop();

  const without = new SchedulerService({
    config: config({ schedulerEnabled: false }),
    chatTurn: { async runTurn() { return completed('x'); } },
    db,
    logger: quietLogger,
  });
  without.start();
  assert.equal((without as unknown as { timer: unknown }).timer, null, 'no timer without cron jobs or reminders');
  without.stop();
  db.close();
});
