import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { AgentService } from './agent.ts';
import { ToolRegistry } from './tools/registry.ts';
import { ToolCallLog } from './tools/log.ts';
import { messagesRoutes } from '../web/routes/messages.ts';
import type { ForgeConfig, LLMRequest, LLMResponse, ToolDef, ToolsConfig } from '../types.ts';

const TOOLS_SCHEMA = fs.readFileSync(new URL('../db/schemas/tools.sql', import.meta.url), 'utf-8');

function toolsDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(TOOLS_SCHEMA);
  return db;
}

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

function textResponse(content: string): LLMResponse {
  return { content, provider: 'ollama', model: 'local-model', inputTokens: 1, outputTokens: 1 };
}

function toolCallResponse(name: string, args: Record<string, unknown>): LLMResponse {
  return { ...textResponse(''), toolCalls: [{ name, arguments: args }] };
}

function scriptedLlm(responses: LLMResponse[]): { requests: LLMRequest[]; complete: (req: LLMRequest) => Promise<LLMResponse> } {
  const requests: LLMRequest[] = [];
  const queue = [...responses];
  return {
    requests,
    async complete(req: LLMRequest): Promise<LLMResponse> {
      requests.push({ ...req, messages: req.messages.map(m => ({ ...m })) });
      const next = queue.shift();
      if (!next) throw new Error('scripted llm ran out of responses');
      return next;
    },
  };
}

function echoTool(calls: unknown[] = []): ToolDef {
  return {
    name: 'echo',
    description: 'Echo back the provided text.',
    params: z.object({ text: z.string() }),
    permission: 'safe',
    handler: (args) => {
      calls.push(args);
      return { echoed: args.text };
    },
  };
}

test('agent loop: register -> call -> result -> final text, with audit log rows', async () => {
  const handlerCalls: unknown[] = [];
  const registry = new ToolRegistry();
  registry.register(echoTool(handlerCalls));
  const db = toolsDb();
  const llm = scriptedLlm([
    toolCallResponse('echo', { text: 'hello tools' }),
    textResponse('The echo tool returned: hello tools'),
  ]);
  const agent = new AgentService({ config: config(), llm, registry, log: new ToolCallLog(db) });

  const result = await agent.runTurn({
    system: 'You are forge.',
    messages: [{ role: 'user', content: 'echo hello tools' }],
    messageId: 'msg-1',
  });

  assert.equal(result.content, 'The echo tool returned: hello tools');
  assert.deepEqual(handlerCalls, [{ text: 'hello tools' }]);

  // First request advertises the allowed tool and appends the tool contract.
  assert.equal(llm.requests[0].tools?.length, 1);
  assert.equal(llm.requests[0].tools?.[0].name, 'echo');
  assert.match(llm.requests[0].system, /Tool Use Contract/);
  assert.match(llm.requests[0].system, /UNTRUSTED DATA/);

  // Second request replays the assistant tool_calls message plus the result.
  const replay = llm.requests[1].messages;
  const assistantMsg = replay[replay.length - 2];
  const toolMsg = replay[replay.length - 1];
  assert.equal(assistantMsg.role, 'assistant');
  assert.deepEqual(assistantMsg.tool_calls, [{ function: { name: 'echo', arguments: { text: 'hello tools' } } }]);
  assert.equal(toolMsg.role, 'tool');
  assert.equal(toolMsg.tool_name, 'echo');
  assert.deepEqual(JSON.parse(toolMsg.content), { ok: true, result: { echoed: 'hello tools' } });

  const rows = db.prepare('SELECT * FROM tool_calls ORDER BY id').all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tool_name, 'echo');
  assert.equal(rows[0].permission, 'safe');
  assert.equal(rows[0].allowed, 1);
  assert.equal(rows[0].ok, 1);
  assert.equal(rows[0].message_id, 'msg-1');
  assert.equal(typeof rows[0].duration_ms, 'number');
});

test('agent loop: permission-denied tools return a structured error and never run', async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool());
  let sensitiveRan = false;
  registry.register({
    name: 'wipe_disk',
    description: 'A sensitive tool that must not run.',
    params: z.object({}),
    permission: 'sensitive',
    handler: () => {
      sensitiveRan = true;
      return 'ran';
    },
  });
  const db = toolsDb();
  const llm = scriptedLlm([
    toolCallResponse('wipe_disk', {}),
    textResponse('That tool is not permitted.'),
  ]);
  const agent = new AgentService({ config: config(), llm, registry, log: new ToolCallLog(db) });

  const result = await agent.runTurn({ system: 's', messages: [{ role: 'user', content: 'wipe it' }] });

  assert.equal(result.content, 'That tool is not permitted.');
  assert.equal(sensitiveRan, false);

  // Only the allowed tool was ever advertised to the model.
  assert.deepEqual(llm.requests[0].tools?.map(t => t.name), ['echo']);

  const toolMsg = llm.requests[1].messages.at(-1);
  assert.equal(toolMsg?.role, 'tool');
  const envelope = JSON.parse(toolMsg?.content ?? '{}') as { ok: boolean; error: string };
  assert.equal(envelope.ok, false);
  assert.match(envelope.error, /Permission denied/);
  assert.match(envelope.error, /sensitive/);

  const row = db.prepare('SELECT * FROM tool_calls').get() as Record<string, unknown>;
  assert.equal(row.allowed, 0);
  assert.match(String(row.denied_reason), /sensitive/);
});

test('agent loop: handler errors become structured tool results, never throws', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'broken',
    description: 'Always fails.',
    params: z.object({}),
    permission: 'safe',
    handler: () => {
      throw new Error('boom');
    },
  });
  const db = toolsDb();
  const llm = scriptedLlm([
    toolCallResponse('broken', {}),
    textResponse('The tool failed.'),
  ]);
  const agent = new AgentService({ config: config(), llm, registry, log: new ToolCallLog(db) });

  const result = await agent.runTurn({ system: 's', messages: [{ role: 'user', content: 'try it' }] });

  assert.equal(result.content, 'The tool failed.');
  const envelope = JSON.parse(llm.requests[1].messages.at(-1)?.content ?? '{}') as { ok: boolean; error: string };
  assert.equal(envelope.ok, false);
  assert.match(envelope.error, /boom/);

  const row = db.prepare('SELECT * FROM tool_calls').get() as Record<string, unknown>;
  assert.equal(row.allowed, 1);
  assert.equal(row.ok, 0);
  assert.match(String(row.error), /boom/);
});

test('agent loop: invalid arguments are rejected by the zod gate before the handler', async () => {
  const handlerCalls: unknown[] = [];
  const registry = new ToolRegistry();
  registry.register(echoTool(handlerCalls));
  const llm = scriptedLlm([
    toolCallResponse('echo', { text: 42 }),
    textResponse('Bad arguments.'),
  ]);
  const agent = new AgentService({ config: config(), llm, registry });

  const result = await agent.runTurn({ system: 's', messages: [{ role: 'user', content: 'echo' }] });

  assert.equal(result.content, 'Bad arguments.');
  assert.equal(handlerCalls.length, 0);
  const envelope = JSON.parse(llm.requests[1].messages.at(-1)?.content ?? '{}') as { ok: boolean; error: string };
  assert.equal(envelope.ok, false);
  assert.match(envelope.error, /Invalid arguments/);
});

test('agent loop: iteration cap forces a final no-tools completion', async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool());
  const llm = scriptedLlm([
    toolCallResponse('echo', { text: '1' }),
    toolCallResponse('echo', { text: '2' }),
    textResponse('Done after the cap.'),
  ]);
  const agent = new AgentService({ config: config({ max_iterations: 2 }), llm, registry });

  const result = await agent.runTurn({ system: 's', messages: [{ role: 'user', content: 'loop' }] });

  assert.equal(result.content, 'Done after the cap.');
  assert.equal(llm.requests.length, 3);
  assert.equal(llm.requests[0].tools?.length, 1);
  assert.equal(llm.requests[1].tools?.length, 1);
  // The forced final completion offers no tools.
  assert.equal(llm.requests[2].tools, undefined);
});

test('agent loop: with no permitted tools it degrades to a plain completion', async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool());
  const llm = scriptedLlm([textResponse('plain reply')]);
  const agent = new AgentService({
    config: config({ levels: { safe: false, network: false, filesystem: false, sensitive: false } }),
    llm,
    registry,
  });

  const result = await agent.runTurn({ system: 'plain system', messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(result.content, 'plain reply');
  assert.equal(llm.requests.length, 1);
  assert.equal(llm.requests[0].tools, undefined);
  // No tool contract is appended when the turn cannot use tools.
  assert.equal(llm.requests[0].system, 'plain system');
});

// --- Route wiring -------------------------------------------------------------

function makeDb() {
  const runs: unknown[][] = [];
  return {
    runs,
    prepare(sql: string) {
      return {
        all() {
          return sql.includes("WHERE channel = 'web'") ? [] : [];
        },
        run(...args: unknown[]) {
          runs.push(args);
        },
      };
    },
  };
}

function routeCtx(overrides: Record<string, unknown>) {
  return {
    config: config(),
    dbManager: { get: () => makeDb() },
    memory: { async retrieveForChat() { return []; } },
    authToken: 'test',
    identity: 'You are forge-local.',
    identityDir: '.',
    readIdentity: () => 'You are forge-local.',
    resolved: { root: '.', dbs: '.', identity: '.', logs: '.' },
    ...overrides,
  };
}

async function postMessage(ctx: Record<string, unknown>): Promise<{ status: number; body: { reply?: string; error?: string } }> {
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/messages', messagesRoutes(ctx as never));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });
    return { status: response.status, body: await response.json() as { reply?: string; error?: string } };
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
}

test('route: tools disabled keeps today\'s plain completion path, agent untouched', async () => {
  const disabled = config();
  disabled.tools = { ...disabled.tools!, enabled: false };
  let agentCalls = 0;
  const result = await postMessage(routeCtx({
    config: disabled,
    llm: { async complete() { return textResponse('plain path reply'); } },
    agent: { async runTurn() { agentCalls += 1; throw new Error('agent must not run'); } },
  }));

  assert.equal(result.status, 200);
  assert.equal(result.body.reply, 'plain path reply');
  assert.equal(agentCalls, 0);
});

test('route: tools enabled sends the turn through the agent loop', async () => {
  let agentCalls = 0;
  let llmCalls = 0;
  const result = await postMessage(routeCtx({
    llm: { async complete() { llmCalls += 1; throw new Error('llm.complete must not be called directly'); } },
    agent: {
      async runTurn(input: { system: string; messages: unknown[] }) {
        agentCalls += 1;
        assert.match(input.system, /You are forge-local/);
        return textResponse('agent reply');
      },
    },
  }));

  assert.equal(result.status, 200);
  assert.equal(result.body.reply, 'agent reply');
  assert.equal(agentCalls, 1);
  assert.equal(llmCalls, 0);
});
