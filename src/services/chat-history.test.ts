import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import {
  buildConversationMessages,
  ChatContextTooLargeError,
  computePromptBudgetTokens,
} from './chat-history.ts';
import type { ChatMessage, ForgeConfig } from '../types.ts';

type TestDb = ReturnType<typeof Database>;

function createDb(): TestDb {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      user TEXT NOT NULL,
      text TEXT NOT NULL,
      receivedAt INTEGER NOT NULL
    )
  `);
  return db;
}

function insertMessage(
  db: TestDb,
  id: string,
  user: string,
  text: string,
  receivedAt: number,
  channel = 'web',
): void {
  db.prepare(
    `INSERT INTO messages (id, channel, user, text, receivedAt)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, channel, user, text, receivedAt);
}

function config(numCtx = 8192, numPredict = 1024): ForgeConfig {
  return {
    server: {
      host: '127.0.0.1',
      port: 0,
    },
    database: {
      path: ':memory:',
    },
    llm: {
      provider: 'ollama',
      ollama: {
        baseUrl: 'http://127.0.0.1:11434',
        model: 'test-model',
        options: {
          num_ctx: numCtx,
          num_predict: numPredict,
        },
      },
    },
  } as unknown as ForgeConfig;
}

function current(content = 'current', images?: string[]): ChatMessage {
  const message = { role: 'user', content } as unknown as ChatMessage;

  if (images) {
    message.images = images;
  }

  return message;
}

function build(db: TestDb, overrides: Partial<Parameters<typeof buildConversationMessages>[0]> = {}) {
  return buildConversationMessages({
    db,
    config: config(),
    currentMessageId: 'current-id',
    systemPrompt: '',
    currentUserMessage: current('now'),
    ...overrides,
  });
}

describe('buildConversationMessages', () => {
  it('returns only the current message for empty history', () => {
    const db = createDb();

    const result = build(db, { currentUserMessage: current('hello') });

    assert.deepEqual(result.messages, [{ role: 'user', content: 'hello' }]);
    assert.equal(result.includedHistoryMessages, 0);
    assert.equal(result.omittedHistoryMessages, 0);
    assert.ok(result.promptBudgetTokens > 0);
    assert.ok(result.estimatedPromptTokens > 0);
  });

  it('includes a complete prior turn before the current message', () => {
    const db = createDb();
    insertMessage(db, 'u1', 'user', 'first', 1);
    insertMessage(db, 'a1', 'assistant', 'answer', 2);

    const result = build(db, { currentUserMessage: current('next') });

    assert.deepEqual(result.messages, [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'next' },
    ]);
    assert.equal(result.includedHistoryMessages, 2);
  });

  it('preserves images on the appended current message only', () => {
    const db = createDb();
    insertMessage(db, 'u1', 'user', 'first', 1);
    insertMessage(db, 'a1', 'assistant', 'answer', 2);

    const currentUserMessage = current('next', ['image-1', 'image-2']);
    const result = build(db, { currentUserMessage });

    assert.deepEqual(result.messages, [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      currentUserMessage,
    ]);
    assert.equal(result.messages.at(-1), currentUserMessage);
  });

  it('excludes the current message id from prior history', () => {
    const db = createDb();
    insertMessage(db, 'old', 'user', 'old message', 1);
    insertMessage(db, 'current-id', 'user', 'duplicate current row', 2);

    const result = build(db, { currentUserMessage: current('fresh current') });

    assert.deepEqual(result.messages.map((message) => message.content), [
      'old message',
      'fresh current',
    ]);
  });

  it('preserves chronological ordering after newest-first loading', () => {
    const db = createDb();
    insertMessage(db, 'u1', 'user', 'old user', 1);
    insertMessage(db, 'a1', 'assistant', 'old assistant', 2);
    insertMessage(db, 'u2', 'user', 'new user', 3);
    insertMessage(db, 'a2', 'assistant', 'new assistant', 4);

    const result = build(db);

    assert.deepEqual(result.messages.map((message) => message.content), [
      'old user',
      'old assistant',
      'new user',
      'new assistant',
      'now',
    ]);
  });

  it('loads only web channel history', () => {
    const db = createDb();
    insertMessage(db, 'cli-u', 'user', 'cli user', 1, 'cli');
    insertMessage(db, 'web-u', 'user', 'web user', 2, 'web');

    const result = build(db);

    assert.deepEqual(result.messages.map((message) => message.content), [
      'web user',
      'now',
    ]);
  });

  it('loads only user and assistant roles', () => {
    const db = createDb();
    insertMessage(db, 'system', 'system', 'system text', 1);
    insertMessage(db, 'tool', 'tool', 'tool text', 2);
    insertMessage(db, 'user', 'user', 'user text', 3);

    const result = build(db);

    assert.deepEqual(result.messages.map((message) => message.content), [
      'user text',
      'now',
    ]);
  });

  it('ignores empty and trim-only messages', () => {
    const db = createDb();
    insertMessage(db, 'empty', 'user', '', 1);
    insertMessage(db, 'spaces', 'user', '   ', 2);
    insertMessage(db, 'valid', 'user', 'valid text', 3);

    const result = build(db);

    assert.deepEqual(result.messages.map((message) => message.content), [
      'valid text',
      'now',
    ]);
  });

  it('ignores orphan assistant messages before the first user turn', () => {
    const db = createDb();
    insertMessage(db, 'a0', 'assistant', 'orphan', 1);
    insertMessage(db, 'u1', 'user', 'started', 2);
    insertMessage(db, 'a1', 'assistant', 'reply', 3);

    const result = build(db);

    assert.deepEqual(result.messages.map((message) => message.content), [
      'started',
      'reply',
      'now',
    ]);
    assert.equal(result.omittedHistoryMessages, 0);
  });

  it('keeps a user-only turn valid', () => {
    const db = createDb();
    insertMessage(db, 'u1', 'user', 'unanswered', 1);

    const result = build(db);

    assert.deepEqual(result.messages.map((message) => message.content), [
      'unanswered',
      'now',
    ]);
    assert.equal(result.includedHistoryMessages, 1);
  });

  it('limits selected prior history to 50 messages', () => {
    const db = createDb();
    for (let index = 1; index <= 60; index += 1) {
      insertMessage(db, `u${index}`, 'user', `user ${index}`, index);
    }

    const result = build(db);

    assert.equal(result.includedHistoryMessages, 50);
    assert.equal(result.omittedHistoryMessages, 10);
    assert.equal(result.messages[0]?.content, 'user 11');
    assert.equal(result.messages.at(-1)?.content, 'now');
  });

  it('trims history by token budget without skipping an oversized recent turn', () => {
    const db = createDb();
    insertMessage(db, 'old-u', 'user', 'old small', 1);
    insertMessage(db, 'recent-u', 'user', 'x'.repeat(900), 2);

    const result = build(db, {
      config: config(700, 100),
      currentUserMessage: current('now'),
    });

    assert.deepEqual(result.messages.map((message) => message.content), ['now']);
    assert.equal(result.omittedHistoryMessages, 2);
  });

  it('always includes current message when no prior history fits', () => {
    const db = createDb();
    insertMessage(db, 'u1', 'user', 'x'.repeat(900), 1);

    const result = build(db, {
      config: config(700, 100),
      currentUserMessage: current('small'),
    });

    assert.deepEqual(result.messages, [{ role: 'user', content: 'small' }]);
    assert.equal(result.includedHistoryMessages, 0);
  });

  it('throws when current context alone is too large', () => {
    const db = createDb();

    assert.throws(
      () =>
        build(db, {
          config: config(700, 100),
          systemPrompt: 'identity '.repeat(300),
          currentUserMessage: current('message', ['image-1']),
        }),
      ChatContextTooLargeError,
    );
  });

  it('returns deterministic positive estimates for unicode content', () => {
    const db = createDb();
    insertMessage(db, 'u1', 'user', 'hello 漢字', 1);

    const first = build(db, {
      systemPrompt: 'identity ñ',
      currentUserMessage: current('emoji 😀'),
    });
    const second = build(db, {
      systemPrompt: 'identity ñ',
      currentUserMessage: current('emoji 😀'),
    });

    assert.ok(first.estimatedPromptTokens > 0);
    assert.equal(first.estimatedPromptTokens, second.estimatedPromptTokens);
    assert.equal(first.promptBudgetTokens, second.promptBudgetTokens);
  });

  it('uses image reserve to reduce included history without throwing', () => {
    const db = createDb();
    insertMessage(db, 'old-u', 'user', 'o'.repeat(100), 1);
    insertMessage(db, 'old-a', 'assistant', 'p'.repeat(100), 2);
    insertMessage(db, 'new-u', 'user', 'r'.repeat(100), 3);
    insertMessage(db, 'new-a', 'assistant', 's'.repeat(100), 4);

    const withoutImage = build(db, {
      config: config(1200, 100),
      currentUserMessage: current('now'),
    });
    const withImage = build(db, {
      config: config(1700, 100),
      currentUserMessage: current('now', ['image-1']),
    });

    assert.equal(withoutImage.includedHistoryMessages, 4);
    assert.equal(withImage.includedHistoryMessages, 0);
    assert.ok(withImage.estimatedPromptTokens <= withImage.promptBudgetTokens);
  });

  it('reports the receivedAt of the oldest included history message', () => {
    const db = createDb();
    insertMessage(db, 'u1', 'user', 'first', 5);
    insertMessage(db, 'a1', 'assistant', 'answer', 6);
    insertMessage(db, 'u2', 'user', 'second', 7);

    const result = build(db);

    assert.equal(result.oldestIncludedReceivedAt, 5);
  });

  it('tracks the oldest included receivedAt past omitted turns', () => {
    const db = createDb();
    for (let index = 1; index <= 60; index += 1) {
      insertMessage(db, `u${index}`, 'user', `user ${index}`, index);
    }

    const result = build(db);

    assert.equal(result.omittedHistoryMessages, 10);
    assert.equal(result.messages[0]?.content, 'user 11');
    assert.equal(result.oldestIncludedReceivedAt, 11);
  });

  it('leaves oldestIncludedReceivedAt undefined when no history is included', () => {
    const db = createDb();

    const result = build(db, { currentUserMessage: current('hello') });

    assert.equal(result.includedHistoryMessages, 0);
    assert.equal(result.oldestIncludedReceivedAt, undefined);
  });
});

describe('computePromptBudgetTokens', () => {
  it('derives the budget from num_ctx and num_predict', () => {
    assert.equal(computePromptBudgetTokens(config(16384, 1024)), 14848);
    assert.equal(computePromptBudgetTokens(config(8192, 1024)), 6656);
  });

  it('matches the budget reported by buildConversationMessages', () => {
    const db = createDb();
    const result = build(db, { config: config(16384, 1024) });
    assert.equal(result.promptBudgetTokens, computePromptBudgetTokens(config(16384, 1024)));
  });

  it('falls back to defaults when the config has no ollama options', () => {
    assert.equal(
      computePromptBudgetTokens({} as unknown as ForgeConfig),
      8192 - 1024 - 512,
    );
  });
});
