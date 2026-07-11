import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  EmbeddingHealth,
  EmbeddingIndexProgress,
  EmbeddingReindexState,
  MemoryRecord,
} from '../types.ts';
import type { EmbeddingProvider } from './ollama-embeddings.ts';

const RRF_K = 60;
const MAX_CHAT_RETRIEVAL_LIMIT = 100;

function genId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

export interface SaveMemoryInput {
  type: string;
  content: string;
  tags?: string[];
  confidence?: number;
  importance?: number;
}

export interface SearchResult extends MemoryRecord {
  rank?: number;
  semanticScore?: number;
}

export interface MemoryServiceOptions {
  embeddingProvider?: EmbeddingProvider;
  backfillBatchSize?: number;
}

export interface MemoryEmbeddingStatus {
  health: EmbeddingHealth;
  reindex: EmbeddingReindexState;
}

export interface EmbeddingReindexResult extends EmbeddingReindexState {
  indexed: number;
  skipped: number;
  failed: number;
}

interface EmbeddingIdentity {
  model: string;
  revision: string;
}

interface RawMemoryRow {
  id: string; type: string; content: string; tags: string;
  status: string; confidence: number; importance: number;
  accessCount: number; created: string; updated: string;
  supersededBy: string | null;
}

interface RawEmbeddingRow {
  memory_id: string;
  model: string;
  model_revision: string;
  content_hash: string;
  dimensions: number;
  vector: Buffer;
  created: string;
}

/**
 * SQLite/FTS remains the durable memory authority. Embeddings are optional local
 * acceleration: failure to create or read one never prevents lexical retrieval.
 */
export class MemoryService {
  private readonly db: Database.Database;
  private readonly embeddingProvider?: EmbeddingProvider;
  private readonly backfillBatchSize: number;
  private modelRevision: string | undefined;
  private lastEmbeddingHealth: EmbeddingHealth | undefined;
  private lastEmbeddingError: string | undefined;
  private reindexPromise: Promise<EmbeddingReindexResult> | undefined;
  private reindexState: EmbeddingReindexState = {
    status: 'idle',
    progress: { active: 0, indexed: 0, pending: 0, stale: 0, failed: 0 },
  };

  constructor(db: Database.Database, options: MemoryServiceOptions = {}) {
    this.db = db;
    this.embeddingProvider = options.embeddingProvider;
    this.backfillBatchSize = clampBatchSize(options.backfillBatchSize ?? 16);
  }

  async save(input: SaveMemoryInput): Promise<string> {
    const id = this.saveSync(input);
    await this.indexMemoryBestEffort(id);
    return id;
  }

  /** Synchronous callers intentionally receive only durable lexical persistence. */
  saveSync(input: SaveMemoryInput): string {
    const id = genId();
    const timestamp = now();
    this.db.transaction(() => {
      this.insertMemory(id, input, timestamp);
    })();
    return id;
  }

  get(id: string): MemoryRecord | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as RawMemoryRow | undefined;
    if (!row) return null;
    this.db.prepare('UPDATE memories SET accessCount = accessCount + 1 WHERE id = ?').run(id);
    return this.toRecord(row);
  }

  /** Stable synchronous lexical search used by existing evaluation and management callers. */
  search(query: string, limit = 10): SearchResult[] {
    const sanitized = query
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(w => w.length > 1)
      .join(' OR ');

    if (!sanitized) {
      return this.db.prepare(`
        SELECT * FROM memories WHERE status = 'active'
        ORDER BY importance DESC, updated DESC LIMIT ?
      `).all(limit).map(r => this.toRecord(r as RawMemoryRow));
    }

    const ftsResults = this.db.prepare(`
      SELECT m.*, fts.rank
      FROM memories_fts fts
      JOIN memories m ON m.id = fts.id
      WHERE memories_fts MATCH ?
      AND m.status = 'active'
      ORDER BY fts.rank
      LIMIT ?
    `).all(sanitized, limit) as (RawMemoryRow & { rank: number })[];

    if (ftsResults.length > 0) {
      return ftsResults.map(r => ({
        ...this.toRecord(r),
        rank: r.rank,
      }));
    }

    return this.db.prepare(`
      SELECT * FROM memories
      WHERE status = 'active'
      AND (content LIKE ? OR tags LIKE ?)
      ORDER BY importance DESC, updated DESC
      LIMIT ?
    `).all(`%${query}%`, `%${query}%`, limit)
      .map(r => this.toRecord(r as RawMemoryRow));
  }

  /**
   * Chat-only retrieval augments the unchanged lexical baseline with local cosine
   * similarity and deterministic reciprocal-rank fusion.
   */
  async retrieveForChat(query: string, limit = 5): Promise<SearchResult[]> {
    const safeLimit = clampChatRetrievalLimit(limit);
    // Keep a separately fetched baseline so semantic failures retain the exact
    // legacy `search(query, limit)` result even when hybrid retrieval uses more
    // lexical candidates for RRF.
    const lexicalFallback = this.search(query, safeLimit);
    const identity = this.currentEmbeddingIdentity();
    const provider = this.embeddingProvider;

    if (!identity || !provider || !query.trim()) return lexicalFallback;

    let queryVector: number[];
    try {
      queryVector = await provider.embed(query);
      validateVector(queryVector);
    } catch (error) {
      this.recordEmbeddingFailure(error);
      return lexicalFallback;
    }

    const lexicalCandidateLimit = Math.min(MAX_CHAT_RETRIEVAL_LIMIT, safeLimit * 4);
    const lexical = lexicalCandidateLimit === safeLimit
      ? lexicalFallback
      : this.search(query, lexicalCandidateLimit);
    const semantic = this.semanticResults(queryVector, identity);
    if (semantic.length === 0) return lexicalFallback;
    return fuseResults(lexical, semantic, safeLimit);
  }

  /**
   * Best-effort semantic near-duplicate lookup used by automatic capture.
   * Embeds the candidate text and returns the closest active memory with its
   * cosine similarity, or null when the embedding index is unavailable —
   * callers must combine this with exact-match dedupe.
   */
  async findMostSimilar(content: string): Promise<{ id: string; content: string; similarity: number } | null> {
    const identity = this.currentEmbeddingIdentity();
    const provider = this.embeddingProvider;
    if (!identity || !provider || !content.trim()) return null;

    let vector: number[];
    try {
      vector = await provider.embed(content);
      validateVector(vector);
    } catch (error) {
      this.recordEmbeddingFailure(error);
      return null;
    }

    const [top] = this.semanticResults(vector, identity);
    if (!top || top.semanticScore === undefined) return null;
    return { id: top.id, content: top.content, similarity: top.semanticScore };
  }

  /**
   * Increments accessCount for every given memory in one statement. Called by
   * retrieval consumers (chat context, recall tools) so accessCount reflects
   * actual usage; consolidation relies on it to spare retrieved memories.
   */
  markRetrieved(ids: string[]): void {
    const unique = [...new Set(ids)].filter(id => typeof id === 'string' && id.length > 0);
    if (unique.length === 0) return;
    const placeholders = unique.map(() => '?').join(', ');
    this.db.prepare(`UPDATE memories SET accessCount = accessCount + 1 WHERE id IN (${placeholders})`)
      .run(...unique);
  }

  /**
   * Pairwise near-duplicate detection among ACTIVE memories whose stored
   * embeddings share the same model + revision and still match their content
   * hash. Pairs at/above the threshold are matched greedily by highest
   * similarity; each memory appears in at most one pair. The NEWER (created)
   * memory of a pair is kept, the older one is the drop candidate.
   */
  findDuplicatePairs(minSimilarity: number): Array<{ keepId: string; dropId: string; similarity: number }> {
    const rows = this.db.prepare(`
      SELECT m.*, e.model, e.model_revision, e.content_hash, e.dimensions, e.vector
      FROM memories m
      JOIN memory_embeddings e ON e.memory_id = m.id
      WHERE m.status = 'active'
    `).all() as Array<RawMemoryRow & {
      model: string; model_revision: string; content_hash: string; dimensions: number; vector: Buffer;
    }>;

    interface Entry { row: RawMemoryRow; vector: number[] }
    const groups = new Map<string, Entry[]>();
    for (const row of rows) {
      if (row.content_hash !== hashEmbeddingInput(embeddingInput(row))) continue;
      const vector = unpackVector(row.vector, row.dimensions);
      if (!vector) continue;
      const key = `${row.model} ${row.model_revision}`;
      const group = groups.get(key) ?? [];
      group.push({ row, vector });
      groups.set(key, group);
    }

    const candidates: Array<{ keepId: string; dropId: string; similarity: number }> = [];
    for (const group of groups.values()) {
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          const similarity = cosineSimilarity(group[i].vector, group[j].vector);
          if (similarity === undefined || similarity < minSimilarity) continue;
          // Keep the newer memory; drop the older. Ties break on id for determinism.
          const [newer, older] = compareCreated(group[i].row, group[j].row) >= 0
            ? [group[i].row, group[j].row]
            : [group[j].row, group[i].row];
          candidates.push({ keepId: newer.id, dropId: older.id, similarity });
        }
      }
    }

    candidates.sort((a, b) => b.similarity - a.similarity
      || a.dropId.localeCompare(b.dropId)
      || a.keepId.localeCompare(b.keepId));
    const used = new Set<string>();
    const pairs: Array<{ keepId: string; dropId: string; similarity: number }> = [];
    for (const candidate of candidates) {
      if (used.has(candidate.keepId) || used.has(candidate.dropId)) continue;
      used.add(candidate.keepId);
      used.add(candidate.dropId);
      pairs.push(candidate);
    }
    return pairs;
  }

  /**
   * Consolidation outcome for a near-duplicate: supersede dropId in favor of
   * keepId, mirroring the cleanup supersede()/remove() perform (embeddings and
   * FTS rows of the dropped memory are deleted), with an auditable history row.
   */
  markDuplicate(dropId: string, keepId: string): boolean {
    const existing = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(dropId) as RawMemoryRow | undefined;
    if (!existing) return false;

    this.db.transaction(() => {
      this.db.prepare("UPDATE memories SET status = 'superseded', supersededBy = ?, updated = ? WHERE id = ?")
        .run(keepId, now(), dropId);
      this.db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(dropId);
      this.db.prepare('DELETE FROM memories_fts WHERE id = ?').run(dropId);
      this.recordHistory(dropId, 'consolidate-duplicate', {
        oldStatus: 'active',
        newStatus: 'superseded',
        reason: `near-duplicate of ${keepId}`,
      });
    })();
    return true;
  }

  /**
   * Archives every ACTIVE memory that is auto-captured (tagged 'auto'), was
   * never retrieved (accessCount = 0), and is older than retentionDays.
   * Memories without the 'auto' tag are NEVER touched. Returns archived ids.
   */
  archiveStaleAuto(retentionDays: number, nowMs: number): string[] {
    const cutoffMs = nowMs - retentionDays * 86_400_000;
    const rows = this.db.prepare(`
      SELECT * FROM memories WHERE status = 'active' AND accessCount = 0
    `).all() as RawMemoryRow[];

    const archived: string[] = [];
    for (const row of rows) {
      if (!parseTags(row.tags).includes('auto')) continue;
      const createdMs = Date.parse(row.created);
      if (!Number.isFinite(createdMs) || createdMs >= cutoffMs) continue;
      if (this.update(row.id, { status: 'archived' })) archived.push(row.id);
    }
    return archived;
  }

  /** Case- and whitespace-insensitive exact content match among active memories. */
  findExactContent(content: string): MemoryRecord | null {
    const normalized = normalizeContent(content);
    if (!normalized) return null;
    const rows = this.db.prepare("SELECT * FROM memories WHERE status = 'active'").all() as RawMemoryRow[];
    for (const row of rows) {
      if (normalizeContent(row.content) === normalized) return this.toRecord(row);
    }
    return null;
  }

  list(opts?: { type?: string; status?: string; limit?: number }): MemoryRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.type) { conditions.push('type = ?'); params.push(opts.type); }
    if (opts?.status) { conditions.push('status = ?'); params.push(opts.status); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit ?? 50;

    return this.db.prepare(`SELECT * FROM memories ${where} ORDER BY updated DESC LIMIT ?`)
      .all(...params, limit)
      .map(r => this.toRecord(r as RawMemoryRow));
  }

  update(id: string, partial: Partial<Pick<MemoryRecord, 'content' | 'tags' | 'status' | 'confidence' | 'importance'>>): boolean {
    const existing = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as RawMemoryRow | undefined;
    if (!existing) return false;

    const changesEmbeddingInput = partial.content !== undefined || partial.tags !== undefined;
    const changesLifecycle = partial.status !== undefined;
    const sets: string[] = ['updated = ?'];
    const params: unknown[] = [now()];

    if (partial.content !== undefined) { sets.push('content = ?'); params.push(partial.content); }
    if (partial.tags !== undefined) { sets.push('tags = ?'); params.push(JSON.stringify(partial.tags)); }
    if (partial.status !== undefined) { sets.push('status = ?'); params.push(partial.status); }
    if (partial.confidence !== undefined) { sets.push('confidence = ?'); params.push(partial.confidence); }
    if (partial.importance !== undefined) { sets.push('importance = ?'); params.push(partial.importance); }

    params.push(id);
    this.db.transaction(() => {
      this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...params);

      if (changesEmbeddingInput) {
        const newContent = partial.content ?? existing.content;
        const newTags = partial.tags !== undefined ? JSON.stringify(partial.tags) : existing.tags;
        this.db.prepare('DELETE FROM memories_fts WHERE id = ?').run(id);
        this.db.prepare('INSERT INTO memories_fts (id, content, tags) VALUES (?, ?, ?)').run(id, newContent, newTags);
      }

      if (changesEmbeddingInput || changesLifecycle) {
        this.db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(id);
      }

      this.recordHistory(id, 'update', {
        oldContent: existing.content, oldStatus: existing.status,
        oldConfidence: existing.confidence, oldTags: existing.tags,
        newContent: partial.content, newStatus: partial.status,
      });
    })();

    const resultingStatus = partial.status ?? existing.status;
    if ((changesEmbeddingInput || changesLifecycle) && resultingStatus === 'active') {
      void this.indexMemoryBestEffort(id);
    }
    return true;
  }

  remove(id: string): boolean {
    const existing = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as RawMemoryRow | undefined;
    if (!existing) return false;

    this.db.transaction(() => {
      this.recordHistory(id, 'delete', { oldContent: existing.content, oldStatus: existing.status });
      this.db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(id);
      this.db.prepare('DELETE FROM memories_fts WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    })();
    return true;
  }

  supersede(oldId: string, newInput: SaveMemoryInput, reason?: string): string {
    const newId = genId();
    const timestamp = now();
    this.db.transaction(() => {
      this.insertMemory(newId, newInput, timestamp);
      this.db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(oldId);
      this.db.prepare("UPDATE memories SET status = 'superseded', supersededBy = ?, updated = ? WHERE id = ?")
        .run(newId, timestamp, oldId);
      this.recordHistory(oldId, 'supersede', { oldStatus: 'active', newStatus: 'superseded', reason });
    })();
    void this.indexMemoryBestEffort(newId);
    return newId;
  }

  stats(): { total: number; active: number; superseded: number; archived: number } {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) as active,
        COALESCE(SUM(CASE WHEN status = 'superseded' THEN 1 ELSE 0 END), 0) as superseded,
        COALESCE(SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END), 0) as archived
      FROM memories
    `).get() as { total: number; active: number; superseded: number; archived: number };
    return row;
  }

  history(memoryId: string): Array<{
    changeType: string; oldContent: string | null; newContent: string | null;
    changedAt: string; reason: string | null;
  }> {
    const rows = this.db.prepare(`
      SELECT change_type, old_content, new_content, changed_at, reason
      FROM memory_history WHERE memory_id = ? ORDER BY changed_at DESC
    `).all(memoryId) as Array<{
      change_type: string; old_content: string | null; new_content: string | null;
      changed_at: string; reason: string | null;
    }>;
    return rows.map(r => ({
      changeType: r.change_type, oldContent: r.old_content,
      newContent: r.new_content, changedAt: r.changed_at, reason: r.reason,
    }));
  }

  async getEmbeddingStatus(): Promise<MemoryEmbeddingStatus> {
    const health = await this.refreshEmbeddingHealth();
    const progress = this.embeddingProgress();
    this.reindexState = { ...this.reindexState, progress };
    return {
      health,
      reindex: cloneReindexState(this.reindexState),
    };
  }

  reindexEmbeddings(): Promise<EmbeddingReindexResult> {
    if (this.reindexPromise) return this.reindexPromise;

    const run = this.runReindexEmbeddings();
    this.reindexPromise = run;
    void run.then(
      () => { if (this.reindexPromise === run) this.reindexPromise = undefined; },
      () => { if (this.reindexPromise === run) this.reindexPromise = undefined; },
    );
    return run;
  }

  private insertMemory(id: string, input: SaveMemoryInput, timestamp: string): void {
    const tags = JSON.stringify(input.tags ?? []);
    this.db.prepare(`
      INSERT INTO memories (id, type, content, tags, confidence, importance, created, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.type, input.content, tags, input.confidence ?? 1.0, input.importance ?? 0.5, timestamp, timestamp);
    this.db.prepare(`
      INSERT INTO memories_fts (id, content, tags)
      VALUES (?, ?, ?)
    `).run(id, input.content, tags);
    this.recordHistory(id, 'create', { newContent: input.content, newStatus: 'active' });
  }

  private async indexMemoryBestEffort(id: string): Promise<boolean> {
    const identity = this.currentEmbeddingIdentity();
    const provider = this.embeddingProvider;
    if (!identity || !provider) return false;

    const row = this.db.prepare("SELECT * FROM memories WHERE id = ? AND status = 'active'").get(id) as RawMemoryRow | undefined;
    if (!row) return false;

    const input = embeddingInput(row);
    const contentHash = hashEmbeddingInput(input);
    try {
      const vector = await provider.embed(input);
      return this.upsertEmbedding(id, identity, contentHash, vector);
    } catch (error) {
      this.recordEmbeddingFailure(error);
      return false;
    }
  }

  private semanticResults(queryVector: readonly number[], identity: EmbeddingIdentity): SearchResult[] {
    const rows = this.db.prepare(`
      SELECT m.*, e.content_hash, e.dimensions, e.vector, e.model, e.model_revision, e.created as embedding_created
      FROM memories m
      JOIN memory_embeddings e ON e.memory_id = m.id
      WHERE m.status = 'active' AND e.model = ? AND e.model_revision = ?
    `).all(identity.model, identity.revision) as Array<RawMemoryRow & {
      content_hash: string; dimensions: number; vector: Buffer; model: string; model_revision: string; embedding_created: string;
    }>;

    const results: SearchResult[] = [];
    const incompatibleIds: string[] = [];
    for (const row of rows) {
      if (row.content_hash !== hashEmbeddingInput(embeddingInput(row))) continue;
      const vector = unpackVector(row.vector, row.dimensions);
      if (!vector) continue;
      if (vector.length !== queryVector.length) {
        incompatibleIds.push(row.id);
        continue;
      }
      const semanticScore = cosineSimilarity(queryVector, vector);
      if (semanticScore === undefined) continue;
      results.push({ ...this.toRecord(row), semanticScore });
    }

    // A same-identity dimension mismatch means the stored vector cannot ever be
    // compared with the live model output. Drop it so the next bounded reindex
    // treats the memory as pending instead of repeatedly skipping it forever.
    if (incompatibleIds.length > 0) {
      const remove = this.db.prepare(`
        DELETE FROM memory_embeddings
        WHERE memory_id = ? AND model = ? AND model_revision = ?
      `);
      this.db.transaction(() => {
        for (const id of incompatibleIds) remove.run(id, identity.model, identity.revision);
      })();
    }

    return results.sort((a, b) => {
      const score = (b.semanticScore ?? 0) - (a.semanticScore ?? 0);
      if (score !== 0) return score;
      return compareRecords(a, b);
    });
  }

  private async runReindexEmbeddings(): Promise<EmbeddingReindexResult> {
    const startedAt = now();
    this.lastEmbeddingError = undefined;
    this.reindexState = {
      status: 'running',
      startedAt,
      progress: this.embeddingProgress(),
    };

    let indexed = 0;
    let skipped = 0;
    let failed = 0;
    try {
      const health = await this.refreshEmbeddingHealth();
      const identity = this.currentEmbeddingIdentity();
      if (!health.ok || !identity || !this.embeddingProvider) {
        const message = health.message ?? 'Memory embeddings are not available for reindexing.';
        this.lastEmbeddingError = message;
        return this.finishReindex('failed', indexed, skipped, failed, message, startedAt);
      }

      let cursor = '';
      while (true) {
        const rows = this.db.prepare(`
          SELECT * FROM memories
          WHERE status = 'active' AND id > ?
          ORDER BY id ASC
          LIMIT ?
        `).all(cursor, this.backfillBatchSize) as RawMemoryRow[];
        if (rows.length === 0) break;
        cursor = rows[rows.length - 1].id;

        const candidates = rows.filter(row => this.needsEmbedding(row, identity));
        if (candidates.length === 0) {
          skipped += rows.length;
          continue;
        }

        const inputs = candidates.map(embeddingInput);
        let vectors: number[][];
        try {
          vectors = await this.embeddingProvider.embedMany(inputs);
          if (vectors.length !== candidates.length) {
            throw new Error(`Embedding provider returned ${vectors.length} vectors for ${candidates.length} memories.`);
          }
        } catch (error) {
          failed += candidates.length;
          this.recordEmbeddingFailure(error);
          this.reindexState = {
            ...this.reindexState,
            progress: this.embeddingProgress(failed),
          };
          continue;
        }

        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[index];
          try {
            const stored = this.upsertEmbedding(
              candidate.id,
              identity,
              hashEmbeddingInput(inputs[index]),
              vectors[index],
            );
            if (stored) indexed += 1;
            else skipped += 1;
          } catch (error) {
            failed += 1;
            this.recordEmbeddingFailure(error);
          }
        }
        this.reindexState = {
          ...this.reindexState,
          progress: this.embeddingProgress(failed),
        };
      }

      const status = failed > 0 ? 'failed' : 'completed';
      return this.finishReindex(status, indexed, skipped, failed, failed > 0 ? this.lastEmbeddingError : undefined, startedAt);
    } catch (error) {
      const message = errorMessage(error);
      this.recordEmbeddingFailure(error);
      return this.finishReindex('failed', indexed, skipped, failed, message, startedAt);
    }
  }

  private finishReindex(
    status: EmbeddingReindexState['status'],
    indexed: number,
    skipped: number,
    failed: number,
    message: string | undefined,
    startedAt: string,
  ): EmbeddingReindexResult {
    const progress = this.embeddingProgress(failed);
    this.reindexState = {
      status,
      startedAt,
      finishedAt: now(),
      progress,
      ...(message ? { message } : {}),
    };
    return { ...cloneReindexState(this.reindexState), indexed, skipped, failed };
  }

  private needsEmbedding(row: RawMemoryRow, identity: EmbeddingIdentity): boolean {
    const existing = this.db.prepare(`
      SELECT memory_id, model, model_revision, content_hash, dimensions, vector, created
      FROM memory_embeddings WHERE memory_id = ? AND model = ? AND model_revision = ?
    `).get(row.id, identity.model, identity.revision) as RawEmbeddingRow | undefined;
    return !existing
      || existing.content_hash !== hashEmbeddingInput(embeddingInput(row))
      || !unpackVector(existing.vector, existing.dimensions);
  }

  private upsertEmbedding(
    memoryId: string,
    identity: EmbeddingIdentity,
    contentHash: string,
    vector: readonly number[],
  ): boolean {
    const packed = packVector(vector);
    const current = this.db.prepare("SELECT * FROM memories WHERE id = ? AND status = 'active'").get(memoryId) as RawMemoryRow | undefined;
    if (!current || hashEmbeddingInput(embeddingInput(current)) !== contentHash) return false;

    this.db.prepare(`
      INSERT INTO memory_embeddings (memory_id, model, model_revision, content_hash, dimensions, vector, created)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_id, model, model_revision) DO UPDATE SET
        content_hash = excluded.content_hash,
        dimensions = excluded.dimensions,
        vector = excluded.vector,
        created = excluded.created
    `).run(memoryId, identity.model, identity.revision, contentHash, vector.length, packed, now());
    return true;
  }

  private async refreshEmbeddingHealth(): Promise<EmbeddingHealth> {
    const provider = this.embeddingProvider;
    if (!provider) return disabledHealth();

    try {
      const health = await provider.health();
      this.lastEmbeddingHealth = health;
      if (health.ok) this.modelRevision = health.modelRevision;
      return health;
    } catch (error) {
      const message = errorMessage(error);
      this.recordEmbeddingFailure(error);
      return {
        provider: 'ollama',
        enabled: provider.enabled,
        model: provider.model,
        baseUrl: '',
        ok: false,
        status: provider.enabled ? 'protocol-error' : 'disabled',
        installedModels: [],
        message,
      };
    }
  }

  private currentEmbeddingIdentity(): EmbeddingIdentity | null {
    const provider = this.embeddingProvider;
    if (!provider?.enabled || !provider.model) return null;
    return { model: provider.model, revision: this.modelRevision ?? '' };
  }

  private embeddingProgress(failed = this.reindexState.progress.failed): EmbeddingIndexProgress {
    const identity = this.currentEmbeddingIdentity();
    const activeRows = this.db.prepare("SELECT * FROM memories WHERE status = 'active'").all() as RawMemoryRow[];
    if (!identity) {
      return { active: activeRows.length, indexed: 0, pending: 0, stale: 0, failed };
    }

    const embeddings = this.db.prepare(`
      SELECT memory_id, model, model_revision, content_hash, dimensions, vector, created FROM memory_embeddings
    `).all() as RawEmbeddingRow[];
    const current = new Map<string, RawEmbeddingRow>();
    const anyEmbedding = new Set<string>();
    for (const embedding of embeddings) {
      anyEmbedding.add(embedding.memory_id);
      if (embedding.model === identity.model && embedding.model_revision === identity.revision) {
        current.set(embedding.memory_id, embedding);
      }
    }

    let indexed = 0;
    let pending = 0;
    let stale = 0;
    for (const row of activeRows) {
      const embedding = current.get(row.id);
      const valid = embedding
        && embedding.content_hash === hashEmbeddingInput(embeddingInput(row))
        && unpackVector(embedding.vector, embedding.dimensions);
      if (valid) indexed += 1;
      else if (anyEmbedding.has(row.id)) stale += 1;
      else pending += 1;
    }

    return {
      active: activeRows.length,
      indexed,
      pending,
      stale,
      failed,
      model: identity.model,
      ...(this.modelRevision ? { modelRevision: this.modelRevision } : {}),
      ...(this.lastEmbeddingError ? { lastError: this.lastEmbeddingError } : {}),
    };
  }

  private recordHistory(memoryId: string, changeType: string, data: {
    oldContent?: string | null; oldStatus?: string | null; oldConfidence?: number | null;
    oldTags?: string | null; newContent?: string | null; newStatus?: string | null; reason?: string | null;
  }): void {
    this.db.prepare(`
      INSERT INTO memory_history (memory_id, change_type, old_content, old_status, old_confidence, old_tags, new_content, new_status, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(memoryId, changeType, data.oldContent ?? null, data.oldStatus ?? null,
      data.oldConfidence ?? null, data.oldTags ?? null, data.newContent ?? null,
      data.newStatus ?? null, data.reason ?? null);
  }

  private toRecord(row: RawMemoryRow): MemoryRecord {
    return {
      id: row.id, type: row.type, content: row.content,
      tags: JSON.parse(row.tags),
      status: row.status as 'active' | 'superseded' | 'archived',
      confidence: row.confidence, importance: row.importance,
      accessCount: row.accessCount, created: row.created,
      updated: row.updated, supersededBy: row.supersededBy,
    };
  }

  private recordEmbeddingFailure(error: unknown): void {
    this.lastEmbeddingError = errorMessage(error);
  }
}

function normalizeContent(content: string): string {
  return content.toLowerCase().replace(/\s+/g, ' ').trim();
}

function embeddingInput(row: Pick<RawMemoryRow, 'content' | 'tags'>): string {
  const tags = parseTags(row.tags);
  return `Content: ${row.content}\nTags: ${tags.join(', ')}`;
}

function hashEmbeddingInput(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function parseTags(tags: string): string[] {
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) && parsed.every(tag => typeof tag === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

function packVector(vector: readonly number[]): Buffer {
  validateVector(vector);
  const packed = Buffer.allocUnsafe(vector.length * 4);
  for (let index = 0; index < vector.length; index += 1) {
    packed.writeFloatLE(vector[index], index * 4);
  }
  return packed;
}

function unpackVector(value: unknown, dimensions: number): number[] | null {
  if (!Number.isInteger(dimensions) || dimensions < 1 || !Buffer.isBuffer(value) || value.length !== dimensions * 4) {
    return null;
  }
  const vector: number[] = [];
  for (let index = 0; index < dimensions; index += 1) {
    vector.push(value.readFloatLE(index * 4));
  }
  try {
    validateVector(vector);
    return vector;
  } catch {
    return null;
  }
}

function validateVector(vector: readonly number[]): void {
  if (vector.length === 0 || !vector.every(value => Number.isFinite(value)) || vectorNorm(vector) === 0) {
    throw new Error('Embedding vector must contain finite values with a nonzero norm.');
  }
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number | undefined {
  if (left.length !== right.length) return undefined;
  const leftNorm = vectorNorm(left);
  const rightNorm = vectorNorm(right);
  if (leftNorm === 0 || rightNorm === 0) return undefined;

  let score = 0;
  for (let index = 0; index < left.length; index += 1) {
    score += (left[index] / leftNorm) * (right[index] / rightNorm);
  }
  return Number.isFinite(score) ? score : undefined;
}

function vectorNorm(vector: readonly number[]): number {
  let scale = 0;
  let sum = 1;
  for (const value of vector) {
    const absolute = Math.abs(value);
    if (absolute === 0) continue;
    if (scale < absolute) {
      sum = 1 + sum * (scale / absolute) ** 2;
      scale = absolute;
    } else {
      sum += (absolute / scale) ** 2;
    }
  }
  return scale === 0 ? 0 : scale * Math.sqrt(sum);
}

function fuseResults(lexical: SearchResult[], semantic: SearchResult[], limit: number): SearchResult[] {
  const fused = new Map<string, { result: SearchResult; score: number }>();
  const add = (results: SearchResult[]) => {
    results.forEach((result, index) => {
      const existing = fused.get(result.id);
      const score = (existing?.score ?? 0) + 1 / (RRF_K + index + 1);
      fused.set(result.id, { result: { ...existing?.result, ...result }, score });
    });
  };

  add(lexical);
  add(semantic);
  return [...fused.values()]
    .sort((left, right) => {
      const score = right.score - left.score;
      return score !== 0 ? score : compareRecords(left.result, right.result);
    })
    .slice(0, limit)
    .map(entry => entry.result);
}

/** Positive when `left` was created after `right`; ties break on id for determinism. */
function compareCreated(left: Pick<RawMemoryRow, 'created' | 'id'>, right: Pick<RawMemoryRow, 'created' | 'id'>): number {
  const created = left.created.localeCompare(right.created);
  return created !== 0 ? created : left.id.localeCompare(right.id);
}

function compareRecords(left: Pick<MemoryRecord, 'updated' | 'id'>, right: Pick<MemoryRecord, 'updated' | 'id'>): number {
  const updated = right.updated.localeCompare(left.updated);
  return updated !== 0 ? updated : left.id.localeCompare(right.id);
}

function cloneReindexState(state: EmbeddingReindexState): EmbeddingReindexState {
  return {
    ...state,
    progress: { ...state.progress },
  };
}

function disabledHealth(): EmbeddingHealth {
  return {
    provider: 'ollama',
    enabled: false,
    baseUrl: '',
    ok: false,
    status: 'disabled',
    installedModels: [],
    message: 'Memory embeddings are disabled; memory recall uses local FTS only.',
  };
}

function clampBatchSize(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(100, Math.floor(value))) : 16;
}

function clampChatRetrievalLimit(value: number): number {
  if (!Number.isFinite(value)) return 5;
  return Math.max(1, Math.min(MAX_CHAT_RETRIEVAL_LIMIT, Math.floor(value)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
