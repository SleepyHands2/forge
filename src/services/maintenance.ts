import fs from 'node:fs';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import type { ForgeConfig, ResolvedPaths } from '../types.ts';
import type { DatabaseManager } from '../db/manager.ts';
import type { MemoryService } from './memory.ts';
import type { IdentityNotesMaintenanceService } from './identity-notes-maintenance.ts';

type Database = BetterSqlite3.Database;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const BACKUP_DIR_RE = /^forge-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;

interface MaintenanceLogger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface MaintenanceServiceOptions {
  config: ForgeConfig;
  resolved: ResolvedPaths;
  dbManager: DatabaseManager;
  memory: MemoryService;
  /** tools.db handle for the durable scheduler_runs log (Activity tab). */
  db?: Database;
  /** Identity NOTES.md consolidation; scheduled here, logic lives in its service. */
  notesMaintenance?: Pick<IdentityNotesMaintenanceService, 'enabled' | 'run'>;
  logger?: MaintenanceLogger;
  now?: () => Date;
}

/**
 * Background maintenance: scheduled local backups (every SQLite database plus
 * the identity directory), nightly memory consolidation (supersede
 * near-duplicate auto memories, archive stale unused auto memories), and
 * identity NOTES.md consolidation (the three-way promote/archive/keep sort).
 *
 * Everything here is background hygiene: failures are logged to
 * scheduler_runs and the console but never thrown into a foreground path.
 * Tasks are serialized — never two maintenance tasks at once — and due-checks
 * run at boot (setImmediate) and then hourly on an unref'd timer.
 */
export class MaintenanceService {
  private readonly config: ForgeConfig;
  private readonly resolved: ResolvedPaths;
  private readonly dbManager: DatabaseManager;
  private readonly memory: MemoryService;
  private readonly db?: Database;
  private readonly notesMaintenance?: Pick<IdentityNotesMaintenanceService, 'enabled' | 'run'>;
  private readonly logger: MaintenanceLogger;
  private readonly now: () => Date;

  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(options: MaintenanceServiceOptions) {
    this.config = options.config;
    this.resolved = options.resolved;
    this.dbManager = options.dbManager;
    this.memory = options.memory;
    this.db = options.db;
    this.notesMaintenance = options.notesMaintenance;
    this.logger = options.logger ?? console;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (!this.backupEnabled() && !this.consolidationEnabled() && !this.notesMaintenanceEnabled()) return;

    setImmediate(() => {
      void this.runDueTasks();
    });
    this.timer = setInterval(() => {
      void this.runDueTasks();
    }, HOUR_MS);
    this.timer.unref?.();
    this.logger.log('[maintenance] Started (backup: '
      + `${this.backupEnabled() ? 'on' : 'off'}, consolidation: ${this.consolidationEnabled() ? 'on' : 'off'}, `
      + `identity notes: ${this.notesMaintenanceEnabled() ? 'on' : 'off'}).`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Runs every due task. Serialized: while one pass is in flight, further
   * invocations await it instead of starting a second pass.
   */
  runDueTasks(): Promise<void> {
    if (this.inFlight) return this.inFlight;

    const run = this.runDueTasksInner().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async runDueTasksInner(): Promise<void> {
    try {
      if (this.backupEnabled() && this.backupDue()) {
        await this.runBackup();
      }
      if (this.consolidationEnabled() && this.consolidationDue()) {
        await this.runConsolidation();
      }
      if (this.notesMaintenanceEnabled() && this.notesMaintenanceDue()) {
        await this.runNotesMaintenance();
      }
    } catch (err) {
      // The run methods never throw; this guards the due-checks.
      this.logger.warn('[maintenance] Due-check failed:', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Copies every database (via better-sqlite3's live-safe async backup API)
   * and the identity directory into a dated directory under backup.dir, then
   * prunes old backups beyond backup.keep. Logs one scheduler_runs row
   * ('backup', ok/error). Never throws.
   */
  async runBackup(): Promise<void> {
    const started = Date.now();
    const dirName = `forge-backup-${formatStamp(this.now())}`;
    try {
      const backupsRoot = this.backupsRoot();
      const backupDir = path.join(backupsRoot, dirName);
      await fs.promises.mkdir(backupDir, { recursive: true });

      const parts: string[] = [];
      for (const name of this.dbManager.names()) {
        const destination = path.join(backupDir, `${name}.db`);
        await this.dbManager.get(name).backup(destination);
        const { size } = await fs.promises.stat(destination);
        parts.push(`${name}.db ${formatBytes(size)}`);
      }

      if (fs.existsSync(this.resolved.identity)) {
        await fs.promises.cp(this.resolved.identity, path.join(backupDir, 'identity'), { recursive: true });
        parts.push('identity/');
      }

      const pruned = await this.pruneBackups(backupsRoot);
      const detail = `${dirName}: ${parts.join(', ')}`
        + (pruned > 0 ? `; pruned ${pruned} old backup(s)` : '');
      this.logger.log(`[maintenance] Backup complete: ${detail}`);
      this.logRun('backup', 'ok', detail, Date.now() - started);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[maintenance] Backup failed: ${msg}`);
      this.logRun('backup', 'error', msg, Date.now() - started);
    }
  }

  /**
   * Memory hygiene: supersede near-duplicate active memories (keeping the
   * newer of each pair) at/above memory.consolidation.dedupe_similarity, then
   * archive auto-tagged, never-retrieved memories older than
   * memory.retention_days. Manual memories are never touched. Logs one
   * scheduler_runs row ('consolidation', ok/error). Never throws.
   */
  async runConsolidation(): Promise<void> {
    const started = Date.now();
    try {
      const minSimilarity = this.config.memory.consolidation?.dedupe_similarity ?? 0.95;
      const pairs = this.memory.findDuplicatePairs(minSimilarity);
      let superseded = 0;
      for (const pair of pairs) {
        if (this.memory.markDuplicate(pair.dropId, pair.keepId)) superseded += 1;
      }

      const archived = this.memory.archiveStaleAuto(this.config.memory.retention_days, this.now().getTime());

      const detail = `superseded ${superseded} duplicates, archived ${archived.length} stale auto memories`;
      this.logger.log(`[maintenance] Consolidation complete: ${detail}`);
      this.logRun('consolidation', 'ok', detail, Date.now() - started);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[maintenance] Consolidation failed: ${msg}`);
      this.logRun('consolidation', 'error', msg, Date.now() - started);
    }
  }

  /**
   * Identity NOTES.md consolidation: the three-way sort lives in
   * IdentityNotesMaintenanceService; this schedules it and records one
   * scheduler_runs row ('identity_notes', ok/skipped/error). A pass that
   * found nothing to do logs 'skipped'; an unusable model plan logs 'error'
   * so it is visible in the Activity tab. Never throws.
   */
  async runNotesMaintenance(): Promise<void> {
    if (!this.notesMaintenance) return;
    const started = Date.now();
    try {
      const result = await this.notesMaintenance.run();
      const status = result.status === 'ok' ? 'ok'
        : result.status === 'error' || result.status === 'no_output' ? 'error'
        : 'skipped';
      if (status === 'error') {
        this.logger.warn(`[maintenance] Identity notes maintenance failed: ${result.detail}`);
      } else {
        this.logger.log(`[maintenance] Identity notes maintenance ${status === 'ok' ? 'complete' : 'skipped'}: ${result.detail}`);
      }
      this.logRun('identity_notes', status, result.detail, Date.now() - started);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[maintenance] Identity notes maintenance failed: ${msg}`);
      this.logRun('identity_notes', 'error', msg, Date.now() - started);
    }
  }

  private backupEnabled(): boolean {
    return this.config.backup?.enabled === true;
  }

  private consolidationEnabled(): boolean {
    return this.config.memory.consolidation?.enabled === true;
  }

  private notesMaintenanceEnabled(): boolean {
    return this.notesMaintenance !== undefined && this.notesMaintenance.enabled();
  }

  private backupsRoot(): string {
    return path.resolve(this.resolved.root, this.config.backup?.dir ?? './backups');
  }

  /** Due when no backup directory exists or the newest is older than interval_days. */
  private backupDue(): boolean {
    const intervalDays = this.config.backup?.interval_days ?? 7;
    const newest = this.newestBackupMs();
    if (newest === null) return true;
    return this.now().getTime() - newest >= intervalDays * DAY_MS;
  }

  private newestBackupMs(): number | null {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.backupsRoot(), { withFileTypes: true });
    } catch {
      return null;
    }

    let newest: number | null = null;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const stamp = parseStamp(entry.name);
      if (stamp === null) continue;
      if (newest === null || stamp > newest) newest = stamp;
    }
    return newest;
  }

  private async pruneBackups(backupsRoot: string): Promise<number> {
    const keep = this.config.backup?.keep ?? 8;
    const entries = await fs.promises.readdir(backupsRoot, { withFileTypes: true });
    const backups = entries
      .filter(entry => entry.isDirectory() && parseStamp(entry.name) !== null)
      .map(entry => entry.name)
      // The name encodes the timestamp, so a lexical sort is chronological.
      .sort((a, b) => b.localeCompare(a));

    const stale = backups.slice(keep);
    for (const name of stale) {
      await fs.promises.rm(path.join(backupsRoot, name), { recursive: true, force: true });
    }
    return stale.length;
  }

  /** Due when the last 'consolidation' run in scheduler_runs is older than interval_days (or none exists). */
  private consolidationDue(): boolean {
    const intervalDays = this.config.memory.consolidation?.interval_days ?? 1;
    if (!this.db) return true;

    let row: { created_at: string } | undefined;
    try {
      row = this.db.prepare(`
        SELECT created_at FROM scheduler_runs
        WHERE job_name = 'consolidation'
        ORDER BY id DESC LIMIT 1
      `).get() as { created_at: string } | undefined;
    } catch (err) {
      this.logger.warn('[maintenance] Failed to read the consolidation run log:', err instanceof Error ? err.message : String(err));
      return false;
    }
    if (!row) return true;

    const lastMs = Date.parse(row.created_at);
    if (!Number.isFinite(lastMs)) return true;
    return this.now().getTime() - lastMs >= intervalDays * DAY_MS;
  }

  /** Due when the last 'identity_notes' run in scheduler_runs is older than interval_days (or none exists). */
  private notesMaintenanceDue(): boolean {
    const intervalDays = this.config.identity?.notes_maintenance?.interval_days ?? 1;
    if (!this.db) return true;

    let row: { created_at: string } | undefined;
    try {
      row = this.db.prepare(`
        SELECT created_at FROM scheduler_runs
        WHERE job_name = 'identity_notes'
        ORDER BY id DESC LIMIT 1
      `).get() as { created_at: string } | undefined;
    } catch (err) {
      this.logger.warn('[maintenance] Failed to read the identity notes run log:', err instanceof Error ? err.message : String(err));
      return false;
    }
    if (!row) return true;

    const lastMs = Date.parse(row.created_at);
    if (!Number.isFinite(lastMs)) return true;
    return this.now().getTime() - lastMs >= intervalDays * DAY_MS;
  }

  private logRun(jobName: string, status: 'ok' | 'error' | 'skipped', detail: string, durationMs: number): void {
    if (!this.db) return;
    try {
      this.db.prepare(`
        INSERT INTO scheduler_runs (job_name, status, detail, duration_ms, delivered)
        VALUES (?, ?, ?, ?, 0)
      `).run(jobName, status, detail, durationMs);
    } catch (err) {
      this.logger.warn('[maintenance] Failed to write run log:', err instanceof Error ? err.message : String(err));
    }
  }
}

/** Local-time stamp used in backup directory names: YYYYMMDD-HHmmss. */
function formatStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Millisecond timestamp encoded in a backup directory name, or null when it is not one. */
function parseStamp(name: string): number | null {
  const match = BACKUP_DIR_RE.exec(name);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${Math.round((size / (1024 * 1024)) * 10) / 10} MB`;
}
