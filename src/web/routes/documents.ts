import { Router } from 'express';
import type { WebContext } from '../server.ts';
import { documentTypeFromName } from '../../services/rag/extract.ts';

const MAX_PDF_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/**
 * Document management for RAG: upload (base64 JSON body), list, delete.
 * Ingestion runs synchronously — chunking and local embedding for a typical
 * document take a few seconds at most on CPU.
 */
export function documentsRoutes(ctx: WebContext): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    if (!ctx.rag) {
      res.json({ documents: [], rag: { enabled: false } });
      return;
    }
    res.json({
      documents: ctx.rag.list(),
      rag: { enabled: ctx.config.rag?.enabled === true },
    });
  });

  router.post('/', async (req, res) => {
    if (!ctx.rag) {
      res.status(503).json({ error: 'Document RAG is not available.' });
      return;
    }

    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'body must be a JSON object' });
      return;
    }
    const { name, data } = body as { name?: unknown; data?: unknown };

    if (typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'name must be a non-empty string' });
      return;
    }
    if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
      res.status(400).json({ error: 'name must be a file name' });
      return;
    }
    const type = documentTypeFromName(name);
    if (!type) {
      res.status(400).json({ error: 'Unsupported document type; use .pdf, .md, .txt, or .csv' });
      return;
    }
    if (typeof data !== 'string' || data.length === 0) {
      res.status(400).json({ error: 'data must be a base64 string' });
      return;
    }

    const decoded = decodeBase64(data);
    if (!decoded) {
      res.status(400).json({ error: 'data must be valid base64' });
      return;
    }
    const maxBytes = type === 'pdf' ? MAX_PDF_BYTES : MAX_TEXT_BYTES;
    if (decoded.length > maxBytes) {
      res.status(400).json({ error: `document exceeds ${maxBytes} bytes` });
      return;
    }

    try {
      const record = await ctx.rag.ingest({ name: name.trim(), data: decoded });
      res.json({ document: record });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.delete('/:id', (req, res) => {
    if (!ctx.rag) {
      res.status(503).json({ error: 'Document RAG is not available.' });
      return;
    }
    const removed = ctx.rag.remove(req.params.id);
    if (!removed) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    res.json({ removed: true, id: req.params.id });
  });

  return router;
}

function decodeBase64(value: string): Buffer | null {
  if (value.startsWith('data:') || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return null;
  }
  try {
    return Buffer.from(value, 'base64');
  } catch {
    return null;
  }
}
