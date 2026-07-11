import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import Database from 'better-sqlite3';
import { ConversationSummaryService } from './conversation-summary.ts';
import type { ForgeConfig, LLMRequest, LLMResponse, MemorySummaryConfig } from '../types.ts';

const MESSAGES_SCHEMA = fs.readFileSync(new URL('../db/schemas/messages.sql', import.meta.url), 'utf-8');

function config(summary: Partial<MemorySummaryConfig> = {}): ForgeConfig {
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
      summary: { enabled: true, max_chars: 1200, batch_messages: 40, ...summary },
    },
  };
}

function messagesDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(MESSAGES_SCHEMA);
  return db;
}

function insertMessage(db: Database.Database, row: {
  id: string; channel?: string; channelName?: string; user?: string; text: string; receivedAt: number;
}): void {
  db.prepare(`
    INSERT INTO messages (id, channel, channelName, user, userName, text, ts, receivedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.channel ?? 'web',
    row.channelName ?? 'web',
    row.user ?? 'user',
    'tester',
    row.text,
    String(row.receivedAt),
    row.receivedAt,
  );
}

function stubLlm(reply: string | (() => string)) {
  const requests: LLMRequest[] = [];
  return {
    requests,
    async complete(request: LLMRequest): Promise<LLMResponse> {
      requests.push(request);
      const content = typeof reply === 'function' ? reply() : reply;
      return { content, provider: 'ollama', model: 'local-model', inputTokens: 1, outputTokens: 1 };
    },
  };
}

const silentLogger = { warn: () => {} };

test('updateAfterTurn summarizes only messages between the watermark and the window edge', async () => {
  const db = messagesDb();
  const llm = stubLlm('The user planned a garden and the assistant suggested tomatoes.');
  const service = new ConversationSummaryService({ db, config: config(), llm, logger: silentLogger });

  insertMessage(db, { id: 'm1', user: 'user', text: 'fell-out question about the garden', receivedAt: 10 });
  insertMessage(db, { id: 'm2', user: 'assistant', text: 'fell-out answer about tomatoes', receivedAt: 20 });
  insertMessage(db, { id: 'm3', user: 'system', text: 'system row must be excluded', receivedAt: 25 });
  insertMessage(db, { id: 'm4', user: 'user', text: '   ', receivedAt: 26 });
  insertMessage(db, { id: 'm5', user: 'user', text: 'still inside the window', receivedAt: 30 });
  insertMessage(db, { id: 'm6', user: 'user', text: 'other conversation', channelName: 'tg-1', channel: 'telegram', receivedAt: 15 });

  const result = await service.updateAfterTurn({ channel: 'web', channelName: 'web', oldestIncludedReceivedAt: 30 });

  assert.equal(result.status, 'updated');
  assert.equal(result.summarizedMessages, 2);
  assert.equal(llm.requests.length, 1);
  const prompt = llm.requests[0].messages[0].content;
  assert.match(prompt, /User: fell-out question about the garden/);
  assert.match(prompt, /Assistant: fell-out answer about tomatoes/);
  assert.match(prompt, /\(none\)/);
  assert.doesNotMatch(prompt, /still inside the window/);
  assert.doesNotMatch(prompt, /system row must be excluded/);
  assert.doesNotMatch(prompt, /other conversation/);
  db.close();
});

test('updateAfterTurn upserts and advances covered_until_ms across calls', async () => {
  const db = messagesDb();
  let reply = 'First digest.';
  const llm = stubLlm(() => reply);
  const service = new ConversationSummaryService({ db, config: config(), llm, logger: silentLogger });

  insertMessage(db, { id: 'm1', user: 'user', text: 'oldest turn', receivedAt: 10 });
  insertMessage(db, { id: 'm2', user: 'assistant', text: 'oldest reply', receivedAt: 20 });

  const first = await service.updateAfterTurn({ channel: 'web', channelName: 'web', oldestIncludedReceivedAt: 50 });
  assert.equal(first.status, 'updated');
  assert.deepEqual(service.getSummary('web', 'web'), { summary: 'First digest.', coveredUntilMs: 20 });

  insertMessage(db, { id: 'm3', user: 'user', text: 'newly fallen-out turn', receivedAt: 40 });
  reply = 'Second digest.';
  const second = await service.updateAfterTurn({ channel: 'web', channelName: 'web', oldestIncludedReceivedAt: 60 });

  assert.equal(second.status, 'updated');
  assert.equal(second.summarizedMessages, 1);
  const prompt = llm.requests[1].messages[0].content;
  assert.match(prompt, /First digest\./);
  assert.match(prompt, /User: newly fallen-out turn/);
  assert.doesNotMatch(prompt, /oldest turn/);
  assert.deepEqual(service.getSummary('web', 'web'), { summary: 'Second digest.', coveredUntilMs: 40 });
  db.close();
});

test('updateAfterTurn returns skipped when nothing new fell out', async () => {
  const db = messagesDb();
  const llm = stubLlm('Digest.');
  const service = new ConversationSummaryService({ db, config: config(), llm, logger: silentLogger });

  insertMessage(db, { id: 'm1', user: 'user', text: 'only turn', receivedAt: 10 });
  const first = await service.updateAfterTurn({ channel: 'web', channelName: 'web', oldestIncludedReceivedAt: 20 });
  assert.equal(first.status, 'updated');

  const second = await service.updateAfterTurn({ channel: 'web', channelName: 'web', oldestIncludedReceivedAt: 20 });
  assert.equal(second.status, 'skipped');
  assert.equal(second.summarizedMessages, 0);
  assert.equal(llm.requests.length, 1);
  db.close();
});

test('updateAfterTurn reports error and keeps the old summary when the LLM fails', async () => {
  const db = messagesDb();
  const okLlm = stubLlm('Stable digest.');
  const okService = new ConversationSummaryService({ db, config: config(), llm: okLlm, logger: silentLogger });
  insertMessage(db, { id: 'm1', user: 'user', text: 'first turn', receivedAt: 10 });
  await okService.updateAfterTurn({ channel: 'web', channelName: 'web', oldestIncludedReceivedAt: 20 });

  const warnings: unknown[][] = [];
  const failing = new ConversationSummaryService({
    db,
    config: config(),
    llm: { async complete() { throw new Error('ollama exploded'); } },
    logger: { warn: (...args: unknown[]) => { warnings.push(args); } },
  });
  insertMessage(db, { id: 'm2', user: 'user', text: 'second turn', receivedAt: 30 });

  const result = await failing.updateAfterTurn({ channel: 'web', channelName: 'web', oldestIncludedReceivedAt: 40 });

  assert.equal(result.status, 'error');
  assert.equal(result.summarizedMessages, 0);
  assert.deepEqual(failing.getSummary('web', 'web'), { summary: 'Stable digest.', coveredUntilMs: 10 });
  assert.match(String(warnings[0]?.[1] ?? ''), /ollama exploded/);
  db.close();
});

test('updateAfterTurn keeps the old summary when the LLM returns empty output', async () => {
  const db = messagesDb();
  let reply = 'Kept digest.';
  const llm = stubLlm(() => reply);
  const service = new ConversationSummaryService({ db, config: config(), llm, logger: silentLogger });

  insertMessage(db, { id: 'm1', user: 'user', text: 'first turn', receivedAt: 10 });
  await service.updateAfterTurn({ channel: 'web', channelName: 'web', oldestIncludedReceivedAt: 20 });

  insertMessage(db, { id: 'm2', user: 'user', text: 'second turn', receivedAt: 30 });
  reply = '   \n  ';
  const result = await service.updateAfterTurn({ channel: 'web', channelName: 'web', oldestIncludedReceivedAt: 40 });

  assert.equal(result.status, 'no_output');
  assert.deepEqual(service.getSummary('web', 'web'), { summary: 'Kept digest.', coveredUntilMs: 10 });
  db.close();
});

test('updateAfterTurn clips the stored summary to max_chars', async () => {
  const db = messagesDb();
  const llm = stubLlm('x'.repeat(999));
  const service = new ConversationSummaryService({
    db,
    config: config({ max_chars: 200 }),
    llm,
    logger: silentLogger,
  });

  insertMessage(db, { id: 'm1', user: 'user', text: 'a very long conversation', receivedAt: 10 });
  const result = await service.updateAfterTurn({ channel: 'web', channelName: 'web', oldestIncludedReceivedAt: 20 });

  assert.equal(result.status, 'updated');
  const stored = service.getSummary('web', 'web');
  assert.ok(stored);
  assert.equal(stored.summary.length, 200);
  db.close();
});

test('updateAfterTurn is a no-op when disabled or the window edge is unknown', async () => {
  const db = messagesDb();
  const llm = stubLlm('should never run');
  insertMessage(db, { id: 'm1', user: 'user', text: 'turn', receivedAt: 10 });

  const disabled = new ConversationSummaryService({ db, config: config({ enabled: false }), llm, logger: silentLogger });
  assert.deepEqual(
    await disabled.updateAfterTurn({ channel: 'web', channelName: 'web', oldestIncludedReceivedAt: 20 }),
    { status: 'disabled', summarizedMessages: 0 },
  );

  const enabled = new ConversationSummaryService({ db, config: config(), llm, logger: silentLogger });
  assert.deepEqual(
    await enabled.updateAfterTurn({ channel: 'web', channelName: 'web', oldestIncludedReceivedAt: undefined }),
    { status: 'disabled', summarizedMessages: 0 },
  );

  assert.equal(llm.requests.length, 0);
  db.close();
});

test('updateAfterTurn rejects invalid internal scope values without touching the LLM', async () => {
  const db = messagesDb();
  const llm = stubLlm('should never run');
  const warnings: unknown[][] = [];
  const service = new ConversationSummaryService({
    db,
    config: config(),
    llm,
    logger: { warn: (...args: unknown[]) => { warnings.push(args); } },
  });

  const result = await service.updateAfterTurn({
    channel: 'web',
    channelName: "x' OR '1'='1",
    oldestIncludedReceivedAt: 20,
  });

  assert.equal(result.status, 'error');
  assert.equal(llm.requests.length, 0);
  assert.match(String(warnings[0]?.[1] ?? ''), /Invalid channel conversation id/);
  db.close();
});

test('getSummary returns null for a missing row', () => {
  const db = messagesDb();
  const service = new ConversationSummaryService({ db, config: config(), llm: stubLlm(''), logger: silentLogger });
  assert.equal(service.getSummary('web', 'web'), null);
  db.close();
});
