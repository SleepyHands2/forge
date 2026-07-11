import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFilesystemTools } from './filesystem.ts';
import { ToolRegistry } from './registry.ts';
import type { ForgeConfig, ToolDef, ToolsConfig } from '../../types.ts';

function config(toolsOverrides?: Partial<ToolsConfig>): ForgeConfig {
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
      levels: { safe: false, network: false, filesystem: true, sensitive: false },
      filesystem: { readable_dirs: [], writable_dirs: [] },
      ...toolsOverrides,
    },
  };
}

// realpathSync so the allowlist matches what the tools resolve to (os.tmpdir()
// can itself be a symlink or 8.3 short path).
function makeRoot(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fs-test-')));
}

function setup(root: string, filesystemOverrides?: Record<string, unknown>) {
  const cfg = config({
    filesystem: { readable_dirs: [root], writable_dirs: [], ...filesystemOverrides },
  });
  const tools = createFilesystemTools({ config: cfg });
  const byName = new Map<string, ToolDef>(tools.map(tool => [tool.name, tool]));
  return byName;
}

test('filesystem tools register cleanly at the filesystem level', () => {
  const registry = new ToolRegistry();
  const tools = createFilesystemTools({ config: config() });
  for (const tool of tools) {
    assert.equal(tool.permission, 'filesystem');
    registry.register(tool);
  }
  assert.deepEqual(registry.list().map(t => t.name).sort(), ['list_dir', 'read_file']);
});

test('read_file reads a text file inside an allowlisted directory', async () => {
  const root = makeRoot();
  try {
    fs.writeFileSync(path.join(root, 'notes.txt'), 'hello forge');
    const readFile = setup(root).get('read_file')!;
    const result = await readFile.handler({ path: path.join(root, 'notes.txt') }) as Record<string, unknown>;
    assert.equal(result.content, 'hello forge');
    assert.equal(result.size_bytes, 11);
    assert.equal(result.truncated, false);
    assert.equal(result.path, path.join(root, 'notes.txt'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('read_file denies paths outside the allowlist and traversal out of it', async () => {
  const root = makeRoot();
  try {
    const readFile = setup(root).get('read_file')!;
    await assert.rejects(
      Promise.resolve(readFile.handler({ path: path.join(root, '..', 'secrets.txt') })),
      /outside the allowlisted/,
    );
    await assert.rejects(
      Promise.resolve(readFile.handler({ path: path.resolve('elsewhere', 'file.txt') })),
      /outside the allowlisted/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('read_file denies everything when the level is off or the allowlist is empty', async () => {
  const root = makeRoot();
  try {
    fs.writeFileSync(path.join(root, 'notes.txt'), 'hello');
    const target = path.join(root, 'notes.txt');

    const levelOff = createFilesystemTools({
      config: config({
        levels: { safe: false, network: false, filesystem: false, sensitive: false },
        filesystem: { readable_dirs: [root], writable_dirs: [] },
      }),
    }).find(t => t.name === 'read_file')!;
    await assert.rejects(Promise.resolve(levelOff.handler({ path: target })), /disabled/);

    const emptyList = createFilesystemTools({ config: config() }).find(t => t.name === 'read_file')!;
    await assert.rejects(Promise.resolve(emptyList.handler({ path: target })), /No readable directories/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('read_file truncates at max_read_bytes and reports the full size', async () => {
  const root = makeRoot();
  try {
    fs.writeFileSync(path.join(root, 'big.txt'), '0123456789');
    const readFile = setup(root, { max_read_bytes: 4 }).get('read_file')!;
    const result = await readFile.handler({ path: path.join(root, 'big.txt') }) as Record<string, unknown>;
    assert.equal(result.content, '0123');
    assert.equal(result.size_bytes, 10);
    assert.equal(result.truncated, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('read_file rejects binary files, directories, and missing paths', async () => {
  const root = makeRoot();
  try {
    fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    const readFile = setup(root).get('read_file')!;
    await assert.rejects(
      Promise.resolve(readFile.handler({ path: path.join(root, 'blob.bin') })),
      /binary file/,
    );
    await assert.rejects(
      Promise.resolve(readFile.handler({ path: root })),
      /use list_dir/,
    );
    await assert.rejects(
      Promise.resolve(readFile.handler({ path: path.join(root, 'missing.txt') })),
      /does not exist/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('read_file re-checks the symlink-resolved realpath against the allowlist', async (t) => {
  const root = makeRoot();
  const outside = makeRoot();
  try {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    try {
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'), 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('symlink creation requires elevation on this machine');
        return;
      }
      throw error;
    }
    const readFile = setup(root).get('read_file')!;
    await assert.rejects(
      Promise.resolve(readFile.handler({ path: path.join(root, 'link.txt') })),
      /resolves \(via symlink\)/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('list_dir lists entries sorted with types and file sizes', async () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'b.txt'), 'bb');
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    const listDir = setup(root).get('list_dir')!;
    const result = await listDir.handler({ path: root }) as Record<string, unknown>;
    assert.equal(result.total_entries, 3);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.entries, [
      { name: 'a.txt', type: 'file', size_bytes: 1 },
      { name: 'b.txt', type: 'file', size_bytes: 2 },
      { name: 'sub', type: 'dir', size_bytes: null },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('list_dir rejects files, missing paths, and paths outside the allowlist', async () => {
  const root = makeRoot();
  try {
    fs.writeFileSync(path.join(root, 'notes.txt'), 'hello');
    const listDir = setup(root).get('list_dir')!;
    await assert.rejects(
      Promise.resolve(listDir.handler({ path: path.join(root, 'notes.txt') })),
      /use read_file/,
    );
    await assert.rejects(
      Promise.resolve(listDir.handler({ path: path.join(root, 'missing') })),
      /does not exist/,
    );
    await assert.rejects(
      Promise.resolve(listDir.handler({ path: path.resolve('elsewhere') })),
      /outside the allowlisted/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
