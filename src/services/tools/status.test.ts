import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { createGetStatusTool } from './status.ts';
import { ToolRegistry } from './registry.ts';
import { MemoryService } from '../memory.ts';
import type { EmbeddingHealth, ForgeConfig, ToolDef } from '../../types.ts';

const MEMORY_SCHEMA = fs.readFileSync(new URL('../../db/schemas/memory.sql', import.meta.url), 'utf-8');

interface StatusResult {
  assistant: { name: string; version: string; model: string; context_tokens?: number };
  features: {
    tools_enabled: boolean;
    levels: { safe: boolean; network: boolean; filesystem: boolean; sensitive: boolean };
    rag: boolean;
    memory_auto: boolean;
    memory_summary: boolean;
    voice_stt: boolean;
    voice_tts: boolean;
    imagegen: boolean;
    vision: boolean;
    telegram: boolean;
    scheduler: boolean;
  };
  tools: Array<{ name: string; permission: string; allowed: boolean }>;
  counts: { active_memories: number; documents: number; pending_reminders: number; scheduled_jobs: number };
  diagnostics: Record<string, string[]>;
}

function config(overrides: Record<string, unknown> = {}): ForgeConfig {
  return {
    forge: { name: 'forge-local', version: '0.1.0', root: '.' },
    user: { name: 'tester' },
    llm: {
      provider: 'ollama',
      model: 'local-model',
      ollama: { base_url: 'http://localhost:11434', keep_alive: '10m', options: { num_ctx: 8192 } },
    },
    paths: { dbs: './dbs', identity: './identity', logs: './logs' },
    services: { web: { host: '127.0.0.1', port: 6800, context_window_tokens: 80000, debug_prompt_context: false } },
    memory: {
      retention_days: 30,
      auto: { enabled: false, max_per_turn: 3, dedupe_similarity: 0.92 },
      summary: { enabled: true, max_chars: 1200, batch_messages: 40 },
    },
    tools: {
      enabled: true,
      max_iterations: 5,
      levels: { safe: true, network: true, filesystem: false, sensitive: false },
      filesystem: { readable_dirs: [], writable_dirs: [] },
    },
    rag: {
      enabled: true,
      chunk_tokens: 400,
      chunk_overlap_tokens: 50,
      top_k: 4,
      min_similarity: 0.35,
      max_context_tokens: 1500,
    },
    scheduler: {
      enabled: true,
      jobs: [
        { name: 'briefing', cron: '0 8 * * *', prompt: 'Morning briefing.', channel: 'none' },
        { name: 'digest', cron: '0 18 * * *', prompt: 'Evening digest.', channel: 'none' },
      ],
    },
    ...overrides,
  } as ForgeConfig;
}

function visionFixture() {
  return {
    enabled: true,
    model: 'test-vision:7b',
    num_ctx: 8192,
    num_predict: 700,
    repeat_penalty: 1.15,
    timeout_ms: 300000,
    max_image_bytes: 10485760,
  };
}

function fakeTool(name: string, permission: ToolDef['permission']): ToolDef {
  return {
    name,
    description: `${name} test tool`,
    permission,
    params: z.object({}),
    handler: () => ({}),
  };
}

function memoryWithOneEntry(): { memory: MemoryService; db: Database.Database } {
  const db = new Database(':memory:');
  db.exec(MEMORY_SCHEMA);
  const memory = new MemoryService(db);
  memory.saveSync({ type: 'fact', content: 'The user has exactly one saved memory.' });
  return { memory, db };
}

test('get_status reports live feature toggles, tool permissions, and counts', async () => {
  const { memory, db } = memoryWithOneEntry();
  const registry = new ToolRegistry();
  registry.register(fakeTool('web_search', 'network'));
  registry.register(fakeTool('set_reminder', 'sensitive'));
  const tool = createGetStatusTool({
    config: config(),
    registry,
    memory,
    rag: { list: () => [{}, {}] as never },
    reminders: { listPending: () => [{}] as never },
  });
  registry.register(tool);

  assert.equal(tool.name, 'get_status');
  assert.equal(tool.permission, 'safe');
  const result = await tool.handler({}) as StatusResult;

  assert.deepEqual(result.assistant, {
    name: 'forge-local',
    version: '0.1.0',
    model: 'local-model',
    context_tokens: 8192,
  });
  assert.deepEqual(result.features, {
    tools_enabled: true,
    levels: { safe: true, network: true, filesystem: false, sensitive: false },
    rag: true,
    memory_auto: false,
    memory_summary: true,
    voice_stt: false,
    voice_tts: false,
    imagegen: false,
    vision: false,
    telegram: false,
    scheduler: true,
  });

  const byName = new Map(result.tools.map(entry => [entry.name, entry]));
  assert.equal(result.tools.length, 3);
  assert.deepEqual(byName.get('web_search'), { name: 'web_search', permission: 'network', allowed: true });
  assert.deepEqual(byName.get('set_reminder'), { name: 'set_reminder', permission: 'sensitive', allowed: false });
  assert.deepEqual(byName.get('get_status'), { name: 'get_status', permission: 'safe', allowed: true });

  assert.deepEqual(result.counts, {
    active_memories: 1,
    documents: 2,
    pending_reminders: 1,
    scheduled_jobs: 2,
  });
  db.close();
});

test('get_status omits context_tokens when num_ctx is unknown and defaults missing blocks to false', async () => {
  const { memory, db } = memoryWithOneEntry();
  const base = config();
  const minimal = {
    ...base,
    llm: { ...base.llm, ollama: { ...base.llm.ollama, options: {} } },
    memory: { retention_days: 30 },
    tools: undefined,
    rag: undefined,
    scheduler: undefined,
  } as unknown as ForgeConfig;
  const registry = new ToolRegistry();
  const tool = createGetStatusTool({ config: minimal, registry, memory });
  registry.register(tool);

  const result = await tool.handler({}) as StatusResult;

  assert.deepEqual(result.assistant, { name: 'forge-local', version: '0.1.0', model: 'local-model' });
  assert.equal(result.features.tools_enabled, false);
  assert.deepEqual(result.features.levels, { safe: false, network: false, filesystem: false, sensitive: false });
  assert.equal(result.features.rag, false);
  assert.equal(result.features.memory_auto, false);
  assert.equal(result.features.memory_summary, false);
  assert.equal(result.features.scheduler, false);
  assert.deepEqual(result.tools, [{ name: 'get_status', permission: 'safe', allowed: false }]);
  assert.deepEqual(result.counts, { active_memories: 1, documents: 0, pending_reminders: 0, scheduled_jobs: 0 });
  db.close();
});

test('get_status degrades a broken subsystem to a zero count instead of throwing', async () => {
  const { memory, db } = memoryWithOneEntry();
  const registry = new ToolRegistry();
  const tool = createGetStatusTool({
    config: config(),
    registry,
    memory,
    rag: { list: () => { throw new Error('documents.db is corrupt'); } },
    reminders: { listPending: () => { throw new Error('tools.db is corrupt'); } },
  });
  registry.register(tool);

  const result = await tool.handler({}) as StatusResult;

  assert.deepEqual(result.counts, {
    active_memories: 1,
    documents: 0,
    pending_reminders: 0,
    scheduled_jobs: 2,
  });
  db.close();
});

// --- Diagnostics ---------------------------------------------------------------

test('get_status diagnostics carry the permission-gate reasons for blocked tools', async () => {
  const { memory, db } = memoryWithOneEntry();
  const registry = new ToolRegistry();
  registry.register(fakeTool('web_search', 'network'));
  registry.register(fakeTool('set_reminder', 'sensitive'));
  const tool = createGetStatusTool({ config: config(), registry, memory });
  registry.register(tool);

  const result = await tool.handler({}) as StatusResult;

  assert.equal(result.diagnostics.web_search, undefined);
  assert.deepEqual(result.diagnostics.set_reminder, [
    "Permission level 'sensitive' is disabled (tools.levels.sensitive is false).",
  ]);
  db.close();
});

test('get_status diagnostics flag an empty filesystem allowlist and a disabled imagegen', async () => {
  const { memory, db } = memoryWithOneEntry();
  const registry = new ToolRegistry();
  registry.register(fakeTool('read_file', 'filesystem'));
  registry.register(fakeTool('list_dir', 'filesystem'));
  const cfg = config({
    tools: {
      enabled: true,
      max_iterations: 5,
      levels: { safe: true, network: true, filesystem: true, sensitive: false },
      filesystem: { readable_dirs: [], writable_dirs: [] },
    },
  });
  const tool = createGetStatusTool({ config: cfg, registry, memory });
  registry.register(tool);

  const result = await tool.handler({}) as StatusResult;

  assert.deepEqual(result.diagnostics.read_file, ['No readable directories are allowlisted (tools.filesystem).']);
  assert.deepEqual(result.diagnostics.list_dir, ['No readable directories are allowlisted (tools.filesystem).']);
  assert.deepEqual(result.diagnostics.generate_image, ['Image generation is disabled (imagegen.enabled is false).']);
  assert.deepEqual(result.diagnostics.analyze_image, ['Image analysis is disabled (vision.enabled is false).']);
  db.close();
});

test('get_status diagnostics check that the vision model is pulled on Ollama', async () => {
  const { memory, db } = memoryWithOneEntry();
  const registry = new ToolRegistry();
  registry.register(fakeTool('analyze_image', 'filesystem'));
  const cfg = config({
    tools: {
      enabled: true,
      max_iterations: 5,
      levels: { safe: true, network: true, filesystem: true, sensitive: false },
      filesystem: { readable_dirs: ['C:\\allowed'], writable_dirs: [] },
    },
    vision: visionFixture(),
  });

  const missingTool = createGetStatusTool({
    config: cfg, registry, memory,
    listModels: async () => ['some-other-model:latest'],
  });
  const missing = await missingTool.handler({}) as StatusResult;
  assert.deepEqual(missing.diagnostics.analyze_image, [
    "Vision model 'test-vision:7b' is not pulled. Run: ollama pull test-vision:7b",
  ]);

  const downTool = createGetStatusTool({
    config: cfg, registry, memory,
    listModels: async () => null,
  });
  const down = await downTool.handler({}) as StatusResult;
  assert.deepEqual(down.diagnostics.analyze_image, ['Ollama is not reachable at http://localhost:11434.']);

  const okTool = createGetStatusTool({
    config: cfg, registry, memory,
    listModels: async () => ['test-vision:7b'],
  });
  const ok = await okTool.handler({}) as StatusResult;
  assert.equal(ok.diagnostics.analyze_image, undefined);
  db.close();
});

test('get_status diagnostics probe configured backends of allowed tools', async () => {
  const { memory, db } = memoryWithOneEntry();
  const registry = new ToolRegistry();
  registry.register(fakeTool('web_search', 'network'));
  registry.register(fakeTool('generate_image', 'network'));
  const cfg = config({
    search: { searxng_url: 'http://localhost:8888', results: 5, timeout_ms: 8000, fetch_max_chars: 8000 },
    imagegen: {
      enabled: true, backend: 'a1111', base_url: 'http://localhost:7860', timeout_ms: 180000,
      width: 512, height: 512, steps: 20, max_size: 1024, max_steps: 50, free_vram: true,
    },
  });
  const probed: string[] = [];
  const tool = createGetStatusTool({
    config: cfg,
    registry,
    memory,
    probeUrl: async url => { probed.push(url); return false; },
  });
  registry.register(tool);

  const result = await tool.handler({}) as StatusResult;

  assert.deepEqual(probed.sort(), ['http://localhost:7860', 'http://localhost:8888']);
  assert.deepEqual(result.diagnostics.web_search, [
    'SearXNG is not reachable at http://localhost:8888. Is the container running?',
  ]);
  assert.deepEqual(result.diagnostics.generate_image, [
    'Image backend is not reachable at http://localhost:7860. Is the SD WebUI running with --api?',
  ]);
  db.close();
});

test('get_status diagnostics skip probes for gated tools and stay quiet when backends respond', async () => {
  const { memory, db } = memoryWithOneEntry();
  const registry = new ToolRegistry();
  registry.register(fakeTool('web_search', 'network'));
  const gated = config({
    tools: {
      enabled: true,
      max_iterations: 5,
      levels: { safe: true, network: false, filesystem: false, sensitive: false },
      filesystem: { readable_dirs: [], writable_dirs: [] },
    },
    search: { searxng_url: 'http://localhost:8888', results: 5, timeout_ms: 8000, fetch_max_chars: 8000 },
  });
  const probed: string[] = [];
  const gatedTool = createGetStatusTool({
    config: gated, registry, memory,
    probeUrl: async url => { probed.push(url); return false; },
  });
  const gatedResult = await gatedTool.handler({}) as StatusResult;
  assert.deepEqual(probed, []);
  assert.deepEqual(gatedResult.diagnostics.web_search, [
    "Permission level 'network' is disabled (tools.levels.network is false).",
  ]);

  const open = config({
    search: { searxng_url: 'http://localhost:8888', results: 5, timeout_ms: 8000, fetch_max_chars: 8000 },
  });
  const openTool = createGetStatusTool({ config: open, registry, memory, probeUrl: async () => true });
  const openResult = await openTool.handler({}) as StatusResult;
  assert.equal(openResult.diagnostics.web_search, undefined);
  db.close();
});

test('get_status diagnostics report embeddings, rag, voice, telegram, and scheduler issues', async () => {
  const { memory, db } = memoryWithOneEntry();
  const registry = new ToolRegistry();
  delete process.env.FORGE_TEST_STATUS_TOKEN;
  const cfg = config({
    memory: {
      retention_days: 30,
      embeddings: { enabled: true, model: 'nomic-embed-text', request_timeout_ms: 10000, backfill_batch_size: 16 },
    },
    channels: {
      telegram: {
        enabled: true,
        token_env: 'FORGE_TEST_STATUS_TOKEN',
        api_base_url: 'https://api.telegram.org',
        poll_timeout_s: 30,
        allowed_chat_ids: [],
      },
    },
    scheduler: { enabled: true, jobs: [] },
  });
  const offline: EmbeddingHealth = {
    provider: 'ollama',
    enabled: true,
    model: 'nomic-embed-text',
    baseUrl: 'http://localhost:11434',
    ok: false,
    status: 'offline',
    installedModels: [],
    message: 'Ollama is not reachable at http://localhost:11434.',
  };
  const tool = createGetStatusTool({
    config: cfg,
    registry,
    memory,
    embeddingHealth: async () => offline,
    stt: { status: () => ({ enabled: true, engine: 'whisper-cpp', configured: false, message: 'whisper model not found.' }) },
    tts: { status: () => ({ enabled: true, configured: false, message: 'voice.tts.model is not set (path to a Piper voice .onnx).' }) },
  });
  registry.register(tool);

  const result = await tool.handler({}) as StatusResult;

  assert.deepEqual(result.diagnostics.memory_embeddings, ['Ollama is not reachable at http://localhost:11434.']);
  assert.equal(result.diagnostics.rag, undefined);
  assert.deepEqual(result.diagnostics.voice_stt, ['whisper model not found.']);
  assert.deepEqual(result.diagnostics.voice_tts, ['voice.tts.model is not set (path to a Piper voice .onnx).']);
  assert.deepEqual(result.diagnostics.telegram, [
    'Telegram bot token is missing (environment variable FORGE_TEST_STATUS_TOKEN is not set).',
    'No chat ids are allowlisted (channels.telegram.allowed_chat_ids is empty), so nobody can reach the bot.',
  ]);
  assert.deepEqual(result.diagnostics.scheduler, ['Scheduler is enabled but scheduler.jobs is empty; nothing will run.']);
  db.close();
});

test('get_status diagnostics explain every broken link in the telegram attachments chain', async () => {
  const { memory, db } = memoryWithOneEntry();
  const registry = new ToolRegistry();
  const telegram = {
    enabled: false,
    token_env: 'FORGE_TEST_STATUS_TOKEN',
    api_base_url: 'https://api.telegram.org',
    poll_timeout_s: 30,
    allowed_chat_ids: ['777'],
    attachments: { enabled: true, dir: './attachments', max_file_bytes: 10485760, retention_days: 7 },
  };
  // Channel off, vision off, filesystem level off: all three findings.
  const broken = createGetStatusTool({ config: config({ channels: { telegram } }), registry, memory });
  const brokenResult = await broken.handler({}) as StatusResult;
  assert.deepEqual(brokenResult.diagnostics.telegram_attachments, [
    'Attachments are enabled but the Telegram channel is off (channels.telegram.enabled is false).',
    'Downloaded images cannot be analyzed: vision.enabled is false (analyze_image is not registered).',
    "Downloaded images cannot be read: the 'filesystem' tool level is disabled (tools.enabled / tools.levels.filesystem).",
  ]);

  // Healthy chain: no finding, and the implicit attachments root also means an
  // empty readable_dirs no longer flags the filesystem tools.
  process.env.FORGE_TEST_STATUS_TOKEN = 'token';
  registry.register(fakeTool('read_file', 'filesystem'));
  registry.register(fakeTool('analyze_image', 'filesystem'));
  const healthyCfg = config({
    channels: { telegram: { ...telegram, enabled: true } },
    vision: visionFixture(),
    tools: {
      enabled: true,
      max_iterations: 5,
      levels: { safe: true, network: true, filesystem: true, sensitive: false },
      filesystem: { readable_dirs: [], writable_dirs: [] },
    },
  });
  const healthy = createGetStatusTool({ config: healthyCfg, registry, memory, listModels: async () => ['test-vision:7b'] });
  const healthyResult = await healthy.handler({}) as StatusResult;
  assert.equal(healthyResult.diagnostics.telegram_attachments, undefined);
  assert.equal(healthyResult.diagnostics.read_file, undefined);
  assert.equal(healthyResult.diagnostics.analyze_image, undefined);
  delete process.env.FORGE_TEST_STATUS_TOKEN;
  db.close();
});

test('get_status diagnostics note keyword-only recall and the rag dependency when embeddings are off', async () => {
  const { memory, db } = memoryWithOneEntry();
  const registry = new ToolRegistry();
  const tool = createGetStatusTool({ config: config(), registry, memory });
  registry.register(tool);

  const result = await tool.handler({}) as StatusResult;

  assert.deepEqual(result.diagnostics.memory_embeddings, [
    'Memory embeddings are disabled (memory.embeddings.enabled is false); memory recall is keyword-only.',
  ]);
  assert.deepEqual(result.diagnostics.rag, ['Document RAG requires memory.embeddings.enabled, which is false.']);
  db.close();
});

test('get_status diagnostics are empty when everything is enabled, configured, and reachable', async () => {
  const { memory, db } = memoryWithOneEntry();
  const registry = new ToolRegistry();
  registry.register(fakeTool('web_search', 'network'));
  registry.register(fakeTool('generate_image', 'network'));
  registry.register(fakeTool('analyze_image', 'filesystem'));
  const cfg = config({
    memory: {
      retention_days: 30,
      embeddings: { enabled: true, model: 'nomic-embed-text', request_timeout_ms: 10000, backfill_batch_size: 16 },
    },
    tools: {
      enabled: true,
      max_iterations: 5,
      levels: { safe: true, network: true, filesystem: true, sensitive: false },
      filesystem: { readable_dirs: ['C:\\allowed'], writable_dirs: [] },
    },
    search: { searxng_url: 'http://localhost:8888', results: 5, timeout_ms: 8000, fetch_max_chars: 8000 },
    imagegen: {
      enabled: true, backend: 'a1111', base_url: 'http://localhost:7860', timeout_ms: 180000,
      width: 512, height: 512, steps: 20, max_size: 1024, max_steps: 50, free_vram: true,
    },
    vision: visionFixture(),
  });
  const online: EmbeddingHealth = {
    provider: 'ollama',
    enabled: true,
    model: 'nomic-embed-text',
    baseUrl: 'http://localhost:11434',
    ok: true,
    status: 'online',
    installedModels: ['nomic-embed-text'],
  };
  const tool = createGetStatusTool({
    config: cfg,
    registry,
    memory,
    probeUrl: async () => true,
    embeddingHealth: async () => online,
    listModels: async () => ['test-vision:7b'],
  });
  registry.register(tool);

  const result = await tool.handler({}) as StatusResult;

  assert.deepEqual(result.diagnostics, {});
  db.close();
});

test('get_status reports which identity files were cut when identity is over budget', async () => {
  const { memory, db } = memoryWithOneEntry();
  const registry = new ToolRegistry();
  const tool = createGetStatusTool({
    config: config(),
    registry,
    memory,
    identityContext: () => ({
      text: 'capped identity context',
      budgetTokens: 2329,
      estimatedTokens: 2310,
      neededTokens: 9800,
      truncated: true,
      files: [
        { name: 'SOUL.md', status: 'full', totalBytes: 900, includedBytes: 900 },
        { name: 'IDENTITY.md', status: 'full', totalBytes: 1200, includedBytes: 1200 },
        { name: 'USER.md', status: 'full', totalBytes: 800, includedBytes: 800 },
        { name: 'NOTES.md', status: 'truncated', totalBytes: 24000, includedBytes: 3600 },
        { name: 'ZEBRA.md', status: 'omitted', totalBytes: 9000, includedBytes: 0 },
      ],
    }),
  });
  registry.register(tool);

  const result = await tool.handler({}) as StatusResult;

  const messages = result.diagnostics.identity;
  assert.ok(messages, 'expected an identity diagnostic');
  assert.match(messages[0], /~9800 tokens/);
  assert.match(messages[0], /budget is 2329/);
  assert.match(messages[0], /NOTES\.md \(truncated\)/);
  assert.match(messages[0], /ZEBRA\.md \(omitted\)/);
  assert.doesNotMatch(messages[0], /SOUL\.md/);
  assert.match(messages[0], /identity\.budget\.share/);
  db.close();
});

test('get_status stays quiet about identity when it fits its budget', async () => {
  const { memory, db } = memoryWithOneEntry();
  const registry = new ToolRegistry();
  const tool = createGetStatusTool({
    config: config(),
    registry,
    memory,
    identityContext: () => ({
      text: 'full identity context',
      budgetTokens: 2329,
      estimatedTokens: 1100,
      neededTokens: 1100,
      truncated: false,
      files: [
        { name: 'SOUL.md', status: 'full', totalBytes: 900, includedBytes: 900 },
        { name: 'NOTES.md', status: 'full', totalBytes: 1500, includedBytes: 1500 },
      ],
    }),
  });
  registry.register(tool);

  const result = await tool.handler({}) as StatusResult;

  assert.equal(result.diagnostics.identity, undefined);
  db.close();
});
