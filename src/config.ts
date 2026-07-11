import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { ForgeConfigSchema, type ForgeConfig, type ResolvedPaths } from './types.ts';

let _cached: { config: ForgeConfig; resolved: ResolvedPaths; path: string } | null = null;

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUTH_TOKEN_FILENAME = 'web-auth-token';
const CONFIG_FILENAME = 'forge.config.yaml';
const LOCAL_CONFIG_FILENAME = 'forge.config.local.yaml';

function resolveTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(process.env.HOME ?? '/root', p.slice(1));
  }
  return p;
}

function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? '');
  }
  if (Array.isArray(obj)) return obj.map(resolveEnvVars);
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = resolveEnvVars(v);
    }
    return result;
  }
  return obj;
}

function resolveInputPath(p: string, baseDir: string): string {
  const expanded = resolveTilde(p);
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

function defaultAppPath(filename: string): string {
  return path.join(APP_ROOT, filename);
}

export function loadConfig(configPath?: string): { config: ForgeConfig; resolved: ResolvedPaths } {
  if (_cached) return _cached;

  const searchPath = resolveConfigPath(configPath);
  if (!fs.existsSync(searchPath)) {
    throw new Error(`Config not found: ${searchPath}`);
  }

  const raw = fs.readFileSync(searchPath, 'utf-8');
  const config = parseConfig(raw);

  const configDir = path.dirname(searchPath);
  const root = resolveInputPath(config.forge.root, configDir);
  const resolvePath = (p: string): string => {
    const expanded = resolveTilde(p);
    return path.isAbsolute(expanded) ? expanded : path.resolve(root, expanded);
  };

  const resolved: ResolvedPaths = {
    root,
    dbs: resolvePath(config.paths.dbs),
    identity: resolvePath(config.paths.identity),
    logs: resolvePath(config.paths.logs),
    images: resolvePath(config.paths.images ?? './images'),
  };

  for (const dir of [resolved.dbs, resolved.logs, resolved.images]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _cached = { config, resolved, path: path.resolve(searchPath) };
  return _cached;
}

export function saveIdentityReflectionEnabled(enabled: boolean, configPath?: string): ForgeConfig {
  return saveConfigBoolean('identity.reflection.enabled', enabled, configPath);
}

/**
 * Persists a single boolean flag (e.g. 'tools.enabled', 'tools.levels.network')
 * into the ACTIVE YAML config file via line surgery, preserving comments,
 * unrelated lines, and CRLF/final-newline style. After writing, the file is
 * re-parsed against the schema; on failure the original content is restored
 * and the error rethrown. When the cached config is the same file, only the
 * changed top-level block is grafted onto the cached object so running
 * services sharing the root config reference see the change live.
 */
export function saveConfigBoolean(dotPath: string, enabled: boolean, configPath?: string): ForgeConfig {
  const segments = dotPath.split('.');
  if (
    segments.length < 2
    || segments.length > 3
    || segments.some(segment => !/^[a-z0-9_]+$/i.test(segment))
  ) {
    throw new Error(`Unsupported config boolean path: ${dotPath}`);
  }

  const searchPath = resolveConfigPath(configPath);
  if (!fs.existsSync(searchPath)) {
    throw new Error(`Config not found: ${searchPath}`);
  }

  const raw = fs.readFileSync(searchPath, 'utf-8');
  const next = setConfigBooleanYaml(raw, segments, enabled);
  const changed = next !== raw;

  if (changed) {
    fs.writeFileSync(searchPath, next);
  }

  try {
    const config = parseConfig(fs.readFileSync(searchPath, 'utf-8'));
    if (_cached?.path === path.resolve(searchPath)) {
      const top = segments[0];
      (_cached.config as Record<string, unknown>)[top] = (config as unknown as Record<string, unknown>)[top];
    }
    return config;
  } catch (error) {
    if (changed) {
      fs.writeFileSync(searchPath, raw);
    }
    throw error;
  }
}

export function loadEnvFile(envPath?: string): void {
  const p = envPath ? resolveInputPath(envPath, process.cwd()) : defaultAppPath('.env');
  if (!fs.existsSync(p)) return;

  const lines = fs.readFileSync(p, 'utf-8').split('\n');
  for (const line of lines) {
    const parsed = parseEnvLine(line);
    if (parsed && !process.env[parsed.key]) {
      process.env[parsed.key] = parsed.value;
    }
  }
}

export function saveEnvValue(key: string, value: string, envPath?: string): void {
  const p = envPath ? resolveInputPath(envPath, process.cwd()) : defaultAppPath('.env');
  let content = '';
  if (fs.existsSync(p)) {
    content = fs.readFileSync(p, 'utf-8');
  }

  const lines = content.split('\n');
  let found = false;
  const updated = lines.map(line => {
    const parsed = parseEnvLine(line);
    if (parsed?.key === key) {
      found = true;
      return formatEnvLine(key, value);
    }
    return line;
  });

  if (!found) {
    updated.push(formatEnvLine(key, value));
  }

  fs.writeFileSync(p, updated.join('\n'), { mode: 0o600 });
}

function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const normalized = trimmed.startsWith('export ') ? trimmed.slice(7).trimStart() : trimmed;
  const eqIdx = normalized.indexOf('=');
  if (eqIdx === -1) return null;

  const key = normalized.slice(0, eqIdx).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  let value = normalized.slice(eqIdx + 1).trim();
  if (value.startsWith('"')) {
    const end = findClosingQuote(value, '"');
    value = unescapeDoubleQuoted(end >= 0 ? value.slice(1, end) : value.slice(1));
  } else if (value.startsWith("'")) {
    const end = findClosingQuote(value, "'");
    value = end >= 0 ? value.slice(1, end) : value.slice(1);
  } else {
    const hash = value.indexOf('#');
    if (hash >= 0) value = value.slice(0, hash).trimEnd();
  }

  return { key, value };
}

/**
 * Default config resolution prefers the gitignored forge.config.local.yaml
 * when it exists, so machine-specific settings (enabled channels, tokens'
 * chat ids, binary paths) never touch the tracked forge.config.yaml. An
 * explicitly passed configPath always wins and is used as-is.
 */
export function resolveDefaultConfigPath(appRoot: string): string {
  const local = path.join(appRoot, LOCAL_CONFIG_FILENAME);
  return fs.existsSync(local) ? local : path.join(appRoot, CONFIG_FILENAME);
}

function resolveConfigPath(configPath?: string): string {
  return configPath ? resolveInputPath(configPath, process.cwd()) : resolveDefaultConfigPath(APP_ROOT);
}

function parseConfig(raw: string): ForgeConfig {
  const parsed = resolveEnvVars(yaml.load(raw));
  return ForgeConfigSchema.parse(parsed);
}

function setConfigBooleanYaml(raw: string, segments: string[], enabled: boolean): string {
  const dotPath = segments.join('.');
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const hadFinalNewline = raw.endsWith('\n');
  const lines = raw.split(/\r?\n/);
  if (hadFinalNewline) lines.pop();

  const value = enabled ? 'true' : 'false';
  const blocks = segments.slice(0, -1);
  const key = segments[segments.length - 1];
  const keyIndent = blocks.length * 2;

  // Walk the nested blocks (2 spaces per level). searchStart/searchEnd narrow
  // to the current block's line range as each level is found.
  let searchStart = 0;
  let searchEnd = lines.length;
  for (let depth = 0; depth < blocks.length; depth += 1) {
    const indent = depth * 2;
    const blockStart = findYamlKey(lines, blocks[depth], indent, searchStart, searchEnd);
    if (blockStart === -1) {
      // The block is missing: insert the remaining structure minimally —
      // a missing top-level block is appended at the end of the file; a
      // missing nested block is inserted at the end of its parent block.
      const missing: string[] = [];
      for (let d = depth; d < blocks.length; d += 1) {
        missing.push(`${' '.repeat(d * 2)}${blocks[d]}:`);
      }
      missing.push(`${' '.repeat(keyIndent)}${key}: ${value}`);

      const next = [...lines];
      if (depth === 0) {
        if (next.length > 0 && next[next.length - 1].trim() !== '') next.push('');
        next.push(...missing);
      } else {
        next.splice(searchEnd, 0, ...missing);
      }
      return joinYamlLines(next, newline, hadFinalNewline);
    }
    ensureBlockKey(lines[blockStart], blocks[depth], indent, dotPath);
    searchEnd = findYamlBlockEnd(lines, blockStart, indent, searchEnd);
    searchStart = blockStart + 1;
  }

  const keyLine = findYamlKey(lines, key, keyIndent, searchStart, searchEnd);
  if (keyLine === -1) {
    // The boolean line is missing: insert it at the top of its block.
    const next = [...lines];
    next.splice(searchStart, 0, `${' '.repeat(keyIndent)}${key}: ${value}`);
    return joinYamlLines(next, newline, hadFinalNewline);
  }

  const updated = lines[keyLine].replace(
    new RegExp(`^(\\s*${key}:\\s*)(?:true|false)(\\s*(?:#.*)?)$`),
    `$1${value}$2`,
  );
  if (updated === lines[keyLine] && !new RegExp(`^ {${keyIndent}}${key}:\\s*${value}\\s*(?:#.*)?$`).test(lines[keyLine])) {
    throw new Error(`${dotPath} must be a block boolean in the config file`);
  }

  const next = [...lines];
  next[keyLine] = updated;
  return joinYamlLines(next, newline, hadFinalNewline);
}

function findYamlKey(lines: string[], key: string, indent: number, start: number, end: number): number {
  const re = new RegExp(`^ {${indent}}${key}:`);
  for (let index = start; index < end; index += 1) {
    if (re.test(lines[index])) return index;
  }
  return -1;
}

function ensureBlockKey(line: string, key: string, indent: number, dotPath: string): void {
  const re = new RegExp(`^ {${indent}}${key}:\\s*(?:#.*)?$`);
  if (!re.test(line)) {
    throw new Error(`${dotPath} requires ${key} to be a block in the config file`);
  }
}

function findYamlBlockEnd(lines: string[], start: number, parentIndent: number, maxEnd: number): number {
  for (let index = start + 1; index < maxEnd; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    if (leadingSpaces(line) <= parentIndent) return index;
  }
  return maxEnd;
}

function leadingSpaces(line: string): number {
  return line.match(/^ */)?.[0].length ?? 0;
}

function joinYamlLines(lines: string[], newline: string, finalNewline: boolean): string {
  return `${lines.join(newline)}${finalNewline ? newline : ''}`;
}

function findClosingQuote(value: string, quote: '"' | "'"): number {
  for (let i = 1; i < value.length; i++) {
    if (value[i] === quote && value[i - 1] !== '\\') return i;
  }
  return -1;
}

function unescapeDoubleQuoted(value: string): string {
  return value.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function formatEnvLine(key: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid env key: ${key}`);
  }
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
  return `${key}="${escaped}"`;
}

export function resolveWebAuthToken(
  config: ForgeConfig,
  resolved: ResolvedPaths,
): { token: string; source: 'env' | 'config' | 'file' | 'generated'; path?: string } {
  const envToken = process.env.FORGE_AUTH_TOKEN?.trim();
  if (envToken) return { token: envToken, source: 'env' };

  const configToken = config.services.web.auth_token?.trim();
  if (configToken) return { token: configToken, source: 'config' };

  const tokenPath = path.join(resolved.logs, AUTH_TOKEN_FILENAME);
  if (fs.existsSync(tokenPath)) {
    const token = fs.readFileSync(tokenPath, 'utf-8').trim();
    if (token) return { token, source: 'file', path: tokenPath };
  }

  fs.mkdirSync(resolved.logs, { recursive: true });
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return { token, source: 'generated', path: tokenPath };
}

export function clearConfigCache(): void {
  _cached = null;
}
