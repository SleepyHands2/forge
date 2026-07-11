import assert from 'node:assert/strict';
import test from 'node:test';
import { LLMService } from './llm.ts';
import type { ForgeConfig } from '../types.ts';

function config(overrides: Partial<ForgeConfig> = {}): ForgeConfig {
  return {
    forge: { name: 'forge-local', version: '0.1.0', root: '.' },
    user: { name: 'tester' },
    llm: {
      provider: 'ollama',
      model: 'local-model',
      ollama: { base_url: 'http://localhost:11434', keep_alive: '10m', options: { temperature: 0.7 } },
    },
    paths: { dbs: './dbs', identity: './identity', logs: './logs' },
    services: { web: { host: '127.0.0.1', port: 6800, context_window_tokens: 80000, debug_prompt_context: false } },
    memory: { retention_days: 30 },
    ...overrides,
  };
}

test('LLMService calls Ollama and maps token counts', async () => {
  let payload: { url: string | URL | Request; init: { stream: boolean; model: string; messages: Array<{ role: string; content: string }> } } | undefined;
  const fetchMock: typeof fetch = async (url, init) => {
    payload = { url, init: JSON.parse(String(init?.body ?? '{}')) as { stream: boolean; model: string; messages: Array<{ role: string; content: string }> } };
    return new Response(JSON.stringify({ message: { content: 'hi local' }, prompt_eval_count: 11, eval_count: 6 }), { status: 200 });
  };
  const service = new LLMService(config(), { fetchImpl: fetchMock });

  const res = await service.complete({ system: 'system', messages: [{ role: 'user', content: 'hello' }] });
  assert.ok(payload);
  assert.equal(payload.url, 'http://localhost:11434/api/chat');
  assert.equal(payload.init.stream, false);
  assert.equal(payload.init.model, 'local-model');
  assert.deepEqual(payload.init.messages, [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello' },
  ]);
  assert.deepEqual(res, { content: 'hi local', provider: 'ollama', model: 'local-model', inputTokens: 11, outputTokens: 6 });
});

test('LLMService preserves existing system and assistant messages', async () => {
  let messages: Array<{ role: string; content: string }> = [];
  const fetchMock: typeof fetch = async (_url, init) => {
    messages = JSON.parse(String(init?.body ?? '{}')).messages;
    return new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 });
  };
  const service = new LLMService(config(), { fetchImpl: fetchMock });

  await service.complete({
    system: 'top system',
    messages: [
      { role: 'system', content: 'message system' },
      { role: 'assistant', content: 'prior reply' },
      { role: 'user', content: 'next' },
    ],
  });

  assert.deepEqual(messages, [
    { role: 'system', content: 'message system' },
    { role: 'assistant', content: 'prior reply' },
    { role: 'user', content: 'next' },
  ]);
});

test('LLMService sends images only on Ollama user messages', async () => {
  let messages: Array<{ role: string; content: string; images?: string[] }> = [];
  const fetchMock: typeof fetch = async (_url, init) => {
    messages = JSON.parse(String(init?.body ?? '{}')).messages;
    return new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 });
  };
  const service = new LLMService(config(), { fetchImpl: fetchMock });

  await service.complete({
    system: 'system',
    messages: [
      { role: 'system', content: 'message system', images: ['ignored-system'] },
      { role: 'assistant', content: 'prior reply', images: ['ignored-assistant'] },
      { role: 'user', content: 'look', images: ['base64-image'] },
    ],
  });

  assert.deepEqual(messages, [
    { role: 'system', content: 'message system' },
    { role: 'assistant', content: 'prior reply' },
    { role: 'user', content: 'look', images: ['base64-image'] },
  ]);
});

test('LLMService merges per-request options over the configured Ollama options', async () => {
  let options: Record<string, unknown> = {};
  const fetchMock: typeof fetch = async (_url, init) => {
    options = JSON.parse(String(init?.body ?? '{}')).options;
    return new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 });
  };
  const service = new LLMService(config(), { fetchImpl: fetchMock });

  await service.complete({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
    options: { num_predict: 3072, temperature: 0.2 },
  });
  assert.deepEqual(options, { temperature: 0.2, num_predict: 3072 });

  await service.complete({ system: 's', messages: [{ role: 'user', content: 'u' }] });
  assert.deepEqual(options, { temperature: 0.7 });
});

test('LLMService supports explicit request model override', async () => {
  let model = '';
  const fetchMock: typeof fetch = async (_url, init) => {
    model = JSON.parse(String(init?.body ?? '{}')).model;
    return new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 });
  };
  const service = new LLMService(config(), { fetchImpl: fetchMock });

  await service.complete({ system: 's', model: 'other-local-model', messages: [{ role: 'user', content: 'u' }] });
  assert.equal(model, 'other-local-model');
});

test('LLMService returns clear offline error for Ollama', async () => {
  const offlineFetch: typeof fetch = async () => { throw new Error('ECONNREFUSED'); };
  const service = new LLMService(config(), { fetchImpl: offlineFetch });
  await assert.rejects(
    () => service.complete({ system: 's', messages: [{ role: 'user', content: 'u' }] }),
    /Ollama is not reachable at http:\/\/localhost:11434\. Start Ollama and run: ollama run local-model/,
  );
});

test('LLMService rejects invalid JSON and missing message content clearly', async () => {
  const invalidJsonFetch: typeof fetch = async () => new Response('not json', { status: 200 });
  await assert.rejects(
    () => new LLMService(config(), { fetchImpl: invalidJsonFetch }).complete({ system: 's', messages: [{ role: 'user', content: 'u' }] }),
    /Ollama returned invalid JSON\. Check Ollama logs\./,
  );

  const missingContentFetch: typeof fetch = async () => new Response(JSON.stringify({ message: {} }), { status: 200 });
  await assert.rejects(
    () => new LLMService(config(), { fetchImpl: missingContentFetch }).complete({ system: 's', messages: [{ role: 'user', content: 'u' }] }),
    /Ollama response missing message\.content\./,
  );
});

test('LLMService health reports missing configured model', async () => {
  const fetchMock: typeof fetch = async () => new Response(JSON.stringify({ models: [{ name: 'different-model' }] }), { status: 200 });
  const service = new LLMService(config(), { fetchImpl: fetchMock });

  const health = await service.health();
  assert.equal(health.ok, false);
  assert.equal(health.status, 'error');
  assert.deepEqual(health.installedModels, ['different-model']);
  assert.match(health.message || '', /model local-model does not appear to be installed/);
});

test('LLMService health classifies Ollama network and protocol failures', async () => {
  const offlineFetch: typeof fetch = async () => { throw new Error('ECONNREFUSED'); };
  const offline = await new LLMService(config(), { fetchImpl: offlineFetch }).health();
  assert.equal(offline.status, 'offline');
  assert.match(offline.message || '', /Ollama is not reachable/);

  const httpFetch: typeof fetch = async () => new Response('server error', { status: 500 });
  const httpError = await new LLMService(config(), { fetchImpl: httpFetch }).health();
  assert.equal(httpError.status, 'error');
  assert.match(httpError.message || '', /HTTP 500/);

  const invalidJsonFetch: typeof fetch = async () => new Response('not json', { status: 200 });
  const invalidJson = await new LLMService(config(), { fetchImpl: invalidJsonFetch }).health();
  assert.equal(invalidJson.status, 'error');
  assert.match(invalidJson.message || '', /invalid JSON/);
});

test('LLMService lists installed Ollama models', async () => {
  const fetchMock: typeof fetch = async () => new Response(JSON.stringify({
    models: [{ name: 'llama3.2' }, { model: 'gemma3' }],
  }), { status: 200 });
  const service = new LLMService(config(), { fetchImpl: fetchMock });

  assert.deepEqual(await service.listModels(), ['llama3.2', 'gemma3']);
});
