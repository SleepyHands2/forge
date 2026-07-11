import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  clearConfigCache,
  loadConfig,
  loadEnvFile,
  resolveDefaultConfigPath,
  resolveWebAuthToken,
  saveConfigBoolean,
  saveEnvValue,
  saveIdentityReflectionEnabled,
} from '../config.ts';

function writeConfig(dir: string): string {
  const configPath = path.join(dir, 'forge.config.yaml');
  fs.writeFileSync(configPath, [
    'forge:',
    '  name: test-forge',
    '  version: "1.0.0"',
    '  root: .',
    'user:',
    '  name: tester',
    'llm:',
    '  provider: ollama',
    '  model: local-model',
    '  ollama:',
    '    base_url: http://localhost:11434',
    'paths:',
    '  dbs: ./state/dbs',
    '  identity: ./identity',
    '  logs: ./var/logs',
  ].join('\n'));
  return configPath;
}

test('default config loading is independent of process.cwd()', () => {
  clearConfigCache();
  const originalCwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-config-cwd-'));

  try {
    process.chdir(tmp);
    const { resolved } = loadConfig();
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

    assert.equal(resolved.root, repoRoot);
    assert.equal(resolved.logs, path.join(repoRoot, 'logs'));
  } finally {
    process.chdir(originalCwd);
    clearConfigCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('relative config paths resolve from the config file root', () => {
  clearConfigCache();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-config-paths-'));

  try {
    const configPath = writeConfig(tmp);
    const { resolved } = loadConfig(configPath);

    assert.equal(resolved.root, tmp);
    assert.equal(resolved.dbs, path.join(tmp, 'state/dbs'));
    assert.equal(resolved.identity, path.join(tmp, 'identity'));
    assert.equal(resolved.logs, path.join(tmp, 'var/logs'));
  } finally {
    clearConfigCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('default config path prefers the gitignored local override when present', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-config-local-'));

  try {
    // Without a local override, the tracked config is used.
    assert.equal(resolveDefaultConfigPath(tmp), path.join(tmp, 'forge.config.yaml'));

    // With forge.config.local.yaml present, it wins.
    fs.writeFileSync(path.join(tmp, 'forge.config.local.yaml'), 'x: 1\n');
    assert.equal(resolveDefaultConfigPath(tmp), path.join(tmp, 'forge.config.local.yaml'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a local override config loads with paths resolved from its own directory', () => {
  clearConfigCache();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-config-local-load-'));

  try {
    writeConfig(tmp); // tracked-style base config
    const localPath = path.join(tmp, 'forge.config.local.yaml');
    fs.writeFileSync(localPath, [
      'forge:',
      '  name: local-forge',
      '  version: "1.0.0"',
      '  root: .',
      'user:',
      '  name: tester',
      'llm:',
      '  provider: ollama',
      '  model: local-model',
      'paths:',
      '  dbs: ./local-dbs',
      '  identity: ./identity',
      '  logs: ./logs',
    ].join('\n'));

    // Explicit path loading still works and uses exactly the file given.
    const { config, resolved } = loadConfig(localPath);
    assert.equal(config.forge.name, 'local-forge');
    assert.equal(resolved.dbs, path.join(tmp, 'local-dbs'));
  } finally {
    clearConfigCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('config accepts only the local Ollama provider', () => {
  clearConfigCache();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-config-local-only-'));

  try {
    const configPath = writeConfig(tmp);
    let loaded = loadConfig(configPath).config;
    assert.equal(loaded.llm.provider, 'ollama');
    assert.equal(loaded.llm.model, 'local-model');
    assert.equal(loaded.services.web.host, '127.0.0.1');
    assert.equal(loaded.services.web.debug_prompt_context, false);

    clearConfigCache();
    const badConfig = fs.readFileSync(configPath, 'utf-8').replace('provider: ollama', 'provider: claude');
    fs.writeFileSync(configPath, badConfig);
    assert.throws(() => loadConfig(configPath), /Invalid literal value/);
  } finally {
    clearConfigCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('memory embeddings default to disabled for legacy configurations', () => {
  clearConfigCache();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-config-embeddings-default-'));

  try {
    const config = loadConfig(writeConfig(tmp)).config;

    assert.deepEqual(config.memory.embeddings, {
      enabled: false,
      request_timeout_ms: 10_000,
      backfill_batch_size: 16,
    });
  } finally {
    clearConfigCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('memory embeddings use an explicit model independent of the chat model', () => {
  clearConfigCache();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-config-embeddings-model-'));

  try {
    const configPath = writeConfig(tmp);
    fs.appendFileSync(configPath, [
      '',
      'memory:',
      '  retention_days: 30',
      '  embeddings:',
      '    enabled: true',
      '    model: local-embedding-model',
      '    request_timeout_ms: 2500',
      '    backfill_batch_size: 8',
    ].join('\n'));

    const config = loadConfig(configPath).config;
    assert.deepEqual(config.memory.embeddings, {
      enabled: true,
      model: 'local-embedding-model',
      request_timeout_ms: 2500,
      backfill_batch_size: 8,
    });
    assert.notEqual(config.memory.embeddings?.model, config.llm.model);
  } finally {
    clearConfigCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('enabled memory embeddings require an explicit model', () => {
  clearConfigCache();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-config-embeddings-required-model-'));

  try {
    const configPath = writeConfig(tmp);
    fs.appendFileSync(configPath, [
      '',
      'memory:',
      '  embeddings:',
      '    enabled: true',
    ].join('\n'));

    assert.throws(
      () => loadConfig(configPath),
      /memory\.embeddings\.model is required when memory\.embeddings\.enabled is true/,
    );
  } finally {
    clearConfigCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('web auth token is configured, persisted, and reused', () => {
  clearConfigCache();
  const originalToken = process.env.FORGE_AUTH_TOKEN;
  delete process.env.FORGE_AUTH_TOKEN;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-auth-token-'));

  try {
    const configPath = writeConfig(tmp);
    const { config, resolved } = loadConfig(configPath);

    const generated = resolveWebAuthToken(config, resolved);
    assert.equal(generated.source, 'generated');
    assert.ok(generated.path);
    assert.equal(fs.readFileSync(generated.path, 'utf-8').trim(), generated.token);

    const reused = resolveWebAuthToken(config, resolved);
    assert.deepEqual(reused, { token: generated.token, source: 'file', path: generated.path });

    config.services.web.auth_token = 'configured-token';
    assert.deepEqual(resolveWebAuthToken(config, resolved), { token: 'configured-token', source: 'config' });

    process.env.FORGE_AUTH_TOKEN = 'env-token';
    assert.deepEqual(resolveWebAuthToken(config, resolved), { token: 'env-token', source: 'env' });
  } finally {
    if (originalToken === undefined) {
      delete process.env.FORGE_AUTH_TOKEN;
    } else {
      process.env.FORGE_AUTH_TOKEN = originalToken;
    }
    clearConfigCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('identity reflection save updates only the enabled YAML line', () => {
  clearConfigCache();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-reflection-save-'));

  try {
    const configPath = writeConfig(tmp);
    fs.appendFileSync(configPath, [
      '',
      '',
      'identity:',
      '  reflection:',
      '    enabled: false # local switch',
      '    cadence_turns: 3',
      '    recent_notes_in_context: 6',
    ].join('\n'));

    const before = fs.readFileSync(configPath, 'utf-8');
    const config = saveIdentityReflectionEnabled(true, configPath);
    const after = fs.readFileSync(configPath, 'utf-8');

    assert.equal(config.identity?.reflection.enabled, true);
    assert.equal(after, before.replace('enabled: false # local switch', 'enabled: true # local switch'));
  } finally {
    clearConfigCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('identity reflection save adds the minimal block when missing', () => {
  clearConfigCache();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-reflection-add-'));

  try {
    const configPath = writeConfig(tmp);
    const config = saveIdentityReflectionEnabled(true, configPath);
    const saved = fs.readFileSync(configPath, 'utf-8');

    assert.equal(config.identity?.reflection.enabled, true);
    assert.match(saved, /\nidentity:\n  reflection:\n    enabled: true$/);
  } finally {
    clearConfigCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('saveConfigBoolean updates an existing nested boolean line in place', () => {
  clearConfigCache();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-save-bool-update-'));

  try {
    const configPath = writeConfig(tmp);
    fs.appendFileSync(configPath, [
      '',
      '',
      'tools:',
      '  enabled: true',
      '  levels:',
      '    safe: true',
      '    network: false # opt-in gate',
      '    filesystem: false',
    ].join('\n'));

    const before = fs.readFileSync(configPath, 'utf-8');
    const config = saveConfigBoolean('tools.levels.network', true, configPath);
    const after = fs.readFileSync(configPath, 'utf-8');

    assert.equal(config.tools?.levels.network, true);
    assert.equal(config.tools?.levels.safe, true);
    assert.equal(after, before.replace('network: false # opt-in gate', 'network: true # opt-in gate'));
  } finally {
    clearConfigCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('saveConfigBoolean creates missing nested blocks minimally', () => {
  clearConfigCache();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-save-bool-create-'));

  try {
    const configPath = writeConfig(tmp); // no tools block at all
    const before = fs.readFileSync(configPath, 'utf-8');
    const config = saveConfigBoolean('tools.levels.network', true, configPath);
    const saved = fs.readFileSync(configPath, 'utf-8');

    assert.equal(config.tools?.levels.network, true);
    // The whole missing structure is appended; everything above is untouched.
    assert.equal(saved, `${before}\n\ntools:\n  levels:\n    network: true`);

    // A second write into the now-existing block inserts only the new line.
    const config2 = saveConfigBoolean('tools.enabled', true, configPath);
    assert.equal(config2.tools?.enabled, true);
    assert.match(fs.readFileSync(configPath, 'utf-8'), /\ntools:\n  enabled: true\n  levels:\n    network: true$/);
  } finally {
    clearConfigCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('saveConfigBoolean writes to the local override when it is the active config', () => {
  clearConfigCache();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-save-bool-local-'));

  try {
    const trackedPath = writeConfig(tmp);
    const localPath = path.join(tmp, 'forge.config.local.yaml');
    fs.copyFileSync(trackedPath, localPath);
    const trackedBefore = fs.readFileSync(trackedPath, 'utf-8');

    // The local override is the active config for this directory.
    const activePath = resolveDefaultConfigPath(tmp);
    assert.equal(activePath, localPath);

    const { config: cachedConfig } = loadConfig(activePath);
    const saved = saveConfigBoolean('scheduler.enabled', true, activePath);

    assert.equal(saved.scheduler?.enabled, true);
    assert.match(fs.readFileSync(localPath, 'utf-8'), /\nscheduler:\n  enabled: true$/);
    // The tracked config never changes.
    assert.equal(fs.readFileSync(trackedPath, 'utf-8'), trackedBefore);
    // The cached root config object was grafted live (same object reference).
    assert.equal(cachedConfig.scheduler?.enabled, true);
  } finally {
    clearConfigCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('saveConfigBoolean rolls back the file when the result does not parse', () => {
  clearConfigCache();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-save-bool-rollback-'));

  try {
    const configPath = writeConfig(tmp);
    const before = fs.readFileSync(configPath, 'utf-8');

    // Enabling embeddings without a model fails schema validation after the
    // write, so the original content must be restored.
    assert.throws(
      () => saveConfigBoolean('memory.embeddings.enabled', true, configPath),
      /memory\.embeddings\.model is required when memory\.embeddings\.enabled is true/,
    );
    assert.equal(fs.readFileSync(configPath, 'utf-8'), before);
  } finally {
    clearConfigCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('env file save/load escapes quoted values safely', () => {
  const prior = process.env.FORGE_COMPLEX_VALUE;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-env-file-'));
  const envPath = path.join(tmp, '.env');

  try {
    saveEnvValue('FORGE_COMPLEX_VALUE', 'quote " slash \\ newline\nend', envPath);
    delete process.env.FORGE_COMPLEX_VALUE;
    loadEnvFile(envPath);

    assert.equal(process.env.FORGE_COMPLEX_VALUE, 'quote " slash \\ newline\nend');
    assert.match(fs.readFileSync(envPath, 'utf-8'), /FORGE_COMPLEX_VALUE="quote \\" slash \\\\ newline\\nend"/);
  } finally {
    if (prior === undefined) {
      delete process.env.FORGE_COMPLEX_VALUE;
    } else {
      process.env.FORGE_COMPLEX_VALUE = prior;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
