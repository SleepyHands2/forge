import { loadConfig, loadEnvFile } from './config.ts';
import { DatabaseManager } from './db/manager.ts';
import { MemoryService } from './services/memory.ts';
import { LLMService } from './services/llm.ts';
import { OllamaEmbeddingProvider } from './services/ollama-embeddings.ts';
import { IdentityFileService, type IdentityFilename, type IdentityModelContextResult } from './services/identity-files.ts';
import { computePromptBudgetTokens } from './services/chat-history.ts';
import { IdentityReflectionService } from './services/identity-reflection.ts';
import { MemoryCaptureService } from './services/memory-capture.ts';
import { ConversationSummaryService } from './services/conversation-summary.ts';
import { ChatTurnService } from './services/chat-turn.ts';
import { MaintenanceService } from './services/maintenance.ts';
import { IdentityNotesMaintenanceService } from './services/identity-notes-maintenance.ts';
import { RagService } from './services/rag/rag.ts';
import { SttService } from './services/voice/stt.ts';
import { TtsService } from './services/voice/tts.ts';
import { AgentService } from './services/agent.ts';
import { ToolRegistry } from './services/tools/registry.ts';
import { ToolCallLog } from './services/tools/log.ts';
import { createFetchUrlTool, createWebSearchTool } from './services/tools/web.ts';
import { createGenerateImageTool } from './services/tools/imagegen.ts';
import { createRecallTools } from './services/tools/recall.ts';
import { createFilesystemTools } from './services/tools/filesystem.ts';
import { createAnalyzeImageTool } from './services/tools/vision.ts';
import { createReminderTools } from './services/tools/reminders.ts';
import { createGetStatusTool } from './services/tools/status.ts';
import { ReminderService } from './services/scheduler/reminders.ts';
import type { ForgeConfig, ResolvedPaths } from './types.ts';

export class Platform {
  private static instance: Platform | null = null;

  config: ForgeConfig;
  resolved: ResolvedPaths;
  dbManager: DatabaseManager;
  memory!: MemoryService;
  embeddings!: OllamaEmbeddingProvider;
  llm!: LLMService;
  identityFiles!: IdentityFileService;
  identityReflection!: IdentityReflectionService;
  toolRegistry!: ToolRegistry;
  agent!: AgentService;
  reminders!: ReminderService;
  memoryCapture!: MemoryCaptureService;
  conversationSummary!: ConversationSummaryService;
  rag!: RagService;
  stt!: SttService;
  tts!: TtsService;
  chatTurn!: ChatTurnService;
  identityNotesMaintenance!: IdentityNotesMaintenanceService;
  maintenance!: MaintenanceService;

  private booted = false;

  private constructor(config: ForgeConfig, resolved: ResolvedPaths) {
    this.config = config;
    this.resolved = resolved;
    this.dbManager = new DatabaseManager(resolved.dbs);
  }

  static async boot(configPath?: string): Promise<Platform> {
    if (Platform.instance?.booted) return Platform.instance;

    loadEnvFile();
    const { config, resolved } = loadConfig(configPath);
    const platform = new Platform(config, resolved);

    platform.initDatabases();
    platform.initServices();
    platform.loadIdentity();

    platform.booted = true;
    Platform.instance = platform;
    platform.scheduleEmbeddingBackfill();

    console.log('[platform] Booted local web companion');
    console.log(`[platform] DBs: ${platform.resolved.dbs}`);
    console.log(`[platform] Agent: ${config.forge.name}`);
    return platform;
  }

  private initDatabases(): void {
    this.dbManager.openAll();
    const health = this.dbManager.health();
    const failed = health.filter(h => !h.ok);
    if (failed.length > 0) {
      console.error('[platform] Unhealthy databases:', failed);
    }
    console.log(`[platform] ${health.length} databases opened`);
  }

  private initServices(): void {
    this.embeddings = new OllamaEmbeddingProvider(this.config);
    this.memory = new MemoryService(this.dbManager.get('memory'), {
      embeddingProvider: this.embeddings,
      backfillBatchSize: this.config.memory.embeddings?.backfill_batch_size,
    });
    this.llm = new LLMService(this.config);
    this.identityFiles = new IdentityFileService({
      db: this.dbManager.get('messages'),
      identityDir: this.resolved.identity,
    });
    this.identityReflection = new IdentityReflectionService({
      db: this.dbManager.get('messages'),
      config: this.config,
      identityFiles: this.identityFiles,
      llm: this.llm,
      readIdentity: () => this.readIdentity(),
    });
    this.memoryCapture = new MemoryCaptureService({
      db: this.dbManager.get('memory'),
      config: this.config,
      memory: this.memory,
      llm: this.llm,
    });
    this.conversationSummary = new ConversationSummaryService({
      db: this.dbManager.get('messages'),
      config: this.config,
      llm: this.llm,
    });
    this.rag = new RagService({
      db: this.dbManager.get('documents'),
      config: this.config,
      embeddings: this.embeddings,
    });
    this.stt = new SttService({ config: this.config, llm: this.llm });
    this.tts = new TtsService({ config: this.config });
    // Registered tools stay inert until tools.enabled AND their permission
    // level are switched on in config; the agent loop gates every call.
    // The registry and agent are constructed BEFORE chatTurn so the shared
    // turn pipeline captures a real agent, not undefined.
    this.toolRegistry = new ToolRegistry();
    this.toolRegistry.register(createWebSearchTool(this.config));
    this.toolRegistry.register(createFetchUrlTool(this.config));
    // Registered only when enabled so the model never sees the tool otherwise
    // (it is the one feature that contends for the 8 GB GPU).
    if (this.config.imagegen?.enabled === true) {
      this.toolRegistry.register(createGenerateImageTool(this.config, this.resolved));
    }
    for (const tool of createRecallTools({
      config: this.config,
      memory: this.memory,
      messagesDb: this.dbManager.get('messages'),
      rag: this.rag,
    })) {
      this.toolRegistry.register(tool);
    }
    // Read-only filesystem tools: inert until the filesystem level is on AND
    // tools.filesystem.readable_dirs is non-empty (every path is gated).
    for (const tool of createFilesystemTools({ config: this.config })) {
      this.toolRegistry.register(tool);
    }
    // Vision analysis: registered only when enabled (mirrors imagegen, since
    // it also contends for the GPU); image paths go through the same
    // readable_dirs gate as the filesystem tools.
    if (this.config.vision?.enabled === true) {
      this.toolRegistry.register(createAnalyzeImageTool(this.config));
    }
    // Shared with the scheduler wiring in index.ts: the tools create/cancel
    // reminders in the same store the scheduler tick delivers from.
    this.reminders = new ReminderService({ db: this.dbManager.get('tools') });
    for (const tool of createReminderTools({ config: this.config, reminders: this.reminders })) {
      this.toolRegistry.register(tool);
    }
    // Self-inspection: the registry reference is captured here; listing
    // happens at call time, so the tool reporting on itself is fine.
    this.toolRegistry.register(createGetStatusTool({
      config: this.config,
      registry: this.toolRegistry,
      memory: this.memory,
      rag: this.rag,
      reminders: this.reminders,
      stt: this.stt,
      tts: this.tts,
      embeddingHealth: () => this.embeddings.health(),
      identityContext: () => this.buildIdentityContext(),
    }));
    this.agent = new AgentService({
      config: this.config,
      llm: this.llm,
      registry: this.toolRegistry,
      log: new ToolCallLog(this.dbManager.get('tools')),
    });
    // Shared turn pipeline used by non-web channels (the web route builds its
    // own instance from WebContext so tests can substitute every dependency).
    this.chatTurn = new ChatTurnService({
      config: this.config,
      db: this.dbManager.get('messages'),
      memory: this.memory,
      llm: this.llm,
      agent: this.agent,
      rag: this.rag,
      identityReflection: this.identityReflection,
      memoryCapture: this.memoryCapture,
      summary: this.conversationSummary,
      readIdentity: () => this.readIdentity(),
    });
    // Background hygiene: scheduled local backups, memory consolidation, and
    // identity NOTES.md consolidation. Started from index.ts after the
    // scheduler; failures only ever log.
    this.identityNotesMaintenance = new IdentityNotesMaintenanceService({
      config: this.config,
      identityFiles: this.identityFiles,
      memory: this.memory,
      llm: this.llm,
    });
    this.maintenance = new MaintenanceService({
      config: this.config,
      resolved: this.resolved,
      dbManager: this.dbManager,
      memory: this.memory,
      db: this.dbManager.get('tools'),
      notesMaintenance: this.identityNotesMaintenance,
    });
    console.log('[platform] Services initialized');
  }

  private scheduleEmbeddingBackfill(): void {
    if (!this.embeddings.enabled) return;

    setImmediate(() => {
      if (!this.booted) return;
      void this.memory.reindexEmbeddings().then(result => {
        if (result.status === 'failed') {
          console.warn(`[platform] Memory embedding backfill did not complete: ${result.message ?? 'unknown error'}`);
        }
      }).catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[platform] Memory embedding backfill failed: ${message}`);
      });
    });
  }

  private loadIdentity(): void {
    this.identityFiles.scaffold(this.identityTemplates());
  }

  readIdentity(): string {
    return this.buildIdentityContext().text;
  }

  /**
   * Identity context capped to its configured share of the prompt budget, so
   * runaway identity files (the NOTES.md overflow incident) degrade to a
   * truncated context instead of blocking every chat turn.
   */
  buildIdentityContext(): IdentityModelContextResult {
    const share = this.config.identity?.budget?.share ?? 0.35;
    const budgetTokens = Math.floor(computePromptBudgetTokens(this.config) * share);
    return this.identityFiles.buildModelContext(budgetTokens);
  }

  get identity(): string {
    return this.readIdentity();
  }

  private identityTemplates(): Partial<Record<IdentityFilename, string>> {
    const name = this.config.forge.name;
    return {
      'IDENTITY.md': [
        `# Identity`,
        ``,
        `You are ${name}, an AI assistant.`,
        ``,
        `<!-- FIRST RUN: This is a starter template. Update this file to define who you are.`,
        `     What is your name? What are you responsible for? What can you do?`,
        `     Example: "You are ${name}, an AI agent managing a home network and Plex server." -->`,
      ].join('\n'),
      'SOUL.md': [
        `# Soul`,
        ``,
        `You are helpful, direct, and concise.`,
        ``,
        `<!-- FIRST RUN: This defines how you behave. Your personality, tone, and values.`,
        `     Are you casual or formal? Proactive or reactive? Verbose or terse?`,
        `     Example: "You take action first and report after. You don't ask permission for routine ops." -->`,
      ].join('\n'),
      'USER.md': [
        `# User`,
        ``,
        `Your user has not introduced themselves yet.`,
        `When you first interact with them, ask who they are and what they need from you.`,
        `Update this file with what you learn.`,
        ``,
        `<!-- FIRST RUN: This is context about the person you serve.`,
        `     Their name, role, technical background, preferences, and communication style.`,
        `     The more you know, the better you can help. Ask and fill this out. -->`,
      ].join('\n'),
      'NOTES.md': [
        '# Notes',
        '',
        'Lower-trust working notes. These are excluded from the core identity read and require review before promotion.',
        '',
      ].join('\n'),
    };
  }

  shutdown(): void {
    console.log('[platform] Shutting down...');
    this.dbManager.closeAll();
    Platform.instance = null;
    this.booted = false;
    console.log('[platform] Shutdown complete');
  }
}
