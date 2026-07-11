import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { TelegramAdapter, splitMessage } from './telegram.ts';
import type { InboundMessage } from './types.ts';
import { ChatTurnService } from '../services/chat-turn.ts';
import { MemoryService } from '../services/memory.ts';
import type { ForgeConfig, LLMRequest, LLMResponse, TelegramConfig } from '../types.ts';

const MESSAGES_SCHEMA = fs.readFileSync(new URL('../db/schemas/messages.sql', import.meta.url), 'utf-8');
const MEMORY_SCHEMA = fs.readFileSync(new URL('../db/schemas/memory.sql', import.meta.url), 'utf-8');
const TOKEN_ENV = 'FORGE_TELEGRAM_TOKEN_TEST';

function config(telegram: Partial<TelegramConfig> = {}): ForgeConfig {
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
    channels: {
      telegram: {
        enabled: true,
        token_env: TOKEN_ENV,
        api_base_url: 'https://tg.example',
        poll_timeout_s: 1,
        allowed_chat_ids: ['777'],
        ...telegram,
      },
    },
  };
}

interface SentMessage {
  chat_id: string | number;
  text: string;
}

interface MockFile {
  path?: string;
  bytes?: Uint8Array;
  size?: number;
  downloadStatus?: number;
}

/** Mocked Telegram Bot API: serves queued updates once, records sendMessage calls, optionally serves one file. */
function mockTelegramApi(updates: unknown[], file?: MockFile): { sent: SentMessage[]; requests: string[]; fetchImpl: typeof fetch } {
  let pending = [...updates];
  const state = {
    sent: [] as SentMessage[],
    requests: [] as string[],
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const address = String(url);
      state.requests.push(address);
      if (address.includes('/getUpdates')) {
        const result = pending;
        pending = [];
        return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
      }
      if (address.includes('/sendMessage')) {
        state.sent.push(JSON.parse(String(init?.body ?? '{}')) as SentMessage);
        return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
      }
      if (file && address.includes('/getFile')) {
        const filePath = file.path ?? 'photos/file_1.jpg';
        const bytes = file.bytes ?? new Uint8Array([1, 2, 3]);
        return new Response(JSON.stringify({ ok: true, result: { file_path: filePath, file_size: file.size ?? bytes.byteLength } }), { status: 200 });
      }
      if (file && address.includes('/file/bot')) {
        if (file.downloadStatus !== undefined && file.downloadStatus !== 200) {
          return new Response('nope', { status: file.downloadStatus });
        }
        const payload = file.bytes ?? new Uint8Array([1, 2, 3]);
        return new Response(payload.buffer as ArrayBuffer, { status: 200 });
      }
      throw new Error(`Unexpected Telegram API call: ${address}`);
    }) as typeof fetch,
  };
  return state;
}

function realPipeline(replyText: string) {
  const db = new Database(':memory:');
  db.exec(MESSAGES_SCHEMA);
  const memoryDb = new Database(':memory:');
  memoryDb.exec(MEMORY_SCHEMA);
  const llmRequests: LLMRequest[] = [];
  const chatTurn = new ChatTurnService({
    config: config(),
    db,
    memory: new MemoryService(memoryDb),
    llm: {
      async complete(req: LLMRequest): Promise<LLMResponse> {
        llmRequests.push(req);
        return { content: replyText, provider: 'ollama', model: 'local-model', inputTokens: 3, outputTokens: 5 };
      },
      async completeStream(): Promise<LLMResponse> {
        throw new Error('channels must not stream');
      },
    },
    readIdentity: () => 'You are forge-local.',
  });
  return { db, memoryDb, chatTurn, llmRequests };
}

function update(chatId: number | string, text: string, updateId = 1): unknown {
  return { update_id: updateId, message: { chat: { id: chatId, type: 'private' }, from: { first_name: 'Alice' }, text } };
}

function adapterWith(pipeline: ReturnType<typeof realPipeline>, api: ReturnType<typeof mockTelegramApi>, cfg = config()): TelegramAdapter {
  return new TelegramAdapter({
    config: cfg,
    fetchImpl: api.fetchImpl,
    logger: { log: () => {}, warn: () => {} },
    handler: async (msg) => {
      const outcome = await pipeline.chatTurn.runTurn({
        channel: msg.channel,
        channelName: msg.chatId,
        userName: msg.userName,
        content: msg.text,
        interfaceLabel: 'Telegram',
        scopeHistoryToChannelName: true,
      });
      return outcome.reply;
    },
  });
}

function withToken<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prior = process.env[TOKEN_ENV];
  if (value === undefined) delete process.env[TOKEN_ENV];
  else process.env[TOKEN_ENV] = value;
  return fn().finally(() => {
    if (prior === undefined) delete process.env[TOKEN_ENV];
    else process.env[TOKEN_ENV] = prior;
  });
}

test('telegram inbound runs the shared pipeline, stores channel=telegram rows, and sends the reply', async () => {
  await withToken('tg-token', async () => {
    const pipeline = realPipeline('Hello from Forge!');
    const api = mockTelegramApi([update(777, 'Hi Forge, are you there?')]);
    const adapter = adapterWith(pipeline, api);

    const processed = await adapter.pollOnce();
    assert.equal(processed, 1);

    // The token is used in the API path, from the configured env var.
    assert.match(api.requests[0], /^https:\/\/tg\.example\/bottg-token\/getUpdates\?timeout=1&offset=1$/);

    // Both turn rows landed in messages.db under the telegram channel.
    const rows = pipeline.db.prepare("SELECT channel, channelName, user, userName, text FROM messages ORDER BY receivedAt, rowid").all() as Array<Record<string, string>>;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { channel: 'telegram', channelName: '777', user: 'user', userName: 'Alice', text: 'Hi Forge, are you there?' });
    assert.equal(rows[1].channel, 'telegram');
    assert.equal(rows[1].user, 'assistant');
    assert.equal(rows[1].text, 'Hello from Forge!');

    // The same context pipeline ran (identity + Telegram interface label).
    assert.equal(pipeline.llmRequests.length, 1);
    assert.match(pipeline.llmRequests[0].system, /You are forge-local\./);
    assert.match(pipeline.llmRequests[0].system, /Interface: Telegram/);

    // The reply went back out through sendMessage.
    assert.deepEqual(api.sent, [{ chat_id: '777', text: 'Hello from Forge!' }]);

    pipeline.db.close();
    pipeline.memoryDb.close();
  });
});

test('telegram history is scoped to the chat and channel', async () => {
  await withToken('tg-token', async () => {
    const pipeline = realPipeline('Reply.');
    // Existing rows in other scopes must not leak into the prompt.
    pipeline.db.prepare(`
      INSERT INTO messages (id, channel, channelName, user, userName, text, ts, receivedAt)
      VALUES ('w1', 'web', 'web', 'user', 'Alice', 'web-only history', '1', 1),
             ('t1', 'telegram', '999', 'user', 'Alice', 'other-chat history', '2', 2),
             ('t2', 'telegram', '777', 'user', 'Alice', 'same-chat history', '3', 3)
    `).run();

    const api = mockTelegramApi([update(777, 'What did I say before?')]);
    await adapterWith(pipeline, api).pollOnce();

    const history = pipeline.llmRequests[0].messages.map(m => m.content);
    assert.ok(history.some(text => text.includes('same-chat history')));
    assert.ok(!history.some(text => text.includes('web-only history')));
    assert.ok(!history.some(text => text.includes('other-chat history')));

    pipeline.db.close();
    pipeline.memoryDb.close();
  });
});

test('telegram memory commands work as manual overrides over the same pipeline', async () => {
  await withToken('tg-token', async () => {
    const pipeline = realPipeline('should not be called');
    const api = mockTelegramApi([update(777, '/remember Alice prefers tea')]);
    await adapterWith(pipeline, api).pollOnce();

    assert.equal(pipeline.llmRequests.length, 0);
    assert.equal(api.sent.length, 1);
    assert.match(api.sent[0].text, /Remembered\. Memory ID:/);

    pipeline.db.close();
    pipeline.memoryDb.close();
  });
});

test('non-allowlisted chats never reach the pipeline and get a single notice', async () => {
  await withToken('tg-token', async () => {
    const pipeline = realPipeline('must not run');
    const api = mockTelegramApi([
      update(555, 'let me in', 1),
      update(555, 'hello?', 2),
    ]);
    await adapterWith(pipeline, api).pollOnce();

    assert.equal(pipeline.llmRequests.length, 0);
    assert.equal((pipeline.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n, 0);
    // One notice with the chat id, not one per message.
    assert.equal(api.sent.length, 1);
    assert.match(api.sent[0].text, /chat id 555/);
    assert.match(api.sent[0].text, /allowed_chat_ids/);

    pipeline.db.close();
    pipeline.memoryDb.close();
  });
});

test('pipeline failures become an apologetic reply, never a crash', async () => {
  await withToken('tg-token', async () => {
    const api = mockTelegramApi([update(777, 'hi')]);
    const adapter = new TelegramAdapter({
      config: config(),
      fetchImpl: api.fetchImpl,
      logger: { log: () => {}, warn: () => {} },
      handler: async () => {
        throw new Error('pipeline exploded');
      },
    });

    await adapter.pollOnce();
    assert.equal(api.sent.length, 1);
    assert.match(api.sent[0].text, /Something went wrong.*pipeline exploded/);
  });
});

test('start() fails fast with a clear message when no token is configured', async () => {
  await withToken(undefined, async () => {
    const api = mockTelegramApi([]);
    const adapter = new TelegramAdapter({
      config: config(),
      fetchImpl: api.fetchImpl,
      logger: { log: () => {}, warn: () => {} },
      handler: async () => 'x',
    });
    await assert.rejects(adapter.start(), new RegExp(`${TOKEN_ENV} environment variable`));
    assert.equal(api.requests.length, 0);
  });
});

// --- Photo / image attachments -----------------------------------------------------

function attachmentsDirFixture(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tg-attach-')));
}

/** Config with attachments enabled plus a working vision + filesystem chain. */
function attachmentsConfig(dir: string, overrides: Record<string, unknown> = {}): ForgeConfig {
  return {
    ...config({
      attachments: { enabled: true, dir, max_file_bytes: 10_485_760, retention_days: 7, ...overrides },
    }),
    tools: {
      enabled: true,
      max_iterations: 5,
      levels: { safe: true, network: false, filesystem: true, sensitive: false },
      filesystem: { readable_dirs: [], writable_dirs: [] },
    },
    vision: {
      enabled: true,
      model: 'test-vision:7b',
      num_ctx: 8192,
      num_predict: 700,
      repeat_penalty: 1.15,
      timeout_ms: 300000,
      max_image_bytes: 10_485_760,
    },
  };
}

function photoUpdate(chatId: number | string, sizes: Array<{ file_id?: string; file_size?: number }>, caption?: string, updateId = 1): unknown {
  return { update_id: updateId, message: { chat: { id: chatId, type: 'private' }, from: { first_name: 'Alice' }, photo: sizes, caption } };
}

/** Adapter wired to a recording handler instead of the full pipeline. */
function recordingAdapter(cfg: ForgeConfig, api: ReturnType<typeof mockTelegramApi>): { adapter: TelegramAdapter; received: InboundMessage[] } {
  const received: InboundMessage[] = [];
  const adapter = new TelegramAdapter({
    config: cfg,
    fetchImpl: api.fetchImpl,
    logger: { log: () => {}, warn: () => {} },
    handler: async (msg) => {
      received.push(msg);
      return 'got it';
    },
  });
  return { adapter, received };
}

test('a photo is downloaded, saved under a generated name, and the turn points the model at analyze_image', async () => {
  await withToken('tg-token', async () => {
    const dir = attachmentsDirFixture();
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x42]);
    const api = mockTelegramApi(
      [photoUpdate(777, [{ file_id: 'small', file_size: 100 }, { file_id: 'big', file_size: 5000 }], 'translate this page please')],
      { bytes },
    );
    const { adapter, received } = recordingAdapter(attachmentsConfig(dir), api);

    await adapter.pollOnce();

    // The largest size was requested and the file landed on disk.
    assert.ok(api.requests.some(r => r.includes('/getFile?file_id=big')));
    assert.ok(api.requests.some(r => r.includes('/file/bottg-token/photos/file_1.jpg')));
    assert.equal(received.length, 1);
    const meta = received[0].attachmentsMeta?.[0] as Record<string, unknown>;
    const savedPath = String(meta.path);
    assert.equal(path.dirname(savedPath), dir);
    assert.match(path.basename(savedPath), /^telegram-\d{8}-\d{6}-[0-9a-f]{6}\.jpg$/);
    assert.deepEqual(new Uint8Array(fs.readFileSync(savedPath)), bytes);
    assert.equal(meta.bytes, bytes.byteLength);
    assert.equal(meta.type, 'photo');

    // Stored text carries the filename + caption; the model-facing text carries the path and the tool.
    assert.equal(received[0].text, `[Photo: ${path.basename(savedPath)}] translate this page please`);
    assert.ok(received[0].llmText?.includes(savedPath));
    assert.ok(received[0].llmText?.includes('analyze_image'));
    assert.ok(received[0].llmText?.includes('translate this page please'));

    // The reply still goes out normally.
    assert.deepEqual(api.sent, [{ chat_id: '777', text: 'got it' }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test('photos are dropped exactly as before while attachments are disabled', async () => {
  await withToken('tg-token', async () => {
    const api = mockTelegramApi([photoUpdate(777, [{ file_id: 'big', file_size: 5000 }], 'see this?')]);
    const { adapter, received } = recordingAdapter(config(), api);

    await adapter.pollOnce();

    assert.equal(received.length, 0);
    assert.equal(api.sent.length, 0);
    assert.ok(!api.requests.some(r => r.includes('/getFile')));
  });
});

test('an image over the size cap is refused with a clear reply and never downloaded', async () => {
  await withToken('tg-token', async () => {
    const dir = attachmentsDirFixture();
    // Every declared photo size exceeds the 500-byte cap.
    const api = mockTelegramApi([photoUpdate(777, [{ file_id: 'huge', file_size: 999 }])]);
    const { adapter, received } = recordingAdapter(attachmentsConfig(dir, { max_file_bytes: 500 }), api);

    await adapter.pollOnce();

    assert.equal(received.length, 0);
    assert.ok(!api.requests.some(r => r.includes('/getFile')));
    assert.equal(api.sent.length, 1);
    assert.match(api.sent[0].text, /over this Forge's attachment cap/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test('image documents are downloaded with their extension; non-image documents are dropped', async () => {
  await withToken('tg-token', async () => {
    const dir = attachmentsDirFixture();
    const image = {
      update_id: 1,
      message: {
        chat: { id: 777, type: 'private' },
        from: { first_name: 'Alice' },
        document: { file_id: 'doc-img', file_name: 'scan.png', mime_type: 'image/png', file_size: 400 },
      },
    };
    const pdf = {
      update_id: 2,
      message: {
        chat: { id: 777, type: 'private' },
        from: { first_name: 'Alice' },
        document: { file_id: 'doc-pdf', file_name: 'report.pdf', mime_type: 'application/pdf', file_size: 400 },
      },
    };
    const api = mockTelegramApi([image, pdf], { path: 'documents/file_2.png', bytes: new Uint8Array([0x89, 0x50]) });
    const { adapter, received } = recordingAdapter(attachmentsConfig(dir), api);

    await adapter.pollOnce();

    assert.equal(received.length, 1);
    const meta = received[0].attachmentsMeta?.[0] as Record<string, unknown>;
    assert.match(path.basename(String(meta.path)), /^telegram-\d{8}-\d{6}-[0-9a-f]{6}\.png$/);
    assert.equal(meta.type, 'document');
    assert.ok(!api.requests.some(r => r.includes('file_id=doc-pdf')));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test('when vision or filesystem tools are off, the model is told it cannot view the photo', async () => {
  await withToken('tg-token', async () => {
    const dir = attachmentsDirFixture();
    const cfg = attachmentsConfig(dir);
    delete (cfg as { vision?: unknown }).vision;
    const api = mockTelegramApi([photoUpdate(777, [{ file_id: 'p1', file_size: 100 }])], {});
    const { adapter, received } = recordingAdapter(cfg, api);

    await adapter.pollOnce();

    assert.equal(received.length, 1);
    assert.ok(!received[0].llmText?.includes('Call the analyze_image tool'));
    assert.ok(received[0].llmText?.includes('cannot view it'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test('a failed file download becomes an apologetic reply, not a crash or a turn', async () => {
  await withToken('tg-token', async () => {
    const dir = attachmentsDirFixture();
    const api = mockTelegramApi([photoUpdate(777, [{ file_id: 'p1', file_size: 100 }])], { downloadStatus: 404 });
    const { adapter, received } = recordingAdapter(attachmentsConfig(dir), api);

    await adapter.pollOnce();

    assert.equal(received.length, 0);
    assert.equal(api.sent.length, 1);
    assert.match(api.sent[0].text, /couldn't fetch that image.*HTTP 404/);
    assert.equal(fs.readdirSync(dir).length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test('long replies are split at the Telegram limit on word boundaries', async () => {
  const parts = splitMessage(`${'word '.repeat(1200)}end`, 4096);
  assert.ok(parts.length >= 2);
  for (const part of parts) {
    assert.ok(part.length <= 4096, `part of ${part.length} chars exceeds limit`);
  }
  assert.equal(parts.join(' ').replace(/\s+/g, ' ').trim(), `${'word '.repeat(1200)}end`.replace(/\s+/g, ' ').trim());

  await withToken('tg-token', async () => {
    const pipeline = realPipeline('A'.repeat(5000));
    const api = mockTelegramApi([update(777, 'write a lot')]);
    await adapterWith(pipeline, api).pollOnce();
    assert.equal(api.sent.length, 2);
    pipeline.db.close();
    pipeline.memoryDb.close();
  });
});
