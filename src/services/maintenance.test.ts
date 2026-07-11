import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { DatabaseManager } from '../db/manager.ts';
import { MemoryService } from './memory.ts';
import { MaintenanceService } from './maintenance.ts';
import type { NotesMaintenanceResult } from './identity-notes-maintenance.ts';
import type { EmbeddingHealth, ForgeConfig, ResolvedPaths } from '../types.ts';
import type { EmbeddingProvider } from './ollama-embeddings.ts';

const quietLogger = { log: () => {}, warn: () => {} };

// Fixed injected clock: 2026-07-07 12:00:00 local time.
const NOW = new Date(2026, 6, 7, 12, 0, 0);
const NOW_STAMP = '20260707-120000';
const DAY_MS = 86_400_000;

function config(overrides: {
  backup?: Partial<NonNullable<ForgeConfig['backup']>>;
  consolidation?: Partial<NonNullable<ForgeConfig['memory']['consolidation']>>;
  retention_days?: number;
} = {}): ForgeConfig {
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
    memory: {
      retention_days: overrides.retention_days ?? 30,
      consolidation: { enabled: false, dedupe_similarity: 0.95, interval_days: 1, ...overrides.consolidation },
    },
    backup: { enabled: false, interval_days: 7, keep: 8, dir: './backups', ...overrides.backup },
  };
}

function fakeEmbeddings(vectorFor: (input: string) => number[]): EmbeddingProvider {
  const health: EmbeddingHealth = {
    provider: 'ollama',
    enabled: true,
    model: 'test-embeddings',
    baseUrl: 'http://localhost:11434',
    ok: true,
    status: 'online',
    installedModels: ['test-embeddings'],
  };
  return {
    enabled: true,
    model: 'test-embeddings',
    async embed(input: string) { return vectorFor(input); },
    async embedMany(inputs: readonly string[]) { return inputs.map(vectorFor); },
    async health() { return health; },
  };
}

interface Env {
  root: string;
  resolved: ResolvedPaths;
  dbManager: DatabaseManager;
  memory: MemoryService;
  service: MaintenanceService;
  runs: () => Array<Record<string, unknown>>;
  backupDirs: () => string[];
  cleanup: () => void;
}

function makeEnv(cfg: ForgeConfig, options: {
  embeddings?: EmbeddingProvider;
  notesMaintenance?: { enabled: () => boolean; run: () => Promise<NotesMaintenanceResult> };
} = {}): Env {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-maintenance-'));
  const resolved: ResolvedPaths = {
    root,
    dbs: path.join(root, 'dbs'),
    identity: path.join(root, 'identity'),
    logs: path.join(root, 'logs'),
    images: path.join(root, 'images'),
  };
  const dbManager = new DatabaseManager(resolved.dbs);
  dbManager.openAll();
  const memory = new MemoryService(dbManager.get('memory'), { embeddingProvider: options.embeddings });
  const service = new MaintenanceService({
    config: cfg,
    resolved,
    dbManager,
    memory,
    db: dbManager.get('tools'),
    notesMaintenance: options.notesMaintenance,
    logger: quietLogger,
    now: () => NOW,
  });
  const backupsRoot = path.join(root, 'backups');
  return {
    root,
    resolved,
    dbManager,
    memory,
    service,
    runs: () => dbManager.get('tools').prepare('SELECT * FROM scheduler_runs ORDER BY id').all() as Array<Record<string, unknown>>,
    backupDirs: () => fs.existsSync(backupsRoot)
      ? fs.readdirSync(backupsRoot).filter(name => name.startsWith('forge-backup-')).sort()
      : [],
    cleanup: () => {
      service.stop();
      dbManager.closeAll();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

// --- backups ---------------------------------------------------------------------

test('runBackup copies every database and the identity directory into a dated dir and logs ok', async () => {
  const env = makeEnv(config({ backup: { enabled: true } }));

  try {
    const memoryId = env.memory.saveSync({ type: 'fact', content: 'backup fixture memory', tags: ['auto'] });
    fs.mkdirSync(path.join(env.resolved.identity, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(env.resolved.identity, 'IDENTITY.md'), '# Identity fixture\n');
    fs.writeFileSync(path.join(env.resolved.identity, 'nested', 'NOTES.md'), '# Notes fixture\n');

    await env.service.runBackup();

    const backupDir = path.join(env.root, 'backups', `forge-backup-${NOW_STAMP}`);
    for (const name of ['documents', 'memory', 'messages', 'tools']) {
      const copyPath = path.join(backupDir, `${name}.db`);
      assert.ok(fs.existsSync(copyPath), `expected ${name}.db in the backup`);
      const copy = new Database(copyPath, { readonly: true, fileMustExist: true });
      try {
        assert.deepEqual(copy.prepare('SELECT 1 AS ok').get(), { ok: 1 });
        if (name === 'memory') {
          const row = copy.prepare('SELECT content FROM memories WHERE id = ?').get(memoryId) as { content: string };
          assert.equal(row.content, 'backup fixture memory');
        }
      } finally {
        copy.close();
      }
    }
    assert.equal(fs.readFileSync(path.join(backupDir, 'identity', 'IDENTITY.md'), 'utf-8'), '# Identity fixture\n');
    assert.equal(fs.readFileSync(path.join(backupDir, 'identity', 'nested', 'NOTES.md'), 'utf-8'), '# Notes fixture\n');

    const runs = env.runs();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].job_name, 'backup');
    assert.equal(runs[0].status, 'ok');
    assert.match(String(runs[0].detail), new RegExp(`forge-backup-${NOW_STAMP}`));
    assert.match(String(runs[0].detail), /memory\.db/);
    assert.match(String(runs[0].detail), /identity\//);
  } finally {
    env.cleanup();
  }
});

test('runBackup prunes old backup directories beyond keep and leaves unrelated entries alone', async () => {
  const env = makeEnv(config({ backup: { enabled: true, keep: 2 } }));

  try {
    const backupsRoot = path.join(env.root, 'backups');
    for (const stamp of ['20250101-000000', '20250315-090000', '20260101-063000']) {
      const dir = path.join(backupsRoot, `forge-backup-${stamp}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'memory.db'), 'old backup payload');
    }
    fs.mkdirSync(path.join(backupsRoot, 'unrelated-dir'), { recursive: true });

    await env.service.runBackup();

    assert.deepEqual(env.backupDirs(), [
      'forge-backup-20260101-063000',
      `forge-backup-${NOW_STAMP}`,
    ]);
    assert.ok(fs.existsSync(path.join(backupsRoot, 'unrelated-dir')));

    const runs = env.runs();
    assert.equal(runs[0].status, 'ok');
    assert.match(String(runs[0].detail), /pruned 2 old backup\(s\)/);
  } finally {
    env.cleanup();
  }
});

test('a database backup failure logs an error run and never throws', async () => {
  const env = makeEnv(config({ backup: { enabled: true } }));

  try {
    // A directory where documents.db must be written makes db.backup() fail.
    fs.mkdirSync(path.join(env.root, 'backups', `forge-backup-${NOW_STAMP}`, 'documents.db'), { recursive: true });

    await assert.doesNotReject(env.service.runBackup());

    const runs = env.runs();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].job_name, 'backup');
    assert.equal(runs[0].status, 'error');
    assert.ok(String(runs[0].detail).length > 0);
  } finally {
    env.cleanup();
  }
});

// --- due-scheduling ----------------------------------------------------------------

test('backup is not due while a fresh backup directory exists, and due once it ages out', async () => {
  const fresh = makeEnv(config({ backup: { enabled: true, interval_days: 7 } }));
  try {
    // One day old: within the 7-day interval.
    fs.mkdirSync(path.join(fresh.root, 'backups', 'forge-backup-20260706-120000'), { recursive: true });

    const first = fresh.service.runDueTasks();
    const second = fresh.service.runDueTasks();
    assert.strictEqual(first, second, 'concurrent due-checks share one in-flight run');
    await first;

    assert.deepEqual(fresh.backupDirs(), ['forge-backup-20260706-120000']);
    assert.deepEqual(fresh.runs(), []);
  } finally {
    fresh.cleanup();
  }

  const stale = makeEnv(config({ backup: { enabled: true, interval_days: 7 } }));
  try {
    fs.mkdirSync(path.join(stale.root, 'backups', 'forge-backup-20260601-000000'), { recursive: true });

    await stale.service.runDueTasks();

    assert.deepEqual(stale.backupDirs(), ['forge-backup-20260601-000000', `forge-backup-${NOW_STAMP}`]);
    const runs = stale.runs();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].job_name, 'backup');
    assert.equal(runs[0].status, 'ok');
  } finally {
    stale.cleanup();
  }
});

test('consolidation due-check reads the last consolidation row in scheduler_runs', async () => {
  const env = makeEnv(config({ consolidation: { enabled: true, interval_days: 1 } }));

  try {
    const tools = env.dbManager.get('tools');
    const insert = tools.prepare(`
      INSERT INTO scheduler_runs (job_name, status, detail, duration_ms, delivered, created_at)
      VALUES ('consolidation', 'ok', '', 0, 0, ?)
    `);

    // Ran two hours ago: not due.
    insert.run(new Date(NOW.getTime() - 2 * 3_600_000).toISOString());
    await env.service.runDueTasks();
    assert.equal(env.runs().length, 1);

    // Last run two days ago: due again.
    tools.prepare('DELETE FROM scheduler_runs').run();
    insert.run(new Date(NOW.getTime() - 2 * DAY_MS).toISOString());
    await env.service.runDueTasks();

    const runs = env.runs();
    assert.equal(runs.length, 2);
    assert.equal(runs[1].job_name, 'consolidation');
    assert.equal(runs[1].status, 'ok');
    assert.equal(runs[1].detail, 'superseded 0 duplicates, archived 0 stale auto memories');
  } finally {
    env.cleanup();
  }
});

// --- consolidation -------------------------------------------------------------------

test('runConsolidation supersedes near-duplicates and archives stale auto memories, sparing everything else', async () => {
  const embeddings = fakeEmbeddings(input => {
    if (input.includes('tea over coffee')) return [1, 0, 0];
    if (input.includes('tea rather than coffee')) return [0.999, 0.0447, 0];
    if (input.includes('stale auto detail')) return [0, 1, 0];
    return [0, 0, 1];
  });
  const env = makeEnv(
    config({ consolidation: { enabled: true }, retention_days: 30 }),
    { embeddings },
  );

  try {
    const oldIso = new Date(NOW.getTime() - 60 * DAY_MS).toISOString();
    const recentIso = new Date(NOW.getTime() - 1 * DAY_MS).toISOString();

    const dupOld = await env.memory.save({ type: 'preference', content: 'The user prefers tea over coffee.', tags: ['auto'] });
    const dupNew = await env.memory.save({ type: 'preference', content: 'User prefers tea rather than coffee.', tags: ['auto'] });
    const staleAuto = await env.memory.save({ type: 'fact', content: 'A stale auto detail nobody asked about.', tags: ['auto'] });
    const manualOld = await env.memory.save({ type: 'chat', content: 'An old manual memory.', tags: ['chat', 'explicit'] });

    const memDb = env.dbManager.get('memory');
    const setCreated = memDb.prepare('UPDATE memories SET created = ? WHERE id = ?');
    setCreated.run(oldIso, dupOld);
    setCreated.run(recentIso, dupNew);
    setCreated.run(oldIso, staleAuto);
    setCreated.run(oldIso, manualOld);

    await env.service.runConsolidation();

    const rowOf = (id: string) => memDb.prepare('SELECT status, supersededBy FROM memories WHERE id = ?')
      .get(id) as { status: string; supersededBy: string | null };
    assert.equal(rowOf(dupOld).status, 'superseded');
    assert.equal(rowOf(dupOld).supersededBy, dupNew);
    assert.equal(rowOf(dupNew).status, 'active');
    assert.equal(rowOf(staleAuto).status, 'archived');
    assert.equal(rowOf(manualOld).status, 'active');

    const history = env.memory.history(dupOld);
    assert.ok(history.some(entry => entry.changeType === 'consolidate-duplicate'));

    const runs = env.runs();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].job_name, 'consolidation');
    assert.equal(runs[0].status, 'ok');
    assert.equal(runs[0].detail, 'superseded 1 duplicates, archived 1 stale auto memories');
  } finally {
    env.cleanup();
  }
});

// --- identity notes maintenance -------------------------------------------------------

function notesConfig(): ForgeConfig {
  const cfg = config();
  cfg.identity = {
    reflection: { enabled: false, cadence_turns: 1, recent_notes_in_context: 5 },
    notes_maintenance: { enabled: true, interval_days: 1, max_bytes: 6144, keep_recent: 4, max_promotions: 2 },
  };
  return cfg;
}

test('identity notes maintenance runs when due and logs the sort counts', async () => {
  let calls = 0;
  const env = makeEnv(notesConfig(), {
    notesMaintenance: {
      enabled: () => true,
      run: async () => {
        calls += 1;
        return {
          status: 'ok', promoted: 1, archived: 2, kept: 3,
          detail: 'promoted 1 to proposals, archived 2 to memory, kept 3 notes',
        };
      },
    },
  });

  try {
    await env.service.runDueTasks();

    assert.equal(calls, 1);
    const runs = env.runs();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].job_name, 'identity_notes');
    assert.equal(runs[0].status, 'ok');
    assert.equal(runs[0].detail, 'promoted 1 to proposals, archived 2 to memory, kept 3 notes');
  } finally {
    env.cleanup();
  }
});

test('identity notes due-check reads the last identity_notes row and maps skips and failures to run statuses', async () => {
  let result: NotesMaintenanceResult = {
    status: 'under_budget', promoted: 0, archived: 0, kept: 5,
    detail: 'NOTES.md is 900 bytes (limit 6144); nothing to do',
  };
  let calls = 0;
  const env = makeEnv(notesConfig(), {
    notesMaintenance: {
      enabled: () => true,
      run: async () => {
        calls += 1;
        return result;
      },
    },
  });

  try {
    const tools = env.dbManager.get('tools');
    const insert = tools.prepare(`
      INSERT INTO scheduler_runs (job_name, status, detail, duration_ms, delivered, created_at)
      VALUES ('identity_notes', 'ok', '', 0, 0, ?)
    `);

    // Ran two hours ago: not due, the service is never invoked.
    insert.run(new Date(NOW.getTime() - 2 * 3_600_000).toISOString());
    await env.service.runDueTasks();
    assert.equal(calls, 0);
    assert.equal(env.runs().length, 1);

    // Last run two days ago: due; a nothing-to-do pass logs 'skipped'.
    tools.prepare('DELETE FROM scheduler_runs').run();
    insert.run(new Date(NOW.getTime() - 2 * DAY_MS).toISOString());
    await env.service.runDueTasks();
    assert.equal(calls, 1);
    let runs = env.runs();
    assert.equal(runs[1].job_name, 'identity_notes');
    assert.equal(runs[1].status, 'skipped');

    // An unusable model plan logs 'error' so it is visible in the Activity tab.
    tools.prepare('DELETE FROM scheduler_runs').run();
    insert.run(new Date(NOW.getTime() - 2 * DAY_MS).toISOString());
    result = { status: 'no_output', promoted: 0, archived: 0, kept: 5, detail: 'model returned no parseable sort plan; NOTES.md unchanged' };
    await env.service.runDueTasks();
    runs = env.runs();
    assert.equal(runs[1].status, 'error');
  } finally {
    env.cleanup();
  }
});

test('start is a no-op when both backup and consolidation are disabled', async () => {
  const env = makeEnv(config());

  try {
    env.service.start();
    // Give the boot-time setImmediate due-check (which must not be scheduled
    // at all here) a chance to run before asserting nothing happened.
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(env.runs(), []);
    assert.deepEqual(env.backupDirs(), []);
  } finally {
    env.cleanup();
  }
});
