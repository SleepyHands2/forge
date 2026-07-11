import { Router } from 'express';
import type { Request, Response } from 'express';
import type { WebContext } from '../server.ts';
import { ChatContextTooLargeError } from '../../services/chat-history.ts';
import { ChatTurnService, type CompletedTurn } from '../../services/chat-turn.ts';

const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_BYTES = 128 * 1024;
const MAX_ATTACHMENT_CHARS = 20_000;
const MAX_IMAGE_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_ATTACHMENT_TOTAL_BYTES = 4 * 1024 * 1024;

export function messagesRoutes(ctx: WebContext): Router {
  const router = Router();
  // All chat logic lives in the shared ChatTurnService; this route adds only
  // web concerns: body/attachment validation, SSE, and response shaping.
  // Constructed per turn so the db handle is resolved exactly when the
  // original inline code resolved it.
  const makeTurns = (): ChatTurnService => new ChatTurnService({
    config: ctx.config,
    db: ctx.dbManager.get('messages'),
    memory: ctx.memory,
    llm: ctx.llm,
    agent: ctx.agent,
    rag: ctx.rag,
    identityReflection: ctx.identityReflection,
    memoryCapture: ctx.memoryCapture,
    summary: ctx.conversationSummary,
    readIdentity: ctx.readIdentity,
  });

  router.get('/poll', (req, res) => {
    const parsed = parsePollQuery(req.query);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { since, limit } = parsed;
    const db = ctx.dbManager.get('messages');

    let rows;
    if (since !== undefined) {
      rows = db.prepare(`
        SELECT * FROM messages
        WHERE receivedAt > ?
        ORDER BY receivedAt ASC
        LIMIT ?
      `).all(since, limit);
    } else {
      rows = db.prepare(`
        SELECT * FROM messages
        ORDER BY receivedAt DESC
        LIMIT ?
      `).all(limit).reverse();
    }

    res.json({
      messages: rows,
      agentName: ctx.config.forge.name,
      ui: {
        contextWindowTokens: ctx.config.services.web.context_window_tokens,
      },
    });
  });

  router.post('/', async (req, res) => {
    if (req.query.attachments !== undefined) {
      res.status(400).json({ error: 'attachments must be provided in the JSON body' });
      return;
    }

    const body = req.body;
    if (!isPlainRecord(body)) {
      res.status(400).json({ error: 'body must be a JSON object' });
      return;
    }
    if (!hasOnlyKeys(body, ['attachments', 'content'])) {
      res.status(400).json({ error: 'body must include only content and attachments' });
      return;
    }

    const { content } = body;
    if (typeof content !== 'string' || content.trim().length === 0) {
      res.status(400).json({ error: 'content must be a non-empty string' });
      return;
    }

    const attachments = parseAttachments(body.attachments);
    if (!attachments.ok) {
      res.status(400).json({ error: attachments.error });
      return;
    }

    try {
      const turns = makeTurns();
      const llmUserContent = formatLlmUserContent(content, attachments.value);
      const images = attachments.value
        .filter((attachment): attachment is ImageAttachment => attachment.kind === 'image')
        .map(attachment => attachment.data);

      const prepared = await turns.prepare({
        channel: 'web',
        channelName: 'web',
        userName: ctx.config.user.name,
        content,
        llmContent: llmUserContent,
        images,
        attachmentsMeta: attachments.value.map(toAttachmentMetadata),
        interfaceLabel: 'Web Chat',
      });

      if (prepared.kind === 'command') {
        const commandBody = {
          reply: prepared.reply,
          ts: prepared.replyTs,
          agentName: ctx.config.forge.name,
          memoryId: prepared.memoryId,
        };
        if (wantsEventStream(req)) {
          startEventStream(res);
          writeEvent(res, 'done', commandBody);
          res.end();
        } else {
          res.json(commandBody);
        }
        return;
      }

      if (!wantsEventStream(req)) {
        const done = await turns.complete(prepared);
        res.json(buildResponseBody(ctx, done));
        return;
      }

      // Streaming path: headers go out before the model responds, so failures
      // from here on are reported as SSE error events, not HTTP status codes.
      // (prepare() already ran, so context-too-large still returned a 413.)
      startEventStream(res);
      const abort = new AbortController();
      let upstreamSettled = false;
      res.on('close', () => {
        if (!upstreamSettled) abort.abort();
      });

      let done: CompletedTurn;
      try {
        // Agent turns are not token-streamed: tool rounds happen between
        // completions, so the reply arrives whole in the final done event.
        done = await turns.complete(prepared, {
          signal: abort.signal,
          onToken: (token) => {
            if (!res.writableEnded) writeEvent(res, 'token', { text: token });
          },
        });
      } catch (err) {
        upstreamSettled = true;
        if (abort.signal.aborted) {
          console.warn('[web] Chat stream client disconnected; Ollama request aborted.');
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[web] Chat stream error:', msg);
        if (!res.writableEnded) {
          writeEvent(res, 'error', { error: msg });
          res.end();
        }
        return;
      }
      upstreamSettled = true;

      if (!res.writableEnded) {
        writeEvent(res, 'done', buildResponseBody(ctx, done));
        res.end();
      }
    } catch (err) {
      if (res.headersSent) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[web] Chat error after stream start:', msg);
        if (!res.writableEnded) {
          writeEvent(res, 'error', { error: msg });
          res.end();
        }
        return;
      }
      if (err instanceof ChatContextTooLargeError) {
        res.status(413).json({ error: err.message });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[web] Chat error:', msg);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}

function wantsEventStream(req: Request): boolean {
  const accept = req.headers.accept;
  return typeof accept === 'string' && accept.includes('text/event-stream');
}

function startEventStream(res: Response): void {
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
}

function writeEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function buildResponseBody(ctx: WebContext, done: CompletedTurn): Record<string, unknown> {
  const body: Record<string, unknown> = {
    reply: done.reply,
    provider: done.response.provider,
    model: done.response.model,
    ts: done.replyTs,
    agentName: ctx.config.forge.name,
    usage: { input: done.response.inputTokens, output: done.response.outputTokens },
  };
  if (done.sources.length > 0) body.sources = done.sources;
  body.context = done.context;
  if (done.promptContext) body.prompt_context = done.promptContext;
  return body;
}

interface TextAttachment {
  kind: 'text';
  name: string;
  type: string;
  size: number;
  content: string;
  extension: '.txt' | '.md' | '.json' | '.csv';
}

interface ImageAttachment {
  kind: 'image';
  name: string;
  type: string;
  size: number;
  data: string;
  extension: '.jpg' | '.jpeg' | '.png' | '.gif' | '.tif' | '.tiff';
  bytes: number;
}

type Attachment = TextAttachment | ImageAttachment;

type AttachmentResult =
  | { ok: true; value: Attachment[] }
  | { ok: false; error: string };

const MIME_ALLOWLIST: Record<TextAttachment['extension'], Set<string>> = {
  '.txt': new Set(['text/plain', 'text/*', 'application/octet-stream']),
  '.md': new Set(['text/markdown', 'text/x-markdown', 'text/plain', 'text/*', 'application/octet-stream']),
  '.json': new Set(['application/json', 'text/json', 'text/plain', 'text/*', 'application/octet-stream']),
  '.csv': new Set(['text/csv', 'application/csv', 'text/plain', 'text/*', 'application/octet-stream']),
};

const IMAGE_MIME_ALLOWLIST: Record<ImageAttachment['extension'], string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

function parseAttachments(value: unknown): AttachmentResult {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: 'attachments must be an array' };
  if (value.length > MAX_ATTACHMENTS) {
    return { ok: false, error: `attachments must include at most ${MAX_ATTACHMENTS} files` };
  }

  const attachments: Attachment[] = [];
  let totalChars = 0;
  let totalImageBytes = 0;

  for (const item of value) {
    if (!isPlainRecord(item)) return { ok: false, error: 'attachment must be an object' };
    const kind = item.kind === undefined ? 'text' : item.kind;
    if (kind !== 'text' && kind !== 'image') {
      return { ok: false, error: 'attachment kind must be text or image' };
    }

    const keys = Object.keys(item).sort();
    const expectedKeys = kind === 'text'
      ? (item.kind === undefined ? 'content,name,size,type' : 'content,kind,name,size,type')
      : 'data,kind,name,size,type';
    if (keys.join(',') !== expectedKeys) {
      return { ok: false, error: kind === 'text' ? 'text attachment must include only kind, name, type, size, and content' : 'image attachment must include only kind, name, type, size, and data' };
    }

    const { name, type, size } = item;
    if (typeof name !== 'string' || name.trim().length === 0) {
      return { ok: false, error: 'attachment name must be a non-empty string' };
    }
    if (name.includes('/') || name.includes('\\')) {
      return { ok: false, error: 'attachment name must be a file name' };
    }
    if (typeof type !== 'string') {
      return { ok: false, error: 'attachment type must be a string' };
    }
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      return { ok: false, error: 'attachment size must be a non-negative integer' };
    }

    if (kind === 'image') {
      const { data } = item;
      if (typeof data !== 'string') {
        return { ok: false, error: 'image attachment data must be a base64 string' };
      }

      const extension = getSupportedImageExtension(name);
      if (!extension) {
        return { ok: false, error: 'image attachment type is unsupported; use .jpg, .jpeg, .png, .gif, .tif, or .tiff' };
      }
      if (!isImageMimeAllowed(extension, type)) {
        return { ok: false, error: 'image attachment MIME type is unsupported for its extension' };
      }

      const decoded = decodeBase64(data);
      if (!decoded) {
        return { ok: false, error: 'image attachment data must be valid base64' };
      }
      if (!hasImageMagicBytes(extension, decoded)) {
        return { ok: false, error: 'image attachment data does not match its extension' };
      }
      if (decoded.length > MAX_IMAGE_ATTACHMENT_BYTES) {
        return { ok: false, error: `image attachment exceeds ${MAX_IMAGE_ATTACHMENT_BYTES} bytes` };
      }
      totalImageBytes += decoded.length;
      if (totalImageBytes > MAX_IMAGE_ATTACHMENT_TOTAL_BYTES) {
        return { ok: false, error: `image attachments exceed ${MAX_IMAGE_ATTACHMENT_TOTAL_BYTES} bytes` };
      }
      if (size !== decoded.length) {
        return { ok: false, error: 'attachment size must match decoded byte length' };
      }

      attachments.push({ kind: 'image', name, type, size, data, extension, bytes: decoded.length });
      continue;
    }

    const { content } = item;
    if (typeof content !== 'string') {
      return { ok: false, error: 'attachment content must be a string' };
    }

    const extension = getSupportedExtension(name);
    if (!extension) {
      return { ok: false, error: 'attachment type is unsupported; use .txt, .md, .json, or .csv' };
    }
    if (!isMimeAllowed(extension, type)) {
      return { ok: false, error: 'attachment MIME type is unsupported for its extension' };
    }

    const byteLength = Buffer.byteLength(content, 'utf8');
    if (size > MAX_ATTACHMENT_BYTES || byteLength > MAX_ATTACHMENT_BYTES) {
      return { ok: false, error: `attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes` };
    }
    if (size !== byteLength) {
      return { ok: false, error: 'attachment size must match content byte length' };
    }

    totalChars += content.length;
    if (totalChars > MAX_ATTACHMENT_CHARS) {
      return { ok: false, error: `attachments exceed ${MAX_ATTACHMENT_CHARS} characters` };
    }

    attachments.push({ kind: 'text', name, type, size, content, extension });
  }

  return { ok: true, value: attachments };
}

function getSupportedExtension(name: string): TextAttachment['extension'] | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.txt')) return '.txt';
  if (lower.endsWith('.md')) return '.md';
  if (lower.endsWith('.json')) return '.json';
  if (lower.endsWith('.csv')) return '.csv';
  return null;
}

function getSupportedImageExtension(name: string): ImageAttachment['extension'] | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.jpg')) return '.jpg';
  if (lower.endsWith('.jpeg')) return '.jpeg';
  if (lower.endsWith('.png')) return '.png';
  if (lower.endsWith('.gif')) return '.gif';
  if (lower.endsWith('.tif')) return '.tif';
  if (lower.endsWith('.tiff')) return '.tiff';
  return null;
}

function isMimeAllowed(extension: TextAttachment['extension'], type: string): boolean {
  const normalized = type.split(';', 1)[0].trim().toLowerCase();
  return normalized.length > 0 && MIME_ALLOWLIST[extension].has(normalized);
}

function isImageMimeAllowed(extension: ImageAttachment['extension'], type: string): boolean {
  const normalized = type.split(';', 1)[0].trim().toLowerCase();
  return normalized === IMAGE_MIME_ALLOWLIST[extension] || normalized === '' || normalized === 'application/octet-stream';
}

function decodeBase64(value: string): Buffer | null {
  if (value.length === 0 || value.startsWith('data:') || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return null;
  }
  try {
    return Buffer.from(value, 'base64');
  } catch {
    return null;
  }
}

function hasImageMagicBytes(extension: ImageAttachment['extension'], data: Buffer): boolean {
  if (extension === '.jpg' || extension === '.jpeg') {
    return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  }
  if (extension === '.png') {
    return data.length >= 8
      && data[0] === 0x89
      && data[1] === 0x50
      && data[2] === 0x4e
      && data[3] === 0x47
      && data[4] === 0x0d
      && data[5] === 0x0a
      && data[6] === 0x1a
      && data[7] === 0x0a;
  }
  if (extension === '.gif') {
    return data.length >= 6
      && data[0] === 0x47
      && data[1] === 0x49
      && data[2] === 0x46
      && data[3] === 0x38
      && (data[4] === 0x37 || data[4] === 0x39)
      && data[5] === 0x61;
  }
  return data.length >= 4
    && ((data[0] === 0x49 && data[1] === 0x49 && data[2] === 0x2a && data[3] === 0x00)
      || (data[0] === 0x4d && data[1] === 0x4d && data[2] === 0x00 && data[3] === 0x2a));
}

function formatLlmUserContent(content: string, attachments: Attachment[]): string {
  const textAttachments = attachments.filter((attachment): attachment is TextAttachment => attachment.kind === 'text');
  if (textAttachments.length === 0) return content;

  const sections = [content, '\n\n## Attachments'];
  textAttachments.forEach((attachment, index) => {
    sections.push([
      `\n### Attachment ${index + 1}: ${attachment.name}`,
      `Type: ${attachment.type || 'unknown'}`,
      `Size: ${attachment.size} bytes`,
      'Content:',
      '```',
      attachment.content,
      '```',
    ].join('\n'));
  });
  return sections.join('\n');
}

function toAttachmentMetadata(attachment: Attachment): Record<string, unknown> {
  if (attachment.kind === 'image') {
    return {
      kind: attachment.kind,
      name: attachment.name,
      type: attachment.type,
      size: attachment.size,
      extension: attachment.extension,
      bytes: attachment.bytes,
    };
  }
  return {
    kind: attachment.kind,
    name: attachment.name,
    type: attachment.type,
    size: attachment.size,
    extension: attachment.extension,
    chars: attachment.content.length,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

type PollQueryResult =
  | { ok: true; since?: number; limit: number }
  | { ok: false; error: string };

function parsePollQuery(query: Record<string, unknown>): PollQueryResult {
  const sinceValue = query.since;
  const limitValue = query.limit;

  if (sinceValue !== undefined) {
    const since = parseNonNegativeInteger(sinceValue);
    if (since === null) return { ok: false, error: 'since must be a non-negative integer' };

    const limit = parseLimit(limitValue);
    if (limit === null) return { ok: false, error: 'limit must be an integer between 1 and 500' };
    return { ok: true, since, limit };
  }

  const limit = parseLimit(limitValue);
  if (limit === null) return { ok: false, error: 'limit must be an integer between 1 and 500' };
  return { ok: true, limit };
}

function parseLimit(value: unknown): number | null {
  if (value === undefined) return 200;
  const parsed = parsePositiveInteger(value);
  if (parsed === null) return null;
  return Math.min(parsed, 500);
}

function parseNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parsePositiveInteger(value: unknown): number | null {
  const parsed = parseNonNegativeInteger(value);
  return parsed !== null && parsed >= 1 ? parsed : null;
}
