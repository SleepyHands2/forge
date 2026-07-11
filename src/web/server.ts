import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ForgeConfig, ResolvedPaths } from '../types.ts';
import type { DatabaseManager } from '../db/manager.ts';
import type { MemoryService } from '../services/memory.ts';
import type { LLMService } from '../services/llm.ts';
import type { IdentityFileService } from '../services/identity-files.ts';
import type { IdentityReflectionService } from '../services/identity-reflection.ts';
import type { AgentService } from '../services/agent.ts';
import type { MemoryCaptureService } from '../services/memory-capture.ts';
import type { ConversationSummaryService } from '../services/conversation-summary.ts';
import type { RagService } from '../services/rag/rag.ts';
import type { SttService } from '../services/voice/stt.ts';
import type { TtsService } from '../services/voice/tts.ts';
import { settingsRoutes } from './routes/settings.ts';
import { messagesRoutes } from './routes/messages.ts';
import { identityRoutes } from './routes/identity.ts';
import { memoriesRoutes } from './routes/memories.ts';
import { documentsRoutes } from './routes/documents.ts';
import { voiceRoutes } from './routes/voice.ts';
import { activityRoutes } from './routes/activity.ts';

const COOKIE_NAME = 'forge_session';

export interface WebContext {
  configPath?: string;
  config: ForgeConfig;
  dbManager: DatabaseManager;
  memory: MemoryService;
  llm: LLMService;
  authToken: string;
  identity: string;
  identityDir: string;
  identityFiles: IdentityFileService;
  identityReflection?: Pick<IdentityReflectionService, 'reflectAfterAssistantReply'>;
  /** Agent loop for tool-enabled turns; chat falls back to plain llm.complete when absent or tools are disabled. */
  agent?: Pick<AgentService, 'runTurn'>;
  /** Automatic memory capture; queued after each completed LLM turn when memory.auto.enabled is true. */
  memoryCapture?: Pick<MemoryCaptureService, 'captureAfterAssistantReply'>;
  /** Rolling conversation summary; read at prepare and updated after turns whose history overflowed, when memory.summary.enabled is true. */
  conversationSummary?: Pick<ConversationSummaryService, 'getSummary' | 'updateAfterTurn'>;
  /** Document RAG: ingestion, retrieval, and management. */
  rag?: Pick<RagService, 'ingest' | 'retrieve' | 'list' | 'get' | 'remove'>;
  /** Local CPU voice I/O: whisper.cpp transcription and Piper synthesis. */
  voice?: {
    stt: Pick<SttService, 'transcribe' | 'status'>;
    tts: Pick<TtsService, 'synthesize' | 'status'>;
  };
  readIdentity: () => string;
  resolved: ResolvedPaths;
}

function extractToken(req: express.Request): string | null {
  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  const cookies = parseCookies(req.headers.cookie ?? '');
  return cookies[COOKIE_NAME] ?? null;
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const [key, ...vals] = pair.trim().split('=');
    if (key) cookies[key.trim()] = decodeURIComponent(vals.join('='));
  }
  return cookies;
}

function isTokenValid(supplied: string | null, expected: string): boolean {
  if (!supplied) return false;
  const a = Buffer.from(supplied, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function createWebServer(ctx: WebContext): express.Express {
  const app = express();
  app.use(express.json({ limit: '8mb' }));

  const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
  app.use(express.static(publicDir));

  app.get('/api/public/info', (_req, res) => {
    res.json({
      name: ctx.config.forge.name,
      version: ctx.config.forge.version,
      memory: {
        retentionDays: ctx.config.memory.retention_days,
        contextWindowTokens: ctx.config.services.web.context_window_tokens,
      },
    });
  });

  const authMiddleware: express.RequestHandler = (req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) {
      return next();
    }
    if (req.path === '/api/auth/login') return next();

    const token = extractToken(req);
    if (!isTokenValid(token, ctx.authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };

  app.use(authMiddleware);

  app.post('/api/auth/login', (req, res) => {
    const { token } = req.body;
    if (!isTokenValid(token, ctx.authToken)) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const attrs = [
      `${COOKIE_NAME}=${encodeURIComponent(token)}`,
      'HttpOnly', 'Path=/', 'SameSite=Strict', 'Max-Age=31536000',
    ];
    if (isSecure) attrs.push('Secure');
    res.setHeader('Set-Cookie', attrs.join('; '));
    res.json({ ok: true });
  });

  app.use('/api/settings', settingsRoutes(ctx));
  app.use('/api/messages', messagesRoutes(ctx));
  app.use('/api/identity', identityRoutes(ctx));
  app.use('/api/memories', memoriesRoutes(ctx));
  app.use('/api/documents', documentsRoutes(ctx));
  app.use('/api/voice', voiceRoutes(ctx));
  app.use('/api/activity', activityRoutes(ctx));

  // Generated images (written by the generate_image tool). Same-origin cookie
  // auth covers <img> tags; the filename pattern blocks traversal.
  app.get('/api/images/:name', (req, res) => {
    const name = req.params.name;
    if (!/^[A-Za-z0-9_-]+\.png$/.test(name)) {
      res.status(400).json({ error: 'invalid image name' });
      return;
    }
    res.sendFile(path.join(ctx.resolved.images, name), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Image not found' });
    });
  });

  app.get('*', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  return app;
}
