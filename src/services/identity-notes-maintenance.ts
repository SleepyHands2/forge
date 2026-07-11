import type { ForgeConfig } from '../types.ts';
import { renderNotesFile, type IdentityFileService, type IdentityNote } from './identity-files.ts';
import type { MemoryService } from './memory.ts';
import type { LLMService } from './llm.ts';

/** Standing line kept at the top of NOTES.md so the model knows the archive exists. */
export const NOTES_ARCHIVE_POINTER =
  "Older notes are archived to long-term memory tagged 'identity-note'; use memory_search to recall them when needed.";

const MAX_REASON_LENGTH = 500;
// The chat model hides "thinking" tokens that count against num_predict; the
// default budget starves the visible JSON on multi-note prompts (verified
// live: empty content at num_predict 1024). Classification also wants a low,
// stable temperature rather than the chat setting.
const SORT_LLM_OPTIONS = { num_predict: 3072, temperature: 0.2 } as const;
// Enough of a note to classify it; full content is not needed and only feeds
// more hidden reasoning.
const PROMPT_CONTENT_CHARS = 400;

interface NotesMaintenanceLogger {
  warn: (...args: unknown[]) => void;
}

export interface IdentityNotesMaintenanceOptions {
  config: ForgeConfig;
  identityFiles: IdentityFileService;
  memory: Pick<MemoryService, 'save'>;
  llm: Pick<LLMService, 'complete'>;
  logger?: NotesMaintenanceLogger;
}

export interface NotesMaintenanceResult {
  status: 'disabled' | 'under_budget' | 'no_candidates' | 'no_output' | 'ok' | 'error';
  /** IDENTITY.md promotion proposals created (pending user approval). */
  promoted: number;
  /** Notes durably archived to the memory store and removed from NOTES.md. */
  archived: number;
  /** Notes remaining in NOTES.md. */
  kept: number;
  detail: string;
}

type NoteAction = 'promote' | 'archive' | 'keep';

/**
 * Scheduled three-way sort of identity/NOTES.md, run by MaintenanceService
 * once the file outgrows identity.notes_maintenance.max_bytes:
 *
 * - PROMOTE: durable directives become pending IDENTITY.md proposals through
 *   the existing approval flow — the model never edits high-trust files.
 * - ARCHIVE: episodic notes are saved to the memory store tagged
 *   'identity-note' (not 'auto', so consolidation never reaps them) and
 *   recalled through normal relevance plus memory_search.
 * - KEEP: the newest keep_recent notes are never sorted out, and anything the
 *   model marks keep stays — unless the file is still over budget, in which
 *   case the oldest kept candidates are archived mechanically.
 *
 * The model's plan is a proposal: it is parsed defensively, unknown ids and
 * actions degrade to keep, and a note leaves NOTES.md only after its archive
 * copy is durably saved. Promoted notes are archived as well, so a rejected
 * proposal loses nothing. run() never throws.
 */
export class IdentityNotesMaintenanceService {
  private readonly config: ForgeConfig;
  private readonly identityFiles: IdentityFileService;
  private readonly memory: Pick<MemoryService, 'save'>;
  private readonly llm: Pick<LLMService, 'complete'>;
  private readonly logger: NotesMaintenanceLogger;

  constructor(options: IdentityNotesMaintenanceOptions) {
    this.config = options.config;
    this.identityFiles = options.identityFiles;
    this.memory = options.memory;
    this.llm = options.llm;
    this.logger = options.logger ?? console;
  }

  enabled(): boolean {
    return this.config.identity?.notes_maintenance?.enabled === true;
  }

  async run(): Promise<NotesMaintenanceResult> {
    try {
      return await this.runInner();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[notes-maintenance] Run failed: ${msg}`);
      return { status: 'error', promoted: 0, archived: 0, kept: 0, detail: msg };
    }
  }

  private async runInner(): Promise<NotesMaintenanceResult> {
    const cfg = this.config.identity?.notes_maintenance;
    if (cfg?.enabled !== true) {
      return { status: 'disabled', promoted: 0, archived: 0, kept: 0, detail: 'identity.notes_maintenance.enabled is false' };
    }
    const maxBytes = cfg.max_bytes ?? 6144;
    const keepRecent = cfg.keep_recent ?? 4;
    const maxPromotions = cfg.max_promotions ?? 2;

    const notesContent = this.identityFiles.readAllFiles().find(file => file.name === 'NOTES.md')?.content ?? '';
    const fileBytes = Buffer.byteLength(notesContent, 'utf-8');
    const notes = this.identityFiles.listNotes();
    if (fileBytes <= maxBytes) {
      return {
        status: 'under_budget', promoted: 0, archived: 0, kept: notes.length,
        detail: `NOTES.md is ${fileBytes} bytes (limit ${maxBytes}); nothing to do`,
      };
    }

    const candidates = keepRecent > 0 ? notes.slice(0, Math.max(0, notes.length - keepRecent)) : notes;
    if (candidates.length === 0) {
      return {
        status: 'no_candidates', promoted: 0, archived: 0, kept: notes.length,
        detail: `NOTES.md is ${fileBytes} bytes (limit ${maxBytes}) but only the protected working set remains (keep_recent ${keepRecent})`,
      };
    }

    const decisions = await this.requestPlan(candidates);
    if (decisions === null) {
      return {
        status: 'no_output', promoted: 0, archived: 0, kept: notes.length,
        detail: 'model returned no parseable sort plan; NOTES.md unchanged',
      };
    }

    // Resolve the plan. Promotions beyond the cap degrade to archive: the
    // content is preserved either way and the next run can promote again.
    const resolved = new Map<string, 'archive' | 'keep'>();
    const promoteNotes: IdentityNote[] = [];
    for (const note of candidates) {
      const action = decisions.get(note.id) ?? 'keep';
      if (action === 'keep') {
        resolved.set(note.id, 'keep');
        continue;
      }
      if (action === 'promote' && promoteNotes.length < maxPromotions) {
        promoteNotes.push(note);
      }
      resolved.set(note.id, 'archive');
    }

    let promoted = 0;
    for (const note of promoteNotes) {
      try {
        const result = this.identityFiles.createProposal({
          filename: 'IDENTITY.md',
          title: note.title,
          content: note.content,
          reason: `Promoted from NOTES.md by scheduled maintenance: ${note.reason}`.slice(0, MAX_REASON_LENGTH),
        });
        if (result.status === 'created') promoted += 1;
      } catch (err) {
        // Pending-proposal cap or validation; the note is still archived below.
        this.logger.warn(`[notes-maintenance] Promotion proposal failed for note ${note.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Mechanical overflow guard: if the model's plan still leaves the file
    // over budget, archive the oldest kept candidates until it fits. The
    // protected working set is never touched.
    const keptNotes = () => notes.filter(note => resolved.get(note.id) !== 'archive');
    for (const note of candidates) {
      if (Buffer.byteLength(renderNotesFile(keptNotes(), NOTES_ARCHIVE_POINTER), 'utf-8') <= maxBytes) break;
      resolved.set(note.id, 'archive');
    }

    // Durability rule: a note is removed only after its archive copy saved.
    let archived = 0;
    for (const note of notes) {
      if (resolved.get(note.id) !== 'archive') continue;
      try {
        await this.memory.save({
          type: 'identity-note',
          content: formatArchivedNote(note),
          tags: ['identity-note'],
          importance: 0.6,
        });
        archived += 1;
      } catch (err) {
        resolved.set(note.id, 'keep');
        this.logger.warn(`[notes-maintenance] Archive failed for note ${note.id}; keeping it in NOTES.md: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const finalKeep = keptNotes();
    this.identityFiles.replaceNotes({ keep: finalKeep, pointer: NOTES_ARCHIVE_POINTER });

    return {
      status: 'ok', promoted, archived, kept: finalKeep.length,
      detail: `promoted ${promoted} to proposals, archived ${archived} to memory, kept ${finalKeep.length} notes`,
    };
  }

  /** Ask the model for a three-way sort; null when it returns nothing usable. */
  private async requestPlan(candidates: IdentityNote[]): Promise<Map<string, NoteAction> | null> {
    const identity = this.identityFiles.readIdentity()['IDENTITY.md'];
    const response = await this.llm.complete({
      system: sortSystemPrompt(),
      messages: [{ role: 'user', content: sortUserPrompt(identity, candidates) }],
      options: { ...SORT_LLM_OPTIONS },
    });
    const plan = parseSortPlan(response.content);
    if (plan === null) {
      this.logger.warn('[notes-maintenance] Could not parse a sort plan from the model output.');
    }
    return plan;
  }
}

function sortSystemPrompt(): string {
  return [
    'You are performing scheduled maintenance on your own working notes file (NOTES.md).',
    'Classify every note by its id into exactly one action:',
    '- "promote": a durable directive, value, or self-definition that belongs in IDENTITY.md permanently. Rare; most notes are not this.',
    '- "archive": an episodic, dated, completed, or superseded observation worth remembering but not worth carrying into every conversation. Archived notes stay searchable in long-term memory.',
    '- "keep": still-active working context you will need in upcoming conversations.',
    'Prefer "archive" over "keep" when unsure; nothing is lost from the archive.',
    'Return strict JSON only, with no markdown fences or commentary:',
    '{"decisions":[{"id":"<note id>","action":"promote"|"archive"|"keep"}]}',
  ].join('\n');
}

function sortUserPrompt(identity: string, candidates: IdentityNote[]): string {
  const sections = [
    '## Current IDENTITY.md (already durable; do not promote duplicates of this)',
    identity.trim() || '(empty)',
    '',
    '## Notes to classify',
  ];
  for (const note of candidates) {
    sections.push(
      `- id: ${note.id}`,
      `  created_at: ${note.createdAt}`,
      `  title: ${note.title}`,
      `  content: ${clip(note.content)}`,
      `  reason: ${clip(note.reason)}`,
    );
  }
  sections.push('', 'Return JSON only.');
  return sections.join('\n');
}

/** Defensive parse of the model's JSON plan; unknown shapes yield null. */
export function parseSortPlan(content: string): Map<string, NoteAction> | null {
  const json = extractJsonObject(content);
  if (json === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const decisions = (parsed as { decisions?: unknown }).decisions;
  if (!Array.isArray(decisions)) return null;

  const plan = new Map<string, NoteAction>();
  for (const entry of decisions) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, action } = entry as { id?: unknown; action?: unknown };
    if (typeof id !== 'string' || id.length === 0) continue;
    if (action !== 'promote' && action !== 'archive' && action !== 'keep') continue;
    plan.set(id, action);
  }
  return plan;
}

function extractJsonObject(content: string): string | null {
  const trimmed = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return trimmed.slice(start, end + 1);
}

function clip(text: string): string {
  const flat = text.replace(/\n/g, ' ');
  return flat.length > PROMPT_CONTENT_CHARS ? `${flat.slice(0, PROMPT_CONTENT_CHARS)}…` : flat;
}

function formatArchivedNote(note: IdentityNote): string {
  return `Identity note from ${note.createdAt.slice(0, 10)} — ${note.title}: ${note.content} (why it was noted: ${note.reason})`;
}
