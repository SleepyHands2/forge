import type BetterSqlite3 from 'better-sqlite3';
import type { ChatMessage, ForgeConfig, LLMResponse } from '../types.ts';
import type { LLMService } from './llm.ts';
import type { HighTrustIdentityFilename, IdentityFileService, IdentityNote } from './identity-files.ts';

type Database = BetterSqlite3.Database;
type ReflectionStatus = 'disabled' | 'skipped_cadence' | 'no_output' | 'applied';

interface ReflectionAction {
  title: string;
  content: string;
  reason: string;
}

interface ReflectionProposal extends ReflectionAction {
  filename: HighTrustIdentityFilename;
}

interface ReflectionPlan {
  notes: ReflectionAction[];
  proposals: ReflectionProposal[];
}

export interface IdentityReflectionInput {
  userMessage: string;
  assistantMessage: string;
  assistantMessageId: string;
}

export interface IdentityReflectionResult {
  status: ReflectionStatus;
  assistantReplyCount: number;
  notesCreated: number;
  proposalsCreated: number;
}

export interface IdentityReflectionLogger {
  warn: (...args: unknown[]) => void;
}

export interface IdentityReflectionServiceOptions {
  db: Database;
  config: ForgeConfig;
  identityFiles: IdentityFileService;
  llm: Pick<LLMService, 'complete'>;
  readIdentity: () => string;
  logger?: IdentityReflectionLogger;
}

const MAX_REFLECTION_ITEMS = 3;
const ALLOWED_PROPOSAL_FILES = new Set(['IDENTITY.md', 'SOUL.md', 'USER.md']);

export class IdentityReflectionService {
  private readonly db: Database;
  private readonly config: ForgeConfig;
  private readonly identityFiles: IdentityFileService;
  private readonly llm: Pick<LLMService, 'complete'>;
  private readonly readIdentity: () => string;
  private readonly logger: IdentityReflectionLogger;

  constructor(options: IdentityReflectionServiceOptions) {
    this.db = options.db;
    this.config = options.config;
    this.identityFiles = options.identityFiles;
    this.llm = options.llm;
    this.readIdentity = options.readIdentity;
    this.logger = options.logger ?? console;
  }

  async reflectAfterAssistantReply(input: IdentityReflectionInput): Promise<IdentityReflectionResult> {
    const reflection = this.config.identity?.reflection;
    if (reflection?.enabled !== true) {
      return emptyResult('disabled', 0);
    }

    const assistantReplyCount = this.countCompletedAssistantReplies();
    const cadence = Math.max(1, Math.floor(reflection.cadence_turns ?? 1));
    if (assistantReplyCount < 1 || assistantReplyCount % cadence !== 0) {
      return emptyResult('skipped_cadence', assistantReplyCount);
    }

    const recentNotes = this.identityFiles.readRecentNotes(reflection.recent_notes_in_context ?? 5);
    const response = await this.llm.complete({
      system: reflectionSystemPrompt(),
      messages: [{
        role: 'user',
        content: reflectionUserPrompt({
          identity: this.readIdentity(),
          recentNotes,
          latestUserMessage: input.userMessage,
          latestAssistantMessage: input.assistantMessage,
        }),
      }],
    });

    const plan = parseReflectionPlan(response.content, this.logger);
    if (!plan || (plan.notes.length === 0 && plan.proposals.length === 0)) {
      return emptyResult('no_output', assistantReplyCount);
    }

    const applied = this.applyPlan(plan, input, response);
    return {
      status: applied.notesCreated > 0 || applied.proposalsCreated > 0 ? 'applied' : 'no_output',
      assistantReplyCount,
      notesCreated: applied.notesCreated,
      proposalsCreated: applied.proposalsCreated,
    };
  }

  private countCompletedAssistantReplies(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM messages
      WHERE channel = 'web'
        AND user = 'assistant'
        AND trim(text) <> ''
    `).get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  private applyPlan(
    plan: ReflectionPlan,
    input: IdentityReflectionInput,
    response: LLMResponse,
  ): { notesCreated: number; proposalsCreated: number } {
    let notesCreated = 0;
    let proposalsCreated = 0;

    for (const note of plan.notes) {
      try {
        const result = this.identityFiles.appendNote({
          title: note.title,
          content: note.content,
          reason: note.reason,
        });
        if (result.status === 'appended') notesCreated += 1;
      } catch (error) {
        this.warnApplyFailure('note', error, input, response);
      }
    }

    for (const proposal of plan.proposals) {
      try {
        const result = this.identityFiles.createProposal({
          filename: proposal.filename,
          title: proposal.title,
          content: proposal.content,
          reason: proposal.reason,
        });
        if (result.status === 'created') proposalsCreated += 1;
      } catch (error) {
        this.warnApplyFailure('proposal', error, input, response);
      }
    }

    return { notesCreated, proposalsCreated };
  }

  private warnApplyFailure(
    kind: 'note' | 'proposal',
    error: unknown,
    input: IdentityReflectionInput,
    response: LLMResponse,
  ): void {
    this.logger.warn('[identity-reflection] Failed to apply reflection output:', {
      kind,
      assistantMessageId: input.assistantMessageId,
      provider: response.provider,
      model: response.model,
      error: errorMessage(error),
    });
  }
}

function reflectionSystemPrompt(): string {
  return [
    'You are Forge identity reflection, a conservative supervised reviewer that runs only after a completed chat reply.',
    'Do not answer the user. Do not use tools. Do not claim anything was saved.',
    'Use only the latest completed turn as evidence. Current identity Markdown context and notes are context for avoiding duplicates.',
    'Only capture durable, user-relevant identity, relationship, or user preference updates that are clearly supported by the latest turn.',
    'Prefer pending proposals for high-trust identity file changes and low-trust notes for observations.',
    'Allowed proposal filenames are IDENTITY.md, SOUL.md, and USER.md. Never directly edit IDENTITY.md, SOUL.md, USER.md, or RELATIONSHIP.md.',
    'Return strict JSON only, with no markdown fences or commentary.',
    'Schema: {"notes":[{"title":"...","content":"...","reason":"..."}],"proposals":[{"filename":"USER.md","title":"...","content":"...","reason":"..."}]}',
    'Use empty arrays when no update is warranted. Produce at most 3 total items.',
  ].join('\n');
}

function reflectionUserPrompt(input: {
  identity: string;
  recentNotes: IdentityNote[];
  latestUserMessage: string;
  latestAssistantMessage: string;
}): string {
  return [
    '## Current identity Markdown context',
    input.identity.trim() || '(empty)',
    '',
    '## Recent low-trust notes',
    formatRecentNotes(input.recentNotes),
    '',
    '## Latest completed turn',
    'User:',
    input.latestUserMessage,
    '',
    'Assistant:',
    input.latestAssistantMessage,
    '',
    'Return JSON only.',
  ].join('\n');
}

function formatRecentNotes(notes: IdentityNote[]): string {
  if (notes.length === 0) return '(none)';
  return notes.map(note => [
    `- ${note.title}`,
    `  Content: ${note.content}`,
    `  Reason: ${note.reason}`,
  ].join('\n')).join('\n');
}

function parseReflectionPlan(content: string, logger: IdentityReflectionLogger): ReflectionPlan | null {
  const jsonText = extractJsonObject(content);
  if (!jsonText) {
    logger.warn('[identity-reflection] Ignoring reflection output without a JSON object.');
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    logger.warn('[identity-reflection] Ignoring invalid reflection JSON:', errorMessage(error));
    return null;
  }

  if (!isPlainRecord(parsed)) return null;

  const notes = parseActions(parsed.notes).slice(0, MAX_REFLECTION_ITEMS);
  const remaining = Math.max(0, MAX_REFLECTION_ITEMS - notes.length);
  const proposals = parseProposals(parsed.proposals).slice(0, remaining);

  return { notes, proposals };
}

function extractJsonObject(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return unfenced.slice(start, end + 1);
}

function parseActions(value: unknown): ReflectionAction[] {
  if (!Array.isArray(value)) return [];
  const actions: ReflectionAction[] = [];

  for (const item of value) {
    if (!isPlainRecord(item)) continue;
    const title = cleanString(item.title);
    const content = cleanString(item.content);
    const reason = cleanString(item.reason);
    if (!title || !content || !reason) continue;
    actions.push({ title, content, reason });
  }

  return actions;
}

function parseProposals(value: unknown): ReflectionProposal[] {
  if (!Array.isArray(value)) return [];
  const proposals: ReflectionProposal[] = [];

  for (const item of value) {
    if (!isPlainRecord(item)) continue;
    const filename = cleanString(item.filename);
    if (!ALLOWED_PROPOSAL_FILES.has(filename)) continue;
    const title = cleanString(item.title);
    const content = cleanString(item.content);
    const reason = cleanString(item.reason);
    if (!title || !content || !reason) continue;
    proposals.push({
      filename: filename as HighTrustIdentityFilename,
      title,
      content,
      reason,
    });
  }

  return proposals;
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyResult(status: ReflectionStatus, assistantReplyCount: number): IdentityReflectionResult {
  return {
    status,
    assistantReplyCount,
    notesCreated: 0,
    proposalsCreated: 0,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
