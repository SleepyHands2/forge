import { Router } from 'express';
import type { WebContext } from '../server.ts';
import type { ProposalStatus } from '../../services/identity-files.ts';

const DEFAULT_EVENT_LIMIT = 25;
const MAX_EVENT_LIMIT = 100;
const PROPOSAL_STATUSES = new Set(['pending', 'approved', 'rejected', 'all']);

export function identityRoutes(ctx: Pick<WebContext, 'identityFiles'>): Router {
  const router = Router();
  const service = ctx.identityFiles;

  router.get('/', (_req, res) => {
    try {
      res.json({
        files: service.readAllFiles(),
        proposals: service.listProposals('pending'),
        events: service.listEvents(DEFAULT_EVENT_LIMIT),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/proposals', (req, res) => {
    try {
      const status = parseProposalStatus(req.query.status);
      res.json({ proposals: service.listProposals(status) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/proposals/:id/approve', (req, res) => {
    try {
      const edit = parseApprovalEdit(req.body);
      const result = service.approveProposal(req.params.id, edit);
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/proposals/:id/reject', (req, res) => {
    try {
      res.json(service.rejectProposal(req.params.id));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/events', (req, res) => {
    try {
      const limit = parseEventLimit(req.query.limit);
      res.json({ events: service.listEvents(limit) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/:filename', (req, res) => {
    try {
      const { content } = req.body;
      if (typeof content !== 'string') {
        res.status(400).json({ error: 'content required' });
        return;
      }

      res.json({ ok: true, file: service.writeManualFile(req.params.filename, content) });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}

function parseProposalStatus(value: unknown): ProposalStatus | 'all' {
  if (value === undefined) return 'pending';
  if (typeof value !== 'string' || !PROPOSAL_STATUSES.has(value)) {
    throw new Error('Invalid proposal status');
  }
  return value as ProposalStatus | 'all';
}

function parseApprovalEdit(body: unknown): { content?: string } | undefined {
  if (!body || typeof body !== 'object' || !('content' in body)) return undefined;
  const content = (body as { content?: unknown }).content;
  if (content === undefined) return undefined;
  if (typeof content !== 'string') throw new Error('content must be a string');
  return { content };
}

function parseEventLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_EVENT_LIMIT;
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error('Invalid event limit');
  const limit = Number(raw);
  if (!Number.isInteger(limit)) throw new Error('Invalid event limit');
  return Math.min(MAX_EVENT_LIMIT, Math.max(1, limit));
}

function sendError(res: { status: (code: number) => { json: (body: unknown) => void } }, error: unknown): void {
  const message = error instanceof Error ? error.message : 'Unexpected identity error';
  const status = statusForError(message);
  res.status(status).json({ error: status === 500 ? 'Unexpected identity error' : message });
}

function statusForError(message: string): number {
  if (message.includes('not found')) return 404;
  if (
    message.includes('Invalid')
    || message.includes('required')
    || message.includes('must')
    || message.includes('cannot')
    || message.includes('exceeds')
    || message.includes('allowlisted')
    || message.includes('supported')
    || message.includes('Maximum pending')
    || message.includes('Rejected identity proposal')
    || message.includes('Approved identity proposal')
  ) {
    return 400;
  }
  return 500;
}
