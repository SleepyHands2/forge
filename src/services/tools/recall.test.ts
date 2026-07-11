import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createRecallTools } from './recall.ts';
import { ToolRegistry } from './registry.ts';
import { AgentService } from '../agent.ts';
import { MemoryService } from '../memory.ts';
import type { ForgeConfig, LLMRequest, LLMResponse, ToolDef, ToolsConfig } from '../../types.ts';
import type { RetrievedChunk } from '../rag/rag.ts';

const MEMORY_SCHEMA = fs.readFileSync(new URL('../../db/schemas/memory.sql', import.meta.url), 'utf-8');
const MESSAGES_SCHEMA = fs.readFileSync(new URL('../../db/schemas/messages.sql', import.meta.url), 'utf-8');

function config(tools: Partial<ToolsConfig> = {}): ForgeConfig {
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
    tools: {
      enabled: true,
      max_iterations: 5,
      levels: { safe: true, network: false, filesystem: false, sensitive: false },
      filesystem: { readable_dirs: [], writable_dirs: [] },
      ...tools,
    },
  };
}

function memoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(MEMORY_SCHEMA);
  return db;
}

function messagesDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(MESSAGES_SCHEMA);
  return db;
}

function insertMessage(db: Database.Database, row: {
  id: string; channel?: string; channelName?: string; user?: string;
  userName?: string; text: string; receivedAt?: number;
}): void {
  db.prepare(`
    INSERT INTO messages (id, channel, channelName, user, userName, text, ts, receivedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.channel ?? 'web',
    row.channelName ?? 'web',
    row.user ?? 'user',
    row.userName ?? 'tester',
    row.text,
    String(row.receivedAt ?? Date.now()),
    row.receivedAt ?? Date.now(),
  );
}

function setup(options: { rag?: { retrieve: (query: string) => Promise<RetrievedChunk[]> } } = {}) {
  const memDb = memoryDb();
  const msgDb = messagesDb();
  const memory = new MemoryService(memDb);
  const tools = createRecallTools({
    config: config(),
    memory,
    messagesDb: msgDb,
    ...(options.rag ? { rag: options.rag } : {}),
  });
  const byName = new Map<string, ToolDef>(tools.map(tool => [tool.name, tool]));
  return { memDb, msgDb, memory, tools, byName };
}

function chunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    documentId: 'doc-1',
    documentName: 'notes.md',
    chunkIndex: 2,
    content: 'The server rack lives in the garage.',
    similarity: 0.87654,
    tokenEstimate: 12,
    ...overrides,
  };
}

// --- memory_search -----------------------------------------------------------------

test('memory_search returns matching memories from a real MemoryService', async () => {
  const { memory, byName, memDb, msgDb } = setup();
  memory.saveSync({ type: 'fact', content: 'The user prefers dark roast coffee.' });
  memory.saveSync({ type: 'preference', content: 'Backups run every Sunday night.' });

  const tool = byName.get('memory_search')!;
  assert.equal(tool.permission, 'safe');
  const result = await tool.handler({ query: 'coffee preference' }) as {
    query: string;
    results: Array<{ id: string; type: string; content: string; created: string }>;
  };

  assert.equal(result.query, 'coffee preference');
  assert.ok(result.results.length >= 1);
  const hit = result.results.find(r => r.content.includes('dark roast'));
  assert.ok(hit, 'expected the coffee memory to be found');
  assert.equal(hit.type, 'fact');
  assert.deepEqual(Object.keys(result.results[0]).sort(), ['content', 'created', 'id', 'type']);
  memDb.close();
  msgDb.close();
});

test('memory_search with no stored memories throws a clear error', async () => {
  const { byName, memDb, msgDb } = setup();
  const tool = byName.get('memory_search')!;
  await assert.rejects(
    Promise.resolve(tool.handler({ query: 'anything at all' })),
    /No memories found for "anything at all"/,
  );
  memDb.close();
  msgDb.close();
});

// --- history_search ----------------------------------------------------------------

test('history_search finds past messages via FTS and clips long text', async () => {
  const { byName, memDb, msgDb } = setup();
  const longText = `The quarterly numbers were discussed at length. ${'More detail. '.repeat(40)}`;
  insertMessage(msgDb, { id: 'web:user:1', text: longText, receivedAt: 1750000000000 });
  insertMessage(msgDb, { id: 'web:user:2', text: 'Unrelated grocery list.', receivedAt: 1750000001000 });

  const tool = byName.get('history_search')!;
  assert.equal(tool.permission, 'safe');
  const result = await tool.handler({ query: 'quarterly numbers' }) as {
    query: string;
    results: Array<{ channel: string; userName: string; text: string; when: string }>;
  };

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].channel, 'web');
  assert.equal(result.results[0].userName, 'tester');
  assert.ok(result.results[0].text.length <= 301, 'text should be clipped to 300 chars plus ellipsis');
  assert.ok(result.results[0].text.endsWith('…'));
  assert.equal(result.results[0].when, new Date(1750000000000).toISOString());
  memDb.close();
  msgDb.close();
});

test('history_search rejects punctuation-only queries and reports zero matches clearly', async () => {
  const { byName, memDb, msgDb } = setup();
  insertMessage(msgDb, { id: 'web:user:1', text: 'Hello there.' });

  const tool = byName.get('history_search')!;
  await assert.rejects(
    Promise.resolve(tool.handler({ query: '?!... ---' })),
    /contains no searchable words/,
  );
  await assert.rejects(
    Promise.resolve(tool.handler({ query: 'zebra spaceship' })),
    /No messages found for "zebra spaceship"/,
  );
  memDb.close();
  msgDb.close();
});

// --- document_search ---------------------------------------------------------------

test('document_search returns passages from the RAG service with rounded similarity', async () => {
  const { byName, memDb, msgDb } = setup({
    rag: { retrieve: async () => [chunk(), chunk({ chunkIndex: 0, similarity: 0.5, content: 'Second passage.' })] },
  });

  const tool = byName.get('document_search')!;
  assert.equal(tool.permission, 'safe');
  const result = await tool.handler({ query: 'where is the server rack' }) as {
    query: string;
    results: Array<{ document: string; part: number; content: string; similarity: number }>;
  };

  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results[0], {
    document: 'notes.md',
    part: 3,
    content: 'The server rack lives in the garage.',
    similarity: 0.877,
  });
  assert.equal(result.results[1].part, 1);
  memDb.close();
  msgDb.close();
});

test('document_search throws when rag is unavailable or returns nothing', async () => {
  const withoutRag = setup();
  const unavailable = withoutRag.byName.get('document_search')!;
  await assert.rejects(
    Promise.resolve(unavailable.handler({ query: 'anything' })),
    /Document search is unavailable\./,
  );
  withoutRag.memDb.close();
  withoutRag.msgDb.close();

  const emptyRag = setup({ rag: { retrieve: async () => [] } });
  const empty = emptyRag.byName.get('document_search')!;
  await assert.rejects(
    Promise.resolve(empty.handler({ query: 'nothing matches this' })),
    /No relevant document passages found/,
  );
  emptyRag.memDb.close();
  emptyRag.msgDb.close();
});

// --- through the agent loop ---------------------------------------------------------

test('memory_search results reach the model as an ok:true envelope through the agent loop', async () => {
  const { memory, tools, memDb, msgDb } = setup();
  memory.saveSync({ type: 'fact', content: 'The router password is stored in the vault.' });

  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);

  const requests: LLMRequest[] = [];
  const responses: LLMResponse[] = [
    {
      content: '', provider: 'ollama', model: 'local-model', inputTokens: 1, outputTokens: 1,
      toolCalls: [{ name: 'memory_search', arguments: { query: 'router password' } }],
    },
    { content: 'It is in the vault.', provider: 'ollama', model: 'local-model', inputTokens: 1, outputTokens: 1 },
  ];
  const llm = {
    async complete(req: LLMRequest): Promise<LLMResponse> {
      requests.push({ ...req, messages: [...req.messages] });
      const next = responses.shift();
      if (!next) throw new Error('out of responses');
      return next;
    },
  };
  const agent = new AgentService({ config: config(), llm, registry });

  const result = await agent.runTurn({ system: 's', messages: [{ role: 'user', content: 'where is the router password?' }] });

  assert.equal(result.content, 'It is in the vault.');
  const toolMsg = requests[1].messages.at(-1);
  assert.equal(toolMsg?.role, 'tool');
  const envelope = JSON.parse(toolMsg?.content ?? '{}') as { ok: boolean; result: { results: Array<{ content: string }> } };
  assert.equal(envelope.ok, true);
  assert.match(envelope.result.results[0].content, /router password/);
  memDb.close();
  msgDb.close();
});
