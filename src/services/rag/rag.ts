import crypto from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type { ForgeConfig } from '../../types.ts';
import type { EmbeddingProvider } from '../ollama-embeddings.ts';
import { chunkCsv, chunkText, estimateTokens, type TextChunk } from './chunker.ts';
import { extractText, documentTypeFromName, type DocumentType } from './extract.ts';
import { cosineSimilarity, packVector, unpackVector, validateVector } from './vectors.ts';

type Database = BetterSqlite3.Database;

const EMBED_BATCH_SIZE = 16;

export interface DocumentRecord {
  id: string;
  name: string;
  type: DocumentType;
  size: number;
  chunkCount: number;
  status: 'ready' | 'failed';
  error: string | null;
  created: string;
}

export interface RetrievedChunk {
  documentId: string;
  documentName: string;
  chunkIndex: number;
  content: string;
  similarity: number;
  tokenEstimate: number;
}

export interface RagServiceOptions {
  db: Database;
  config: ForgeConfig;
  embeddings?: EmbeddingProvider;
}

interface DocumentRow {
  id: string; name: string; type: DocumentType; size: number;
  chunk_count: number; status: 'ready' | 'failed'; error: string | null; created: string;
}

interface ChunkRow {
  id: string; document_id: string; chunk_index: number; content: string;
  token_estimate: number; embedding_model: string | null; dimensions: number | null; vector: Buffer | null;
}

/**
 * Local document RAG: uploads are chunked, embedded with the same local
 * embedding model as memory, and stored in documents.db. Retrieval embeds the
 * query, ranks chunks by cosine similarity, and returns a token-capped top-k
 * so injection can never blow the 8 GB context budget. All failures degrade
 * to "no chunks" — retrieval must never break chat.
 */
export class RagService {
  private readonly db: Database;
  private readonly config: ForgeConfig;
  private readonly embeddings?: EmbeddingProvider;

  constructor(options: RagServiceOptions) {
    this.db = options.db;
    this.config = options.config;
    this.embeddings = options.embeddings;
  }

  async ingest(input: { name: string; data: Buffer }): Promise<DocumentRecord> {
    const type = documentTypeFromName(input.name);
    if (!type) throw new Error('Unsupported document type; use .pdf, .md, .txt, or .csv');

    const id = crypto.randomUUID();
    const created = new Date().toISOString();
    const base = { id, name: input.name, type, size: input.data.length, created };

    if (this.embeddings?.enabled !== true || !this.embeddings.model) {
      return this.storeFailed(base, 'Document RAG requires memory.embeddings to be enabled.');
    }

    let text: string;
    try {
      text = await extractText(type, input.data);
    } catch (error) {
      return this.storeFailed(base, `Text extraction failed: ${message(error)}`);
    }

    const chunkOptions = {
      chunkTokens: this.config.rag?.chunk_tokens ?? 400,
      overlapTokens: this.config.rag?.chunk_overlap_tokens ?? 50,
    };
    const chunks = type === 'csv' ? chunkCsv(text, chunkOptions) : chunkText(text, chunkOptions);
    if (chunks.length === 0) {
      return this.storeFailed(base, 'No extractable text found in the document.');
    }

    let vectors: number[][];
    try {
      vectors = await this.embedInBatches(chunks);
    } catch (error) {
      return this.storeFailed(base, `Embedding failed: ${message(error)}`);
    }

    const model = this.embeddings.model;
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO documents (id, name, type, size, chunk_count, status, error, created)
        VALUES (?, ?, ?, ?, ?, 'ready', NULL, ?)
      `).run(id, base.name, type, base.size, chunks.length, created);

      const insertChunk = this.db.prepare(`
        INSERT INTO document_chunks (id, document_id, chunk_index, content, token_estimate, embedding_model, dimensions, vector, created)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (let index = 0; index < chunks.length; index += 1) {
        insertChunk.run(
          crypto.randomUUID(),
          id,
          index,
          chunks[index].content,
          chunks[index].tokenEstimate,
          model,
          vectors[index].length,
          packVector(vectors[index]),
          created,
        );
      }
    })();

    return { ...base, chunkCount: chunks.length, status: 'ready', error: null };
  }

  /**
   * Embed the query and return the highest-similarity chunks, filtered by
   * min_similarity, limited to top_k, then capped by cumulative token budget.
   * Returns [] on any failure or when RAG is disabled.
   */
  async retrieve(query: string): Promise<RetrievedChunk[]> {
    const rag = this.config.rag;
    if (rag?.enabled !== true) return [];
    const provider = this.embeddings;
    if (provider?.enabled !== true || !provider.model || !query.trim()) return [];

    let queryVector: number[];
    try {
      queryVector = await provider.embed(query);
      validateVector(queryVector);
    } catch {
      return [];
    }

    const rows = this.db.prepare(`
      SELECT c.*, d.name AS document_name
      FROM document_chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE d.status = 'ready' AND c.embedding_model = ? AND c.vector IS NOT NULL
    `).all(provider.model) as Array<ChunkRow & { document_name: string }>;

    const minSimilarity = rag.min_similarity ?? 0.35;
    const scored: RetrievedChunk[] = [];
    for (const row of rows) {
      const vector = row.dimensions === null ? null : unpackVector(row.vector, row.dimensions);
      if (!vector) continue;
      const similarity = cosineSimilarity(queryVector, vector);
      if (similarity === undefined || similarity < minSimilarity) continue;
      scored.push({
        documentId: row.document_id,
        documentName: row.document_name,
        chunkIndex: row.chunk_index,
        content: row.content,
        similarity,
        tokenEstimate: row.token_estimate,
      });
    }

    scored.sort((a, b) => b.similarity - a.similarity
      || a.documentId.localeCompare(b.documentId)
      || a.chunkIndex - b.chunkIndex);

    const topK = scored.slice(0, rag.top_k ?? 4);
    return capByTokenBudget(topK, rag.max_context_tokens ?? 1500);
  }

  list(): DocumentRecord[] {
    const rows = this.db.prepare('SELECT * FROM documents ORDER BY created DESC').all() as DocumentRow[];
    return rows.map(toRecord);
  }

  get(id: string): DocumentRecord | null {
    const row = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow | undefined;
    return row ? toRecord(row) : null;
  }

  remove(id: string): boolean {
    const existing = this.db.prepare('SELECT id FROM documents WHERE id = ?').get(id);
    if (!existing) return false;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM document_chunks WHERE document_id = ?').run(id);
      this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
    })();
    return true;
  }

  private async embedInBatches(chunks: TextChunk[]): Promise<number[][]> {
    const provider = this.embeddings;
    if (!provider) throw new Error('Embedding provider unavailable.');
    const vectors: number[][] = [];
    for (let start = 0; start < chunks.length; start += EMBED_BATCH_SIZE) {
      const batch = chunks.slice(start, start + EMBED_BATCH_SIZE);
      const embedded = await provider.embedMany(batch.map(chunk => chunk.content));
      if (embedded.length !== batch.length) {
        throw new Error(`Embedding provider returned ${embedded.length} vectors for ${batch.length} chunks.`);
      }
      for (const vector of embedded) validateVector(vector);
      vectors.push(...embedded);
    }
    return vectors;
  }

  private storeFailed(
    base: { id: string; name: string; type: DocumentType; size: number; created: string },
    error: string,
  ): DocumentRecord {
    this.db.prepare(`
      INSERT INTO documents (id, name, type, size, chunk_count, status, error, created)
      VALUES (?, ?, ?, ?, 0, 'failed', ?, ?)
    `).run(base.id, base.name, base.type, base.size, error, base.created);
    return { ...base, chunkCount: 0, status: 'failed', error };
  }
}

/**
 * Keep chunks while the cumulative token estimate fits the cap. The first
 * chunk is always included, truncated if it alone exceeds the budget, so a
 * strong match on a large chunk still contributes.
 */
function capByTokenBudget(chunks: RetrievedChunk[], maxTokens: number): RetrievedChunk[] {
  const result: RetrievedChunk[] = [];
  let used = 0;
  for (const chunk of chunks) {
    if (result.length === 0 && chunk.tokenEstimate > maxTokens) {
      const content = truncateToTokens(chunk.content, maxTokens);
      result.push({ ...chunk, content, tokenEstimate: estimateTokens(content) });
      break;
    }
    if (used + chunk.tokenEstimate > maxTokens) break;
    result.push(chunk);
    used += chunk.tokenEstimate;
  }
  return result;
}

function truncateToTokens(content: string, maxTokens: number): string {
  const maxChars = Math.max(1, maxTokens * 3);
  return content.length <= maxChars ? content : `${content.slice(0, maxChars)}…`;
}

function toRecord(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    size: row.size,
    chunkCount: row.chunk_count,
    status: row.status,
    error: row.error,
    created: row.created,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
