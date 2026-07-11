import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import Database from 'better-sqlite3';
import { ChatTurnService, type ChatTurnDeps } from './chat-turn.ts';
import type { StoredConversationSummary, SummaryUpdateInput, SummaryUpdateResult } from './conversation-summary.ts';

const MESSAGES_SCHEMA = fs.readFileSync(new URL('../db/schemas/messages.sql', import.meta.url), 'utf-8');

function config(overrides: Record<string, unknown> = {}) {
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
    memory: { retention_days: 30, summary: { enabled: true, max_chars: 1200, batch_messages: 40 } },
    ...overrides,
  };
}

function messagesDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(MESSAGES_SCHEMA);
  return db;
}

function insertHistory(db: Database.Database, id: string, user: string, text: string, receivedAt: number): void {
  db.prepare(`
    INSERT INTO messages (id, channel, channelName, user, userName, text, ts, receivedAt)
    VALUES (?, 'web', 'web', ?, ?, ?, ?, ?)
  `).run(id, user, 'tester', text, String(receivedAt), receivedAt);
}

function stubSummary(stored: StoredConversationSummary | null = null) {
  const getCalls: Array<[string, string]> = [];
  const updateCalls: SummaryUpdateInput[] = [];
  return {
    getCalls,
    updateCalls,
    getSummary(channel: string, channelName: string): StoredConversationSummary | null {
      getCalls.push([channel, channelName]);
      return stored;
    },
    async updateAfterTurn(input: SummaryUpdateInput): Promise<SummaryUpdateResult> {
      updateCalls.push(input);
      return { status: 'updated', summarizedMessages: 1 };
    },
  };
}

function makeService(options: {
  db: Database.Database;
  config?: Record<string, unknown>;
  summary?: ReturnType<typeof stubSummary>;
}): ChatTurnService {
  return new ChatTurnService({
    config: options.config ?? config(),
    db: options.db,
    memory: { async retrieveForChat() { return []; } },
    llm: {
      async complete() {
        return { content: 'reply', provider: 'ollama', model: 'local-model', inputTokens: 1, outputTokens: 1 };
      },
    },
    ...(options.summary ? { summary: options.summary } : {}),
    readIdentity: () => 'You are forge-local.',
  } as unknown as ChatTurnDeps);
}

function turnInput() {
  return {
    channel: 'web',
    channelName: 'web',
    userName: 'tester',
    content: 'current question',
    interfaceLabel: 'Web Chat',
  };
}

async function flushQueued(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

test('prepare injects the stored summary between the Memory Contract and the context section', async () => {
  const db = messagesDb();
  const summary = stubSummary({ summary: 'Earlier they discussed database backups.', coveredUntilMs: 5 });
  const service = makeService({ db, summary });

  const prepared = await service.prepare(turnInput());
  assert.equal(prepared.kind, 'chat');
  if (prepared.kind !== 'chat') return;

  assert.deepEqual(summary.getCalls, [['web', 'web']]);
  assert.match(prepared.system, /## Earlier Conversation \(summary\)/);
  assert.match(prepared.system, /Compressed record of turns no longer in the context window; may be imperfect\./);
  assert.match(prepared.system, /Earlier they discussed database backups\./);
  assert.ok(
    prepared.system.indexOf('## Memory Contract') < prepared.system.indexOf('## Earlier Conversation (summary)'),
    'summary section must come after the Memory Contract',
  );
  assert.ok(
    prepared.system.indexOf('## Earlier Conversation (summary)') < prepared.system.indexOf('## Context'),
    'summary section must come before the trailing context section',
  );
  db.close();
});

test('prepare injects nothing when no summary row exists', async () => {
  const db = messagesDb();
  const summary = stubSummary(null);
  const service = makeService({ db, summary });

  const prepared = await service.prepare(turnInput());
  assert.equal(prepared.kind, 'chat');
  if (prepared.kind !== 'chat') return;

  assert.deepEqual(summary.getCalls, [['web', 'web']]);
  assert.doesNotMatch(prepared.system, /## Earlier Conversation \(summary\)/);
  db.close();
});

test('prepare skips the summary read entirely when memory.summary is absent from config', async () => {
  const db = messagesDb();
  const summary = stubSummary({ summary: 'must not appear', coveredUntilMs: 5 });
  const service = makeService({
    db,
    summary,
    config: config({ memory: { retention_days: 30 } }),
  });

  const prepared = await service.prepare(turnInput());
  assert.equal(prepared.kind, 'chat');
  if (prepared.kind !== 'chat') return;

  assert.deepEqual(summary.getCalls, []);
  assert.doesNotMatch(prepared.system, /must not appear/);
  db.close();
});

test('complete queues a summary update when history messages were omitted', async () => {
  const db = messagesDb();
  // 60 single-message user turns exceed the 50-message history cap: the 10
  // oldest fall out, and the oldest included row has receivedAt 11.
  for (let index = 1; index <= 60; index += 1) {
    insertHistory(db, `web:user:${index}`, 'user', `user ${index}`, index);
  }
  const summary = stubSummary(null);
  const service = makeService({ db, summary });

  const prepared = await service.prepare(turnInput());
  assert.equal(prepared.kind, 'chat');
  if (prepared.kind !== 'chat') return;
  assert.equal(prepared.conversation.omittedHistoryMessages, 10);

  await service.complete(prepared);
  assert.deepEqual(summary.updateCalls, []);
  await flushQueued();

  assert.deepEqual(summary.updateCalls, [{
    channel: 'web',
    channelName: 'web',
    oldestIncludedReceivedAt: 11,
  }]);
  db.close();
});

test('complete does not queue a summary update when nothing fell out of the window', async () => {
  const db = messagesDb();
  insertHistory(db, 'web:user:1', 'user', 'small history', 1);
  const summary = stubSummary(null);
  const service = makeService({ db, summary });

  const prepared = await service.prepare(turnInput());
  assert.equal(prepared.kind, 'chat');
  if (prepared.kind !== 'chat') return;
  assert.equal(prepared.conversation.omittedHistoryMessages, 0);

  await service.complete(prepared);
  await flushQueued();

  assert.deepEqual(summary.updateCalls, []);
  db.close();
});

test('complete does not queue a summary update when the summary feature is disabled', async () => {
  const db = messagesDb();
  for (let index = 1; index <= 60; index += 1) {
    insertHistory(db, `web:user:${index}`, 'user', `user ${index}`, index);
  }
  const summary = stubSummary(null);
  const service = makeService({
    db,
    summary,
    config: config({
      memory: { retention_days: 30, summary: { enabled: false, max_chars: 1200, batch_messages: 40 } },
    }),
  });

  const prepared = await service.prepare(turnInput());
  assert.equal(prepared.kind, 'chat');
  if (prepared.kind !== 'chat') return;
  assert.equal(prepared.conversation.omittedHistoryMessages, 10);

  await service.complete(prepared);
  await flushQueued();

  assert.deepEqual(summary.updateCalls, []);
  db.close();
});
