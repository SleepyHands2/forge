import { Router } from 'express';
import type { WebContext } from '../server.ts';

const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 100;

interface CaptureRow {
  id: number;
  memory_id: string | null;
  action: string;
  content: string;
  reason: string | null;
  similarity: number | null;
  duplicate_of: string | null;
  source_message_id: string | null;
  source_preview: string;
  created_at: string;
}

/**
 * Memory review API: list memories (with capture source for auto-captured
 * ones), prune wrong ones, and inspect the raw capture log so a small model's
 * extraction mistakes are easy to catch.
 */
export function memoriesRoutes(ctx: WebContext): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const limit = parseLimit(req.query.limit, DEFAULT_LIST_LIMIT);
    if (limit === null) {
      res.status(400).json({ error: `limit must be an integer between 1 and ${MAX_LIST_LIMIT}` });
      return;
    }
    const source = req.query.source;
    if (source !== undefined && source !== 'auto' && source !== 'manual') {
      res.status(400).json({ error: 'source must be auto or manual' });
      return;
    }

    let memories = ctx.memory.list({ status: 'active', limit: MAX_LIST_LIMIT });
    if (source === 'auto') memories = memories.filter(m => m.tags.includes('auto'));
    if (source === 'manual') memories = memories.filter(m => !m.tags.includes('auto'));
    memories = memories.slice(0, limit);

    const captures = loadCapturesByMemoryId(ctx, memories.map(m => m.id));
    res.json({
      memories: memories.map(memory => {
        const capture = captures.get(memory.id);
        return {
          id: memory.id,
          type: memory.type,
          content: memory.content,
          tags: memory.tags,
          created: memory.created,
          source: memory.tags.includes('auto') ? 'auto' : 'manual',
          ...(capture ? {
            capture: {
              sourceMessageId: capture.source_message_id,
              sourcePreview: capture.source_preview,
              reason: capture.reason,
              capturedAt: capture.created_at,
            },
          } : {}),
        };
      }),
      autoCapture: {
        enabled: ctx.config.memory.auto?.enabled === true,
      },
    });
  });

  router.get('/captures', (req, res) => {
    const limit = parseLimit(req.query.limit, 50);
    if (limit === null) {
      res.status(400).json({ error: `limit must be an integer between 1 and ${MAX_LIST_LIMIT}` });
      return;
    }
    const db = ctx.dbManager.get('memory');
    const rows = db.prepare(`
      SELECT * FROM memory_captures ORDER BY id DESC LIMIT ?
    `).all(limit) as CaptureRow[];

    res.json({
      captures: rows.map(row => ({
        id: row.id,
        memoryId: row.memory_id,
        action: row.action,
        content: row.content,
        reason: row.reason,
        similarity: row.similarity,
        duplicateOf: row.duplicate_of,
        sourceMessageId: row.source_message_id,
        sourcePreview: row.source_preview,
        createdAt: row.created_at,
      })),
    });
  });

  router.delete('/:id', (req, res) => {
    const id = req.params.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      res.status(400).json({ error: 'memory id is required' });
      return;
    }
    const removed = ctx.memory.remove(id);
    if (!removed) {
      res.status(404).json({ error: 'Memory not found' });
      return;
    }
    res.json({ removed: true, id });
  });

  return router;
}

function loadCapturesByMemoryId(ctx: WebContext, memoryIds: string[]): Map<string, CaptureRow> {
  const captures = new Map<string, CaptureRow>();
  if (memoryIds.length === 0) return captures;

  const db = ctx.dbManager.get('memory');
  const placeholders = memoryIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT * FROM memory_captures
    WHERE action = 'created' AND memory_id IN (${placeholders})
    ORDER BY id ASC
  `).all(...memoryIds) as CaptureRow[];
  for (const row of rows) {
    if (row.memory_id) captures.set(row.memory_id, row);
  }
  return captures;
}

function parseLimit(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= MAX_LIST_LIMIT ? parsed : null;
}
