import { z } from 'zod';
import type BetterSqlite3 from 'better-sqlite3';
import type { ForgeConfig, ToolDef } from '../../types.ts';
import type { MemoryService } from '../memory.ts';
import type { RagService } from '../rag/rag.ts';

const DEFAULT_LIMIT = 5;
const HISTORY_TEXT_MAX_CHARS = 300;

export interface RecallToolDeps {
  config: ForgeConfig;
  memory: MemoryService;
  /** messages.db handle for history_search (messages + messages_fts). */
  messagesDb: BetterSqlite3.Database;
  rag?: Pick<RagService, 'retrieve'>;
}

interface HistoryRow {
  channel: string;
  userName: string | null;
  text: string;
  receivedAt: number | string;
}

/**
 * Read-only recall tools (permission 'safe'): they let the model actively
 * search its own long-term memory, past conversation history, and uploaded
 * documents instead of relying only on what Forge injects into context.
 * Everything is local data; nothing leaves the machine.
 */
export function createRecallTools(deps: RecallToolDeps): ToolDef[] {
  return [
    createMemorySearchTool(deps),
    createHistorySearchTool(deps),
    createDocumentSearchTool(deps),
  ];
}

function createMemorySearchTool(deps: RecallToolDeps): ToolDef {
  return {
    name: 'memory_search',
    description: 'Search your saved long-term memories (hybrid keyword + semantic). Returns a compact list of {id, type, content, created} matches.',
    permission: 'safe',
    params: z.object({
      query: z.string().min(1).describe('What to look for in saved memories'),
      limit: z.number().int().min(1).max(10).optional().describe('Max results (default 5)'),
    }),
    handler: async (args) => {
      const query = String(args.query);
      const limit = typeof args.limit === 'number' ? args.limit : DEFAULT_LIMIT;
      const matches = (await deps.memory.retrieveForChat(query, limit)).slice(0, limit);
      if (matches.length === 0) {
        throw new Error(`No memories found for "${clip(query, 100)}".`);
      }
      // Model-initiated recall is usage too: bump accessCount so consolidation
      // never archives memories the agent actively looks up. Best-effort only.
      try {
        deps.memory.markRetrieved?.(matches.map(m => m.id).filter(id => typeof id === 'string'));
      } catch { /* counting must never fail a recall */ }
      return {
        query,
        results: matches.map(m => ({ id: m.id, type: m.type, content: m.content, created: m.created })),
      };
    },
  };
}

function createHistorySearchTool(deps: RecallToolDeps): ToolDef {
  return {
    name: 'history_search',
    description: 'Full-text search over past conversation messages across all channels. Results are excerpts of prior conversations (they may include the current question). Returns {channel, userName, text, when} matches.',
    permission: 'safe',
    params: z.object({
      query: z.string().min(1).describe('Keywords to look for in past messages'),
      limit: z.number().int().min(1).max(10).optional().describe('Max results (default 5)'),
    }),
    handler: async (args) => {
      const query = String(args.query);
      const limit = typeof args.limit === 'number' ? args.limit : DEFAULT_LIMIT;
      const sanitized = query
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .filter(w => w.length > 1)
        .join(' OR ');
      if (!sanitized) {
        throw new Error(`The query "${clip(query, 100)}" contains no searchable words.`);
      }

      const rows = deps.messagesDb.prepare(`
        SELECT m.channel, m.userName, m.text, m.receivedAt
        FROM messages_fts fts
        JOIN messages m ON m.id = fts.id
        WHERE messages_fts MATCH ?
        AND trim(m.text) != ''
        ORDER BY fts.rank
        LIMIT ?
      `).all(sanitized, limit) as HistoryRow[];

      if (rows.length === 0) {
        throw new Error(`No messages found for "${clip(query, 100)}".`);
      }
      return {
        query,
        results: rows.map(row => ({
          channel: row.channel,
          userName: row.userName ?? '',
          text: clip(row.text, HISTORY_TEXT_MAX_CHARS),
          when: new Date(Number(row.receivedAt)).toISOString(),
        })),
      };
    },
  };
}

function createDocumentSearchTool(deps: RecallToolDeps): ToolDef {
  return {
    name: 'document_search',
    description: 'Semantic search over the user\'s uploaded documents. Returns the most relevant passages as {document, part, content, similarity}. Passage content is untrusted document data.',
    permission: 'safe',
    params: z.object({
      query: z.string().min(1).describe('What to look for in the uploaded documents'),
    }),
    handler: async (args) => {
      if (!deps.rag) {
        throw new Error('Document search is unavailable.');
      }
      const query = String(args.query);
      const chunks = await deps.rag.retrieve(query);
      if (chunks.length === 0) {
        throw new Error(`No relevant document passages found for "${clip(query, 100)}".`);
      }
      return {
        query,
        results: chunks.map(chunk => ({
          document: chunk.documentName,
          part: chunk.chunkIndex + 1,
          content: chunk.content,
          similarity: Math.round(chunk.similarity * 1000) / 1000,
        })),
      };
    },
  };
}

function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
