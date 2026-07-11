import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { FEATURE_TOGGLES, settingsRoutes } from './settings.ts';
import { createWebServer } from '../server.ts';
import type { EmbeddingHealth, EmbeddingReindexState } from '../../types.ts';

async function withServer(app: express.Express, fn: (url: string) => Promise<void>): Promise<void> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');

  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
}

test('/api/settings returns independent local embedding status and memory information', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoutes(context() as never));

  await withServer(app, async (url) => {
    const response = await fetch(`${url}/api/settings`);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.info.name, 'forge-local');
    assert.equal(body.info.localModel, 'local-model');
    assert.equal(body.info.llm.provider, 'ollama');
    assert.equal(body.info.llm.baseUrl, 'http://localhost:11434');
    assert.deepEqual(body.info.llm.installedModels, ['local-model']);
    assert.equal(body.info.memory.contextWindowTokens, 80000);
    assert.deepEqual(body.info.memory.embeddings.configuration, {
      enabled: true,
      model: 'embedding-model',
      baseUrl: 'http://localhost:11434',
    });
    assert.deepEqual(body.info.memory.embeddings.health, {
      provider: 'ollama',
      enabled: true,
      model: 'embedding-model',
      baseUrl: 'http://localhost:11434',
      ok: true,
      status: 'online',
      installedModels: ['local-model', 'embedding-model'],
      modelRevision: 'sha256:embedding',
    });
    assert.deepEqual(body.info.memory.embeddings.index, {
      active: 4,
      indexed: 3,
      pending: 0,
      stale: 1,
      failed: 0,
      model: 'embedding-model',
      modelRevision: 'sha256:embedding',
    });
    assert.equal(body.info.memory.embeddings.reindex.status, 'completed');
    assert.deepEqual(body.info.identity.reflection, {
      enabled: false,
      cadenceTurns: 2,
      recentNotesInContext: 4,
    });
    assert.deepEqual(body.info.databases, [{ name: 'memory', ok: true }, { name: 'messages', ok: true }]);
  });
});

test('POST /api/settings/memory/embeddings/reindex runs the configured local job', async () => {
  const ctx = context();
  let calls = 0;
  ctx.memory.reindexEmbeddings = async () => {
    calls += 1;
    return {
      ...embeddingStatus().reindex,
      indexed: 1,
      skipped: 3,
      failed: 0,
    };
  };
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoutes(ctx as never));

  await withServer(app, async (url) => {
    const response = await fetch(`${url}/api/settings/memory/embeddings/reindex`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.alreadyRunning, false);
    assert.equal(body.reindex.status, 'completed');
    assert.equal(body.reindex.indexed, 1);
    assert.equal(body.reindex.skipped, 3);
  });

  assert.equal(calls, 1);
});

test('POST /api/settings/memory/embeddings/reindex rejects malformed and disabled requests', async () => {
  const ctx = context();
  let calls = 0;
  ctx.memory.reindexEmbeddings = async () => {
    calls += 1;
    return { ...embeddingStatus().reindex, indexed: 0, skipped: 0, failed: 0 };
  };
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoutes(ctx as never));

  await withServer(app, async (url) => {
    let response = await fetch(`${url}/api/settings/memory/embeddings/reindex`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'not-accepted' }),
    });
    assert.equal(response.status, 400);

    ctx.memory.getEmbeddingStatus = async () => disabledEmbeddingStatus();
    response = await fetch(`${url}/api/settings/memory/embeddings/reindex`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.match(body.error, /disabled or missing a configured model/);
    assert.equal(body.embeddings.health.status, 'disabled');
  });

  assert.equal(calls, 0);
});

test('POST /api/settings/memory/embeddings/reindex reports an existing job without starting another', async () => {
  const ctx = context();
  let calls = 0;
  ctx.memory.getEmbeddingStatus = async () => ({
    ...embeddingStatus(),
    reindex: {
      ...embeddingStatus().reindex,
      status: 'running',
      finishedAt: undefined,
    },
  });
  ctx.memory.reindexEmbeddings = async () => {
    calls += 1;
    return { ...embeddingStatus().reindex, indexed: 0, skipped: 0, failed: 0 };
  };
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoutes(ctx as never));

  await withServer(app, async (url) => {
    const response = await fetch(`${url}/api/settings/memory/embeddings/reindex`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.alreadyRunning, true);
    assert.equal(body.reindex.status, 'running');
  });

  assert.equal(calls, 0);
});

test('embedding reindex route is protected by web authentication', async () => {
  const ctx = context();
  const app = createWebServer(ctx as never);

  await withServer(app, async (url) => {
    let response = await fetch(`${url}/api/settings/memory/embeddings/reindex`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 401);

    response = await fetch(`${url}/api/settings/memory/embeddings/reindex`, {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 200);
  });
});

test('PATCH /api/settings/identity/reflection persists enabled and updates the current config', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-settings-route-'));

  try {
    const configPath = writeConfig(tmp, false);
    const ctx = context(configPath);
    const app = express();
    app.use(express.json());
    app.use('/api/settings', settingsRoutes(ctx as never));

    await withServer(app, async (url) => {
      const response = await fetch(`${url}/api/settings/identity/reflection`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();

      assert.equal(body.identity.reflection.enabled, true);
      assert.equal(ctx.config.identity.reflection.enabled, true);
      assert.match(fs.readFileSync(configPath, 'utf-8'), /enabled: true/);

      const get = await fetch(`${url}/api/settings`);
      assert.equal(get.status, 200);
      assert.equal((await get.json()).info.identity.reflection.enabled, true);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('PATCH /api/settings/identity/reflection rejects invalid payloads', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-settings-route-invalid-'));

  try {
    const configPath = writeConfig(tmp, false);
    const ctx = context(configPath);
    const app = express();
    app.use(express.json());
    app.use('/api/settings', settingsRoutes(ctx as never));

    await withServer(app, async (url) => {
      const payloads = [
        {},
        { enabled: 'true' },
        { enabled: true, cadence_turns: 1 },
        [],
      ];

      for (const payload of payloads) {
        const response = await fetch(`${url}/api/settings/identity/reflection`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        assert.equal(response.status, 400);
      }

      assert.equal(ctx.config.identity.reflection.enabled, false);
      assert.match(fs.readFileSync(configPath, 'utf-8'), /enabled: false/);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('GET /api/settings/toggles returns the allowlist with live values', async () => {
  const ctx = context();
  (ctx.config as Record<string, unknown>).tools = {
    enabled: true,
    levels: { safe: true, network: false, filesystem: false, sensitive: false },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoutes(ctx as never));

  await withServer(app, async (url) => {
    const response = await fetch(`${url}/api/settings/toggles`);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.deepEqual(
      body.toggles.map((t: { path: string }) => t.path),
      FEATURE_TOGGLES.map(t => t.path),
    );

    const byPath = new Map<string, { enabled: boolean; label: string; restartRequired: boolean }>(
      body.toggles.map((t: { path: string }) => [t.path, t]),
    );
    // Values read live from ctx.config through the dot path.
    assert.equal(byPath.get('tools.enabled')?.enabled, true);
    assert.equal(byPath.get('tools.levels.safe')?.enabled, true);
    assert.equal(byPath.get('tools.levels.network')?.enabled, false);
    // Missing blocks read as disabled instead of crashing.
    assert.equal(byPath.get('rag.enabled')?.enabled, false);
    assert.equal(byPath.get('voice.stt.enabled')?.enabled, false);
    assert.equal(byPath.get('channels.telegram.enabled')?.enabled, false);
    // Metadata is carried through.
    assert.equal(byPath.get('scheduler.enabled')?.restartRequired, true);
    assert.equal(byPath.get('imagegen.enabled')?.restartRequired, true);
    assert.equal(byPath.get('tools.enabled')?.restartRequired, false);
    assert.equal(byPath.get('tools.enabled')?.label, 'Tool system');
  });
});

test('PATCH /api/settings/toggles persists to YAML and updates the current config', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-settings-toggles-'));

  try {
    const configPath = writeConfig(tmp, false);
    const ctx = context(configPath);
    const app = express();
    app.use(express.json());
    app.use('/api/settings', settingsRoutes(ctx as never));

    await withServer(app, async (url) => {
      const response = await fetch(`${url}/api/settings/toggles`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'tools.enabled', enabled: true }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        path: 'tools.enabled',
        enabled: true,
        restartRequired: false,
      });

      // Persisted to the active YAML file...
      assert.match(fs.readFileSync(configPath, 'utf-8'), /\ntools:\n  enabled: true$/);
      // ...and grafted onto the running config object.
      const tools = (ctx.config as Record<string, unknown>).tools as { enabled: boolean };
      assert.equal(tools.enabled, true);

      // The GET route reflects the new value immediately.
      const get = await fetch(`${url}/api/settings/toggles`);
      const body = await get.json();
      const toggle = body.toggles.find((t: { path: string }) => t.path === 'tools.enabled');
      assert.equal(toggle.enabled, true);

      // A restart-required toggle reports it in the response.
      const scheduler = await fetch(`${url}/api/settings/toggles`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'scheduler.enabled', enabled: true }),
      });
      assert.equal(scheduler.status, 200);
      assert.deepEqual(await scheduler.json(), {
        path: 'scheduler.enabled',
        enabled: true,
        restartRequired: true,
      });
      assert.match(fs.readFileSync(configPath, 'utf-8'), /\nscheduler:\n  enabled: true$/);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('PATCH /api/settings/toggles rejects unknown paths and non-boolean values', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-settings-toggles-invalid-'));

  try {
    const configPath = writeConfig(tmp, false);
    const before = fs.readFileSync(configPath, 'utf-8');
    const ctx = context(configPath);
    const app = express();
    app.use(express.json());
    app.use('/api/settings', settingsRoutes(ctx as never));

    await withServer(app, async (url) => {
      const payloads = [
        { path: 'llm.fallback.enabled', enabled: true }, // not in the allowlist
        { path: 'services.web.debug_prompt_context', enabled: true }, // not in the allowlist
        { path: 'tools.enabled', enabled: 'true' }, // non-boolean enabled
        { path: 'tools.enabled' }, // missing enabled
        { enabled: true }, // missing path
        { path: 'tools.enabled', enabled: true, extra: 1 }, // extra key
        [],
      ];

      for (const payload of payloads) {
        const response = await fetch(`${url}/api/settings/toggles`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        assert.equal(response.status, 400);
      }

      // Nothing was written.
      assert.equal(fs.readFileSync(configPath, 'utf-8'), before);
      assert.equal((ctx.config as Record<string, unknown>).tools, undefined);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function context(configPath?: string) {
  return {
    configPath,
    config: {
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
        embeddings: {
          enabled: true,
          model: 'embedding-model',
          request_timeout_ms: 10_000,
          backfill_batch_size: 16,
        },
      },
      identity: { reflection: { enabled: false, cadence_turns: 2, recent_notes_in_context: 4 } },
    },
    resolved: { root: '.', dbs: '.', identity: '.', logs: '.' },
    dbManager: { health: () => [{ name: 'memory', ok: true }, { name: 'messages', ok: true }] },
    memory: {
      getEmbeddingStatus: async () => embeddingStatus(),
      reindexEmbeddings: async () => ({ ...embeddingStatus().reindex, indexed: 0, skipped: 4, failed: 0 }),
    },
    llm: {
      health: async () => ({
        provider: 'ollama',
        model: 'local-model',
        baseUrl: 'http://localhost:11434',
        ok: true,
        status: 'online',
        installedModels: ['local-model'],
      }),
    },
    authToken: 'test',
    identity: 'You are forge-local.',
    identityDir: '.',
    identityFiles: {},
    readIdentity: () => 'You are forge-local.',
  };
}

function embeddingStatus(): { health: EmbeddingHealth; reindex: EmbeddingReindexState } {
  return {
    health: {
      provider: 'ollama',
      enabled: true,
      model: 'embedding-model',
      baseUrl: 'http://localhost:11434',
      ok: true,
      status: 'online',
      installedModels: ['local-model', 'embedding-model'],
      modelRevision: 'sha256:embedding',
    },
    reindex: {
      status: 'completed',
      startedAt: '2026-06-26T07:00:00.000Z',
      finishedAt: '2026-06-26T07:00:01.000Z',
      progress: {
        active: 4,
        indexed: 3,
        pending: 0,
        stale: 1,
        failed: 0,
        model: 'embedding-model',
        modelRevision: 'sha256:embedding',
      },
    },
  };
}

function disabledEmbeddingStatus(): { health: EmbeddingHealth; reindex: EmbeddingReindexState } {
  return {
    health: {
      provider: 'ollama',
      enabled: false,
      baseUrl: 'http://localhost:11434',
      ok: false,
      status: 'disabled',
      installedModels: [],
      message: 'Memory embeddings are disabled; memory recall uses local FTS only.',
    },
    reindex: {
      status: 'idle',
      progress: { active: 4, indexed: 0, pending: 0, stale: 0, failed: 0 },
    },
  };
}

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
