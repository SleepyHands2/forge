import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3';
import { memoriesRoutes } from './memories.ts';
import { MemoryService } from '../../services/memory.ts';
import type { ForgeConfig } from '../../types.ts';

const SCHEMA = fs.readFileSync(new URL('../../db/schemas/memory.sql', import.meta.url), 'utf-8');

function config(autoEnabled = true): ForgeConfig {
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
      auto: { enabled: autoEnabled, max_per_turn: 3, dedupe_similarity: 0.92 },
    },
  };
}

function setup(autoEnabled = true) {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  const memory = new MemoryService(db);
  const app = express();
  app.use(express.json());
  app.use('/api/memories', memoriesRoutes({
    config: config(autoEnabled),
    memory,
    dbManager: { get: () => db },
  } as never));
  return { db, memory, app };
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

test('GET /api/memories lists memories with source and capture provenance', async () => {
  const { db, memory, app } = setup();
  const autoId = memory.saveSync({ type: 'fact', content: 'The user lives in Austin.', tags: ['auto'] });
  const manualId = memory.saveSync({ type: 'chat', content: 'Manual note.', tags: ['chat', 'explicit'] });
  db.prepare(`
    INSERT INTO memory_captures (memory_id, action, content, reason, source_message_id, source_preview)
    VALUES (?, 'created', 'The user lives in Austin.', 'Stated directly.', 'web:assistant:9', 'I live in Austin')
  `).run(autoId);

  await withServer(app, async (url) => {
    const all = await (await fetch(`${url}/api/memories`)).json() as {
      memories: Array<{ id: string; source: string; capture?: { sourcePreview: string; sourceMessageId: string } }>;
      autoCapture: { enabled: boolean };
    };
    assert.equal(all.memories.length, 2);
    assert.equal(all.autoCapture.enabled, true);

    const auto = all.memories.find(m => m.id === autoId);
    const manual = all.memories.find(m => m.id === manualId);
    assert.equal(auto?.source, 'auto');
    assert.equal(auto?.capture?.sourcePreview, 'I live in Austin');
    assert.equal(auto?.capture?.sourceMessageId, 'web:assistant:9');
    assert.equal(manual?.source, 'manual');
    assert.equal(manual?.capture, undefined);

    const filtered = await (await fetch(`${url}/api/memories?source=auto`)).json() as { memories: Array<{ id: string }> };
    assert.deepEqual(filtered.memories.map(m => m.id), [autoId]);

    const bad = await fetch(`${url}/api/memories?source=nope`);
    assert.equal(bad.status, 400);
  });
  db.close();
});

test('DELETE /api/memories/:id prunes a wrong memory', async () => {
  const { db, memory, app } = setup();
  const id = memory.saveSync({ type: 'fact', content: 'Wrong capture from a 4B model.', tags: ['auto'] });

  await withServer(app, async (url) => {
    const res = await fetch(`${url}/api/memories/${id}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { removed: true, id });
    assert.equal(memory.list({ status: 'active' }).length, 0);

    const again = await fetch(`${url}/api/memories/${id}`, { method: 'DELETE' });
    assert.equal(again.status, 404);
  });
  db.close();
});

test('GET /api/memories/captures returns the newest capture log rows', async () => {
  const { db, app } = setup();
  const insert = db.prepare(`
    INSERT INTO memory_captures (memory_id, action, content, reason, similarity, source_preview)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insert.run(null, 'error', '', 'Extraction output was not the expected JSON object.', null, 'hello');
  insert.run('mem-1', 'created', 'The user lives in Austin.', 'Stated directly.', null, 'I live in Austin');
  insert.run(null, 'duplicate', 'The user lives in Austin, TX.', 'Semantically similar.', 0.97, 'I live in Austin');

  await withServer(app, async (url) => {
    const data = await (await fetch(`${url}/api/memories/captures?limit=2`)).json() as {
      captures: Array<{ action: string; similarity: number | null }>;
    };
    assert.equal(data.captures.length, 2);
    // Newest first.
    assert.equal(data.captures[0].action, 'duplicate');
    assert.equal(data.captures[0].similarity, 0.97);
    assert.equal(data.captures[1].action, 'created');

    const bad = await fetch(`${url}/api/memories/captures?limit=0`);
    assert.equal(bad.status, 400);
  });
  db.close();
});
