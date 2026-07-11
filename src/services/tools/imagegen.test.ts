import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createA1111Backend, createGenerateImageTool } from './imagegen.ts';
import type { ForgeConfig, ImagegenConfig } from '../../types.ts';

// 1x1 transparent PNG.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');

function config(imagegen: Partial<ImagegenConfig> = {}): ForgeConfig {
  return {
    forge: { name: 'forge-local', version: '0.1.0', root: '.' },
    user: { name: 'tester' },
    llm: {
      provider: 'ollama',
      model: 'local-model',
      ollama: { base_url: 'http://localhost:11434', keep_alive: '10m', options: {} },
    },
    paths: { dbs: './dbs', identity: './identity', logs: './logs', images: './images' },
    services: { web: { host: '127.0.0.1', port: 6800, context_window_tokens: 80000, debug_prompt_context: false } },
    memory: { retention_days: 30 },
    imagegen: {
      enabled: true,
      backend: 'a1111',
      base_url: 'http://localhost:7860',
      timeout_ms: 180_000,
      width: 512,
      height: 512,
      steps: 20,
      max_size: 1024,
      max_steps: 50,
      free_vram: false,
      ...imagegen,
    },
  };
}

function tempImagesDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-imagegen-'));
}

function backendFetch(handler: (url: string, body: Record<string, unknown>) => Response | Promise<Response>): { urls: string[]; bodies: Array<Record<string, unknown>>; fetchImpl: typeof fetch } {
  const state = {
    urls: [] as string[],
    bodies: [] as Array<Record<string, unknown>>,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      state.urls.push(String(url));
      state.bodies.push(body);
      return handler(String(url), body);
    }) as typeof fetch,
  };
  return state;
}

function okBackend(): Response {
  return new Response(JSON.stringify({ images: [PNG_BASE64] }), { status: 200 });
}

test('generate_image posts clamped params to txt2img, saves the PNG, and returns an /api/images URL', async () => {
  const dir = tempImagesDir();
  const mock = backendFetch(() => okBackend());
  const tool = createGenerateImageTool(config(), { images: dir }, { fetchImpl: mock.fetchImpl });

  try {
    const result = await tool.handler({
      prompt: 'a lighthouse at dawn',
      width: 4096,   // clamped to max_size
      height: 300,   // snapped to a multiple of 8
      steps: 999,    // clamped to max_steps
      seed: 42,
    }) as { image_url: string; file: string; width: number; height: number; steps: number; seed: number; backend: string };

    assert.deepEqual(mock.urls, ['http://localhost:7860/sdapi/v1/txt2img']);
    assert.deepEqual(mock.bodies[0], {
      prompt: 'a lighthouse at dawn',
      width: 1024,
      height: 296,
      steps: 50,
      seed: 42,
    });

    assert.match(result.image_url, /^\/api\/images\/gen-\d+-[0-9a-f]{8}\.png$/);
    assert.equal(result.image_url, `/api/images/${result.file}`);
    assert.equal(result.backend, 'a1111');
    assert.deepEqual(await fs.promises.readFile(path.join(dir, result.file)), PNG_BYTES);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('generate_image uses config defaults when the model passes no optional params', async () => {
  const dir = tempImagesDir();
  const mock = backendFetch(() => okBackend());
  const tool = createGenerateImageTool(config({ width: 768, height: 512, steps: 8 }), { images: dir }, { fetchImpl: mock.fetchImpl });

  try {
    await tool.handler({ prompt: 'a fox' });
    assert.deepEqual(mock.bodies[0], { prompt: 'a fox', width: 768, height: 512, steps: 8, seed: -1 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('free_vram asks Ollama to unload the chat model before the backend call', async () => {
  const dir = tempImagesDir();
  const mock = backendFetch((url) => {
    if (url.includes('11434')) return new Response('{}', { status: 200 });
    return okBackend();
  });
  const tool = createGenerateImageTool(config({ free_vram: true }), { images: dir }, { fetchImpl: mock.fetchImpl });

  try {
    await tool.handler({ prompt: 'a fox' });
    assert.deepEqual(mock.urls, [
      'http://localhost:11434/api/chat',
      'http://localhost:7860/sdapi/v1/txt2img',
    ]);
    assert.deepEqual(mock.bodies[0], { model: 'local-model', messages: [], keep_alive: 0 });

    // A failed unload is best-effort and never blocks generation.
    const failing = backendFetch((url) => {
      if (url.includes('11434')) throw new TypeError('fetch failed');
      return okBackend();
    });
    const resilient = createGenerateImageTool(config({ free_vram: true }), { images: dir }, { fetchImpl: failing.fetchImpl });
    const result = await resilient.handler({ prompt: 'a fox' }) as { image_url: string };
    assert.match(result.image_url, /^\/api\/images\//);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('generate_image maps failures to structured errors: disabled, offline, timeout, non-200, bad payloads', async () => {
  const dir = tempImagesDir();
  try {
    const disabled = createGenerateImageTool(config({ enabled: false }), { images: dir }, {
      fetchImpl: async () => {
        throw new Error('must not fetch');
      },
    });
    await assert.rejects(disabled.handler({ prompt: 'x' }) as Promise<unknown>, /disabled \(imagegen\.enabled\)/);

    const offline = createGenerateImageTool(config(), { images: dir }, {
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await assert.rejects(offline.handler({ prompt: 'x' }) as Promise<unknown>, /not reachable at http:\/\/localhost:7860.*--api/);

    const timeout = createGenerateImageTool(config({ timeout_ms: 5000 }), { images: dir }, {
      fetchImpl: async () => {
        const err = new Error('aborted');
        err.name = 'TimeoutError';
        throw err;
      },
    });
    await assert.rejects(timeout.handler({ prompt: 'x' }) as Promise<unknown>, /timed out after 5000ms.*first image after idle/);

    const serverError = createGenerateImageTool(config(), { images: dir }, {
      fetchImpl: async () => new Response('boom', { status: 500 }),
    });
    await assert.rejects(serverError.handler({ prompt: 'x' }) as Promise<unknown>, /HTTP 500/);

    const noImages = createGenerateImageTool(config(), { images: dir }, {
      fetchImpl: async () => new Response(JSON.stringify({ images: [] }), { status: 200 }),
    });
    await assert.rejects(noImages.handler({ prompt: 'x' }) as Promise<unknown>, /returned no images/);

    const notPng = createGenerateImageTool(config(), { images: dir }, {
      fetchImpl: async () => new Response(JSON.stringify({ images: [Buffer.from('GIF89a').toString('base64')] }), { status: 200 }),
    });
    await assert.rejects(notPng.handler({ prompt: 'x' }) as Promise<unknown>, /did not return a PNG/);

    // No files land in the images dir from any failure.
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a1111 backend strips data-URL prefixes from returned images', async () => {
  const mock = backendFetch(() => new Response(JSON.stringify({
    images: [`data:image/png;base64,${PNG_BASE64}`],
  }), { status: 200 }));
  const backend = createA1111Backend(config(), mock.fetchImpl);

  const bytes = await backend.generate({ prompt: 'x', width: 512, height: 512, steps: 20, seed: -1 });
  assert.deepEqual(bytes, PNG_BYTES);
});
