import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import Database from 'better-sqlite3';
import { MemoryService } from './memory.ts';
import { MemoryCaptureService } from './memory-capture.ts';
import type { EmbeddingHealth, ForgeConfig, LLMRequest, LLMResponse, MemoryAutoConfig } from '../types.ts';
import type { EmbeddingProvider } from './ollama-embeddings.ts';

const SCHEMA = fs.readFileSync(new URL('../db/schemas/memory.sql', import.meta.url), 'utf-8');

function config(auto: Partial<MemoryAutoConfig> = {}): ForgeConfig {
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
      auto: { enabled: true, max_per_turn: 3, dedupe_similarity: 0.92, ...auto },
    },
  };
}

function fakeEmbeddings(vectorFor: (input: string) => number[]): EmbeddingProvider {
  const health: EmbeddingHealth = {
    provider: 'ollama',
    enabled: true,
    model: 'test-embeddings',
    baseUrl: 'http://localhost:11434',
    ok: true,
    status: 'online',
    installedModels: ['test-embeddings'],
  };
  return {
    enabled: true,
    model: 'test-embeddings',
    async embed(input: string) { return vectorFor(input); },
    async embedMany(inputs: readonly string[]) { return inputs.map(vectorFor); },
    async health() { return health; },
  };
}

function llmReturning(content: string): { calls: LLMRequest[]; complete: (req: LLMRequest) => Promise<LLMResponse> } {
  const calls: LLMRequest[] = [];
  return {
    calls,
    async complete(req: LLMRequest) {
      calls.push(req);
      return { content, provider: 'ollama', model: 'local-model', inputTokens: 1, outputTokens: 1 };
    },
  };
}

function setup(options: {
  llmContent?: string;
  llmError?: Error;
  auto?: Partial<MemoryAutoConfig>;
  embeddings?: EmbeddingProvider;
} = {}) {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  const memory = new MemoryService(db, { embeddingProvider: options.embeddings });
  const llm = options.llmError
    ? { calls: [] as LLMRequest[], async complete(): Promise<LLMResponse> { throw options.llmError; } }
    : llmReturning(options.llmContent ?? '{"memories":[]}');
  const capture = new MemoryCaptureService({
    db,
    config: config(options.auto),
    memory,
    llm,
    logger: { warn: () => {} },
  });
  return { db, memory, llm, capture };
}

function captureRows(db: Database.Database): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM memory_captures ORDER BY id').all() as Array<Record<string, unknown>>;
}

const TURN = { userMessage: 'I live in Austin and I prefer tea over coffee.', assistantMessage: 'Noted!', assistantMessageId: 'web:assistant:1' };

test('capture extracts durable facts, saves them tagged auto, and logs created rows', async () => {
  const { db, memory, capture } = setup({
    llmContent: JSON.stringify({
      memories: [
        { content: 'The user lives in Austin.', type: 'fact', reason: 'Stated directly.' },
        { content: 'The user prefers tea over coffee.', type: 'preference', reason: 'Stated directly.' },
      ],
    }),
  });

  const result = await capture.captureAfterAssistantReply(TURN);

  assert.deepEqual(result, { status: 'applied', created: 2, duplicates: 0, invalid: 0 });
  const memories = memory.list({ status: 'active' });
  assert.equal(memories.length, 2);
  for (const m of memories) {
    assert.deepEqual(m.tags, ['auto']);
  }
  const rows = captureRows(db);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].action, 'created');
  assert.equal(rows[0].source_message_id, 'web:assistant:1');
  assert.match(String(rows[0].source_preview), /I live in Austin/);
  assert.equal(typeof rows[0].memory_id, 'string');
  db.close();
});

test('capture dedupes exact content matches without writing a new memory', async () => {
  const { db, memory, capture } = setup({
    llmContent: JSON.stringify({
      memories: [{ content: 'The user lives in Austin.', type: 'fact', reason: 'r' }],
    }),
  });
  const existingId = memory.saveSync({ type: 'fact', content: 'the user lives   in austin.', tags: ['auto'] });

  const result = await capture.captureAfterAssistantReply(TURN);

  assert.deepEqual(result, { status: 'no_output', created: 0, duplicates: 1, invalid: 0 });
  assert.equal(memory.list({ status: 'active' }).length, 1);
  const [row] = captureRows(db);
  assert.equal(row.action, 'duplicate');
  assert.equal(row.duplicate_of, existingId);
  assert.match(String(row.reason), /Exact content match/);
  db.close();
});

test('capture dedupes semantically similar memories via the embedding index', async () => {
  // Any input mentioning Austin embeds to the same direction; tea is orthogonal.
  const embeddings = fakeEmbeddings(input => input.includes('Austin') ? [1, 0] : [0, 1]);
  const { db, memory, capture } = setup({
    embeddings,
    llmContent: JSON.stringify({
      memories: [
        { content: 'The user is based in Austin, Texas.', type: 'fact', reason: 'r' },
        { content: 'The user prefers tea.', type: 'preference', reason: 'r' },
      ],
    }),
  });
  const existingId = await memory.save({ type: 'fact', content: 'The user lives in Austin.', tags: ['auto'] });

  const result = await capture.captureAfterAssistantReply(TURN);

  assert.deepEqual(result, { status: 'applied', created: 1, duplicates: 1, invalid: 0 });
  const contents = memory.list({ status: 'active' }).map(m => m.content).sort();
  assert.deepEqual(contents, ['The user lives in Austin.', 'The user prefers tea.']);

  const rows = captureRows(db);
  const duplicate = rows.find(r => r.action === 'duplicate');
  assert.ok(duplicate);
  assert.equal(duplicate.duplicate_of, existingId);
  assert.ok(Number(duplicate.similarity) >= 0.92);
  db.close();
});

test('capture ignores malformed extraction output and logs an error row, never throwing', async () => {
  const { db, memory, capture } = setup({ llmContent: 'Sure! I think the user likes tea. No JSON here.' });

  const result = await capture.captureAfterAssistantReply(TURN);

  assert.deepEqual(result, { status: 'no_output', created: 0, duplicates: 0, invalid: 0 });
  assert.equal(memory.list({ status: 'active' }).length, 0);
  const [row] = captureRows(db);
  assert.equal(row.action, 'error');
  db.close();
});

test('capture survives an LLM failure and logs it', async () => {
  const { db, memory, capture } = setup({ llmError: new Error('ollama offline') });

  const result = await capture.captureAfterAssistantReply(TURN);

  assert.deepEqual(result, { status: 'no_output', created: 0, duplicates: 0, invalid: 0 });
  assert.equal(memory.list({ status: 'active' }).length, 0);
  const [row] = captureRows(db);
  assert.equal(row.action, 'error');
  assert.match(String(row.reason), /ollama offline/);
  db.close();
});

test('capture rejects invalid candidates (bad type, empty content) as logged invalid rows', async () => {
  const { db, memory, capture } = setup({
    llmContent: JSON.stringify({
      memories: [
        { content: '', type: 'fact', reason: 'r' },
        { content: 'Valid fact about the user.', type: 'opinion', reason: 'r' },
      ],
    }),
  });

  const result = await capture.captureAfterAssistantReply(TURN);

  assert.deepEqual(result, { status: 'no_output', created: 0, duplicates: 0, invalid: 2 });
  assert.equal(memory.list({ status: 'active' }).length, 0);
  const rows = captureRows(db);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.action === 'invalid'));
  db.close();
});

test('capture honors max_per_turn', async () => {
  const { memory, capture } = setup({
    auto: { max_per_turn: 1 },
    llmContent: JSON.stringify({
      memories: [
        { content: 'Fact one about the user.', type: 'fact', reason: 'r' },
        { content: 'Fact two about the user.', type: 'fact', reason: 'r' },
      ],
    }),
  });

  const result = await capture.captureAfterAssistantReply(TURN);

  assert.equal(result.created, 1);
  assert.equal(memory.list({ status: 'active' }).length, 1);
});

test('capture is inert when memory.auto.enabled is false', async () => {
  const { db, memory, llm, capture } = setup({
    auto: { enabled: false },
    llmContent: JSON.stringify({ memories: [{ content: 'Should never be saved.', type: 'fact', reason: 'r' }] }),
  });

  const result = await capture.captureAfterAssistantReply(TURN);

  assert.deepEqual(result, { status: 'disabled', created: 0, duplicates: 0, invalid: 0 });
  assert.equal(llm.calls.length, 0);
  assert.equal(memory.list({ status: 'active' }).length, 0);
  assert.equal(captureRows(db).length, 0);
  db.close();
});
