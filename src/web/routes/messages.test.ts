import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { messagesRoutes } from './messages.ts';

function config() {
  return {
    forge: { name: 'forge-local', version: '0.1.0', root: '.' },
    user: { name: 'Alice' },
    llm: {
      provider: 'ollama',
      model: 'local-model',
      ollama: { base_url: 'http://localhost:11434', keep_alive: '10m', options: {} },
    },
    paths: { dbs: './dbs', identity: './identity', logs: './logs' },
    services: { web: { host: '127.0.0.1', port: 6800, context_window_tokens: 80000, debug_prompt_context: false } },
    memory: { retention_days: 30 },
  };
}

type HistoryRow = {
  id: string;
  user: 'user' | 'assistant';
  text: string;
  receivedAt: number;
};

function configWith(overrides: Record<string, unknown>) {
  return {
    ...config(),
    ...overrides,
  };
}

function makeDb(historyRows: HistoryRow[] = []) {
  const runs: unknown[][] = [];
  const queries: unknown[][] = [];
  return {
    runs,
    queries,
    prepare(sql: string) {
      return {
        all(...args: unknown[]) {
          queries.push([sql, ...args]);
          if (sql.includes('WHERE channel = \'web\'')) return historyRows;
          return sql.includes('SELECT * FROM messages') ? [] : [];
        },
        run(...args: unknown[]) {
          runs.push(args);
        },
      };
    },
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

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const pngBase64 = pngBytes.toString('base64');

test('POST /api/messages handles /remember without calling the LLM', async () => {
  const db = makeDb();
  let llmCalls = 0;
  const saved: unknown[] = [];
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/messages', messagesRoutes({
    config: config(),
    dbManager: { get: () => db },
    memory: {
      async save(input: unknown) {
        saved.push(input);
        return 'mem-1';
      },
      remove() {
        return false;
      },
      async retrieveForChat() {
        return [];
      },
    },
    llm: {
      async complete() {
        llmCalls += 1;
        return { content: 'should not happen', provider: 'ollama', model: 'local-model', inputTokens: 0, outputTokens: 0 };
      },
    },
    authToken: 'test',
    identity: 'You are forge-local.',
    identityDir: '.',
    readIdentity: () => 'You are forge-local.',
    resolved: { root: '.', dbs: '.', identity: '.', logs: '.' },
  } as never));

  await withServer(app, async (url) => {
    const response = await fetch(`${url}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '/remember Use configured names' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.reply, 'Remembered. Memory ID: mem-1');
    assert.equal(body.agentName, 'forge-local');
    assert.equal(body.memoryId, 'mem-1');
  });

  assert.equal(llmCalls, 0);
  assert.deepEqual(saved, [{
    type: 'chat',
    content: 'Use configured names',
    tags: ['chat', 'explicit'],
    confidence: 1.0,
    importance: 0.7,
  }]);
  assert.equal(db.runs.length, 2);
});

test('POST /api/messages handles /forget without calling the LLM', async () => {
  const db = makeDb();
  let llmCalls = 0;
  const removed: string[] = [];
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/messages', messagesRoutes({
    config: config(),
    dbManager: { get: () => db },
    memory: {
      save() {
        throw new Error('should not save');
      },
      remove(id: string) {
        removed.push(id);
        return true;
      },
      async retrieveForChat() {
        return [];
      },
    },
    llm: {
      async complete() {
        llmCalls += 1;
        return { content: 'should not happen', provider: 'ollama', model: 'local-model', inputTokens: 0, outputTokens: 0 };
      },
    },
    authToken: 'test',
    identity: 'You are forge-local.',
    identityDir: '.',
    readIdentity: () => 'You are forge-local.',
    resolved: { root: '.', dbs: '.', identity: '.', logs: '.' },
  } as never));

  await withServer(app, async (url) => {
    const response = await fetch(`${url}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '/forget mem-1' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(typeof body.reply, 'string');
    assert.equal(body.agentName, 'forge-local');
    assert.equal(body.memoryId, 'mem-1');
  });

  assert.equal(llmCalls, 0);
  assert.deepEqual(removed, ['mem-1']);
  assert.equal(db.runs.length, 2);
});

test('POST /api/messages sends bounded prior web turns plus current user turn', async () => {
  const db = makeDb([
    { id: 'web:assistant:1', user: 'assistant', text: 'Prior assistant answer', receivedAt: 20 },
    { id: 'web:user:1', user: 'user', text: 'Prior user question', receivedAt: 10 },
  ]);
  let capturedMessages: Array<{ role: string; content: string; images?: string[] }> = [];
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/messages', messagesRoutes({
    config: configWith({
      llm: {
        ...config().llm,
        ollama: { ...config().llm.ollama, options: { num_ctx: 8192 } },
      },
    }),
    dbManager: { get: () => db },
    memory: { retrieveForChat: async () => [] },
    llm: {
      async complete(request: { messages: Array<{ role: string; content: string; images?: string[] }> }) {
        capturedMessages = request.messages;
        return { content: 'current answer', provider: 'ollama', model: 'local-model', inputTokens: 14, outputTokens: 4 };
      },
    },
    authToken: 'test',
    identity: 'You are forge-local.',
    identityDir: '.',
    readIdentity: () => 'You are forge-local.',
    resolved: { root: '.', dbs: '.', identity: '.', logs: '.' },
  } as never));

  await withServer(app, async (url) => {
    const response = await fetch(`${url}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Current user question' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.model, 'local-model');
    assert.deepEqual(body.usage, { input: 14, output: 4 });
  });

  assert.deepEqual(capturedMessages.map(message => [message.role, message.content]), [
    ['user', 'Prior user question'],
    ['assistant', 'Prior assistant answer'],
    ['user', 'Current user question'],
  ]);
  assert.equal(capturedMessages.filter(message => message.content === 'Current user question').length, 1);
});

test('POST /api/messages retrieves up to five hybrid memories before building the existing prompt contract', async () => {
  const db = makeDb();
  let capturedSystem = '';
  const retrievalCalls: Array<[string, number]> = [];
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/messages', messagesRoutes({
    config: config(),
    dbManager: { get: () => db },
    memory: {
      async retrieveForChat(query: string, limit: number) {
        retrievalCalls.push([query, limit]);
        return [
          { type: 'chat', content: 'likes local models' },
          { type: 'chat', content: 'memory two' },
          { type: 'chat', content: 'memory three' },
          { type: 'chat', content: 'memory four' },
          { type: 'chat', content: 'memory five' },
          { type: 'chat', content: 'memory six' },
        ];
      },
    },
    llm: {
      async complete(request: { system: string }) {
        capturedSystem = request.system;
        return { content: 'local reply', provider: 'ollama', model: 'local-model', inputTokens: 12, outputTokens: 5 };
      },
    },
    authToken: 'test',
    identity: 'stale identity',
    identityDir: '.',
    readIdentity: () => 'You are forge-local.',
    resolved: { root: '.', dbs: '.', identity: '.', logs: '.' },
  } as never));

  await withServer(app, async (url) => {
    const response = await fetch(`${url}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.reply, 'local reply');
    assert.equal(body.provider, 'ollama');
    assert.equal(body.model, 'local-model');
    assert.deepEqual(body.usage, { input: 12, output: 5 });
    assert.equal(body.prompt_context, undefined);
  });

  assert.match(capturedSystem, /You are forge-local\./);
  assert.match(capturedSystem, /## Memory Contract/);
  assert.match(capturedSystem, /Forge manages long-term memory outside the model\./);
  assert.match(capturedSystem, /Explicit memories are saved only when the user uses \/remember/);
  assert.match(capturedSystem, /You do not directly read or write the memory database/);
  assert.match(capturedSystem, /must not claim a memory was saved unless Forge confirms it/);
  assert.match(capturedSystem, /likes local models/);
  assert.match(capturedSystem, /memory five/);
  assert.doesNotMatch(capturedSystem, /memory six/);
  assert.deepEqual(retrievalCalls, [['hello', 5]]);
  assert.equal(db.runs.length, 2);
  assert.match(String(db.runs[1][6]), /"provider":"ollama"/);
});

test('POST /api/messages returns true per-turn context stats and persists them in llm_metadata', async () => {
  // Newest-first, matching the ORDER BY receivedAt DESC of the real query.
  const db = makeDb([
    { id: 'h2', user: 'assistant', text: 'earlier answer', receivedAt: 2 },
    { id: 'h1', user: 'user', text: 'earlier question', receivedAt: 1 },
  ]);
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/messages', messagesRoutes({
    config: config(),
    dbManager: { get: () => db },
    memory: { async retrieveForChat() { return []; } },
    llm: {
      async complete() {
        return { content: 'reply', provider: 'ollama', model: 'local-model', inputTokens: 12, outputTokens: 5 };
      },
    },
    authToken: 'test',
    identity: 'You are forge-local.',
    identityDir: '.',
    readIdentity: () => 'You are forge-local.',
    resolved: { root: '.', dbs: '.', identity: '.', logs: '.' },
  } as never));

  await withServer(app, async (url) => {
    const response = await fetch(`${url}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      context: { estimatedPromptTokens: number; promptBudgetTokens: number; includedHistoryMessages: number; omittedHistoryMessages: number };
    };

    assert.ok(body.context.estimatedPromptTokens > 0);
    assert.ok(body.context.promptBudgetTokens > 0);
    assert.ok(body.context.estimatedPromptTokens <= body.context.promptBudgetTokens);
    assert.equal(body.context.includedHistoryMessages, 2);
    assert.equal(body.context.omittedHistoryMessages, 0);
  });

  const metadata = JSON.parse(String(db.runs[1][6])) as { context?: { promptBudgetTokens?: number } };
  assert.ok((metadata.context?.promptBudgetTokens ?? 0) > 0);
});

test('POST /api/messages does not queue identity reflection when disabled', async () => {
  const db = makeDb();
  let reflectionCalls = 0;
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/messages', messagesRoutes({
    config: {
      ...config(),
      identity: { reflection: { enabled: false, cadence_turns: 1, recent_notes_in_context: 5 } },
    },
    dbManager: { get: () => db },
    memory: { retrieveForChat: async () => [] },
    llm: {
      async complete() {
        return { content: 'local reply', provider: 'ollama', model: 'local-model', inputTokens: 1, outputTokens: 1 };
      },
    },
    identityReflection: {
      reflectAfterAssistantReply() {
        reflectionCalls += 1;
        throw new Error('should not run');
      },
    },
    authToken: 'test',
    identity: 'You are forge-local.',
    identityDir: '.',
    readIdentity: () => 'You are forge-local.',
    resolved: { root: '.', dbs: '.', identity: '.', logs: '.' },
  } as never));

  await withServer(app, async (url) => {
    const response = await fetch(`${url}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });
    assert.equal(response.status, 200);
  });
  await waitForQueuedReflection();

  assert.equal(reflectionCalls, 0);
});

test('POST /api/messages schedules identity reflection after assistant persistence', async () => {
  const db = makeDb();
  let runCountAtReflection = 0;
  let reflectionInput: { userMessage: string; assistantMessage: string; assistantMessageId: string } | undefined;
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/messages', messagesRoutes({
    config: {
      ...config(),
      identity: { reflection: { enabled: true, cadence_turns: 1, recent_notes_in_context: 5 } },
    },
    dbManager: { get: () => db },
    memory: { retrieveForChat: async () => [] },
    llm: {
      async complete() {
        return { content: 'reflected reply', provider: 'ollama', model: 'local-model', inputTokens: 1, outputTokens: 1 };
      },
    },
    identityReflection: {
      reflectAfterAssistantReply(input: { userMessage: string; assistantMessage: string; assistantMessageId: string }) {
        runCountAtReflection = db.runs.length;
        reflectionInput = input;
      },
    },
    authToken: 'test',
    identity: 'You are forge-local.',
    identityDir: '.',
    readIdentity: () => 'You are forge-local.',
    resolved: { root: '.', dbs: '.', identity: '.', logs: '.' },
  } as never));

  await withServer(app, async (url) => {
    const response = await fetch(`${url}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.reply, 'reflected reply');
  });
  await waitForQueuedReflection();

  assert.equal(runCountAtReflection, 2);
  assert.deepEqual(reflectionInput?.userMessage, 'hello');
  assert.deepEqual(reflectionInput?.assistantMessage, 'reflected reply');
  assert.match(reflectionInput?.assistantMessageId ?? '', /^web:assistant:/);
});

test('POST /api/messages keeps chat successful when identity reflection fails', async () => {
  const db = makeDb();
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    const app = express();
    app.use(express.json({ limit: '8mb' }));
    app.use('/api/messages', messagesRoutes({
      config: {
        ...config(),
        identity: { reflection: { enabled: true, cadence_turns: 1, recent_notes_in_context: 5 } },
      },
      dbManager: { get: () => db },
      memory: { retrieveForChat: async () => [] },
      llm: {
        async complete() {
          return { content: 'still succeeds', provider: 'ollama', model: 'local-model', inputTokens: 1, outputTokens: 1 };
        },
      },
      identityReflection: {
        reflectAfterAssistantReply() {
          throw new Error('reflection exploded');
        },
      },
      authToken: 'test',
      identity: 'You are forge-local.',
      identityDir: '.',
      readIdentity: () => 'You are forge-local.',
      resolved: { root: '.', dbs: '.', identity: '.', logs: '.' },
    } as never));

    await withServer(app, async (url) => {
      const response = await fetch(`${url}/api/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hello' }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.reply, 'still succeeds');
    });
    await waitForQueuedReflection();
  } finally {
    console.warn = originalWarn;
  }

  assert.match(String(warnings[0]?.[0] ?? ''), /identity-reflection/);
  assert.match(String(warnings[0]?.[1] ?? ''), /reflection exploded/);
});

test('POST /api/messages passes valid text attachments to LLM without storing bodies in user message', async () => {
  const db = makeDb();
  let capturedUserContent = '';
  const attachmentContent = '# Notes\nLocal Ollama context only.';
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/messages', messagesRoutes({
    config: config(),
    dbManager: { get: () => db },
    memory: { retrieveForChat: async () => [] },
    llm: {
      async complete(request: { messages: Array<{ role: string; content: string }> }) {
        capturedUserContent = request.messages[0].content;
        return { content: 'read it', provider: 'ollama', model: 'local-model', inputTokens: 10, outputTokens: 2 };
      },
    },
    authToken: 'test',
    identity: 'You are forge-local.',
    identityDir: '.',
    readIdentity: () => 'You are forge-local.',
    resolved: { root: '.', dbs: '.', identity: '.', logs: '.' },
  } as never));

  await withServer(app, async (url) => {
    const response = await fetch(`${url}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Please summarize the attachment.',
        attachments: [{
          name: 'notes.md',
          type: 'text/markdown',
          size: Buffer.byteLength(attachmentContent, 'utf8'),
          content: attachmentContent,
        }],
      }),
    });
    assert.equal(response.status, 200);
  });

  assert.equal(db.runs.length, 2);
  assert.equal(db.runs[0][2], 'Please summarize the attachment.');
  assert.doesNotMatch(String(db.runs[0][2]), /Local Ollama context only/);
  assert.match(capturedUserContent, /Please summarize the attachment\./);
  assert.match(capturedUserContent, /## Attachments/);
  assert.match(capturedUserContent, /### Attachment 1: notes\.md/);
  assert.match(capturedUserContent, /Local Ollama context only\./);
});

test('POST /api/messages passes mixed text and image attachments to LLM without persisting image data', async () => {
  const db = makeDb();
  let capturedMessages: Array<{ role: string; content: string; images?: string[] }> = [];
  const attachmentContent = 'visible text context';
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/messages', messagesRoutes({
    config: config(),
    dbManager: { get: () => db },
    memory: { retrieveForChat: async () => [] },
    llm: {
      async complete(request: { messages: Array<{ role: string; content: string; images?: string[] }> }) {
        capturedMessages = request.messages;
        return { content: 'saw both', provider: 'ollama', model: 'local-model', inputTokens: 10, outputTokens: 2 };
      },
    },
    authToken: 'test',
    identity: 'You are forge-local.',
    identityDir: '.',
    readIdentity: () => 'You are forge-local.',
    resolved: { root: '.', dbs: '.', identity: '.', logs: '.' },
  } as never));

  await withServer(app, async (url) => {
    const response = await fetch(`${url}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Please inspect these.',
        attachments: [
          {
            kind: 'text',
            name: 'notes.txt',
            type: 'text/plain',
            size: Buffer.byteLength(attachmentContent, 'utf8'),
            content: attachmentContent,
          },
          {
            kind: 'image',
            name: 'pixel.png',
            type: 'image/png',
            size: pngBytes.length,
            data: pngBase64,
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
  });

  assert.equal(db.runs.length, 2);
  assert.equal(db.runs[0][2], 'Please inspect these.');
  assert.doesNotMatch(String(db.runs[0][2]), new RegExp(pngBase64));
  assert.match(capturedMessages[0].content, /visible text context/);
  assert.deepEqual(capturedMessages[0].images, [pngBase64]);
});

test('POST /api/messages does not resend previous image data from history', async () => {
  const db = makeDb([
    { id: 'web:assistant:1', user: 'assistant', text: 'I saw the image.', receivedAt: 20 },
    { id: 'web:user:1', user: 'user', text: 'Inspect the previous image.', receivedAt: 10 },
  ]);
  let capturedMessages: Array<{ role: string; content: string; images?: string[] }> = [];
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/messages', messagesRoutes({
    config: config(),
    dbManager: { get: () => db },
    memory: { retrieveForChat: async () => [] },
    llm: {
      async complete(request: { messages: Array<{ role: string; content: string; images?: string[] }> }) {
        capturedMessages = request.messages;
        return { content: 'ok', provider: 'ollama', model: 'local-model', inputTokens: 10, outputTokens: 2 };
      },
    },
    authToken: 'test',
    identity: 'You are forge-local.',
    identityDir: '.',
    readIdentity: () => 'You are forge-local.',
    resolved: { root: '.', dbs: '.', identity: '.', logs: '.' },
  } as never));

  await withServer(app, async (url) => {
    const response = await fetch(`${url}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Follow up without an image.' }),
    });
    assert.equal(response.status, 200);
  });

  assert.equal(capturedMessages.length, 3);
  assert.equal(capturedMessages.some(message => message.images !== undefined), false);
  assert.doesNotMatch(JSON.stringify(capturedMessages), new RegExp(pngBase64));
});

test('POST /api/messages rejects invalid text attachments before DB writes', async () => {
  const db = makeDb();
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/messages', messagesRoutes({
    config: config(),
    dbManager: { get: () => db },
    memory: { retrieveForChat: async () => [] },
    llm: { async complete() { throw new Error('should not run'); } },
    authToken: 'test',
    identity: 'You are forge-local.',
    identityDir: '.',
    readIdentity: () => 'You are forge-local.',
    resolved: { root: '.', dbs: '.', identity: '.', logs: '.' },
  } as never));

  await withServer(app, async (url) => {
    let response = await fetch(`${url}/api/messages?attachments=bad`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'read this' }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'attachments must be provided in the JSON body' });

    response = await fetch(`${url}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'read this', extra: true }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'body must include only content and attachments' });

    response = await fetch(`${url}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'read this',
        attachments: [{ name: 'scan.pdf', type: 'application/pdf', size: 4, content: 'nope' }],
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'attachment type is unsupported; use .txt, .md, .json, or .csv' });

    response = await fetch(`${url}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'read this',
        attachments: [{ name: 'notes.md', type: 'application/pdf', size: 4, content: 'nope' }],
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'attachment MIME type is unsupported for its extension' });

    response = await fetch(`${url}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'read these',
        attachments: [
          { name: 'a.txt', type: 'text/plain', size: 1, content: 'a' },
          { name: 'b.txt', type: 'text/plain', size: 1, content: 'b' },
          { name: 'c.txt', type: 'text/plain', size: 1, content: 'c' },
          { name: 'd.txt', type: 'text/plain', size: 1, content: 'd' },
        ],
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'attachments must include at most 3 files' });

    const oversized = 'x'.repeat((128 * 1024) + 1);
    response = await fetch(`${url}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'read this',
        attachments: [{ name: 'large.txt', type: 'text/plain', size: Buffer.byteLength(oversized, 'utf8'), content: oversized }],
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'attachment exceeds 131072 bytes' });
  });

  assert.equal(db.runs.length, 0);
});

test('POST /api/messages rejects invalid image attachments before DB writes', async () => {
  const db = makeDb();
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/messages', messagesRoutes({
    config: config(),
    dbManager: { get: () => db },
    memory: { retrieveForChat: async () => [] },
    llm: { async complete() { throw new Error('should not run'); } },
    authToken: 'test',
    identity: 'You are forge-local.',
    identityDir: '.',
    readIdentity: () => 'You are forge-local.',
    resolved: { root: '.', dbs: '.', identity: '.', logs: '.' },
  } as never));

  const oversized = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc((2 * 1024 * 1024) - 7),
  ]);

  const cases = [
    {
      attachment: { kind: 'image', name: 'pixel.bmp', type: 'image/png', size: pngBytes.length, data: pngBase64 },
      error: 'image attachment type is unsupported; use .jpg, .jpeg, .png, .gif, .tif, or .tiff',
    },
    {
      attachment: { kind: 'image', name: 'pixel.png', type: 'image/jpeg', size: pngBytes.length, data: pngBase64 },
      error: 'image attachment MIME type is unsupported for its extension',
    },
    {
      attachment: { kind: 'image', name: 'pixel.png', type: 'image/png', size: 3, data: 'not-base64' },
      error: 'image attachment data must be valid base64',
    },
    {
      attachment: { kind: 'image', name: 'pixel.jpg', type: 'image/jpeg', size: pngBytes.length, data: pngBase64 },
      error: 'image attachment data does not match its extension',
    },
    {
      attachment: { kind: 'image', name: 'large.png', type: 'image/png', size: oversized.length, data: oversized.toString('base64') },
      error: 'image attachment exceeds 2097152 bytes',
    },
  ];

  await withServer(app, async (url) => {
    for (const entry of cases) {
      const response = await fetch(`${url}/api/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'inspect this', attachments: [entry.attachment] }),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: entry.error });
    }
  });

  assert.equal(db.runs.length, 0);
});

test('POST /api/messages debug prompt context keeps selected history and attachment metadata without bodies', async () => {
  const db = makeDb([
    { id: 'web:assistant:1', user: 'assistant', text: 'Prior assistant context', receivedAt: 20 },
    { id: 'web:user:1', user: 'user', text: 'Prior user context', receivedAt: 10 },
  ]);
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/messages', messagesRoutes({
    config: {
      ...config(),
      services: { web: { ...config().services.web, debug_prompt_context: true } },
    },
    dbManager: { get: () => db },
    memory: { retrieveForChat: async () => [] },
    llm: {
      async complete() {
        return { content: 'ok', provider: 'ollama', model: 'local-model', inputTokens: 1, outputTokens: 1 };
      },
    },
    authToken: 'test',
    identity: 'You are forge-local.',
    identityDir: '.',
    readIdentity: () => 'You are forge-local.',
    resolved: { root: '.', dbs: '.', identity: '.', logs: '.' },
  } as never));

  await withServer(app, async (url) => {
    const response = await fetch(`${url}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Inspect metadata only.',
        attachments: [
          {
            name: 'data.json',
            type: 'application/json; charset=utf-8',
            size: Buffer.byteLength('{"secret":"do not persist"}', 'utf8'),
            content: '{"secret":"do not persist"}',
          },
          {
            kind: 'image',
            name: 'pixel.png',
            type: 'application/octet-stream',
            size: pngBytes.length,
            data: pngBase64,
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.prompt_context, 'string');
    assert.doesNotMatch(body.prompt_context, /do not persist/);
    assert.doesNotMatch(body.prompt_context, new RegExp(pngBase64));
    assert.match(body.prompt_context, /data\.json/);
    assert.match(body.prompt_context, /pixel\.png/);
  });

  const promptContext = String(db.runs[1][7]);
  assert.match(promptContext, /Prior user context/);
  assert.match(promptContext, /Prior assistant context/);
  assert.match(promptContext, /"includedMessages":2/);
  assert.match(promptContext, /"omittedMessages":0/);
  assert.match(promptContext, /"estimatedPromptTokens":/);
  assert.match(promptContext, /"promptBudgetTokens":/);
  assert.doesNotMatch(promptContext, /do not persist/);
  assert.doesNotMatch(promptContext, new RegExp(pngBase64));
  assert.match(promptContext, /"name":"data\.json"/);
  assert.match(promptContext, /"chars":27/);
  assert.match(promptContext, /"name":"pixel\.png"/);
  assert.match(promptContext, /"bytes":9/);
});

test('POST /api/messages returns 413 when current context exceeds prompt budget', async () => {
  const db = makeDb();
  let llmCalls = 0;
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/messages', messagesRoutes({
    config: configWith({
      llm: {
        ...config().llm,
        ollama: { ...config().llm.ollama, options: { num_ctx: 32, num_predict: 1 } },
      },
    }),
    dbManager: { get: () => db },
    memory: { retrieveForChat: async () => [] },
    llm: {
      async complete() {
        llmCalls += 1;
        return { content: 'should not happen', provider: 'ollama', model: 'local-model', inputTokens: 0, outputTokens: 0 };
      },
    },
    authToken: 'test',
    identity: 'You are forge-local.',
    identityDir: '.',
    readIdentity: () => 'You are forge-local.',
    resolved: { root: '.', dbs: '.', identity: '.', logs: '.' },
  } as never));

  await withServer(app, async (url) => {
    const response = await fetch(`${url}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'This message is too large for the tiny configured context window.' }),
    });
    assert.equal(response.status, 413);
    const body = await response.json();
    assert.match(body.error, /exceed the configured Ollama context window/);
  });

  assert.equal(llmCalls, 0);
  assert.equal(db.runs.length, 1);
});

test('POST /api/messages history query uses only web messages', async () => {
  const db = makeDb();
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/messages', messagesRoutes({
    config: config(),
    dbManager: { get: () => db },
    memory: { retrieveForChat: async () => [] },
    llm: {
      async complete() {
        return { content: 'ok', provider: 'ollama', model: 'local-model', inputTokens: 1, outputTokens: 1 };
      },
    },
    authToken: 'test',
    identity: 'You are forge-local.',
    identityDir: '.',
    readIdentity: () => 'You are forge-local.',
    resolved: { root: '.', dbs: '.', identity: '.', logs: '.' },
  } as never));

  await withServer(app, async (url) => {
    const response = await fetch(`${url}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });
    assert.equal(response.status, 200);
  });

  const historyQuery = db.queries.find(query => String(query[0]).includes('id <> ?'));
  assert.notEqual(historyQuery, undefined);
  assert.match(String(historyQuery?.[0]), /WHERE channel = 'web'/);
  assert.match(String(historyQuery?.[0]), /user IN \('user', 'assistant'\)/);
});

test('POST /api/messages reads latest identity for each chat turn', async () => {
  const db = makeDb();
  let identity = 'first identity';
  const capturedSystems: string[] = [];
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/messages', messagesRoutes({
    config: config(),
    dbManager: { get: () => db },
    memory: { retrieveForChat: async () => [] },
    llm: {
      async complete(request: { system: string }) {
        capturedSystems.push(request.system);
        return { content: 'ok', provider: 'ollama', model: 'local-model', inputTokens: 1, outputTokens: 1 };
      },
    },
    authToken: 'test',
    identity: 'stale identity',
    identityDir: '.',
    readIdentity: () => identity,
    resolved: { root: '.', dbs: '.', identity: '.', logs: '.' },
  } as never));

  await withServer(app, async (url) => {
    let response = await fetch(`${url}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });
    assert.equal(response.status, 200);

    identity = 'updated identity';
    response = await fetch(`${url}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello again' }),
    });
    assert.equal(response.status, 200);
  });

  assert.match(capturedSystems[0], /first identity/);
  assert.match(capturedSystems[1], /updated identity/);
  assert.doesNotMatch(capturedSystems[1], /first identity/);
});

test('GET /api/messages/poll validates since and clamps limit', async () => {
  const db = makeDb();
  const queries: unknown[][] = [];
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/messages', messagesRoutes({
    config: config(),
    dbManager: {
      get: () => ({
        prepare(sql: string) {
          return {
            all(...args: unknown[]) {
              queries.push([sql, ...args]);
              return [];
            },
          };
        },
      }),
    },
    memory: { retrieveForChat: async () => [] },
    llm: { async complete() { throw new Error('should not run'); } },
    authToken: 'test',
    identity: 'You are forge-local.',
    identityDir: '.',
    readIdentity: () => 'You are forge-local.',
    resolved: { root: '.', dbs: '.', identity: '.', logs: '.' },
  } as never));

  await withServer(app, async (url) => {
    let response = await fetch(`${url}/api/messages/poll?since=-1`);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'since must be a non-negative integer' });

    response = await fetch(`${url}/api/messages/poll?limit=0`);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'limit must be an integer between 1 and 500' });

    response = await fetch(`${url}/api/messages/poll?since=42&limit=999`);
    assert.equal(response.status, 200);
  });

  assert.equal(queries.length, 1);
  assert.equal(queries[0][1], 42);
  assert.equal(queries[0][2], 500);
  assert.equal(db.runs.length, 0);
});

test('POST /api/messages rejects non-string content before DB writes', async () => {
  const db = makeDb();
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/messages', messagesRoutes({
    config: config(),
    dbManager: { get: () => db },
    memory: { retrieveForChat: async () => [] },
    llm: { async complete() { throw new Error('should not run'); } },
    authToken: 'test',
    identity: 'You are forge-local.',
    identityDir: '.',
    readIdentity: () => 'You are forge-local.',
    resolved: { root: '.', dbs: '.', identity: '.', logs: '.' },
  } as never));

  await withServer(app, async (url) => {
    const response = await fetch(`${url}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { bad: true } }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'content must be a non-empty string' });
  });

  assert.equal(db.runs.length, 0);
});
