import assert from 'node:assert/strict';
import test from 'node:test';
import { OllamaChatStreamAssembler, OllamaStreamError } from './ollama-stream.ts';
import { LLMService } from '../llm.ts';
import type { ForgeConfig } from '../../types.ts';

function chunkLine(content: string): string {
  return JSON.stringify({ model: 'local-model', message: { role: 'assistant', content }, done: false }) + '\n';
}

function doneLine(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'local-model',
    message: { role: 'assistant', content: '' },
    done: true,
    prompt_eval_count: 11,
    eval_count: 6,
    ...extra,
  }) + '\n';
}

test('assembler emits tokens in order and assembles the full reply', () => {
  const assembler = new OllamaChatStreamAssembler();
  const tokens = [
    ...assembler.push(chunkLine('Hel')),
    ...assembler.push(chunkLine('lo') + chunkLine(' world')),
    ...assembler.push(doneLine()),
    ...assembler.end(),
  ];

  assert.deepEqual(tokens, ['Hel', 'lo', ' world']);
  assert.deepEqual(assembler.result(), {
    content: 'Hello world',
    model: 'local-model',
    inputTokens: 11,
    outputTokens: 6,
  });
});

test('assembler handles JSON lines split across arbitrary chunk boundaries', () => {
  const raw = chunkLine('to') + chunkLine('ken') + doneLine();
  const assembler = new OllamaChatStreamAssembler();
  const tokens: string[] = [];

  // Feed one byte at a time: no chunk ever contains a complete JSON line.
  for (const char of raw) {
    tokens.push(...assembler.push(char));
  }
  tokens.push(...assembler.end());

  assert.deepEqual(tokens, ['to', 'ken']);
  assert.equal(assembler.result().content, 'token');
});

test('assembler flushes a trailing done line that has no final newline', () => {
  const assembler = new OllamaChatStreamAssembler();
  assert.deepEqual(assembler.push(chunkLine('hi')), ['hi']);

  const trailing = JSON.stringify({ message: { content: '!' }, done: true, prompt_eval_count: 2, eval_count: 3 });
  assert.deepEqual(assembler.push(trailing), []);
  assert.deepEqual(assembler.end(), ['!']);

  const result = assembler.result();
  assert.equal(result.content, 'hi!');
  assert.equal(result.inputTokens, 2);
  assert.equal(result.outputTokens, 3);
});

test('assembler ignores blank lines and empty content chunks', () => {
  const assembler = new OllamaChatStreamAssembler();
  const tokens = [
    ...assembler.push('\n\n'),
    ...assembler.push(JSON.stringify({ message: { content: '' }, done: false }) + '\n'),
    ...assembler.push(chunkLine('only')),
    ...assembler.push(doneLine()),
    ...assembler.end(),
  ];

  assert.deepEqual(tokens, ['only']);
  assert.equal(assembler.result().content, 'only');
});

test('assembler defaults token counts to zero when the done chunk omits them', () => {
  const assembler = new OllamaChatStreamAssembler();
  assembler.push(chunkLine('x'));
  assembler.push(JSON.stringify({ message: { content: '' }, done: true }) + '\n');

  const result = assembler.result();
  assert.equal(result.inputTokens, 0);
  assert.equal(result.outputTokens, 0);
});

test('assembler throws a typed error on a mid-stream Ollama error chunk', () => {
  const assembler = new OllamaChatStreamAssembler();
  assembler.push(chunkLine('partial'));

  assert.throws(
    () => assembler.push(JSON.stringify({ error: 'model crashed' }) + '\n'),
    (err: unknown) => err instanceof OllamaStreamError && /model crashed/.test(err.message),
  );
});

test('assembler throws a typed error on malformed stream chunks', () => {
  assert.throws(
    () => new OllamaChatStreamAssembler().push('not-json\n'),
    (err: unknown) => err instanceof OllamaStreamError && /invalid streaming chunk/.test(err.message),
  );
  assert.throws(
    () => new OllamaChatStreamAssembler().push('[1,2,3]\n'),
    (err: unknown) => err instanceof OllamaStreamError && /invalid streaming chunk/.test(err.message),
  );
});

test('assembler result() throws when the stream ended before a done chunk', () => {
  const assembler = new OllamaChatStreamAssembler();
  assembler.push(chunkLine('cut off'));
  assembler.end();

  assert.throws(
    () => assembler.result(),
    (err: unknown) => err instanceof OllamaStreamError && /ended before completion/.test(err.message),
  );
});

// --- LLMService.completeStream wiring ---------------------------------------

function config(): ForgeConfig {
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
  };
}

function ndjsonResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
}

test('completeStream requests stream:true, emits tokens, and matches complete() response shape', async () => {
  let requestBody: { stream?: boolean; model?: string } = {};
  const fetchMock: typeof fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean; model?: string };
    return ndjsonResponse([chunkLine('Hel'), chunkLine('lo'), doneLine()]);
  };
  const service = new LLMService(config(), { fetchImpl: fetchMock });

  const tokens: string[] = [];
  const res = await service.completeStream(
    { system: 'system', messages: [{ role: 'user', content: 'hello' }] },
    { onToken: token => tokens.push(token) },
  );

  assert.equal(requestBody.stream, true);
  assert.equal(requestBody.model, 'local-model');
  assert.deepEqual(tokens, ['Hel', 'lo']);
  assert.deepEqual(res, { content: 'Hello', provider: 'ollama', model: 'local-model', inputTokens: 11, outputTokens: 6 });
});

test('completeStream surfaces mid-stream Ollama error chunks as errors', async () => {
  const fetchMock: typeof fetch = async () =>
    ndjsonResponse([chunkLine('par'), JSON.stringify({ error: 'out of memory' }) + '\n']);
  const service = new LLMService(config(), { fetchImpl: fetchMock });

  await assert.rejects(
    service.completeStream({ system: '', messages: [{ role: 'user', content: 'hi' }] }),
    /out of memory/,
  );
});

test('completeStream fails when the stream ends without a done chunk', async () => {
  const fetchMock: typeof fetch = async () => ndjsonResponse([chunkLine('cut')]);
  const service = new LLMService(config(), { fetchImpl: fetchMock });

  await assert.rejects(
    service.completeStream({ system: '', messages: [{ role: 'user', content: 'hi' }] }),
    /ended before completion/,
  );
});

test('completeStream rethrows aborts instead of reporting Ollama offline', async () => {
  const fetchMock: typeof fetch = async () => {
    const err = new Error('This operation was aborted');
    err.name = 'AbortError';
    throw err;
  };
  const service = new LLMService(config(), { fetchImpl: fetchMock });

  await assert.rejects(
    service.completeStream({ system: '', messages: [{ role: 'user', content: 'hi' }] }),
    (err: unknown) => err instanceof Error && err.name === 'AbortError',
  );
});

test('completeStream maps non-ok responses to the same clear errors as complete()', async () => {
  const missingModel: typeof fetch = async () =>
    new Response(JSON.stringify({ error: 'model "local-model" not found' }), { status: 404 });
  await assert.rejects(
    new LLMService(config(), { fetchImpl: missingModel })
      .completeStream({ system: '', messages: [{ role: 'user', content: 'hi' }] }),
    /does not appear to be installed/,
  );

  const offline: typeof fetch = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(
    new LLMService(config(), { fetchImpl: offline })
      .completeStream({ system: '', messages: [{ role: 'user', content: 'hi' }] }),
    /Ollama is not reachable/,
  );
});
