import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3';
import { chunkCsv, chunkText, estimateTokens } from './chunker.ts';
import { RagService } from './rag.ts';
import { documentsRoutes } from '../../web/routes/documents.ts';
import type { EmbeddingHealth, ForgeConfig, RagConfig } from '../../types.ts';
import type { EmbeddingProvider } from '../ollama-embeddings.ts';

const SCHEMA = fs.readFileSync(new URL('../../db/schemas/documents.sql', import.meta.url), 'utf-8');

function config(rag: Partial<RagConfig> = {}): ForgeConfig {
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
    rag: {
      enabled: true,
      chunk_tokens: 400,
      chunk_overlap_tokens: 50,
      top_k: 4,
      min_similarity: 0.35,
      max_context_tokens: 1500,
      ...rag,
    },
  };
}

function fakeEmbeddings(vectorFor: (input: string) => number[], options: { throwOnEmbed?: Error; throwOnEmbedMany?: Error } = {}): EmbeddingProvider {
  const health: EmbeddingHealth = {
    provider: 'ollama', enabled: true, model: 'test-embeddings', baseUrl: 'http://localhost:11434',
    ok: true, status: 'online', installedModels: ['test-embeddings'],
  };
  return {
    enabled: true,
    model: 'test-embeddings',
    async embed(input: string) {
      if (options.throwOnEmbed) throw options.throwOnEmbed;
      return vectorFor(input);
    },
    async embedMany(inputs: readonly string[]) {
      if (options.throwOnEmbedMany) throw options.throwOnEmbedMany;
      return inputs.map(vectorFor);
    },
    async health() { return health; },
  };
}

function topicVector(input: string): number[] {
  // Orthogonal topics: rockets vs. recipes; queries and chunks share direction by keyword.
  const rockets = /rocket|thrust|engine/i.test(input) ? 1 : 0;
  const recipes = /recipe|flour|oven/i.test(input) ? 1 : 0;
  if (rockets === 0 && recipes === 0) return [0.01, 0.01];
  return [rockets, recipes];
}

function openRag(rag: Partial<RagConfig> = {}, embeddings: EmbeddingProvider | undefined = fakeEmbeddings(topicVector)) {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return { db, rag: new RagService({ db, config: config(rag), embeddings }) };
}

// --- Chunker -------------------------------------------------------------------

test('chunkText keeps short text as a single chunk and empty text as none', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n\n  '), []);
  const chunks = chunkText('One short paragraph.');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].content, 'One short paragraph.');
  assert.equal(chunks[0].tokenEstimate, estimateTokens('One short paragraph.'));
});

test('chunkText splits long text into bounded chunks with overlap and preserves content', () => {
  const paragraphs = Array.from({ length: 20 }, (_, i) =>
    `Paragraph ${i} discusses topic number ${i} in enough words to give it some real length for chunking.`);
  const text = paragraphs.join('\n\n');
  const chunkTokens = 80;
  const overlapTokens = 20;
  const chunks = chunkText(text, { chunkTokens, overlapTokens });

  assert.ok(chunks.length > 1, 'expected multiple chunks');
  for (const chunk of chunks) {
    assert.ok(
      chunk.tokenEstimate <= chunkTokens + overlapTokens + 2,
      `chunk of ${chunk.tokenEstimate} tokens exceeds bound`,
    );
  }
  // Every paragraph survives chunking in at least one chunk.
  for (const paragraph of paragraphs) {
    assert.ok(chunks.some(chunk => chunk.content.includes(paragraph)), `lost: ${paragraph}`);
  }
  // Overlap: each later chunk begins with text carried from its predecessor.
  for (let i = 1; i < chunks.length; i += 1) {
    const head = chunks[i].content.slice(0, 20);
    assert.ok(chunks[i - 1].content.includes(head), `chunk ${i} does not overlap its predecessor`);
  }
});

test('chunkText hard-splits a single oversized run of text', () => {
  const wall = 'x'.repeat(3000);
  const chunks = chunkText(wall, { chunkTokens: 100, overlapTokens: 0 });
  assert.ok(chunks.length > 1);
  assert.equal(chunks.map(c => c.content).join(''), wall);
});

test('chunkCsv repeats the header row in every chunk', () => {
  const header = 'name,city,role';
  const rows = Array.from({ length: 60 }, (_, i) => `person-${i},city-${i},role-${i}`);
  const chunks = chunkCsv([header, ...rows].join('\n'), { chunkTokens: 100 });

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.content.startsWith(`${header}\n`), 'chunk missing header');
  }
  const rejoined = chunks.flatMap(c => c.content.split('\n').slice(1));
  assert.deepEqual(rejoined, rows);
});

// --- Ingest + retrieve ----------------------------------------------------------

const ROCKET_DOC = [
  'Rocket engines produce thrust by expelling mass at high velocity.',
  'The main engine uses a staged combustion cycle for higher thrust efficiency.',
].join('\n\n');

const RECIPE_DOC = [
  'This bread recipe needs flour, water, salt, and yeast.',
  'Bake the loaf in a hot oven for forty minutes following the recipe.',
].join('\n\n');

test('ingest chunks, embeds, and stores a document; retrieve returns the right topic first', async () => {
  const { db, rag } = openRag({ chunk_tokens: 30, chunk_overlap_tokens: 0 });

  const rocket = await rag.ingest({ name: 'rockets.md', data: Buffer.from(ROCKET_DOC) });
  const recipe = await rag.ingest({ name: 'bread.txt', data: Buffer.from(RECIPE_DOC) });

  assert.equal(rocket.status, 'ready');
  assert.equal(recipe.status, 'ready');
  assert.ok(rocket.chunkCount >= 2);
  const storedChunks = db.prepare('SELECT COUNT(*) AS n FROM document_chunks').get() as { n: number };
  assert.equal(storedChunks.n, rocket.chunkCount + recipe.chunkCount);

  const results = await rag.retrieve('How does a rocket engine make thrust?');
  assert.ok(results.length >= 1);
  for (const result of results) {
    assert.equal(result.documentName, 'rockets.md');
    assert.ok(result.similarity >= 0.35);
    assert.match(result.content, /thrust|engine|Rocket/);
  }
  db.close();
});

test('retrieve respects top_k and the injected token budget cap', async () => {
  const { db, rag } = openRag({ chunk_tokens: 40, chunk_overlap_tokens: 0, top_k: 2, max_context_tokens: 45 });
  const doc = Array.from({ length: 6 }, (_, i) =>
    `Rocket fact ${i}: the engine generates thrust with details ${i}.`).join('\n\n');
  await rag.ingest({ name: 'rockets.md', data: Buffer.from(doc) });

  const results = await rag.retrieve('rocket engine thrust');
  // top_k allows 2, but the 45-token cap only fits one ~30-token chunk.
  assert.equal(results.length, 1);
  assert.ok(results[0].tokenEstimate <= 45);
  db.close();
});

test('retrieve truncates a single oversized top chunk instead of dropping it', async () => {
  const { db, rag } = openRag({ chunk_tokens: 400, chunk_overlap_tokens: 0, max_context_tokens: 20 });
  await rag.ingest({
    name: 'rockets.md',
    data: Buffer.from(`Rocket engine thrust. ${'Additional engine thrust detail. '.repeat(30)}`),
  });

  const results = await rag.retrieve('rocket engine thrust');
  assert.equal(results.length, 1);
  assert.ok(results[0].tokenEstimate <= 21, `expected truncation, got ${results[0].tokenEstimate} tokens`);
  assert.ok(results[0].content.endsWith('…'));
  db.close();
});

test('retrieve filters by min_similarity and returns [] for unrelated queries', async () => {
  const { db, rag } = openRag();
  await rag.ingest({ name: 'bread.txt', data: Buffer.from(RECIPE_DOC) });

  const results = await rag.retrieve('How does a rocket engine make thrust?');
  assert.deepEqual(results, []);
  db.close();
});

test('retrieve is inert when rag is disabled and safe when the query embed fails', async () => {
  const disabled = openRag({ enabled: false });
  await disabled.rag.ingest({ name: 'rockets.md', data: Buffer.from(ROCKET_DOC) });
  assert.deepEqual(await disabled.rag.retrieve('rocket thrust'), []);
  disabled.db.close();

  const failing = openRag({}, fakeEmbeddings(topicVector, { throwOnEmbed: new Error('embed offline') }));
  await failing.rag.ingest({ name: 'rockets.md', data: Buffer.from(ROCKET_DOC) });
  assert.deepEqual(await failing.rag.retrieve('rocket thrust'), []);
  failing.db.close();
});

test('ingest records a failed document when embeddings are unavailable or failing', async () => {
  // Constructed without an embeddings provider at all (not via openRag, whose
  // default parameter would kick in for an explicit undefined).
  const bareDb = new Database(':memory:');
  bareDb.exec(SCHEMA);
  const bareRag = new RagService({ db: bareDb, config: config() });
  const missing = await bareRag.ingest({ name: 'rockets.md', data: Buffer.from(ROCKET_DOC) });
  assert.equal(missing.status, 'failed');
  assert.match(missing.error ?? '', /requires memory\.embeddings/);
  bareDb.close();

  const broken = openRag({}, fakeEmbeddings(topicVector, { throwOnEmbedMany: new Error('boom') }));
  const failed = await broken.rag.ingest({ name: 'rockets.md', data: Buffer.from(ROCKET_DOC) });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /Embedding failed: boom/);
  assert.equal((broken.db.prepare('SELECT COUNT(*) AS n FROM document_chunks').get() as { n: number }).n, 0);
  // The failed document is still listed so the UI can surface the error.
  assert.equal(broken.rag.list().length, 1);
  broken.db.close();

  const empty = openRag();
  const blank = await empty.rag.ingest({ name: 'blank.txt', data: Buffer.from('   ') });
  assert.equal(blank.status, 'failed');
  assert.match(blank.error ?? '', /No extractable text/);
  empty.db.close();
});

test('remove deletes the document and all of its chunks', async () => {
  const { db, rag } = openRag();
  const doc = await rag.ingest({ name: 'rockets.md', data: Buffer.from(ROCKET_DOC) });

  assert.equal(rag.remove(doc.id), true);
  assert.equal(rag.list().length, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM document_chunks').get() as { n: number }).n, 0);
  assert.deepEqual(await rag.retrieve('rocket engine thrust'), []);
  assert.equal(rag.remove(doc.id), false);
  db.close();
});

// --- Upload/list/delete routes ---------------------------------------------------

test('documents routes: upload, list, and delete round-trip', async () => {
  const { db, rag } = openRag();
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/documents', documentsRoutes({ config: config(), rag } as never));

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const url = `http://127.0.0.1:${address.port}/api/documents`;

  try {
    const upload = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'rockets.md', data: Buffer.from(ROCKET_DOC).toString('base64') }),
    });
    assert.equal(upload.status, 200);
    const uploaded = await upload.json() as { document: { id: string; status: string; chunkCount: number } };
    assert.equal(uploaded.document.status, 'ready');
    assert.ok(uploaded.document.chunkCount >= 1);

    const badType = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'evil.exe', data: 'aGk=' }),
    });
    assert.equal(badType.status, 400);

    const list = await (await fetch(url)).json() as { documents: Array<{ id: string }>; rag: { enabled: boolean } };
    assert.equal(list.documents.length, 1);
    assert.equal(list.rag.enabled, true);

    const del = await fetch(`${url}/${uploaded.document.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const missing = await fetch(`${url}/${uploaded.document.id}`, { method: 'DELETE' });
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    db.close();
  }
});
