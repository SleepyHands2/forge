import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { ToolRegistry } from './registry.ts';
import { zodToJsonSchema } from './schema.ts';
import { checkToolPermission, isPathAllowed } from './permissions.ts';
import { LLMService } from '../llm.ts';
import type { ForgeConfig, ToolDef, ToolsConfig } from '../../types.ts';

function config(toolsOverrides: Partial<ToolsConfig> = {}): ForgeConfig {
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
      levels: { safe: true, network: false, filesystem: false, sensitive: false },
      filesystem: { readable_dirs: [], writable_dirs: [] },
      ...toolsOverrides,
    },
  };
}

function tool(overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    name: 'echo',
    description: 'Echo a value.',
    params: z.object({ text: z.string() }),
    permission: 'safe',
    handler: args => args,
    ...overrides,
  };
}

test('registry validates names, rejects duplicates, and lists registered tools', () => {
  const registry = new ToolRegistry();
  registry.register(tool());

  assert.ok(registry.has('echo'));
  assert.equal(registry.get('echo')?.description, 'Echo a value.');
  assert.deepEqual(registry.list().map(t => t.name), ['echo']);

  assert.throws(() => registry.register(tool()), /already registered/);
  assert.throws(() => registry.register(tool({ name: 'Bad Name!' })), /must match/);
  assert.throws(() => registry.register(tool({ name: 'blank', description: '   ' })), /requires a description/);
});

test('zodToJsonSchema converts the supported tool-parameter subset', () => {
  const schema = zodToJsonSchema(z.object({
    query: z.string().describe('Search text'),
    limit: z.number().int().optional(),
    exact: z.boolean().default(false),
    kind: z.enum(['note', 'fact']),
    tags: z.array(z.string()),
  }));

  assert.deepEqual(schema, {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search text' },
      limit: { type: 'integer' },
      exact: { type: 'boolean' },
      kind: { type: 'string', enum: ['note', 'fact'] },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['query', 'kind', 'tags'],
  });

  assert.throws(() => zodToJsonSchema(z.object({ cb: z.function() })), /Unsupported Zod type/);
});

test('checkToolPermission denies unless master switch and level are both on', () => {
  const safeTool = tool();
  assert.equal(checkToolPermission(config(), safeTool).allowed, true);

  const masterOff = config();
  masterOff.tools = { ...masterOff.tools!, enabled: false };
  assert.equal(checkToolPermission(masterOff, safeTool).allowed, false);
  assert.match(checkToolPermission(masterOff, safeTool).reason ?? '', /tools\.enabled/);

  const levelOff = config({ levels: { safe: false, network: false, filesystem: false, sensitive: false } });
  const denied = checkToolPermission(levelOff, safeTool);
  assert.equal(denied.allowed, false);
  assert.match(denied.reason ?? '', /levels\.safe/);

  const noToolsBlock = config();
  delete (noToolsBlock as { tools?: unknown }).tools;
  assert.equal(checkToolPermission(noToolsBlock, safeTool).allowed, false);
});

test('isPathAllowed enforces the filesystem level and per-mode allowlists', () => {
  const root = path.resolve('sandbox');
  const fsOn = config({
    levels: { safe: false, network: false, filesystem: true, sensitive: false },
    filesystem: { readable_dirs: [root], writable_dirs: [] },
  });

  assert.equal(isPathAllowed(fsOn, path.join(root, 'notes.txt'), 'read').allowed, true);
  assert.equal(isPathAllowed(fsOn, root, 'read').allowed, true);
  assert.equal(isPathAllowed(fsOn, path.join(root, '..', 'secrets.txt'), 'read').allowed, false);
  assert.equal(isPathAllowed(fsOn, path.resolve('elsewhere', 'file.txt'), 'read').allowed, false);
  // Sibling directory sharing the allowlisted dir as a name prefix must not match.
  assert.equal(isPathAllowed(fsOn, `${root}-evil${path.sep}file.txt`, 'read').allowed, false);
  // Write mode uses writable_dirs, which are empty here.
  assert.equal(isPathAllowed(fsOn, path.join(root, 'notes.txt'), 'write').allowed, false);
  assert.equal(isPathAllowed(fsOn, path.join(root, 'a\0b'), 'read').allowed, false);

  const fsOff = config({ filesystem: { readable_dirs: [root], writable_dirs: [root] } });
  assert.equal(isPathAllowed(fsOff, path.join(root, 'notes.txt'), 'read').allowed, false);
});

test('isPathAllowed treats an enabled telegram attachments dir as an implicit read-only root', () => {
  const attachmentsDir = path.resolve('attachments-sandbox');
  const telegram = (enabled: boolean) => ({
    telegram: {
      enabled: true,
      token_env: 'FORGE_TELEGRAM_TOKEN_TEST',
      api_base_url: 'https://tg.example',
      poll_timeout_s: 1,
      allowed_chat_ids: [],
      attachments: { enabled, dir: attachmentsDir, max_file_bytes: 1024, retention_days: 7 },
    },
  });
  const base = config({
    levels: { safe: false, network: false, filesystem: true, sensitive: false },
    filesystem: { readable_dirs: [], writable_dirs: [] },
  });

  const on: ForgeConfig = { ...base, channels: telegram(true) };
  assert.equal(isPathAllowed(on, path.join(attachmentsDir, 'photo.jpg'), 'read').allowed, true);
  // Implicit READ root only — never writable, and no reach outside the dir.
  assert.equal(isPathAllowed(on, path.join(attachmentsDir, 'photo.jpg'), 'write').allowed, false);
  assert.equal(isPathAllowed(on, path.resolve('elsewhere', 'photo.jpg'), 'read').allowed, false);

  const off: ForgeConfig = { ...base, channels: telegram(false) };
  assert.equal(isPathAllowed(off, path.join(attachmentsDir, 'photo.jpg'), 'read').allowed, false);
});

test('LLMService advertises tools in Ollama native format and parses tool_calls', async () => {
  let body: {
    tools?: Array<{ type: string; function: { name: string; description: string; parameters: unknown } }>;
  } = {};
  const fetchMock: typeof fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body ?? '{}')) as typeof body;
    return new Response(JSON.stringify({
      message: {
        content: '',
        tool_calls: [
          { function: { name: 'echo', arguments: { text: 'hi' } } },
          { bogus: true },
          { function: { name: '', arguments: {} } },
        ],
      },
      prompt_eval_count: 5,
      eval_count: 2,
    }), { status: 200 });
  };
  const service = new LLMService(config(), { fetchImpl: fetchMock });

  const res = await service.complete({
    system: 'system',
    messages: [{ role: 'user', content: 'echo hi' }],
    tools: [tool()],
  });

  assert.deepEqual(body.tools, [{
    type: 'function',
    function: {
      name: 'echo',
      description: 'Echo a value.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  }]);
  // Malformed tool_calls entries are dropped; valid ones parse.
  assert.deepEqual(res.toolCalls, [{ name: 'echo', arguments: { text: 'hi' } }]);
  assert.equal(res.content, '');
});

test('LLMService sends no tools field and requires content when tools are absent', async () => {
  let raw = '';
  const fetchMock: typeof fetch = async (_url, init) => {
    raw = String(init?.body ?? '{}');
    return new Response(JSON.stringify({ message: { content: 'plain' } }), { status: 200 });
  };
  const service = new LLMService(config(), { fetchImpl: fetchMock });

  const res = await service.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.content, 'plain');
  assert.equal(res.toolCalls, undefined);
  assert.ok(!Object.hasOwn(JSON.parse(raw) as Record<string, unknown>, 'tools'));
});

test('LLMService replays tool history messages to Ollama', async () => {
  let messages: Array<Record<string, unknown>> = [];
  const fetchMock: typeof fetch = async (_url, init) => {
    messages = (JSON.parse(String(init?.body ?? '{}')) as { messages: Array<Record<string, unknown>> }).messages;
    return new Response(JSON.stringify({ message: { content: 'final' } }), { status: 200 });
  };
  const service = new LLMService(config(), { fetchImpl: fetchMock });

  await service.complete({
    system: 's',
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'echo', arguments: { text: 'hi' } } }] },
      { role: 'tool', content: '{"ok":true,"result":"hi"}', tool_name: 'echo' },
    ],
  });

  assert.deepEqual(messages, [
    { role: 'system', content: 's' },
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'echo', arguments: { text: 'hi' } } }] },
    { role: 'tool', content: '{"ok":true,"result":"hi"}', tool_name: 'echo' },
  ]);
});
