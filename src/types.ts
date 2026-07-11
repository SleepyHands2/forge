import { z } from 'zod';

const IdentityConfigSchema = z.object({
  reflection: z.object({
    enabled: z.boolean().default(false),
    cadence_turns: z.number().int().safe().positive().default(1),
    recent_notes_in_context: z.number().int().min(0).max(10).default(5),
  }).default({}),
  budget: z.object({
    // Identity's maximum share of the prompt token budget. Files past the
    // share are truncated lowest-priority-first (SOUL > IDENTITY > USER >
    // NOTES > other .md files) instead of overflowing the context window.
    share: z.number().min(0.05).max(0.9).default(0.35),
  }).default({}),
  notes_maintenance: z.object({
    // Scheduled three-way sort of identity/NOTES.md when it outgrows
    // max_bytes: durable directives become pending IDENTITY.md proposals
    // (user approves), episodic notes are archived to the memory store
    // (tagged 'identity-note', recalled like any memory), and a recent
    // working set stays in NOTES.md with a pointer to the archive. A note
    // leaves NOTES.md only after its archive copy is durably saved.
    enabled: z.boolean().default(false),
    // Minimum days between maintenance passes.
    interval_days: z.number().int().min(1).max(30).default(1),
    // Size that triggers a sort, and the rewrite target afterwards.
    max_bytes: z.number().int().min(1024).max(65536).default(6144),
    // The newest N notes are the active working set and are never sorted out.
    keep_recent: z.number().int().min(0).max(20).default(4),
    // Cap on IDENTITY.md promotion proposals created per run.
    max_promotions: z.number().int().min(0).max(5).default(2),
  }).default({}),
}).default({});

// Forward-compatible stub for features that ship in later phases. Reserving the
// keys now keeps existing configs valid when the real schemas replace the stubs.
const FeatureStubSchema = z.object({
  enabled: z.boolean().default(false),
}).default({});

// Tool permission levels, least to most sensitive. Every level defaults OFF;
// each must be switched on explicitly in forge.config.yaml.
export const TOOL_PERMISSIONS = ['safe', 'network', 'filesystem', 'sensitive'] as const;
export type ToolPermission = typeof TOOL_PERMISSIONS[number];

const ToolsConfigSchema = z.object({
  // Master switch. When false the chat path never enters the agent loop.
  enabled: z.boolean().default(false),
  // Upper bound on model->tools->model round trips per user turn.
  max_iterations: z.number().int().min(1).max(20).default(5),
  // Per-level switches. A tool runs only when tools.enabled AND its level is on.
  levels: z.object({
    safe: z.boolean().default(false),
    network: z.boolean().default(false),
    filesystem: z.boolean().default(false),
    sensitive: z.boolean().default(false),
  }).default({}),
  // Path allowlist for the filesystem level. Empty lists mean no path is
  // allowed even when the level itself is switched on.
  filesystem: z.object({
    readable_dirs: z.array(z.string()).default([]),
    writable_dirs: z.array(z.string()).default([]),
    // Byte cap on a single read_file result. Optional (not defaulted) so
    // existing config fixtures stay valid; the tool falls back to 256 KiB.
    max_read_bytes: z.number().int().min(1).optional(),
  }).default({}),
}).default({});

const RagConfigSchema = z.object({
  // Document retrieval into chat context. Requires memory.embeddings to be
  // enabled (documents are embedded with the same local model at upload time).
  // Inert until documents are uploaded, so enabled-by-default is safe.
  enabled: z.boolean().default(true),
  // Target chunk size and overlap, in estimated tokens.
  chunk_tokens: z.number().int().min(50).max(2000).default(400),
  chunk_overlap_tokens: z.number().int().min(0).max(500).default(50),
  // Retrieval knobs: top_k candidate chunks, minimum cosine similarity, and a
  // hard cap on injected chunk tokens so retrieval cannot blow the 8 GB
  // context budget.
  top_k: z.number().int().min(1).max(20).default(4),
  min_similarity: z.number().min(0).max(1).default(0.35),
  max_context_tokens: z.number().int().min(100).max(8000).default(1500),
}).default({});

const ImagegenConfigSchema = z.object({
  // Image generation is the one feature that fights the 8 GB budget: SD and
  // E4B must NOT be co-resident. The tool runs on demand — by default it asks
  // Ollama to unload the chat model first, the backend loads SD, and Ollama
  // reloads E4B on the next completion. First image after idle is slower.
  enabled: z.boolean().default(false),
  // A1111-compatible txt2img HTTP API (SD WebUI / SD.Next / Forge webui, or
  // ComfyUI behind a compat layer). Behind an interface so a hosted API can
  // swap in later.
  backend: z.literal('a1111').default('a1111'),
  base_url: z.string().url().default('http://localhost:7860'),
  // Generous timeout: on-demand generation includes SD model load after idle.
  timeout_ms: z.number().int().min(5000).max(600_000).default(180_000),
  // Small-VRAM-friendly defaults (SD 1.5 / SDXL-Turbo at 512px).
  width: z.number().int().min(64).max(2048).default(512),
  height: z.number().int().min(64).max(2048).default(512),
  steps: z.number().int().min(1).max(150).default(20),
  // Hard caps applied to model-requested parameters.
  max_size: z.number().int().min(64).max(2048).default(1024),
  max_steps: z.number().int().min(1).max(150).default(50),
  // Ask Ollama to unload the chat model before generating (recommended on 8 GB).
  free_vram: z.boolean().default(true),
}).default({});

const VisionConfigSchema = z.object({
  // On-demand image analysis (analyze_image tool) with a dedicated
  // vision-capable model on the same Ollama server. Ollama swaps models in
  // and out of VRAM itself, so no free_vram handoff is needed — but the
  // first call after chatting pays a model-load delay.
  enabled: z.boolean().default(false),
  // Vision-capable Ollama model tag. The chat model is never used for
  // vision even when its card claims the capability (community abliterated
  // builds can ship a broken vision projector that hallucinates).
  model: z.string().min(1).default('qwen2.5vl:7b'),
  // Modest per-request context keeps a 7b vision model mostly on an 8 GB GPU
  // (the Ollama default of 64k splits it roughly half onto the CPU).
  num_ctx: z.number().int().min(1024).max(131_072).default(8192),
  // Output cap and repeat penalty guard against runaway repetition loops:
  // pages dense with repeated glyphs (manga sound effects) can otherwise trap
  // the model into generating the same token for many minutes.
  num_predict: z.number().int().min(64).max(4096).default(700),
  repeat_penalty: z.number().min(0.5).max(2).default(1.15),
  // Generous: a dense image takes ~3 minutes on an 8 GB card including the
  // model swap.
  timeout_ms: z.number().int().min(5000).max(600_000).default(300_000),
  // Largest image file accepted (it is base64-encoded in-process).
  max_image_bytes: z.number().int().min(1024).max(104_857_600).default(10_485_760),
}).default({});

const VoiceConfigSchema = z.object({
  // Speech-to-text. 'whisper-cpp' runs the whisper.cpp CLI on CPU (default,
  // reliable); 'native' sends the audio to the chat model itself for
  // transcription (Gemma 4 E4B accepts audio natively).
  stt: z.object({
    enabled: z.boolean().default(false),
    engine: z.enum(['whisper-cpp', 'native']).default('whisper-cpp'),
    // Path to the whisper.cpp CLI binary (or a name on PATH).
    binary: z.string().default('whisper-cli'),
    // Path to a ggml whisper model, e.g. ggml-base.en.bin.
    model: z.string().default(''),
    language: z.string().default('auto'),
    timeout_ms: z.number().int().min(1000).max(300_000).default(60_000),
  }).default({}),
  // Text-to-speech via Piper (CPU).
  tts: z.object({
    enabled: z.boolean().default(false),
    // Path to the piper binary (or a name on PATH).
    binary: z.string().default('piper'),
    // Path to a piper voice model, e.g. en_US-lessac-medium.onnx.
    model: z.string().default(''),
    timeout_ms: z.number().int().min(1000).max(120_000).default(30_000),
    // Longest reply text synthesized in one request.
    max_chars: z.number().int().min(100).max(10_000).default(2000),
  }).default({}),
}).default({});

const SchedulerJobSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i, 'job name must be alphanumeric with - or _'),
  // Standard 5-field cron: minute hour day-of-month month day-of-week.
  // Fully validated (ranges, lists, steps) when the scheduler starts.
  cron: z.string().trim().regex(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/, 'cron must have 5 fields'),
  // The unattended prompt run through the normal agent pipeline.
  prompt: z.string().trim().min(1),
  // Where the output goes. 'none' still stores it in messages.db.
  channel: z.enum(['none', 'telegram']).default('none'),
  chat_id: z.string().optional(),
}).superRefine((value, ctx) => {
  if (value.channel === 'telegram' && !value.chat_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['chat_id'],
      message: 'chat_id is required when a job delivers to telegram',
    });
  }
});

const SchedulerConfigSchema = z.object({
  // Unattended scheduled agent turns. Default off, no jobs defined.
  enabled: z.boolean().default(false),
  jobs: z.array(SchedulerJobSchema).default([]),
}).default({});

const TelegramAttachmentsConfigSchema = z.object({
  // Download inbound Telegram photos (and images sent as files) to a local
  // directory so the analyze_image tool can read them. Default off. While on,
  // the resolved dir counts as an implicit readable root for filesystem tools
  // (see isPathAllowed) — no manual readable_dirs entry needed.
  enabled: z.boolean().default(false),
  // Where downloads land. Relative paths resolve against the process cwd,
  // the same way tools.filesystem allowlist entries do.
  dir: z.string().trim().min(1).default('./attachments'),
  // Refuse Telegram files larger than this. Default 10 MiB, matching the
  // vision.max_image_bytes default so anything saved is also analyzable.
  max_file_bytes: z.number().int().min(1024).max(104_857_600).default(10_485_760),
  // Downloads older than this are pruned whenever a new one is saved.
  retention_days: z.number().int().min(1).default(7),
}).default({});

const TelegramConfigSchema = z.object({
  // Telegram channel bridge (Bot API, long polling). Default off.
  enabled: z.boolean().default(false),
  // The bot token comes from this environment variable; a config-file token
  // is supported as a fallback but the env var is preferred.
  token_env: z.string().trim().min(1).default('FORGE_TELEGRAM_TOKEN'),
  token: z.string().optional(),
  api_base_url: z.string().url().default('https://api.telegram.org'),
  poll_timeout_s: z.number().int().min(1).max(50).default(30),
  // Only these chat ids reach the pipeline. Empty = nobody (the bot replies
  // once with the chat id so the owner can allowlist themselves).
  allowed_chat_ids: z.array(z.union([z.string(), z.number()])).default([]),
  // Inbound photo/image-file downloads for analyze_image. Default off.
  attachments: TelegramAttachmentsConfigSchema,
}).default({});

const SearchConfigSchema = z.object({
  // Self-hosted SearXNG instance for the web_search tool. Queries go only to
  // this URL; nothing leaves the machine except SearXNG's own upstream calls.
  // The tools themselves are gated by tools.enabled + tools.levels.network.
  searxng_url: z.string().url().default('http://localhost:8888'),
  // Max results returned per search.
  results: z.number().int().min(1).max(10).default(5),
  // Request timeout for web_search and fetch_url.
  timeout_ms: z.number().int().min(500).max(60_000).default(8000),
  // Cap on readable text returned by fetch_url (characters).
  fetch_max_chars: z.number().int().min(500).max(50_000).default(8000),
}).default({});

const LlmFallbackSchema = z.object({
  // Cloud fallback is opt-in; the default path stays 100% local.
  enabled: z.boolean().default(false),
  provider: z.literal('openai-compatible').default('openai-compatible'),
  base_url: z.string().url().default('https://api.openai.com/v1'),
  model: z.string().trim().min(1).optional(),
  // Name of the environment variable holding the API key; the key itself
  // never lives in config files.
  api_key_env: z.string().trim().min(1).default('FORGE_FALLBACK_API_KEY'),
}).superRefine((value, ctx) => {
  if (value.enabled && !value.model) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['model'],
      message: 'llm.fallback.model is required when llm.fallback.enabled is true',
    });
  }
}).default({});

const MemoryAutoConfigSchema = z.object({
  // Automatic capture is the default memory experience; /remember and /forget
  // remain as manual overrides. Set false to return to manual-only memory.
  enabled: z.boolean().default(true),
  // Upper bound on memories extracted from a single turn.
  max_per_turn: z.number().int().min(1).max(10).default(3),
  // Cosine similarity at or above which a candidate is treated as a duplicate
  // of an existing memory (requires the embedding index; exact-match dedupe
  // always applies).
  dedupe_similarity: z.number().min(0).max(1).default(0.92),
}).default({});

const MemorySummaryConfigSchema = z.object({
  // Rolling per-conversation summary: when older turns fall out of the sliding
  // history window, an async pass after the reply folds them into a compact
  // digest that is injected back into the system context on later turns.
  enabled: z.boolean().default(true),
  // Hard cap on the stored/injected summary text (characters).
  max_chars: z.number().int().min(200).max(4000).default(1200),
  // Max fallen-out messages folded into the summary per background pass.
  batch_messages: z.number().int().min(4).max(100).default(40),
}).default({});

const MemoryConsolidationConfigSchema = z.object({
  // Nightly memory hygiene: supersede near-duplicate auto-captured memories
  // (keeping the newer of each pair) and archive stale auto memories that were
  // never retrieved within memory.retention_days. Manual memories (anything
  // not tagged 'auto') are never touched.
  enabled: z.boolean().default(true),
  // Cosine similarity at or above which two active memories with embeddings
  // from the same model are treated as near-duplicates.
  dedupe_similarity: z.number().min(0).max(1).default(0.95),
  // Minimum days between consolidation passes.
  interval_days: z.number().int().min(1).max(30).default(1),
}).default({});

const BackupConfigSchema = z.object({
  // Scheduled local backups of every SQLite database plus the identity
  // directory. Local-only: backups are written to `dir` on this machine and
  // never leave it.
  enabled: z.boolean().default(true),
  // Days between backups.
  interval_days: z.number().int().min(1).max(90).default(7),
  // How many backups to retain; older ones are pruned after each run.
  keep: z.number().int().min(1).max(52).default(8),
  // Backup destination, relative to the forge root (gitignored).
  dir: z.string().default('./backups'),
}).default({});

const MemoryEmbeddingsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  model: z.string().trim().min(1).optional(),
  request_timeout_ms: z.number().int().min(100).max(120_000).default(10_000),
  backfill_batch_size: z.number().int().min(1).max(100).default(16),
}).superRefine((value, ctx) => {
  if (value.enabled && !value.model) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['model'],
      message: 'memory.embeddings.model is required when memory.embeddings.enabled is true',
    });
  }
});

export const ForgeConfigSchema = z.object({
  forge: z.object({
    name: z.string(),
    version: z.string(),
    root: z.string(),
  }),
  user: z.object({
    name: z.string(),
  }),
  llm: z.object({
    provider: z.literal('ollama').default('ollama'),
    model: z.string().min(1),
    ollama: z.object({
      base_url: z.string().url().default('http://localhost:11434'),
      keep_alive: z.string().default('10m'),
      // Defaults target gemma4:e4b on an 8 GB GPU. Sampling follows the Gemma 4
      // guidance (temperature 1.0, top_k 64, top_p 0.95). num_ctx 8192 keeps the
      // KV cache fully in 8 GB VRAM; see forge.config.yaml for the 16384 path
      // (OLLAMA_FLASH_ATTENTION=1 + OLLAMA_KV_CACHE_TYPE=q8_0).
      options: z.record(z.string(), z.unknown()).default({
        temperature: 1.0,
        top_k: 64,
        top_p: 0.95,
        num_ctx: 8192,
        num_predict: 1024,
      }),
    }).default({}),
    // Optional cloud fallback used only when local Ollama fails. Default off.
    fallback: LlmFallbackSchema,
  }),
  paths: z.object({
    dbs: z.string().default('./dbs'),
    identity: z.string().default('./identity'),
    logs: z.string().default('./logs'),
    // Generated images (gitignored runtime output).
    images: z.string().default('./images'),
  }),
  services: z.object({
    web: z.object({
      host: z.string().default('127.0.0.1'),
      port: z.number().default(6800),
      auth_token: z.string().optional(),
      context_window_tokens: z.number().int().positive().default(80000),
      debug_prompt_context: z.boolean().default(false),
    }).default({}),
  }).default({}),
  memory: z.object({
    retention_days: z.number().int().positive().default(30),
    embeddings: MemoryEmbeddingsConfigSchema.default({}),
    // Automatic memory capture after each chat turn.
    auto: MemoryAutoConfigSchema,
    // Rolling summary of conversation turns that fell out of the context window.
    summary: MemorySummaryConfigSchema,
    // Nightly hygiene pass: dedupe + archive stale auto-captured memories.
    consolidation: MemoryConsolidationConfigSchema,
  }).default({}),
  identity: IdentityConfigSchema,
  // Safe tool system: explicit permissions, logs, and user control. Everything
  // defaults OFF.
  tools: ToolsConfigSchema,
  // Document RAG: uploaded documents are chunked, embedded locally, and
  // retrieved into chat context.
  rag: RagConfigSchema,
  // Connection settings for the network-level web tools (web_search, fetch_url).
  search: SearchConfigSchema,
  // Local CPU voice I/O: whisper.cpp STT and Piper TTS.
  voice: VoiceConfigSchema,
  // On-demand local image generation (generate_image tool).
  imagegen: ImagegenConfigSchema,
  // On-demand image analysis with a local vision model (analyze_image tool).
  vision: VisionConfigSchema,
  // Stubs for later phases — all disabled. Reserved so configs written today
  // stay valid as each feature lands.
  scheduler: SchedulerConfigSchema,
  // Scheduled local backups (dbs + identity). Local-only, gitignored output.
  backup: BackupConfigSchema,
  // Message channels beyond the web UI. All feed the same chat pipeline.
  channels: z.object({
    telegram: TelegramConfigSchema,
  }).default({}),
});

type ParsedForgeConfig = z.infer<typeof ForgeConfigSchema>;
export type MemoryEmbeddingsConfig = z.infer<typeof MemoryEmbeddingsConfigSchema>;
export type FeatureStubConfig = z.infer<typeof FeatureStubSchema>;
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type LlmFallbackConfig = z.infer<typeof LlmFallbackSchema>;
export type MemoryAutoConfig = z.infer<typeof MemoryAutoConfigSchema>;
export type MemorySummaryConfig = z.infer<typeof MemorySummaryConfigSchema>;
export type RagConfig = z.infer<typeof RagConfigSchema>;
export type SearchConfig = z.infer<typeof SearchConfigSchema>;
export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;
export type ImagegenConfig = z.infer<typeof ImagegenConfigSchema>;
export type VisionConfig = z.infer<typeof VisionConfigSchema>;
export type TelegramAttachmentsConfig = z.infer<typeof TelegramAttachmentsConfigSchema>;
// Same Omit convention as ForgeConfig below: the loader always supplies the
// attachments block, but fixtures that build a telegram config inline may omit it.
export type TelegramConfig = Omit<z.infer<typeof TelegramConfigSchema>, 'attachments'> & {
  attachments?: TelegramAttachmentsConfig;
};
export type SchedulerConfig = z.infer<typeof SchedulerConfigSchema>;
export type SchedulerJobConfig = z.infer<typeof SchedulerJobSchema>;
export type MemoryConsolidationConfig = z.infer<typeof MemoryConsolidationConfigSchema>;
export type BackupConfig = z.infer<typeof BackupConfigSchema>;
export type ForgeConfig = Omit<
  ParsedForgeConfig,
  'identity' | 'memory' | 'llm' | 'tools' | 'rag' | 'voice' | 'search' | 'imagegen' | 'vision' | 'scheduler' | 'backup' | 'channels' | 'paths'
> & {
  paths: Omit<ParsedForgeConfig['paths'], 'images'> & {
    images?: string;
  };
  // The loader always supplies these blocks. Keep them optional for existing test
  // and extension fixtures that construct ForgeConfig objects directly.
  llm: Omit<ParsedForgeConfig['llm'], 'fallback'> & {
    fallback?: LlmFallbackConfig;
  };
  memory: Omit<ParsedForgeConfig['memory'], 'embeddings' | 'auto' | 'summary' | 'consolidation'> & {
    embeddings?: MemoryEmbeddingsConfig;
    auto?: MemoryAutoConfig;
    summary?: MemorySummaryConfig;
    consolidation?: MemoryConsolidationConfig;
  };
  identity?: Omit<z.infer<typeof IdentityConfigSchema>, 'budget' | 'notes_maintenance'> & {
    budget?: z.infer<typeof IdentityConfigSchema>['budget'];
    notes_maintenance?: z.infer<typeof IdentityConfigSchema>['notes_maintenance'];
  };
  tools?: ToolsConfig;
  rag?: RagConfig;
  search?: SearchConfig;
  voice?: VoiceConfig;
  imagegen?: ImagegenConfig;
  vision?: VisionConfig;
  scheduler?: SchedulerConfig;
  backup?: BackupConfig;
  channels?: {
    telegram?: TelegramConfig;
  };
};

export type EmbeddingAvailabilityStatus =
  | 'disabled'
  | 'online'
  | 'offline'
  | 'missing-model'
  | 'protocol-error';

export interface EmbeddingHealth {
  provider: 'ollama';
  enabled: boolean;
  model?: string;
  baseUrl: string;
  ok: boolean;
  status: EmbeddingAvailabilityStatus;
  installedModels: string[];
  modelRevision?: string;
  message?: string;
}

export interface EmbeddingIndexProgress {
  active: number;
  indexed: number;
  pending: number;
  stale: number;
  failed: number;
  model?: string;
  modelRevision?: string;
  lastError?: string;
}

export type EmbeddingReindexStatus = 'idle' | 'running' | 'completed' | 'failed';

export interface EmbeddingReindexState {
  status: EmbeddingReindexStatus;
  progress: EmbeddingIndexProgress;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
}

export interface ResolvedPaths {
  root: string;
  dbs: string;
  identity: string;
  logs: string;
  images: string;
}

export interface MemoryRecord {
  id: string;
  type: string;
  content: string;
  tags: string[];
  status: 'active' | 'superseded' | 'archived';
  confidence: number;
  importance: number;
  accessCount: number;
  created: string;
  updated: string;
  supersededBy: string | null;
}

export interface MemoryHistoryEntry {
  id: number;
  memoryId: string;
  changeType: string;
  oldContent: string | null;
  oldStatus: string | null;
  oldConfidence: number | null;
  oldTags: string | null;
  newContent: string | null;
  newStatus: string | null;
  changedAt: string;
  changedBy: string;
  reason: string | null;
}

/** Tool-call request shape used in Ollama's native /api/chat message format. */
export interface RawToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  images?: string[];
  /** Base64 audio clips for natively multimodal models (Gemma 4 E4B). */
  audio?: string[];
  name?: string;
  timestamp?: string;
  /** Tool calls issued by an assistant message (replayed to the model on later iterations). */
  tool_calls?: RawToolCall[];
  /** Which tool produced this role:'tool' result message. */
  tool_name?: string;
}

/**
 * A registered tool. `params` is a Zod object schema: it validates arguments
 * before the handler runs and is converted to JSON Schema for the model.
 * Handlers receive validated args and return a JSON-serializable result;
 * whatever they return is data for the model, never instructions.
 */
export interface ToolDef {
  name: string;
  description: string;
  params: z.ZodObject<z.ZodRawShape>;
  permission: ToolPermission;
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

/** A tool invocation parsed from a model response. */
export interface LLMToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMRequest {
  system: string;
  messages: ChatMessage[];
  model?: string;
  /** When present, the provider advertises these tools to the model. */
  tools?: ToolDef[];
  /**
   * Per-request Ollama option overrides, merged over llm.ollama.options.
   * Background jobs use this to raise num_predict for thinking models (hidden
   * reasoning counts against the budget) or pin a low temperature for JSON.
   * The OpenAI-compatible fallback ignores these.
   */
  options?: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  provider: 'ollama' | 'openai-compatible';
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Tool invocations requested by the model, if any. */
  toolCalls?: LLMToolCall[];
}
