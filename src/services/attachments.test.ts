import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pruneAttachments, resolveAttachmentsDir, saveAttachment } from './attachments.ts';
import type { ForgeConfig, TelegramAttachmentsConfig } from '../types.ts';

function config(attachments?: Partial<TelegramAttachmentsConfig>): ForgeConfig {
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
    channels: attachments === undefined ? {} : {
      telegram: {
        enabled: true,
        token_env: 'FORGE_TELEGRAM_TOKEN_TEST',
        api_base_url: 'https://tg.example',
        poll_timeout_s: 1,
        allowed_chat_ids: [],
        attachments: {
          enabled: true,
          dir: './attachments',
          max_file_bytes: 10_485_760,
          retention_days: 7,
          ...attachments,
        },
      },
    },
  };
}

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-attach-'));
}

test('resolveAttachmentsDir is undefined unless attachments are enabled', () => {
  assert.equal(resolveAttachmentsDir(config()), undefined);
  assert.equal(resolveAttachmentsDir(config({ enabled: false })), undefined);

  const dir = makeDir();
  const resolved = resolveAttachmentsDir(config({ dir }));
  assert.equal(resolved, path.resolve(dir));
  assert.ok(path.isAbsolute(resolved as string));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saveAttachment writes bytes under a generated name, creating the dir', async () => {
  const root = makeDir();
  const dir = path.join(root, 'nested', 'attachments');
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x01]);

  const saved = await saveAttachment({ dir, bytes, extension: '.jpg', prefix: 'telegram' });

  assert.equal(path.dirname(saved), dir);
  assert.match(path.basename(saved), /^telegram-\d{8}-\d{6}-[0-9a-f]{6}\.jpg$/);
  assert.deepEqual(new Uint8Array(fs.readFileSync(saved)), bytes);
  fs.rmSync(root, { recursive: true, force: true });
});

test('pruneAttachments removes only old files with the given prefix', async () => {
  const dir = makeDir();
  const old = path.join(dir, 'telegram-20200101-000000-aaaaaa.jpg');
  const fresh = path.join(dir, 'telegram-20990101-000000-bbbbbb.jpg');
  const otherPrefix = path.join(dir, 'keepme-20200101-000000-cccccc.jpg');
  for (const file of [old, fresh, otherPrefix]) fs.writeFileSync(file, 'x');
  const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  fs.utimesSync(old, past, past);
  fs.utimesSync(otherPrefix, past, past);

  const deleted = await pruneAttachments(dir, 'telegram', 7);

  assert.equal(deleted, 1);
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(fresh));
  assert.ok(fs.existsSync(otherPrefix));
  // A missing dir is a no-op, not an error.
  assert.equal(await pruneAttachments(path.join(dir, 'nope'), 'telegram', 7), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saveAttachment prunes expired files when retentionDays is set', async () => {
  const dir = makeDir();
  const old = path.join(dir, 'telegram-20200101-000000-dddddd.jpg');
  fs.writeFileSync(old, 'x');
  const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  fs.utimesSync(old, past, past);

  const saved = await saveAttachment({
    dir,
    bytes: new Uint8Array([1]),
    extension: '.png',
    prefix: 'telegram',
    retentionDays: 7,
  });

  assert.ok(fs.existsSync(saved));
  assert.ok(!fs.existsSync(old));
  fs.rmSync(dir, { recursive: true, force: true });
});
