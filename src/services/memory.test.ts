import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import Database from 'better-sqlite3';
import type { EmbeddingHealth } from '../types.ts';
import type { EmbeddingProvider } from './ollama-embeddings.ts';
import { MemoryService } from './memory.ts';

const SCHEMA = fs.readFileSync(
  new URL('../db/schemas/memory.sql', import.meta.url),
  'utf-8',
);

interface FakeEmbeddingProvider extends EmbeddingProvider {
  inputs: string[];
  batches: string[][];
}

function openMemory(options?: ConstructorParameters<typeof MemoryService>[1]): { db: Database.Database; memory: MemoryService } {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return { db, memory: new MemoryService(db, options) };
}

function fakeEmbeddings(options: {
  model?: string;
  revision?: string;
  vectorFor?: (input: string) => number[];
  throwOnEmbed?: Error;
  throwOnEmbedMany?: Error;
} = {}): FakeEmbeddingProvider {
  const model = options.model ?? 'test-embeddings';
  const revision = options.revision ?? 'sha256:test';
  const vectorFor = options.vectorFor ?? (() => [1, 0]);
  const health: EmbeddingHealth = {
    provider: 'ollama',
    enabled: true,
    model,
    baseUrl: 'http://localhost:11434',
    ok: true,
    status: 'online',
    installedModels: [model],
    modelRevision: revision,
  };

  return {
    enabled: true,
    model,
    inputs: [],
    batches: [],
    async embed(input: string) {
      if (options.throwOnEmbed) throw options.throwOnEmbed;
      this.inputs.push(input);
      return vectorFor(input);
    },
    async embedMany(inputs: readonly string[]) {
      if (options.throwOnEmbedMany) throw options.throwOnEmbedMany;
      this.batches.push([...inputs]);
      return inputs.map(vectorFor);
    },
    async health() {
      return health;
    },
  };
}

function embeddingRows(db: Database.Database, memoryId?: string): Array<{
  memory_id: string; model: string; model_revision: string; content_hash: string; dimensions: number; vector: Buffer;
}> {
  const where = memoryId ? 'WHERE memory_id = ?' : '';
  return db.prepare(`SELECT memory_id, model, model_revision, content_hash, dimensions, vector FROM memory_embeddings ${where}`)
    .all(...(memoryId ? [memoryId] : [])) as Array<{
      memory_id: string; model: string; model_revision: string; content_hash: string; dimensions: number; vector: Buffer;
    }>;
}

test('MemoryService stores, searches, and removes memories with FTS5', () => {
  const { db, memory } = openMemory();

  try {
    const id = memory.saveSync({
      type: 'chat',
      content: 'Alice prefers local Ollama models',
      tags: ['chat', 'explicit'],
    });

    const results = memory.search('Ollama models');
    assert.equal(results.length, 1);
    assert.equal(results[0].id, id);
    assert.equal(results[0].content, 'Alice prefers local Ollama models');

    assert.equal(memory.remove(id), true);
    assert.deepEqual(memory.search('Ollama models'), []);
  } finally {
    db.close();
  }
});

test('save persists Float32 embeddings after the lexical record and retrieves semantic-only matches', async () => {
  const embeddings = fakeEmbeddings({
    vectorFor: input => input.includes('Astronomy club') || input === 'space telescope' ? [1, 0] : [0, 1],
  });
  const { db, memory } = openMemory({ embeddingProvider: embeddings });

  try {
    const astronomyId = await memory.save({
      type: 'chat',
      content: 'Astronomy club meets on Tuesdays',
      tags: ['community'],
    });
    await memory.save({ type: 'chat', content: 'The workshop starts at noon', tags: ['schedule'] });

    assert.deepEqual(memory.search('space telescope'), []);
    const semantic = await memory.retrieveForChat('space telescope', 5);
    assert.equal(semantic[0].id, astronomyId);
    assert.equal(semantic[0].semanticScore, 1);

    const [stored] = embeddingRows(db, astronomyId);
    assert.equal(stored.model, 'test-embeddings');
    assert.equal(stored.model_revision, '');
    assert.equal(stored.dimensions, 2);
    assert.equal(stored.vector.length, 8);
    assert.equal(stored.vector.readFloatLE(0), 1);
    assert.equal(stored.vector.readFloatLE(4), 0);
    assert.equal(stored.content_hash.length, 64);
  } finally {
    db.close();
  }
});

test('hybrid retrieval uses deterministic reciprocal-rank fusion and never duplicates a memory', async () => {
  const embeddings = fakeEmbeddings({
    vectorFor: input => {
      if (input.includes('alpha alpha alpha')) return [0, 1];
      if (input.includes('both alpha')) return [0.9, Math.sqrt(1 - 0.9 ** 2)];
      if (input.includes('orbital navigation') || input === 'alpha') return [1, 0];
      return [0, 1];
    },
  });
  const { db, memory } = openMemory({ embeddingProvider: embeddings });

  try {
    await memory.save({ type: 'chat', content: 'alpha alpha alpha', tags: [] });
    const bothId = await memory.save({ type: 'chat', content: 'both alpha', tags: [] });
    await memory.save({ type: 'chat', content: 'orbital navigation guidance', tags: [] });

    const results = await memory.retrieveForChat('alpha', 5);
    const repeated = await memory.retrieveForChat('alpha', 5);
    assert.deepEqual(results.map(result => result.id), repeated.map(result => result.id));
    assert.equal(new Set(results.map(result => result.id)).size, results.length);
    assert.equal(results.filter(result => result.id === bothId).length, 1);
    assert.equal(results.find(result => result.id === bothId)?.rank !== undefined, true);
    assert.equal(results.find(result => result.id === bothId)?.semanticScore !== undefined, true);
  } finally {
    db.close();
  }
});

test('embedding failures and corrupt vectors fall back to unchanged lexical results', async () => {
  const failing = fakeEmbeddings({ throwOnEmbed: new Error('Ollama offline') });
  const { db, memory } = openMemory({ embeddingProvider: failing });

  try {
    const id = await memory.save({ type: 'chat', content: 'Keep the local FTS index', tags: ['fts'] });
    await memory.save({ type: 'chat', content: 'Local FTS results must remain ordered', tags: ['fts'] });
    const lexicalOne = memory.search('local FTS', 1);
    const lexicalFive = memory.search('local FTS', 5);
    assert.deepEqual(await memory.retrieveForChat('local FTS', 1), lexicalOne);
    assert.deepEqual(await memory.retrieveForChat('local FTS', 5), lexicalFive);
    assert.equal(embeddingRows(db, id).length, 0);

    const working = fakeEmbeddings({ vectorFor: input => input.includes('local FTS') ? [1, 0] : [1, 0] });
    const indexed = new MemoryService(db, { embeddingProvider: working });
    await indexed.reindexEmbeddings();
    db.prepare('UPDATE memory_embeddings SET vector = ?, dimensions = ?')
      .run(Buffer.from([0, 0, 0]), 2);
    assert.deepEqual(await indexed.retrieveForChat('local FTS', 5), lexicalFive);
  } finally {
    db.close();
  }
});

test('chat retrieval bounds invalid limits and keeps the lexical baseline when no semantic vector matches', async () => {
  const embeddings = fakeEmbeddings({ vectorFor: input => input === 'dimension mismatch' ? [1, 0, 0] : [1, 0] });
  const { db, memory } = openMemory({ embeddingProvider: embeddings });

  try {
    await memory.save({ type: 'chat', content: 'dimension mismatch fixture', tags: [] });
    const lexical = memory.search('dimension mismatch', 5);
    assert.deepEqual(await memory.retrieveForChat('dimension mismatch', Number.POSITIVE_INFINITY), lexical);
    assert.deepEqual(await memory.retrieveForChat('dimension mismatch', Number.NaN), lexical);

    assert.deepEqual(await memory.retrieveForChat('dimension mismatch', 5), lexical);
    assert.equal(embeddingRows(db).length, 0);

    const backfill = await memory.reindexEmbeddings();
    assert.equal(backfill.indexed, 1);
  } finally {
    db.close();
  }
});

test('update, remove, and supersede invalidate incompatible vectors and preserve lifecycle cleanup', async () => {
  const embeddings = fakeEmbeddings({
    vectorFor: input => input.includes('blue') ? [0, 1] : [1, 0],
  });
  const { db, memory } = openMemory({ embeddingProvider: embeddings });

  try {
    const id = await memory.save({ type: 'chat', content: 'green preference', tags: ['color'] });
    const originalHash = embeddingRows(db, id)[0].content_hash;

    assert.equal(memory.update(id, { content: 'blue preference', tags: [] }), true);
    await new Promise<void>(resolve => setImmediate(resolve));
    const [updated] = embeddingRows(db, id);
    assert.notEqual(updated.content_hash, originalHash);
    assert.equal(memory.search('blue preference')[0].id, id);

    assert.equal(memory.remove(id), true);
    assert.equal(embeddingRows(db, id).length, 0);

    const oldId = await memory.save({ type: 'chat', content: 'old answer', tags: [] });
    const replacementId = memory.supersede(oldId, { type: 'chat', content: 'new answer', tags: [] }, 'corrected');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(memory.get(oldId)?.status, 'superseded');
    assert.equal(embeddingRows(db, oldId).length, 0);
    assert.equal(embeddingRows(db, replacementId).length, 1);
  } finally {
    db.close();
  }
});

test('reindex batches missing vectors, reports progress, and remains single-flight', async () => {
  const embeddings = fakeEmbeddings({ vectorFor: input => [input.length, 1] });
  const { db, memory } = openMemory({ embeddingProvider: embeddings, backfillBatchSize: 2 });

  try {
    memory.saveSync({ type: 'chat', content: 'one', tags: [] });
    memory.saveSync({ type: 'chat', content: 'two', tags: [] });
    memory.saveSync({ type: 'chat', content: 'three', tags: [] });

    const first = memory.reindexEmbeddings();
    const second = memory.reindexEmbeddings();
    assert.strictEqual(first, second);
    const result = await first;

    assert.equal(result.status, 'completed');
    assert.equal(result.indexed, 3);
    assert.equal(result.failed, 0);
    assert.deepEqual(embeddings.batches.map(batch => batch.length), [2, 1]);
    assert.equal(result.progress.indexed, 3);
    assert.equal(result.progress.pending, 0);
    assert.equal(result.progress.modelRevision, 'sha256:test');

    const status = await memory.getEmbeddingStatus();
    assert.equal(status.health.status, 'online');
    assert.equal(status.reindex.status, 'completed');
  } finally {
    db.close();
  }
});

test('a successful retry clears the prior reindex failure from its public status', async () => {
  const embeddings = fakeEmbeddings();
  let fail = true;
  embeddings.embedMany = async function embedMany(inputs: readonly string[]): Promise<number[][]> {
    this.batches.push([...inputs]);
    if (fail) throw new Error('Ollama temporarily unavailable');
    return inputs.map(() => [1, 0]);
  };
  const { db, memory } = openMemory({ embeddingProvider: embeddings });

  try {
    memory.saveSync({ type: 'chat', content: 'retry fixture', tags: [] });
    const first = await memory.reindexEmbeddings();
    assert.equal(first.status, 'failed');
    assert.match(first.message ?? '', /temporarily unavailable/);

    fail = false;
    const second = await memory.reindexEmbeddings();
    assert.equal(second.status, 'completed');
    assert.equal(second.message, undefined);
    assert.equal(second.progress.lastError, undefined);
  } finally {
    db.close();
  }
});

test('a model change leaves old vectors unused until the current model is reindexed', async () => {
  const firstProvider = fakeEmbeddings({ model: 'model-a', revision: 'rev-a' });
  const { db, memory } = openMemory({ embeddingProvider: firstProvider });

  try {
    const id = memory.saveSync({ type: 'chat', content: 'A private detail', tags: [] });
    await memory.reindexEmbeddings();
    assert.equal(embeddingRows(db, id)[0].model, 'model-a');

    const secondProvider = fakeEmbeddings({ model: 'model-b', revision: 'rev-b' });
    const switched = new MemoryService(db, { embeddingProvider: secondProvider });
    assert.deepEqual(await switched.retrieveForChat('private detail', 5), memory.search('private detail'));

    const result = await switched.reindexEmbeddings();
    assert.equal(result.indexed, 1);
    assert.deepEqual(embeddingRows(db, id).map(row => row.model).sort(), ['model-a', 'model-b']);
  } finally {
    db.close();
  }
});

// --- consolidation primitives ----------------------------------------------------

function accessCounts(db: Database.Database): Map<string, number> {
  const rows = db.prepare('SELECT id, accessCount FROM memories').all() as Array<{ id: string; accessCount: number }>;
  return new Map(rows.map(row => [row.id, row.accessCount]));
}

test('markRetrieved bumps accessCount once per unique id and ignores empty input', () => {
  const { db, memory } = openMemory();

  try {
    const first = memory.saveSync({ type: 'chat', content: 'first memory', tags: [] });
    const second = memory.saveSync({ type: 'chat', content: 'second memory', tags: [] });

    memory.markRetrieved([first, second, first]);
    memory.markRetrieved([first]);
    memory.markRetrieved([]);

    const counts = accessCounts(db);
    assert.equal(counts.get(first), 2);
    assert.equal(counts.get(second), 1);
  } finally {
    db.close();
  }
});

test('findDuplicatePairs pairs same-model near-duplicates keeping the newer memory, at most once each', async () => {
  const embeddings = fakeEmbeddings({
    vectorFor: input => {
      if (input.includes('tea over coffee')) return [1, 0, 0];
      if (input.includes('tea rather than coffee')) return [0.999, 0.0447, 0];
      return [0, 0, 1];
    },
  });
  const { db, memory } = openMemory({ embeddingProvider: embeddings });

  try {
    const olderId = await memory.save({ type: 'preference', content: 'The user prefers tea over coffee.', tags: ['auto'] });
    const newerId = await memory.save({ type: 'preference', content: 'User prefers tea rather than coffee.', tags: ['auto'] });
    const distinctId = await memory.save({ type: 'fact', content: 'The user lives in Austin.', tags: ['auto'] });
    db.prepare('UPDATE memories SET created = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', olderId);
    db.prepare('UPDATE memories SET created = ? WHERE id = ?').run('2026-02-01T00:00:00.000Z', newerId);

    const pairs = memory.findDuplicatePairs(0.95);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].keepId, newerId);
    assert.equal(pairs[0].dropId, olderId);
    assert.ok(pairs[0].similarity >= 0.95);
    assert.ok(pairs.every(pair => pair.dropId !== distinctId && pair.keepId !== distinctId));

    // A stricter threshold finds nothing.
    assert.deepEqual(memory.findDuplicatePairs(0.9999), []);
  } finally {
    db.close();
  }
});

test('markDuplicate supersedes the drop memory, cleans its index rows, and records history', async () => {
  const embeddings = fakeEmbeddings({
    vectorFor: input => input.includes('tea') ? [1, 0] : [0, 1],
  });
  const { db, memory } = openMemory({ embeddingProvider: embeddings });

  try {
    const dropId = await memory.save({ type: 'preference', content: 'The user prefers tea over coffee.', tags: ['auto'] });
    const keepId = await memory.save({ type: 'preference', content: 'User drinks tea, not coffee.', tags: ['auto'] });
    const otherId = await memory.save({ type: 'fact', content: 'The user lives in Austin.', tags: ['auto'] });

    assert.equal(memory.markDuplicate(dropId, keepId), true);

    const dropped = db.prepare('SELECT * FROM memories WHERE id = ?').get(dropId) as { status: string; supersededBy: string };
    assert.equal(dropped.status, 'superseded');
    assert.equal(dropped.supersededBy, keepId);
    assert.equal(embeddingRows(db, dropId).length, 0);
    assert.deepEqual(db.prepare('SELECT id FROM memories_fts WHERE id = ?').all(dropId), []);

    const history = memory.history(dropId);
    const entry = history.find(item => item.changeType === 'consolidate-duplicate');
    assert.ok(entry, 'expected a consolidate-duplicate history row');
    assert.match(entry.reason ?? '', new RegExp(`near-duplicate of ${keepId}`));

    // The kept and unrelated memories stay active and indexed.
    const keep = db.prepare('SELECT status FROM memories WHERE id = ?').get(keepId) as { status: string };
    const other = db.prepare('SELECT status FROM memories WHERE id = ?').get(otherId) as { status: string };
    assert.equal(keep.status, 'active');
    assert.equal(other.status, 'active');
    assert.equal(embeddingRows(db, keepId).length, 1);

    assert.equal(memory.markDuplicate('missing-id', keepId), false);
  } finally {
    db.close();
  }
});

test('archiveStaleAuto archives only old, never-retrieved, auto-tagged memories', () => {
  const { db, memory } = openMemory();

  try {
    const nowMs = Date.parse('2026-07-07T12:00:00.000Z');
    const oldIso = '2026-05-01T00:00:00.000Z';
    const freshIso = '2026-07-01T00:00:00.000Z';

    const staleAuto = memory.saveSync({ type: 'fact', content: 'stale auto memory', tags: ['auto'] });
    const accessedAuto = memory.saveSync({ type: 'fact', content: 'accessed auto memory', tags: ['auto'] });
    const manualOld = memory.saveSync({ type: 'chat', content: 'old manual memory', tags: ['chat', 'explicit'] });
    const freshAuto = memory.saveSync({ type: 'fact', content: 'fresh auto memory', tags: ['auto'] });
    const setCreated = db.prepare('UPDATE memories SET created = ? WHERE id = ?');
    setCreated.run(oldIso, staleAuto);
    setCreated.run(oldIso, accessedAuto);
    setCreated.run(oldIso, manualOld);
    setCreated.run(freshIso, freshAuto);
    memory.markRetrieved([accessedAuto]);

    const archived = memory.archiveStaleAuto(30, nowMs);
    assert.deepEqual(archived, [staleAuto]);

    const status = (id: string) => (db.prepare('SELECT status FROM memories WHERE id = ?').get(id) as { status: string }).status;
    assert.equal(status(staleAuto), 'archived');
    assert.equal(status(accessedAuto), 'active');
    assert.equal(status(manualOld), 'active');
    assert.equal(status(freshAuto), 'active');
  } finally {
    db.close();
  }
});
