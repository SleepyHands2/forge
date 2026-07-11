import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { messagesRoutes } from './messages.ts';
import { settingsRoutes } from './settings.ts';

type ReflectionInput = {
  userMessage: string;
  assistantMessage: string;
  assistantMessageId: string;
};

type ReflectionPatchResponse = {
  identity: {
    reflection: {
      enabled: boolean;
    };
  };
};

function config() {
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
    identity: { reflection: { enabled: false, cadence_turns: 2, recent_notes_in_context: 4 } },
  };
}

function makeDb() {
  return {
    prepare(sql: string) {
      return {
        all() {
          if (sql.includes('WHERE channel = \'web\'')) return [];
          return sql.includes('SELECT * FROM messages') ? [] : [];
        },
        run() {},
      };
    },
  };
}

function context(configPath: string, reflectionCalls: ReflectionInput[]) {
  const db = makeDb();
  return {
    configPath,
    config: config(),
    resolved: { root: '.', dbs: '.', identity: '.', logs: '.' },
    dbManager: {
      get: () => db,
      health: () => [{ name: 'memory', ok: true }, { name: 'messages', ok: true }],
    },
    memory: {
      retrieveForChat: async () => [],
      getEmbeddingStatus: async () => ({
        health: {
          provider: 'ollama' as const,
          enabled: false,
          baseUrl: '',
          ok: false,
          status: 'disabled' as const,
          installedModels: [],
        },
        reindex: {
          status: 'idle' as const,
          progress: { active: 0, indexed: 0, pending: 0, stale: 0, failed: 0 },
        },
      }),
    },
    llm: {
      async complete() {
        return { content: 'local reply', provider: 'ollama', model: 'local-model', inputTokens: 1, outputTokens: 1 };
      },
      async health() {
        return {
          provider: 'ollama',
          model: 'local-model',
          baseUrl: 'http://localhost:11434',
          ok: true,
          status: 'online',
          installedModels: ['local-model'],
        };
      },
    },
    authToken: 'test',
    identity: 'You are forge-local.',
    identityDir: '.',
    identityFiles: {},
    identityReflection: {
      reflectAfterAssistantReply(input: ReflectionInput) {
        reflectionCalls.push(input);
      },
    },
    readIdentity: () => 'You are forge-local.',
  };
}

async function withServer(app: express.Express, fn: (url: string) => Promise<void>): Promise<void> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.notEqual(address, null);
  assert.notEqual(typeof address, 'string');
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');

  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
}

async function waitForQueuedReflection(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

async function patchReflection(url: string, enabled: boolean): Promise<ReflectionPatchResponse> {
  const response = await fetch(`${url}/api/settings/identity/reflection`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  assert.equal(response.status, 200);
  return await response.json() as ReflectionPatchResponse;
}

async function postMessage(url: string, content: string): Promise<void> {
  const response = await fetch(`${url}/api/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { reply?: unknown };
  assert.equal(body.reply, 'local reply');
}

async function getReflectionEnabled(url: string): Promise<boolean> {
  const response = await fetch(`${url}/api/settings`);
  assert.equal(response.status, 200);
  const body = await response.json() as { info: { identity: { reflection: { enabled: boolean } } } };
  return body.info.identity.reflection.enabled;
}

test('identity reflection toggle is live across settings and message routes', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-identity-reflection-live-'));

  try {
    const configPath = writeConfig(tmp, false);
    const reflectionCalls: ReflectionInput[] = [];
    const ctx = context(configPath, reflectionCalls);
    const app = express();
    app.use(express.json({ limit: '8mb' }));
    app.use('/api/settings', settingsRoutes(ctx as never));
    app.use('/api/messages', messagesRoutes(ctx as never));

    assert.equal(ctx.config.identity.reflection.enabled, false);

    await withServer(app, async (url) => {
      await postMessage(url, 'disabled before toggle');
      await waitForQueuedReflection();
      assert.equal(reflectionCalls.length, 0);

      let patchBody = await patchReflection(url, true);
      assert.equal(patchBody.identity.reflection.enabled, true);
      assert.equal(ctx.config.identity.reflection.enabled, true);
      assert.match(fs.readFileSync(configPath, 'utf-8'), /^    enabled: true$/m);
      assert.equal(await getReflectionEnabled(url), true);

      await postMessage(url, 'enabled after toggle');
      await waitForQueuedReflection();
      assert.equal(reflectionCalls.length, 1);
      assert.equal(reflectionCalls[0].userMessage, 'enabled after toggle');
      assert.equal(reflectionCalls[0].assistantMessage, 'local reply');
      assert.match(reflectionCalls[0].assistantMessageId, /^web:assistant:/);

      patchBody = await patchReflection(url, false);
      assert.equal(patchBody.identity.reflection.enabled, false);
      assert.equal(ctx.config.identity.reflection.enabled, false);
      assert.match(fs.readFileSync(configPath, 'utf-8'), /^    enabled: false$/m);
      assert.equal(await getReflectionEnabled(url), false);

      await postMessage(url, 'disabled after toggle');
      await waitForQueuedReflection();
      assert.equal(reflectionCalls.length, 1);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function writeConfig(dir: string, reflectionEnabled: boolean): string {
  const configPath = path.join(dir, 'forge.config.yaml');
  fs.writeFileSync(configPath, [
    'forge:',
    '  name: forge-local',
    '  version: "0.1.0"',
    '  root: .',
    'user:',
    '  name: tester',
    'llm:',
    '  provider: ollama',
    '  model: local-model',
    '  ollama:',
    '    base_url: http://localhost:11434',
    'paths:',
    '  dbs: ./dbs',
    '  identity: ./identity',
    '  logs: ./logs',
    'services:',
    '  web:',
    '    host: 127.0.0.1',
    '    port: 6800',
    'memory:',
    '  retention_days: 30',
    'identity:',
    '  reflection:',
    `    enabled: ${reflectionEnabled ? 'true' : 'false'}`,
    '    cadence_turns: 2',
    '    recent_notes_in_context: 4',
  ].join('\n'));
  return configPath;
}
