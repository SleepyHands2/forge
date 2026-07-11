import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAnalyzeImageTool } from './vision.ts';
import { ToolRegistry } from './registry.ts';
import type { ForgeConfig, VisionConfig } from '../../types.ts';

function config(overrides?: { vision?: Partial<VisionConfig>; readableDirs?: string[] }): ForgeConfig {
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
      levels: { safe: false, network: false, filesystem: true, sensitive: false },
      filesystem: { readable_dirs: overrides?.readableDirs ?? [], writable_dirs: [] },
    },
    vision: {
      enabled: true,
      model: 'test-vision:7b',
      num_ctx: 8192,
      num_predict: 700,
      repeat_penalty: 1.15,
      timeout_ms: 5000,
      max_image_bytes: 1_048_576,
      ...overrides?.vision,
    },
  };
}

// realpathSync so the allowlist matches what the tool resolves to (os.tmpdir()
// can itself be a symlink or 8.3 short path).
function makeRoot(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-vision-test-')));
}

function okResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('analyze_image registers cleanly at the filesystem level', () => {
  const registry = new ToolRegistry();
  const tool = createAnalyzeImageTool(config());
  assert.equal(tool.permission, 'filesystem');
  registry.register(tool);
  assert.ok(registry.has('analyze_image'));
});

test('analyze_image sends the image to /api/generate and returns the analysis', async () => {
  const root = makeRoot();
  try {
    const file = path.join(root, 'photo.png');
    fs.writeFileSync(file, Buffer.from('fake-png-bytes'));

    let requestedUrl = '';
    let requestBody: Record<string, unknown> = {};
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(url);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return okResponse({ response: 'A small cat on a windowsill.', done_reason: 'stop' });
    }) as typeof fetch;

    const tool = createAnalyzeImageTool(config({ readableDirs: [root] }), { fetchImpl });
    const result = await tool.handler({ path: file, prompt: 'What animal is this?' }) as Record<string, unknown>;

    assert.equal(requestedUrl, 'http://localhost:11434/api/generate');
    assert.equal(requestBody.model, 'test-vision:7b');
    assert.equal(requestBody.prompt, 'What animal is this?');
    assert.equal(requestBody.stream, false);
    assert.deepEqual(requestBody.images, [Buffer.from('fake-png-bytes').toString('base64')]);
    assert.deepEqual(requestBody.options, { num_ctx: 8192, num_predict: 700, repeat_penalty: 1.15 });

    assert.equal(result.analysis, 'A small cat on a windowsill.');
    assert.equal(result.model, 'test-vision:7b');
    assert.equal(result.done_reason, 'stop');
    assert.equal(result.truncated, false);
    assert.equal(result.path, file);
    assert.equal(typeof result.duration_ms, 'number');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('analyze_image uses the default prompt when none is given', async () => {
  const root = makeRoot();
  try {
    const file = path.join(root, 'scan.jpg');
    fs.writeFileSync(file, Buffer.from('x'));
    let prompt = '';
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      prompt = (JSON.parse(String(init?.body)) as { prompt: string }).prompt;
      return okResponse({ response: 'text', done_reason: 'stop' });
    }) as typeof fetch;
    const tool = createAnalyzeImageTool(config({ readableDirs: [root] }), { fetchImpl });
    await tool.handler({ path: file });
    assert.match(prompt, /Describe this image/);
    assert.match(prompt, /transcribe/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('analyze_image reports truncation when the output cap cut generation short', async () => {
  const root = makeRoot();
  try {
    const file = path.join(root, 'dense.jpg');
    fs.writeFileSync(file, Buffer.from('x'));
    const fetchImpl = (async () => okResponse({ response: 'partial...', done_reason: 'length' })) as typeof fetch;
    const tool = createAnalyzeImageTool(config({ readableDirs: [root] }), { fetchImpl });
    const result = await tool.handler({ path: file }) as Record<string, unknown>;
    assert.equal(result.truncated, true);
    assert.equal(result.done_reason, 'length');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('analyze_image throws while vision.enabled is false', async () => {
  const root = makeRoot();
  try {
    const file = path.join(root, 'photo.png');
    fs.writeFileSync(file, Buffer.from('x'));
    const tool = createAnalyzeImageTool(config({ vision: { enabled: false }, readableDirs: [root] }));
    await assert.rejects(() => Promise.resolve(tool.handler({ path: file })), /vision\.enabled/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('analyze_image denies paths outside the readable_dirs allowlist', async () => {
  const root = makeRoot();
  const outside = makeRoot();
  try {
    const file = path.join(outside, 'photo.png');
    fs.writeFileSync(file, Buffer.from('x'));
    const fetchImpl = (async () => {
      throw new Error('must not be called');
    }) as typeof fetch;
    const tool = createAnalyzeImageTool(config({ readableDirs: [root] }), { fetchImpl });
    await assert.rejects(() => Promise.resolve(tool.handler({ path: file })));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('analyze_image rejects non-image files without calling Ollama', async () => {
  const root = makeRoot();
  try {
    const file = path.join(root, 'notes.txt');
    fs.writeFileSync(file, 'not an image');
    const fetchImpl = (async () => {
      throw new Error('must not be called');
    }) as typeof fetch;
    const tool = createAnalyzeImageTool(config({ readableDirs: [root] }), { fetchImpl });
    await assert.rejects(() => Promise.resolve(tool.handler({ path: file })), /not a supported image type/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('analyze_image rejects files over max_image_bytes', async () => {
  const root = makeRoot();
  try {
    const file = path.join(root, 'big.png');
    fs.writeFileSync(file, Buffer.alloc(64));
    const fetchImpl = (async () => {
      throw new Error('must not be called');
    }) as typeof fetch;
    const tool = createAnalyzeImageTool(config({ vision: { max_image_bytes: 16 }, readableDirs: [root] }), { fetchImpl });
    await assert.rejects(() => Promise.resolve(tool.handler({ path: file })), /max_image_bytes/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('analyze_image explains how to pull a missing vision model on 404', async () => {
  const root = makeRoot();
  try {
    const file = path.join(root, 'photo.png');
    fs.writeFileSync(file, Buffer.from('x'));
    const fetchImpl = (async () => new Response('{"error":"model not found"}', { status: 404 })) as typeof fetch;
    const tool = createAnalyzeImageTool(config({ readableDirs: [root] }), { fetchImpl });
    await assert.rejects(() => Promise.resolve(tool.handler({ path: file })), /ollama pull test-vision:7b/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('analyze_image surfaces non-ok HTTP statuses', async () => {
  const root = makeRoot();
  try {
    const file = path.join(root, 'photo.png');
    fs.writeFileSync(file, Buffer.from('x'));
    const fetchImpl = (async () => new Response('oops', { status: 500 })) as typeof fetch;
    const tool = createAnalyzeImageTool(config({ readableDirs: [root] }), { fetchImpl });
    await assert.rejects(() => Promise.resolve(tool.handler({ path: file })), /HTTP 500/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('analyze_image maps network failure and timeout to distinct messages', async () => {
  const root = makeRoot();
  try {
    const file = path.join(root, 'photo.png');
    fs.writeFileSync(file, Buffer.from('x'));

    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const downTool = createAnalyzeImageTool(config({ readableDirs: [root] }), { fetchImpl: down });
    await assert.rejects(() => Promise.resolve(downTool.handler({ path: file })), /not reachable/);

    const slow = (async () => {
      const err = new Error('aborted');
      err.name = 'TimeoutError';
      throw err;
    }) as typeof fetch;
    const slowTool = createAnalyzeImageTool(config({ readableDirs: [root] }), { fetchImpl: slow });
    await assert.rejects(() => Promise.resolve(slowTool.handler({ path: file })), /timed out after 5000ms/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('analyze_image rejects an empty analysis and invalid JSON', async () => {
  const root = makeRoot();
  try {
    const file = path.join(root, 'photo.png');
    fs.writeFileSync(file, Buffer.from('x'));

    const empty = (async () => okResponse({ response: '   ', done_reason: 'stop' })) as typeof fetch;
    const emptyTool = createAnalyzeImageTool(config({ readableDirs: [root] }), { fetchImpl: empty });
    await assert.rejects(() => Promise.resolve(emptyTool.handler({ path: file })), /empty analysis/);

    const garbled = (async () => new Response('not-json', { status: 200 })) as typeof fetch;
    const garbledTool = createAnalyzeImageTool(config({ readableDirs: [root] }), { fetchImpl: garbled });
    await assert.rejects(() => Promise.resolve(garbledTool.handler({ path: file })), /invalid JSON/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
