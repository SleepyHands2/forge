import { Router } from 'express';
import type { WebContext } from '../server.ts';
import { saveConfigBoolean, saveIdentityReflectionEnabled } from '../../config.ts';

export interface FeatureToggleDefinition {
  path: string;
  label: string;
  hint: string;
  restartRequired: boolean;
}

/**
 * The only config booleans the web UI may flip. Single source of truth for
 * the GET/PATCH /api/settings/toggles routes; anything outside this list is
 * rejected with a 400.
 */
export const FEATURE_TOGGLES: readonly FeatureToggleDefinition[] = [
  {
    path: 'tools.enabled',
    label: 'Tool system',
    hint: 'Master switch for the agent tool loop',
    restartRequired: false,
  },
  {
    path: 'tools.levels.safe',
    label: 'Safe tools',
    hint: 'Low-risk read-only tools with no side effects',
    restartRequired: false,
  },
  {
    path: 'tools.levels.network',
    label: 'Network tools',
    hint: 'Tools that reach the network: web_search, fetch_url, generate_image',
    restartRequired: false,
  },
  {
    path: 'tools.levels.filesystem',
    label: 'Filesystem tools',
    hint: 'Read-only read_file / list_dir, bound by the readable_dirs allowlist',
    restartRequired: false,
  },
  {
    path: 'tools.levels.sensitive',
    label: 'Sensitive tools',
    hint: 'Highest-risk tool level; keep off unless a tool requires it',
    restartRequired: false,
  },
  {
    path: 'memory.auto.enabled',
    label: 'Automatic memory capture',
    hint: 'Extract and save memories automatically after each chat turn',
    restartRequired: false,
  },
  {
    path: 'rag.enabled',
    label: 'Document retrieval (RAG)',
    hint: 'Retrieve uploaded document chunks into chat context',
    restartRequired: false,
  },
  {
    path: 'voice.stt.enabled',
    label: 'Voice input (whisper.cpp)',
    hint: 'Transcribe microphone input locally with whisper.cpp',
    restartRequired: false,
  },
  {
    path: 'voice.tts.enabled',
    label: 'Voice output (Piper)',
    hint: 'Speak replies locally with Piper',
    restartRequired: false,
  },
  {
    path: 'imagegen.enabled',
    label: 'Image generation',
    hint: 'Enabling from off requires a restart (tool registration happens at boot); disabling applies immediately',
    restartRequired: true,
  },
  {
    path: 'vision.enabled',
    label: 'Image analysis (vision)',
    hint: 'Analyze/OCR images with a local vision model; enabling from off requires a restart (tool registration happens at boot)',
    restartRequired: true,
  },
  {
    path: 'channels.telegram.enabled',
    label: 'Telegram bridge',
    hint: 'Bridge chats to a Telegram bot; the bridge starts at boot',
    restartRequired: true,
  },
  {
    path: 'scheduler.enabled',
    label: 'Scheduler',
    hint: 'Unattended scheduled agent turns; the scheduler starts at boot',
    restartRequired: true,
  },
];

function readConfigBoolean(config: WebContext['config'], dotPath: string): boolean {
  let node: unknown = config;
  for (const segment of dotPath.split('.')) {
    if (!node || typeof node !== 'object') return false;
    node = (node as Record<string, unknown>)[segment];
  }
  return node === true;
}

interface MemoryPolicy {
  retentionDays: number;
  contextWindowTokens: number;
}

interface IdentityReflectionSettings {
  enabled: boolean;
  cadenceTurns: number;
  recentNotesInContext: number;
}

interface EmbeddingSettings {
  configuration: {
    enabled: boolean;
    model: string | null;
    baseUrl: string;
  };
  health: Awaited<ReturnType<WebContext['memory']['getEmbeddingStatus']>>['health'];
  index: Awaited<ReturnType<WebContext['memory']['getEmbeddingStatus']>>['reindex']['progress'];
  reindex: Awaited<ReturnType<WebContext['memory']['getEmbeddingStatus']>>['reindex'];
}

function memoryPolicy(ctx: WebContext): MemoryPolicy {
  return {
    retentionDays: ctx.config.memory.retention_days,
    contextWindowTokens: ctx.config.services.web.context_window_tokens,
  };
}

function identityReflection(ctx: WebContext): IdentityReflectionSettings {
  const reflection = ctx.config.identity?.reflection;
  return {
    enabled: reflection?.enabled ?? false,
    cadenceTurns: reflection?.cadence_turns ?? 1,
    recentNotesInContext: reflection?.recent_notes_in_context ?? 5,
  };
}

function embeddingSettings(
  ctx: WebContext,
  status: Awaited<ReturnType<WebContext['memory']['getEmbeddingStatus']>>,
): EmbeddingSettings {
  const config = ctx.config.memory.embeddings;
  return {
    configuration: {
      enabled: config?.enabled === true,
      model: config?.model ?? null,
      baseUrl: status.health.baseUrl || ctx.config.llm.ollama.base_url,
    },
    health: status.health,
    index: status.reindex.progress,
    reindex: status.reindex,
  };
}

export function settingsRoutes(ctx: WebContext): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const [llm, embeddingStatus] = await Promise.all([
      ctx.llm.health(),
      ctx.memory.getEmbeddingStatus(),
    ]);
    const dbHealth = ctx.dbManager.health();

    res.json({
      info: {
        name: ctx.config.forge.name,
        version: ctx.config.forge.version,
        root: ctx.config.forge.root,
        localModel: ctx.config.llm.model,
        memory: {
          ...memoryPolicy(ctx),
          embeddings: embeddingSettings(ctx, embeddingStatus),
        },
        identity: {
          reflection: identityReflection(ctx),
        },
        databases: dbHealth,
        llm,
      },
    });
  });

  router.get('/toggles', (_req, res) => {
    res.json({
      toggles: FEATURE_TOGGLES.map(toggle => ({
        ...toggle,
        enabled: readConfigBoolean(ctx.config, toggle.path),
      })),
    });
  });

  router.patch('/toggles', (req, res) => {
    const patch = parseTogglePatch(req.body);
    if (!patch) {
      res.status(400).json({ error: 'Expected { path: string, enabled: boolean }' });
      return;
    }

    const toggle = FEATURE_TOGGLES.find(t => t.path === patch.path);
    if (!toggle) {
      res.status(400).json({ error: `Unknown toggle path: ${patch.path}` });
      return;
    }

    try {
      const saved = saveConfigBoolean(toggle.path, patch.enabled, ctx.configPath);
      // Graft the changed top-level block onto the route's config too: in
      // production ctx.config is the cached root object saveConfigBoolean
      // already updated, but tests construct a separate ctx (mirrors how the
      // identity reflection PATCH assigns ctx.config.identity).
      const top = toggle.path.split('.')[0];
      (ctx.config as Record<string, unknown>)[top] = (saved as unknown as Record<string, unknown>)[top];
      res.json({ path: toggle.path, enabled: patch.enabled, restartRequired: toggle.restartRequired });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not save feature toggle';
      res.status(500).json({ error: message });
    }
  });

  router.patch('/identity/reflection', (req, res) => {
    const patch = parseReflectionPatch(req.body);
    if (!patch) {
      res.status(400).json({ error: 'Expected { enabled: boolean }' });
      return;
    }

    try {
      const saved = saveIdentityReflectionEnabled(patch.enabled, ctx.configPath);
      ctx.config.identity = saved.identity;
      res.json({
        identity: {
          reflection: identityReflection(ctx),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not save identity reflection settings';
      res.status(500).json({ error: message });
    }
  });

  router.post('/memory/embeddings/reindex', async (req, res) => {
    if (!isEmptyObject(req.body)) {
      res.status(400).json({ error: 'Expected an empty JSON object.' });
      return;
    }

    const initial = await ctx.memory.getEmbeddingStatus();
    if (!initial.health.enabled || !initial.health.model) {
      res.status(409).json({
        error: 'Memory embeddings are disabled or missing a configured model.',
        embeddings: embeddingSettings(ctx, initial),
      });
      return;
    }

    if (initial.reindex.status === 'running') {
      res.status(202).json({
        reindex: initial.reindex,
        alreadyRunning: true,
      });
      return;
    }

    const reindex = await ctx.memory.reindexEmbeddings();
    res.json({ reindex, alreadyRunning: false });
  });

  return router;
}

function parseTogglePatch(body: unknown): { path: string; enabled: boolean } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body).sort();
  if (keys.length !== 2 || keys[0] !== 'enabled' || keys[1] !== 'path') return null;
  const { path, enabled } = body as { path?: unknown; enabled?: unknown };
  if (typeof path !== 'string' || typeof enabled !== 'boolean') return null;
  return { path, enabled };
}

function parseReflectionPatch(body: unknown): { enabled: boolean } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'enabled') return null;
  const enabled = (body as { enabled?: unknown }).enabled;
  return typeof enabled === 'boolean' ? { enabled } : null;
}

function isEmptyObject(body: unknown): boolean {
  return body === undefined
    || (typeof body === 'object' && body !== null && !Array.isArray(body) && Object.keys(body).length === 0);
}
