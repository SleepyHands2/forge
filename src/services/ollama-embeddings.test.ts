import assert from 'node:assert/strict';
import test from 'node:test';
import type { ForgeConfig } from '../types.ts';
import { OllamaEmbeddingError, OllamaEmbeddingProvider } from './ollama-embeddings.ts';

function config(overrides: Partial<ForgeConfig> = {}): ForgeConfig {
  return {
    forge: { name: 'forge-local', version: '0.1.0', root: '.' },
    user: { name: 'tester' },
    llm: {
      provider: 'ollama',
      model: 'chat-model',
      ollama: { base_url: 'http://localhost:11434/', keep_alive: '10m', options: {} },
    },
    paths: { dbs: './dbs', identity: './identity', logs: './logs' },
    services: { web: { host: '127.0.0.1', port: 6800, context_window_tokens: 80000, debug_prompt_context: false } },
    memory: {
      retention_days: 30,
      embeddings: {
        enabled: true,
        model: 'local-embedding-model',
        request_timeout_ms: 100,
        backfill_batch_size: 16,
      },
    },
    ...overrides,
  };
}

async function expectError(action: () => Promise<unknown>, code: OllamaEmbeddingError['code']): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof OllamaEmbeddingError && error.code === code);
}

test('OllamaEmbeddingProvider uses the configured local embedding model and validates vectors', async () => {
  let requestedUrl = '';
  let requestedBody: unknown;
  const fetchMock: typeof fetch = async (url, init) => {
    requestedUrl = String(url);
    requestedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ embeddings: [[0.1, -0.2], [3, 4]] }), { status: 200 });
  };
  const provider = new OllamaEmbeddingProvider(config(), { fetchImpl: fetchMock });

  assert.deepEqual(await provider.embedMany(['first', 'second']), [[0.1, -0.2], [3, 4]]);
  assert.equal(requestedUrl, 'http://localhost:11434/api/embed');
  assert.deepEqual(requestedBody, {
    model: 'local-embedding-model',
    input: ['first', 'second'],
  });
  assert.notEqual((requestedBody as { model: string }).model, config().llm.model);
});

test('OllamaEmbeddingProvider rejects malformed, non-finite, and dimension-mismatched vectors', async () => {
  const invalidBodies = [
    { body: { embeddings: [] }, code: 'invalid-response' },
    { body: { embeddings: [[1, Number.NaN]] }, code: 'invalid-response' },
    { body: { embeddings: [[1], [2, 3]] }, code: 'dimension-mismatch' },
  ] as const;

  for (const { body, code } of invalidBodies) {
    const fetchMock: typeof fetch = async () => new Response(JSON.stringify(body), { status: 200 });
    await expectError(() => new OllamaEmbeddingProvider(config(), { fetchImpl: fetchMock }).embedMany(['one', 'two']), code);
  }
});

test('OllamaEmbeddingProvider classifies local request failures with typed errors', async () => {
  const offlineFetch: typeof fetch = async () => { throw new Error('ECONNREFUSED'); };
  await expectError(() => new OllamaEmbeddingProvider(config(), { fetchImpl: offlineFetch }).embed('hello'), 'network');

  const missingModelFetch: typeof fetch = async () => new Response(JSON.stringify({ error: 'model not found' }), { status: 404 });
  await expectError(() => new OllamaEmbeddingProvider(config(), { fetchImpl: missingModelFetch }).embed('hello'), 'missing-model');

  const invalidJsonFetch: typeof fetch = async () => new Response('not json', { status: 200 });
  await expectError(() => new OllamaEmbeddingProvider(config(), { fetchImpl: invalidJsonFetch }).embed('hello'), 'invalid-json');

  const disabled = config();
  disabled.memory.embeddings = { enabled: false, request_timeout_ms: 100, backfill_batch_size: 16 };
  await expectError(() => new OllamaEmbeddingProvider(disabled).embed('hello'), 'disabled');
});

test('OllamaEmbeddingProvider aborts local requests that exceed the configured timeout', async () => {
  const timedOut = config();
  timedOut.memory.embeddings!.request_timeout_ms = 10;
  const timeoutFetch: typeof fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });

  await expectError(() => new OllamaEmbeddingProvider(timedOut, { fetchImpl: timeoutFetch }).embed('hello'), 'timeout');
});

test('OllamaEmbeddingProvider health distinguishes disabled, online, missing, offline, and protocol states', async () => {
  let disabledCalls = 0;
  const disabled = config();
  disabled.memory.embeddings = { enabled: false, request_timeout_ms: 100, backfill_batch_size: 16 };
  const disabledHealth = await new OllamaEmbeddingProvider(disabled, {
    fetchImpl: async () => {
      disabledCalls += 1;
      return new Response();
    },
  }).health();
  assert.equal(disabledHealth.status, 'disabled');
  assert.equal(disabledHealth.ok, false);
  assert.equal(disabledCalls, 0);

  const onlineFetch: typeof fetch = async () => new Response(JSON.stringify({
    models: [{ name: 'local-embedding-model:latest', digest: 'sha256:embedding' }],
  }), { status: 200 });
  const online = await new OllamaEmbeddingProvider(config(), { fetchImpl: onlineFetch }).health();
  assert.equal(online.status, 'online');
  assert.equal(online.ok, true);
  assert.equal(online.modelRevision, 'sha256:embedding');

  const missingFetch: typeof fetch = async () => new Response(JSON.stringify({ models: [{ name: 'other-model' }] }), { status: 200 });
  const missing = await new OllamaEmbeddingProvider(config(), { fetchImpl: missingFetch }).health();
  assert.equal(missing.status, 'missing-model');

  const offlineFetch: typeof fetch = async () => { throw new Error('ECONNREFUSED'); };
  const offline = await new OllamaEmbeddingProvider(config(), { fetchImpl: offlineFetch }).health();
  assert.equal(offline.status, 'offline');

  const invalidJsonFetch: typeof fetch = async () => new Response('not json', { status: 200 });
  const protocol = await new OllamaEmbeddingProvider(config(), { fetchImpl: invalidJsonFetch }).health();
  assert.equal(protocol.status, 'protocol-error');
});
