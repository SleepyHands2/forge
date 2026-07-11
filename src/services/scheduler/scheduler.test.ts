import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import Database from 'better-sqlite3';
import { cronMatches, parseCron } from './cron.ts';
import { SchedulerService } from './scheduler.ts';
import type { ForgeConfig, SchedulerJobConfig } from '../../types.ts';
import type { TurnInput, CompletedTurn } from '../chat-turn.ts';

const TOOLS_SCHEMA = fs.readFileSync(new URL('../../db/schemas/tools.sql', import.meta.url), 'utf-8');

function config(jobs: SchedulerJobConfig[], enabled = true): ForgeConfig {
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
    scheduler: { enabled, jobs },
  };
}

function job(overrides: Partial<SchedulerJobConfig> = {}): SchedulerJobConfig {
  return {
    name: 'briefing',
    cron: '0 8 * * *',
    prompt: 'Give me a morning briefing.',
    channel: 'none',
    ...overrides,
  };
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

function toolsDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(TOOLS_SCHEMA);
  return db;
}

function runsIn(db: Database.Database): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM scheduler_runs ORDER BY id').all() as Array<Record<string, unknown>>;
}

const quietLogger = { log: () => {}, warn: () => {} };

// --- cron ----------------------------------------------------------------------

test('cron parses and matches lists, ranges, steps, and weekday semantics', () => {
  const eight = parseCron('0 8 * * *');
  assert.equal(cronMatches(eight, new Date(2026, 6, 3, 8, 0)), true);
  assert.equal(cronMatches(eight, new Date(2026, 6, 3, 8, 1)), false);
  assert.equal(cronMatches(eight, new Date(2026, 6, 3, 9, 0)), false);

  const workdays = parseCron('*/15 9-17 * * 1-5');
  assert.equal(cronMatches(workdays, new Date(2026, 6, 3, 9, 30)), true);   // Friday
  assert.equal(cronMatches(workdays, new Date(2026, 6, 3, 9, 20)), false);  // not a /15 minute
  assert.equal(cronMatches(workdays, new Date(2026, 6, 4, 9, 30)), false);  // Saturday
  assert.equal(cronMatches(workdays, new Date(2026, 6, 3, 18, 0)), false);  // after hours

  const listed = parseCron('5,35 0,12 1 1 *');
  assert.equal(cronMatches(listed, new Date(2026, 0, 1, 12, 35)), true);
  assert.equal(cronMatches(listed, new Date(2026, 1, 1, 12, 35)), false);   // wrong month

  // Sunday as 7 normalizes to 0.
  const sunday = parseCron('0 0 * * 7');
  assert.equal(cronMatches(sunday, new Date(2026, 6, 5, 0, 0)), true);      // a Sunday

  // Standard either-or when both day fields are restricted.
  const both = parseCron('0 0 15 * 1');
  assert.equal(cronMatches(both, new Date(2026, 6, 15, 0, 0)), true);       // the 15th (a Wednesday)
  assert.equal(cronMatches(both, new Date(2026, 6, 6, 0, 0)), true);        // a Monday
  assert.equal(cronMatches(both, new Date(2026, 6, 7, 0, 0)), false);       // neither

  assert.throws(() => parseCron('0 8 * *'), /5 fields/);
  assert.throws(() => parseCron('61 * * * *'), /out of range/);
  assert.throws(() => parseCron('a * * * *'), /Invalid cron minute/);
  assert.throws(() => parseCron('5-2 * * * *'), /reversed/);
});

// --- trigger -------------------------------------------------------------------

test('tick runs a matching job through the pipeline and logs it, and only fires once per minute', async () => {
  const turns: TurnInput[] = [];
  const db = toolsDb();
  const scheduler = new SchedulerService({
    config: config([job()]),
    chatTurn: {
      async runTurn(input: TurnInput) {
        turns.push(input);
        return completed('Your briefing.');
      },
    },
    db,
    logger: quietLogger,
  });
  scheduler.start();
  scheduler.stop(); // no live timer in tests; drive tick() directly

  const eightAm = new Date(2026, 6, 3, 8, 0, 5);
  await scheduler.tick(eightAm);
  await scheduler.tick(new Date(2026, 6, 3, 8, 0, 40)); // same minute: no re-fire
  await scheduler.tick(new Date(2026, 6, 3, 8, 1, 0));  // next minute: no cron match

  assert.equal(turns.length, 1);
  assert.equal(turns[0].channel, 'scheduler');
  assert.equal(turns[0].channelName, 'briefing');
  assert.equal(turns[0].content, 'Give me a morning briefing.');
  assert.match(turns[0].interfaceLabel, /Scheduled Job \(briefing\)/);

  const runs = runsIn(db);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].job_name, 'briefing');
  assert.equal(runs[0].status, 'ok');
  assert.equal(runs[0].delivered, 0);
  assert.match(String(runs[0].detail), /Your briefing/);
  db.close();
});

// --- one job at a time ----------------------------------------------------------

test('jobs matching the same minute run strictly one at a time, never in parallel', async () => {
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const scheduler = new SchedulerService({
    config: config([
      job({ name: 'job-a', cron: '0 8 * * *' }),
      job({ name: 'job-b', cron: '0 8 * * *' }),
      job({ name: 'job-c', cron: '0 8 * * *' }),
    ]),
    chatTurn: {
      async runTurn(input: TurnInput) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(input.channelName);
        await new Promise(resolve => setTimeout(resolve, 10));
        active -= 1;
        return completed(`done ${input.channelName}`);
      },
    },
    logger: quietLogger,
  });
  scheduler.start();
  scheduler.stop();

  await scheduler.tick(new Date(2026, 6, 3, 8, 0));

  assert.equal(maxActive, 1, 'jobs overlapped on the GPU');
  assert.deepEqual(order, ['job-a', 'job-b', 'job-c']);
});

test('a job whose previous run is still executing is skipped and logged, not queued', async () => {
  const db = toolsDb();
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let runs = 0;
  const scheduler = new SchedulerService({
    config: config([job({ name: 'slow', cron: '* * * * *' })]),
    chatTurn: {
      async runTurn() {
        runs += 1;
        await gate;
        return completed('finally done');
      },
    },
    db,
    logger: quietLogger,
  });
  scheduler.start();
  scheduler.stop();

  const firstTick = scheduler.tick(new Date(2026, 6, 3, 8, 0));
  await new Promise(resolve => setImmediate(resolve));
  await scheduler.tick(new Date(2026, 6, 3, 8, 1)); // fires while 'slow' still runs -> skip
  release();
  await firstTick;

  assert.equal(runs, 1);
  const logged = runsIn(db);
  assert.deepEqual(logged.map(r => r.status), ['skipped', 'ok']);
  assert.match(String(logged[0].detail), /still in progress/);
  db.close();
});

// --- delivery -------------------------------------------------------------------

test('job output is delivered to the configured channel and marked delivered', async () => {
  const db = toolsDb();
  const deliveries: Array<{ chatId?: string; text: string }> = [];
  const scheduler = new SchedulerService({
    config: config([job({ channel: 'telegram', chat_id: '777' })]),
    chatTurn: { async runTurn() { return completed('Morning update for you.'); } },
    deliveries: {
      telegram: async (chatId, text) => {
        deliveries.push({ chatId, text });
      },
    },
    db,
    logger: quietLogger,
  });
  scheduler.start();
  scheduler.stop();

  await scheduler.tick(new Date(2026, 6, 3, 8, 0));

  assert.deepEqual(deliveries, [{ chatId: '777', text: 'Morning update for you.' }]);
  const [run] = runsIn(db);
  assert.equal(run.status, 'ok');
  assert.equal(run.delivered, 1);
  db.close();
});

test('missing delivery channels and pipeline failures are logged as errors, never thrown', async () => {
  const db = toolsDb();
  const noBridge = new SchedulerService({
    config: config([job({ channel: 'telegram', chat_id: '777' })]),
    chatTurn: { async runTurn() { return completed('reply'); } },
    deliveries: {},
    db,
    logger: quietLogger,
  });
  noBridge.start();
  noBridge.stop();
  await noBridge.tick(new Date(2026, 6, 3, 8, 0));

  const failing = new SchedulerService({
    config: config([job({ name: 'broken', cron: '0 9 * * *' })]),
    chatTurn: { async runTurn() { throw new Error('ollama offline'); } },
    db,
    logger: quietLogger,
  });
  failing.start();
  failing.stop();
  await failing.tick(new Date(2026, 6, 3, 9, 0));

  const logged = runsIn(db);
  assert.equal(logged.length, 2);
  assert.equal(logged[0].status, 'error');
  assert.match(String(logged[0].detail), /No delivery available for channel 'telegram'/);
  assert.equal(logged[1].status, 'error');
  assert.match(String(logged[1].detail), /ollama offline/);
  db.close();
});

// --- guard rails ----------------------------------------------------------------

test('start validates cron expressions and duplicate names with clear errors', () => {
  const badCron = new SchedulerService({
    config: config([job({ cron: '99 * * * *' })]),
    chatTurn: { async runTurn() { return completed('x'); } },
    logger: quietLogger,
  });
  assert.throws(() => badCron.start(), /Scheduler job 'briefing'.*out of range/);

  const dupes = new SchedulerService({
    config: config([job(), job()]),
    chatTurn: { async runTurn() { return completed('x'); } },
    logger: quietLogger,
  });
  assert.throws(() => dupes.start(), /Duplicate scheduler job name/);
});

test('disabled scheduler or empty job list never runs anything', async () => {
  let ran = 0;
  const chatTurn = { async runTurn() { ran += 1; return completed('x'); } };

  const disabled = new SchedulerService({ config: config([job()], false), chatTurn, logger: quietLogger });
  disabled.start();
  await disabled.tick(new Date(2026, 6, 3, 8, 0));

  const empty = new SchedulerService({ config: config([]), chatTurn, logger: quietLogger });
  empty.start();
  await empty.tick(new Date(2026, 6, 3, 8, 0));

  assert.equal(ran, 0);
});
