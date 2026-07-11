import { z } from 'zod';
import type { EmbeddingHealth, ForgeConfig, ToolDef } from '../../types.ts';
import type { ToolRegistry } from './registry.ts';
import type { MemoryService } from '../memory.ts';
import type { RagService } from '../rag/rag.ts';
import type { ReminderService } from '../scheduler/reminders.ts';
import type { SttService } from '../voice/stt.ts';
import type { TtsService } from '../voice/tts.ts';
import type { IdentityModelContextResult } from '../identity-files.ts';
import { checkToolPermission, isLevelEnabled } from './permissions.ts';
import { resolveAttachmentsDir } from '../attachments.ts';

/** A backend reachability probe may take this long before counting as down. */
const PROBE_TIMEOUT_MS = 1500;

/** Resolves true when an HTTP request to the url gets any response at all. */
export type ProbeUrl = (url: string, timeoutMs: number) => Promise<boolean>;

/**
 * Lists the model tags installed on an Ollama server, or null when the
 * server cannot be reached. Injectable so config-only tests stay offline.
 */
export type ListModels = (baseUrl: string, timeoutMs: number) => Promise<string[] | null>;

export interface GetStatusToolDeps {
  config: ForgeConfig;
  registry: ToolRegistry;
  memory: MemoryService;
  rag?: Pick<RagService, 'list'>;
  reminders?: Pick<ReminderService, 'listPending'>;
  stt?: Pick<SttService, 'status'>;
  tts?: Pick<TtsService, 'status'>;
  embeddingHealth?: () => Promise<EmbeddingHealth>;
  probeUrl?: ProbeUrl;
  listModels?: ListModels;
  /** Builds the budget-capped identity context, for truncation diagnostics. */
  identityContext?: () => IdentityModelContextResult;
}

/**
 * Read-only self-inspection (permission 'safe'): reports the live config
 * toggles, every registered tool with its call-time permission decision, and
 * small data counts. Everything is read fresh at call time, so the answer
 * tracks config changes; a broken subsystem degrades a count to 0 instead of
 * failing the call. The diagnostics section explains WHY anything unavailable
 * is blocked — the same reason strings the permission gate emits, plus
 * allowlist, missing-config, and backend-reachability findings.
 */
export function createGetStatusTool(deps: GetStatusToolDeps): ToolDef {
  return {
    name: 'get_status',
    description: 'Report your own live status: enabled features, every available tool with whether it is currently allowed, counts of memories, documents, reminders, and scheduled jobs, and a diagnostics section explaining exactly why anything unavailable is blocked (which config switch is off, which allowlist is empty, which backend is unreachable). This is the authoritative answer to "what can you do right now" and "why is this not working" — call it instead of guessing about your capabilities or configuration.',
    permission: 'safe',
    params: z.object({}),
    handler: async () => {
      const { config } = deps;

      const assistant: Record<string, unknown> = {
        name: config.forge.name,
        version: config.forge.version,
        model: config.llm.model,
      };
      const numCtx = config.llm.ollama.options?.num_ctx;
      if (typeof numCtx === 'number' && Number.isFinite(numCtx)) {
        assistant.context_tokens = numCtx;
      }

      const features = {
        tools_enabled: config.tools?.enabled === true,
        levels: {
          safe: config.tools?.levels?.safe === true,
          network: config.tools?.levels?.network === true,
          filesystem: config.tools?.levels?.filesystem === true,
          sensitive: config.tools?.levels?.sensitive === true,
        },
        rag: config.rag?.enabled === true,
        memory_auto: config.memory.auto?.enabled === true,
        memory_summary: config.memory.summary?.enabled === true,
        voice_stt: config.voice?.stt?.enabled === true,
        voice_tts: config.voice?.tts?.enabled === true,
        imagegen: config.imagegen?.enabled === true,
        vision: config.vision?.enabled === true,
        telegram: config.channels?.telegram?.enabled === true,
        scheduler: config.scheduler?.enabled === true,
      };

      const tools = deps.registry.list().map(tool => ({
        name: tool.name,
        permission: tool.permission,
        allowed: checkToolPermission(config, tool).allowed,
      }));

      const counts = {
        active_memories: safeCount(() => deps.memory.stats().active),
        documents: safeCount(() => deps.rag?.list().length ?? 0),
        pending_reminders: safeCount(() => deps.reminders?.listPending().length ?? 0),
        scheduled_jobs: safeCount(() => config.scheduler?.jobs?.length ?? 0),
      };

      const diagnostics = await collectDiagnostics(deps);

      return { assistant, features, tools, counts, diagnostics };
    },
  };
}

/**
 * Map of tool/feature name -> blocker messages. Only blocked or degraded
 * entries appear; a fully healthy setup yields {}. Backend probes run only
 * for tools that are otherwise allowed AND have a configured URL, so plain
 * config-fixture tests never touch the network.
 */
async function collectDiagnostics(deps: GetStatusToolDeps): Promise<Record<string, string[]>> {
  const { config } = deps;
  const out: Record<string, string[]> = {};
  const add = (key: string, message: string): void => {
    (out[key] ??= []).push(message);
  };

  // Per-tool permission gating: surface the exact reasons the gate would give.
  for (const tool of deps.registry.list()) {
    const decision = checkToolPermission(config, tool);
    if (!decision.allowed && decision.reason) add(tool.name, decision.reason);
  }

  // The image tool is not even registered while imagegen is off, so the
  // per-tool pass above cannot see it; explain the absence explicitly.
  if (config.imagegen?.enabled !== true) {
    add('generate_image', 'Image generation is disabled (imagegen.enabled is false).');
  }
  // Same conditional-registration pattern for the vision tool.
  if (config.vision?.enabled !== true) {
    add('analyze_image', 'Image analysis is disabled (vision.enabled is false).');
  }

  // Filesystem tools pass the level gate but still deny every path while the
  // allowlist is empty; same wording as the isPathAllowed denial. An enabled
  // telegram attachments dir counts as an implicit readable root.
  if (
    isLevelEnabled(config, 'filesystem')
    && (config.tools?.filesystem?.readable_dirs?.length ?? 0) === 0
    && resolveAttachmentsDir(config) === undefined
  ) {
    for (const name of ['read_file', 'list_dir', 'analyze_image']) {
      if (deps.registry.has(name)) add(name, 'No readable directories are allowlisted (tools.filesystem).');
    }
  }

  // Telegram attachments: a download only pays off if analyze_image can then
  // read the file; surface every broken link in that chain.
  if (config.channels?.telegram?.attachments?.enabled === true) {
    if (config.channels.telegram.enabled !== true) {
      add('telegram_attachments', 'Attachments are enabled but the Telegram channel is off (channels.telegram.enabled is false).');
    }
    if (config.vision?.enabled !== true) {
      add('telegram_attachments', 'Downloaded images cannot be analyzed: vision.enabled is false (analyze_image is not registered).');
    }
    if (!isLevelEnabled(config, 'filesystem')) {
      add('telegram_attachments', "Downloaded images cannot be read: the 'filesystem' tool level is disabled (tools.enabled / tools.levels.filesystem).");
    }
  }

  // Backend reachability, in parallel and bounded by PROBE_TIMEOUT_MS.
  const probes: Array<Promise<void>> = [];
  const reachable = async (url: string): Promise<boolean> => {
    try {
      return await (deps.probeUrl ?? defaultProbeUrl)(url, PROBE_TIMEOUT_MS);
    } catch {
      return false;
    }
  };
  const searxngUrl = config.search?.searxng_url;
  if (searxngUrl && deps.registry.has('web_search') && !out.web_search) {
    probes.push(reachable(searxngUrl).then(ok => {
      if (!ok) add('web_search', `SearXNG is not reachable at ${searxngUrl}. Is the container running?`);
    }));
  }
  const imageUrl = config.imagegen?.base_url;
  if (imageUrl && config.imagegen?.enabled === true && deps.registry.has('generate_image') && !out.generate_image) {
    probes.push(reachable(imageUrl).then(ok => {
      if (!ok) add('generate_image', `Image backend is not reachable at ${imageUrl}. Is the SD WebUI running with --api?`);
    }));
  }
  // Vision: confirm the configured model is actually pulled on Ollama. A
  // missing model would otherwise surface only as a 404 at call time.
  const visionModel = config.vision?.model;
  if (visionModel && config.vision?.enabled === true && deps.registry.has('analyze_image') && !out.analyze_image) {
    const ollamaUrl = config.llm.ollama.base_url;
    probes.push((deps.listModels ?? defaultListModels)(ollamaUrl, PROBE_TIMEOUT_MS).then(models => {
      if (models === null) {
        add('analyze_image', `Ollama is not reachable at ${ollamaUrl}.`);
      } else if (!models.includes(visionModel) && !models.includes(`${visionModel}:latest`)) {
        add('analyze_image', `Vision model '${visionModel}' is not pulled. Run: ollama pull ${visionModel}`);
      }
    }).catch(() => { /* a broken probe is not a diagnostic finding */ }));
  }

  // Identity context vs its token budget: truncation is a working state, not
  // an error, but it means the model is seeing an incomplete identity.
  if (deps.identityContext) {
    try {
      const identity = deps.identityContext();
      if (identity.truncated) {
        const affected = identity.files
          .filter(file => file.status !== 'full')
          .map(file => `${file.name} (${file.status})`)
          .join(', ');
        add(
          'identity',
          `Identity files need ~${identity.neededTokens} tokens but the identity budget is ${identity.budgetTokens ?? 0}; ` +
          `cut lowest-priority-first: ${affected}. ` +
          'Trim identity files (NOTES.md grows from reflection), raise identity.budget.share, or raise llm.ollama.options.num_ctx.',
        );
      }
    } catch {
      // A broken identity read is not a diagnostic finding.
    }
  }

  // Embedding backend health: recall quality and the RAG dependency.
  if (config.memory.embeddings?.enabled !== true) {
    add('memory_embeddings', 'Memory embeddings are disabled (memory.embeddings.enabled is false); memory recall is keyword-only.');
  } else if (deps.embeddingHealth) {
    probes.push(deps.embeddingHealth().then(health => {
      if (health.status !== 'online') {
        add('memory_embeddings', health.message ?? `Embedding backend status: ${health.status}.`);
      }
    }).catch(err => {
      add('memory_embeddings', err instanceof Error ? err.message : String(err));
    }));
  }
  if (config.rag?.enabled === true && config.memory.embeddings?.enabled !== true) {
    add('rag', 'Document RAG requires memory.embeddings.enabled, which is false.');
  }

  // Voice: enabled-but-misconfigured states carry a ready-made message.
  const stt = deps.stt?.status();
  if (stt && stt.enabled && !stt.configured && stt.message) add('voice_stt', stt.message);
  const tts = deps.tts?.status();
  if (tts && tts.enabled && !tts.configured && tts.message) add('voice_tts', tts.message);

  // Telegram: enabled but unable to start or unable to admit anyone.
  const telegram = config.channels?.telegram;
  if (telegram?.enabled === true) {
    const token = telegram.token ?? (telegram.token_env ? process.env[telegram.token_env] : undefined);
    if (!token) {
      add('telegram', `Telegram bot token is missing (environment variable ${telegram.token_env} is not set).`);
    }
    if ((telegram.allowed_chat_ids?.length ?? 0) === 0) {
      add('telegram', 'No chat ids are allowlisted (channels.telegram.allowed_chat_ids is empty), so nobody can reach the bot.');
    }
  }

  // Scheduler: on, but with nothing to run.
  if (config.scheduler?.enabled === true && (config.scheduler.jobs?.length ?? 0) === 0) {
    add('scheduler', 'Scheduler is enabled but scheduler.jobs is empty; nothing will run.');
  }

  await Promise.all(probes);
  return out;
}

async function defaultListModels(baseUrl: string, timeoutMs: number): Promise<string[] | null> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const body = await response.json() as { models?: Array<{ name?: unknown }> };
    return (body.models ?? [])
      .map(model => typeof model.name === 'string' ? model.name : '')
      .filter(name => name.length > 0);
  } catch {
    return null;
  }
}

async function defaultProbeUrl(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    // Any HTTP response (even 4xx/5xx) proves the backend is reachable.
    void response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

function safeCount(read: () => number): number {
  try {
    const value = read();
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}
