import assert from 'node:assert/strict';
import test from 'node:test';
import { LLMService } from './llm.ts';
import type { ForgeConfig, LlmFallbackConfig } from '../types.ts';

const KEY_ENV = 'FORGE_FALLBACK_API_KEY';

function config(fallback?: Partial<LlmFallbackConfig>): ForgeConfig {
  return {
    forge: { name: 'forge-local', version: '0.1.0', root: '.' },
    user: { name: 'tester' },
    llm: {
      provider: 'ollama',
      model: 'local-model',
      ollama: { base_url: 'http://localhost:11434', keep_alive: '10m', options: {} },
      fallback: {
        enabled: false,
        provider: 'openai-compatible',
        base_url: 'https://cloud.example/v1',
        model: 'cloud-model',
        api_key_env: KEY_ENV,
        ...fallback,
      },
    },
    paths: { dbs: './dbs', identity: './identity', logs: './logs' },
    services: { web: { host: '127.0.0.1', port: 6800, context_window_tokens: 80000, debug_prompt_context: false } },
    memory: { retention_days: 30 },
  };
}

function trackingFetch(onCloud?: () => Response): { urls: string[]; fetchImpl: typeof fetch; lastInit?: RequestInit } {
  const state: { urls: string[]; fetchImpl: typeof fetch; lastInit?: RequestInit } = {
    urls: [],
    fetchImpl: async (url, init) => {
      state.urls.push(String(url));
      state.lastInit = init;
      if (String(url).includes('localhost:11434')) {
        throw new TypeError('fetch failed');
      }
      if (!onCloud) throw new Error('cloud endpoint must not be reached');
      return onCloud();
    },
  };
  return state;
}

function withKey<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prior = process.env[KEY_ENV];
  if (value === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = value;
  return fn().finally(() => {
    if (prior === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = prior;
  });
}

test('fallback stays off unless enabled: Ollama failure propagates, no cloud call', async () => {
  await withKey('key-set-but-disabled', async () => {
    const tracker = trackingFetch();
    const service = new LLMService(config({ enabled: false }), { fetchImpl: tracker.fetchImpl });

    await assert.rejects(
      service.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] }),
      /Ollama is not reachable/,
    );
    assert.deepEqual(tracker.urls, ['http://localhost:11434/api/chat']);
  });
});

test('enabled fallback takes over when local Ollama fails, keyed from env', async () => {
  await withKey('secret-key', async () => {
    const tracker = trackingFetch(() => new Response(JSON.stringify({
      model: 'cloud-model',
      choices: [{ message: { content: 'cloud reply' } }],
      usage: { prompt_tokens: 9, completion_tokens: 4 },
    }), { status: 200 }));
    const service = new LLMService(config({ enabled: true }), { fetchImpl: tracker.fetchImpl });

    const res = await service.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });

    assert.deepEqual(tracker.urls, [
      'http://localhost:11434/api/chat',
      'https://cloud.example/v1/chat/completions',
    ]);
    const headers = tracker.lastInit?.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer secret-key');
    assert.deepEqual(res, {
      content: 'cloud reply',
      provider: 'openai-compatible',
      model: 'cloud-model',
      inputTokens: 9,
      outputTokens: 4,
    });
  });
});

test('enabled fallback without the env key fails with a clear message', async () => {
  await withKey(undefined, async () => {
    const tracker = trackingFetch();
    const service = new LLMService(config({ enabled: true }), { fetchImpl: tracker.fetchImpl });

    await assert.rejects(
      service.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] }),
      new RegExp(`${KEY_ENV} environment variable is not set`),
    );
    // Ollama was tried; the cloud endpoint was never contacted without a key.
    assert.deepEqual(tracker.urls, ['http://localhost:11434/api/chat']);
  });
});

test('fallback is never consulted when local Ollama succeeds', async () => {
  await withKey('secret-key', async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ message: { content: 'local reply' } }), { status: 200 });
    };
    const service = new LLMService(config({ enabled: true }), { fetchImpl });

    const res = await service.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.content, 'local reply');
    assert.equal(res.provider, 'ollama');
    assert.deepEqual(urls, ['http://localhost:11434/api/chat']);
  });
});
