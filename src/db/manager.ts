import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const SCHEMA_DIR = fileURLToPath(new URL('./schemas/', import.meta.url));

export type DbName =
  | 'documents'
  | 'memory'
  | 'messages'
  | 'tools';

const ALL_DBS: DbName[] = [
  'documents', 'memory', 'messages', 'tools',
];

interface DbHandle {
  db: Database.Database;
  name: DbName;
  path: string;
}

export class DatabaseManager {
  private handles = new Map<DbName, DbHandle>();
  private dbDir: string;

  constructor(dbDir: string) {
    this.dbDir = dbDir;
    fs.mkdirSync(dbDir, { recursive: true });
  }

  open(name: DbName): Database.Database {
    const existing = this.handles.get(name);
    if (existing) return existing.db;

    const dbPath = path.join(this.dbDir, `${name}.db`);
    const db = new Database(dbPath);

    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');

    this.applySchema(db, name);

    const handle: DbHandle = { db, name, path: dbPath };
    this.handles.set(name, handle);
    return db;
  }

  get(name: DbName): Database.Database {
    const handle = this.handles.get(name);
    if (!handle) throw new Error(`Database '${name}' not opened. Call open() first.`);
    return handle.db;
  }

  openAll(): void {
    for (const name of ALL_DBS) {
      this.open(name);
    }
  }

  private applySchema(db: Database.Database, name: DbName): void {
    const schemaPath = path.join(SCHEMA_DIR, `${name}.sql`);
    if (!fs.existsSync(schemaPath)) {
      console.warn(`[db] No schema file for ${name}`);
      return;
    }
    const sql = fs.readFileSync(schemaPath, 'utf-8');

    try {
      db.exec(sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[db] Schema error in ${name}: ${msg}`);
    }
  }

  close(name: DbName): void {
    const handle = this.handles.get(name);
    if (handle) {
      handle.db.close();
      this.handles.delete(name);
    }
  }

  closeAll(): void {
    for (const [name] of this.handles) {
      this.close(name);
    }
  }

  health(): Array<{ name: DbName; ok: boolean; error?: string }> {
    const results: Array<{ name: DbName; ok: boolean; error?: string }> = [];
    for (const [name, handle] of this.handles) {
      try {
        handle.db.prepare('SELECT 1').get();
        results.push({ name, ok: true });
      } catch (err) {
        results.push({
          name,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }

  isOpen(name: DbName): boolean {
    return this.handles.has(name);
  }

  getPath(name: DbName): string {
    return path.join(this.dbDir, `${name}.db`);
  }

  /** Every database name the manager knows about (open or not). */
  names(): DbName[] {
    return [...ALL_DBS];
  }
}
