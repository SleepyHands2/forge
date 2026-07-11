import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { estimateTextTokens } from './chat-history.ts';

const HIGH_TRUST_FILES = ['IDENTITY.md', 'SOUL.md', 'USER.md'] as const;
const ALL_IDENTITY_FILES = [...HIGH_TRUST_FILES, 'NOTES.md'] as const;
// Keep-priority when identity exceeds its context budget: budget is granted in
// this order, so later entries are truncated or omitted first. Files not
// listed here (extra top-level .md files) come after NOTES.md and go first.
const CONTEXT_KEEP_PRIORITY = ['SOUL.md', 'IDENTITY.md', 'USER.md', 'NOTES.md'] as const;
// Below this many tokens a truncated remnant is useless; omit the file instead.
const MIN_TRUNCATED_CONTENT_TOKENS = 64;
const TRUNCATED_HEAD_NOTICE = '[Truncated by Forge: the rest of this file exceeded the identity context budget.]';
const TRUNCATED_TAIL_NOTICE = '[Truncated by Forge: older notes exceeded the identity context budget; the newest notes follow.]';
const OMITTED_NOTICE = '(omitted by Forge: identity context over budget)';
const NOTE_START = 'FORGE_NOTE_START';
const NOTE_END = 'FORGE_NOTE_END';
const PROPOSAL_START = 'FORGE_PROPOSAL_START';
const PROPOSAL_END = 'FORGE_PROPOSAL_END';
const MAX_TITLE_LENGTH = 80;
const MAX_CONTENT_LENGTH = 2000;
const MAX_REASON_LENGTH = 500;
const MAX_IDENTITY_FILE_BYTES = 512 * 1024;
const MAX_NOTES_BYTES = 512 * 1024;
const MAX_PENDING_PROPOSALS = 20;
const PREVIEW_LENGTH = 300;

export type IdentityFilename = typeof ALL_IDENTITY_FILES[number];
export type HighTrustIdentityFilename = typeof HIGH_TRUST_FILES[number];
export type ProposalStatus = 'pending' | 'approved' | 'rejected';

export interface IdentityNote {
  id: string;
  createdAt: string;
  title: string;
  content: string;
  reason: string;
}

export interface IdentityProposal {
  id: string;
  filename: HighTrustIdentityFilename;
  title: string;
  content: string;
  reason: string;
  normalizedHash: string;
  status: ProposalStatus;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  appliedHash: string | null;
}

export interface IdentityEvent {
  id: string;
  eventType: string;
  filename: string | null;
  proposalId: string | null;
  normalizedHash: string | null;
  preview: string;
  createdAt: string;
  metadata: string | null;
}

export interface IdentityFileRead {
  name: IdentityFilename;
  content: string;
  trust: 'high' | 'low';
  modelWritable: false | 'append-only';
}

export interface IdentityModelContextFileRead {
  name: string;
  content: string;
  trust: 'high' | 'low';
  modelWritable: false | 'append-only';
}

export interface IdentityContextFileReport {
  name: string;
  status: 'full' | 'truncated' | 'omitted';
  totalBytes: number;
  includedBytes: number;
}

export interface IdentityModelContextResult {
  text: string;
  /** The token budget the context was built against; undefined = unbudgeted. */
  budgetTokens?: number;
  /** Estimated tokens of the rendered text. */
  estimatedTokens: number;
  /** Estimated tokens the full, untruncated context would need. */
  neededTokens: number;
  truncated: boolean;
  files: IdentityContextFileReport[];
}

export class IdentityFileService {
  private readonly db: Database.Database;
  private readonly identityDir: string;

  constructor(options: { db: Database.Database; identityDir: string }) {
    this.db = options.db;
    this.identityDir = path.resolve(options.identityDir);
  }

  scaffold(templates: Partial<Record<IdentityFilename, string>> = {}): void {
    this.ensureIdentityDir();
    this.ensureFile('IDENTITY.md', templates['IDENTITY.md'] ?? '# Identity\n\n');
    this.ensureFile('SOUL.md', templates['SOUL.md'] ?? '# Soul\n\n');
    this.ensureFile('USER.md', templates['USER.md'] ?? '# User\n\n');
    this.ensureFile(
      'NOTES.md',
      templates['NOTES.md'] ?? [
        '# Notes',
        '',
        'Lower-trust working notes. These are excluded from the core identity read and require review before promotion.',
        '',
      ].join('\n'),
    );
  }

  readIdentity(): Record<HighTrustIdentityFilename, string> {
    this.scaffold();
    return {
      'IDENTITY.md': this.readAllowedFile('IDENTITY.md'),
      'SOUL.md': this.readAllowedFile('SOUL.md'),
      'USER.md': this.readAllowedFile('USER.md'),
    };
  }

  readAllFiles(): IdentityFileRead[] {
    this.scaffold();
    return ALL_IDENTITY_FILES.map(name => ({
      name,
      content: this.readAllowedFile(name),
      trust: isHighTrustFilename(name) ? 'high' : 'low',
      modelWritable: isHighTrustFilename(name) ? false : 'append-only',
    }));
  }

  readModelContextFiles(): IdentityModelContextFileRead[] {
    this.scaffold();
    return this.discoverModelContextFilenames().map(name => ({
      name,
      content: this.readModelContextFile(name),
      trust: isHighTrustFilename(name) ? 'high' : 'low',
      modelWritable: name === 'NOTES.md' ? 'append-only' : false,
    }));
  }

  readModelContext(): string {
    return this.buildModelContext().text;
  }

  /**
   * Render the identity markdown context, optionally capped to a token
   * budget. Over budget, files are cut lowest-keep-priority first (extras,
   * then NOTES.md, USER.md, IDENTITY.md, SOUL.md): the file on the boundary
   * is truncated with a visible notice — NOTES.md keeps its newest tail,
   * everything else keeps its head — and files past it are reduced to an
   * omission stub. Without a budget the output is the full legacy context.
   */
  buildModelContext(budgetTokens?: number): IdentityModelContextResult {
    const files = this.readModelContextFiles();
    const headerLines = [
      '## Identity Markdown Context',
      'Forge provides the local model read-only context from safe top-level Markdown files in the identity directory.',
      'Changes to IDENTITY.md, SOUL.md, and USER.md require user approval through pending identity proposals.',
      'The model must not claim it directly edited IDENTITY.md, SOUL.md, or USER.md.',
      '',
    ];
    const headerTokens = linesTokens(headerLines);

    interface Section {
      file: IdentityModelContextFileRead;
      body: string;
      lines: string[];
      fullTokens: number;
      status: 'full' | 'truncated' | 'omitted';
      totalBytes: number;
      includedBytes: number;
    }

    const sections: Section[] = files.map(file => {
      const body = file.content.trim() || '(empty)';
      const lines = sectionLines(file, body);
      const bodyBytes = Buffer.byteLength(body, 'utf-8');
      return {
        file,
        body,
        lines,
        fullTokens: linesTokens(lines),
        status: 'full',
        totalBytes: bodyBytes,
        includedBytes: bodyBytes,
      };
    });

    const neededTokens = headerTokens + sections.reduce((sum, s) => sum + s.fullTokens, 0);

    if (budgetTokens !== undefined && neededTokens > budgetTokens) {
      let remaining = Math.max(0, budgetTokens - headerTokens);
      const byPriority = [...sections].sort(
        (a, b) => contextKeepPriority(a.file.name) - contextKeepPriority(b.file.name),
      );

      for (const section of byPriority) {
        if (section.fullTokens <= remaining) {
          remaining -= section.fullTokens;
          continue;
        }

        // Truncate the boundary file into whatever allowance is left. The
        // notice and section scaffold are costed in bytes first (3 bytes ≈
        // 1 token, plus slack for the ceil) so the result stays under budget.
        const keep = section.file.name === 'NOTES.md' ? 'tail' : 'head';
        const notice = keep === 'tail' ? TRUNCATED_TAIL_NOTICE : TRUNCATED_HEAD_NOTICE;
        const overheadBytes =
          Buffer.byteLength(`${sectionLines(section.file, '').join('\n')}\n`, 'utf-8') +
          Buffer.byteLength(`${notice}\n\n`, 'utf-8');
        const allowedBodyBytes = remaining * 3 - overheadBytes - 3;

        if (allowedBodyBytes >= MIN_TRUNCATED_CONTENT_TOKENS * 3) {
          const kept = sliceBytes(section.body, allowedBodyBytes, keep);
          const truncatedBody = keep === 'tail'
            ? `${notice}\n\n${kept}`
            : `${kept}\n\n${notice}`;
          section.lines = sectionLines(section.file, truncatedBody);
          section.status = 'truncated';
          section.includedBytes = Buffer.byteLength(kept, 'utf-8');
          remaining -= linesTokens(section.lines);
          continue;
        }

        // Not enough room for a useful remnant: keep a stub naming the file
        // if even that fits, so the model knows the file exists.
        const stubLines = sectionLines(section.file, OMITTED_NOTICE);
        const stubTokens = linesTokens(stubLines);
        section.status = 'omitted';
        section.includedBytes = 0;
        if (stubTokens <= remaining) {
          section.lines = stubLines;
          remaining -= stubTokens;
        } else {
          section.lines = [];
        }
      }
    }

    const text = [...headerLines, ...sections.flatMap(s => s.lines)].join('\n').trimEnd();

    return {
      text,
      ...(budgetTokens !== undefined ? { budgetTokens } : {}),
      estimatedTokens: estimateTextTokens(text),
      neededTokens,
      truncated: sections.some(s => s.status !== 'full'),
      files: sections.map(s => ({
        name: s.file.name,
        status: s.status,
        totalBytes: s.totalBytes,
        includedBytes: s.includedBytes,
      })),
    };
  }

  writeManualFile(filename: string, content: string): IdentityFileRead {
    this.scaffold();
    const safe = this.validateFilename(filename);
    if (typeof content !== 'string') throw new Error('Identity file content is required');
    if (Buffer.byteLength(content, 'utf-8') > MAX_IDENTITY_FILE_BYTES) {
      throw new Error('Identity file exceeds maximum size');
    }

    this.atomicWrite(this.resolveAllowedPath(safe), content);
    this.recordEvent('manual_file_edit', {
      filename: safe,
      preview: content,
      metadata: { bytes: Buffer.byteLength(content, 'utf-8') },
    });

    return {
      name: safe,
      content,
      trust: isHighTrustFilename(safe) ? 'high' : 'low',
      modelWritable: isHighTrustFilename(safe) ? false : 'append-only',
    };
  }

  readRecentNotes(limit: number): IdentityNote[] {
    this.scaffold();
    const safeLimit = Math.max(0, Math.floor(limit));
    if (safeLimit === 0) return [];

    return this.parseNotes(this.readAllowedFile('NOTES.md'))
      .reverse()
      .slice(0, safeLimit);
  }

  /** Every note in NOTES.md, oldest first (file order). */
  listNotes(): IdentityNote[] {
    this.scaffold();
    return this.parseNotes(this.readAllowedFile('NOTES.md'));
  }

  /**
   * Rewrite NOTES.md to exactly the given notes (in the order provided),
   * under the canonical header plus an optional standing pointer line.
   * Note blocks keep their original id/created_at and re-derive the content
   * hash, so parsing and dedupe behave as if the notes were appended. Any
   * freeform text outside note blocks is replaced by the canonical header.
   */
  replaceNotes(input: { keep: IdentityNote[]; pointer?: string }): void {
    this.scaffold();
    const before = this.parseNotes(this.readAllowedFile('NOTES.md'));

    const next = renderNotesFile(input.keep, input.pointer);
    if (Buffer.byteLength(next, 'utf-8') > MAX_NOTES_BYTES) {
      throw new Error('NOTES.md exceeds maximum size');
    }

    this.atomicWrite(this.resolveAllowedPath('NOTES.md'), next);
    this.recordEvent('notes_replaced', {
      filename: 'NOTES.md',
      preview: `kept ${input.keep.length} of ${before.length} notes`,
      metadata: {
        keptIds: input.keep.map(note => note.id),
        removed: before.length - input.keep.length,
      },
    });
  }

  appendNote(input: { title: string; content: string; reason: string }): { status: 'appended' | 'duplicate'; id: string | null; hash: string } {
    this.scaffold();
    const clean = this.validateTextInput(input);
    const hash = normalizedHash(clean.content);

    if (this.noteHashExists(hash)) {
      this.recordEvent('note_duplicate', {
        filename: 'NOTES.md',
        normalizedHash: hash,
        preview: clean.content,
      });
      return { status: 'duplicate', id: null, hash };
    }

    const id = genId();
    const createdAt = now();
    const entry = renderNoteBlock({ id, createdAt, title: clean.title, content: clean.content, reason: clean.reason });

    const filePath = this.resolveAllowedPath('NOTES.md');
    const current = this.readFileIfExists(filePath);
    const next = `${current}${current.endsWith('\n') || current.length === 0 ? '' : '\n'}${entry}`;
    if (Buffer.byteLength(next, 'utf-8') > MAX_NOTES_BYTES) {
      throw new Error('NOTES.md exceeds maximum size');
    }

    this.atomicWrite(filePath, next);
    this.recordEvent('note_appended', {
      filename: 'NOTES.md',
      normalizedHash: hash,
      preview: clean.content,
      metadata: { noteId: id, title: clean.title },
    });

    return { status: 'appended', id, hash };
  }

  createProposal(input: {
    filename: string;
    title: string;
    content: string;
    reason: string;
  }): { status: 'created' | 'duplicate'; proposal: IdentityProposal | null; existingId: string | null; hash: string } {
    this.scaffold();
    const filename = this.validateHighTrustFilename(input.filename);
    const clean = this.validateTextInput(input);
    const hash = normalizedHash(clean.content);

    if (this.normalizedFileContent(filename).includes(normalizedContent(clean.content))) {
      this.recordEvent('proposal_content_present', {
        filename,
        normalizedHash: hash,
        preview: clean.content,
      });
      return { status: 'duplicate', proposal: null, existingId: null, hash };
    }

    const existing = this.db.prepare(`
      SELECT * FROM identity_proposals
      WHERE normalized_hash = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(hash) as RawProposalRow | undefined;

    if (existing) {
      this.recordEvent('proposal_duplicate_skipped', {
        filename,
        proposalId: existing.id,
        normalizedHash: hash,
        preview: clean.content,
      });
      return { status: 'duplicate', proposal: null, existingId: existing.id, hash };
    }

    const pendingCount = this.db.prepare(`
      SELECT COUNT(*) AS count FROM identity_proposals WHERE status = 'pending'
    `).get() as { count: number };
    if (pendingCount.count >= MAX_PENDING_PROPOSALS) {
      throw new Error('Maximum pending identity proposals reached');
    }

    const id = genId();
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO identity_proposals
        (id, filename, title, content, reason, normalized_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, filename, clean.title, clean.content, clean.reason, hash, timestamp, timestamp);

    this.recordEvent('proposal_created', {
      filename,
      proposalId: id,
      normalizedHash: hash,
      preview: clean.content,
      metadata: { title: clean.title },
    });

    return {
      status: 'created',
      proposal: this.getProposal(id),
      existingId: null,
      hash,
    };
  }

  listPendingProposals(): IdentityProposal[] {
    return this.listProposals('pending');
  }

  listProposals(status: ProposalStatus | 'all' = 'pending'): IdentityProposal[] {
    if (status === 'all') {
      const rows = this.db.prepare(`
        SELECT * FROM identity_proposals
        ORDER BY created_at ASC
      `).all() as RawProposalRow[];
      return rows.map(toProposal);
    }

    const rows = this.db.prepare(`
      SELECT * FROM identity_proposals
      WHERE status = ?
      ORDER BY created_at ASC
    `).all(status) as RawProposalRow[];
    return rows.map(toProposal);
  }

  getProposal(id: string): IdentityProposal | null {
    const row = this.db.prepare('SELECT * FROM identity_proposals WHERE id = ?').get(id) as RawProposalRow | undefined;
    return row ? toProposal(row) : null;
  }

  approveProposal(id: string, edit?: Partial<Pick<IdentityProposal, 'title' | 'content' | 'reason'>>): { status: 'approved' | 'already_approved'; proposal: IdentityProposal } {
    const existing = this.getProposal(id);
    if (!existing) throw new Error('Identity proposal not found');
    if (existing.status === 'approved') {
      return { status: 'already_approved', proposal: existing };
    }
    if (existing.status === 'rejected') {
      throw new Error('Rejected identity proposal cannot be approved');
    }

    const clean = this.validateTextInput({
      title: edit?.title ?? existing.title,
      content: edit?.content ?? existing.content,
      reason: edit?.reason ?? existing.reason,
    });
    const appliedHash = normalizedHash(clean.content);
    const approvedAt = now();
    const filePath = this.resolveAllowedPath(existing.filename);
    const current = this.readFileIfExists(filePath);

    if (!this.normalizedFileContent(existing.filename).includes(normalizedContent(clean.content))) {
      const section = [
        '',
        `<!-- ${PROPOSAL_START} id="${id}" approved_at="${approvedAt}" hash="${appliedHash}" -->`,
        `## ${clean.title}`,
        '',
        clean.content,
        '',
        `Reason: ${clean.reason}`,
        `<!-- ${PROPOSAL_END} -->`,
        '',
      ].join('\n');
      this.atomicWrite(filePath, `${current}${current.endsWith('\n') || current.length === 0 ? '' : '\n'}${section}`);
    }

    this.db.prepare(`
      UPDATE identity_proposals
      SET title = ?, content = ?, reason = ?, normalized_hash = ?, status = 'approved',
          updated_at = ?, approved_at = ?, applied_hash = ?
      WHERE id = ?
    `).run(clean.title, clean.content, clean.reason, appliedHash, approvedAt, approvedAt, appliedHash, id);

    this.recordEvent('proposal_approved', {
      filename: existing.filename,
      proposalId: id,
      normalizedHash: appliedHash,
      preview: clean.content,
      metadata: { edited: Boolean(edit?.title || edit?.content || edit?.reason) },
    });

    const proposal = this.getProposal(id);
    if (!proposal) throw new Error('Identity proposal disappeared after approval');
    return { status: 'approved', proposal };
  }

  rejectProposal(id: string): { status: 'rejected' | 'already_rejected'; proposal: IdentityProposal } {
    const existing = this.getProposal(id);
    if (!existing) throw new Error('Identity proposal not found');
    if (existing.status === 'rejected') {
      return { status: 'already_rejected', proposal: existing };
    }
    if (existing.status === 'approved') {
      throw new Error('Approved identity proposal cannot be rejected');
    }

    const rejectedAt = now();
    this.db.prepare(`
      UPDATE identity_proposals
      SET status = 'rejected', updated_at = ?, rejected_at = ?
      WHERE id = ?
    `).run(rejectedAt, rejectedAt, id);

    this.recordEvent('proposal_rejected', {
      filename: existing.filename,
      proposalId: id,
      normalizedHash: existing.normalizedHash,
      preview: existing.content,
    });

    const proposal = this.getProposal(id);
    if (!proposal) throw new Error('Identity proposal disappeared after rejection');
    return { status: 'rejected', proposal };
  }

  listEvents(limit?: number): IdentityEvent[] {
    const safeLimit = limit === undefined ? null : Math.max(0, Math.floor(limit));
    if (safeLimit === 0) return [];
    if (safeLimit !== null) {
      const rows = this.db.prepare(`
        SELECT * FROM identity_events ORDER BY created_at DESC, rowid DESC LIMIT ?
      `).all(safeLimit) as RawEventRow[];
      return rows.reverse().map(toEvent);
    }

    const rows = this.db.prepare(`
      SELECT * FROM identity_events ORDER BY created_at ASC, rowid ASC
    `).all() as RawEventRow[];
    return rows.map(toEvent);
  }

  private validateTextInput(input: { title: string; content: string; reason: string }): { title: string; content: string; reason: string } {
    const title = input.title.trim();
    const content = input.content.trim();
    const reason = input.reason.trim();

    if (!title || !content || !reason) throw new Error('Identity text fields are required');
    if (title.length > MAX_TITLE_LENGTH) throw new Error('Identity title exceeds maximum length');
    if (content.length > MAX_CONTENT_LENGTH) throw new Error('Identity content exceeds maximum length');
    if (reason.length > MAX_REASON_LENGTH) throw new Error('Identity reason exceeds maximum length');

    for (const value of [title, content, reason]) {
      if (value.includes(NOTE_START) || value.includes(NOTE_END) || value.includes(PROPOSAL_START) || value.includes(PROPOSAL_END)) {
        throw new Error('Identity text cannot contain Forge delimiters');
      }
    }

    return { title, content, reason };
  }

  private validateHighTrustFilename(filename: string): HighTrustIdentityFilename {
    const safe = this.validateFilename(filename);
    if (!isHighTrustFilename(safe)) {
      throw new Error('Identity proposals are only supported for high-trust identity files');
    }
    return safe;
  }

  private validateFilename(filename: string): IdentityFilename {
    if (filename.includes('\0')) throw new Error('Identity filename cannot contain null bytes');
    if (path.isAbsolute(filename)) throw new Error('Identity filename must be relative');
    if (filename.includes('/') || filename.includes('\\')) throw new Error('Identity filename cannot contain path separators');

    try {
      const decoded = decodeURIComponent(filename);
      if (decoded !== filename && (decoded.includes('/') || decoded.includes('\\') || decoded.includes('..') || path.isAbsolute(decoded))) {
        throw new Error('Identity filename cannot contain encoded traversal');
      }
    } catch {
      throw new Error('Identity filename must be valid URL encoding');
    }

    if (filename.includes('..')) throw new Error('Identity filename cannot contain traversal');
    if (!isIdentityFilename(filename)) throw new Error('Identity filename is not allowlisted');
    return filename;
  }

  private resolveAllowedPath(filename: string): string {
    const safe = this.validateFilename(filename);
    this.ensureIdentityDir();
    const target = path.resolve(this.identityDir, safe);
    const rootWithSeparator = `${this.identityDir}${path.sep}`;
    if (!target.startsWith(rootWithSeparator)) {
      throw new Error('Identity file target escapes identity directory');
    }

    if (fs.existsSync(target)) {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error('Identity file cannot be a symlink');
      const realTarget = fs.realpathSync(target);
      const realRoot = fs.realpathSync(this.identityDir);
      if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`)) {
        throw new Error('Identity file target is outside identity directory');
      }
    }

    return target;
  }

  private ensureIdentityDir(): void {
    fs.mkdirSync(this.identityDir, { recursive: true });
    const stat = fs.lstatSync(this.identityDir);
    if (stat.isSymbolicLink()) throw new Error('Identity directory cannot be a symlink');
  }

  private ensureFile(filename: IdentityFilename, content: string): void {
    const filePath = this.resolveAllowedPath(filename);
    if (!fs.existsSync(filePath)) {
      this.atomicWrite(filePath, content);
    }
  }

  private readAllowedFile(filename: IdentityFilename): string {
    return this.readFileIfExists(this.resolveAllowedPath(filename));
  }

  private discoverModelContextFilenames(): string[] {
    const entries = fs.readdirSync(this.identityDir, { withFileTypes: true });
    const discovered = new Set<string>();

    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      if (!isSafeModelContextFilename(entry.name)) continue;

      const filePath = this.resolveModelContextPath(entry.name);
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (stat.size > MAX_IDENTITY_FILE_BYTES) continue;

      discovered.add(entry.name);
    }

    const ordered: string[] = [];
    for (const name of ALL_IDENTITY_FILES) {
      if (discovered.has(name)) {
        ordered.push(name);
        discovered.delete(name);
      }
    }

    return [
      ...ordered,
      ...[...discovered].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
    ];
  }

  private readModelContextFile(filename: string): string {
    if (isIdentityFilename(filename)) return this.readAllowedFile(filename);
    return this.readFileIfExists(this.resolveModelContextPath(filename));
  }

  private resolveModelContextPath(filename: string): string {
    if (!isSafeModelContextFilename(filename)) {
      throw new Error('Identity context filename is not safe');
    }

    this.ensureIdentityDir();
    const target = path.resolve(this.identityDir, filename);
    const rootWithSeparator = `${this.identityDir}${path.sep}`;
    if (!target.startsWith(rootWithSeparator)) {
      throw new Error('Identity context file target escapes identity directory');
    }

    if (fs.existsSync(target)) {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error('Identity context file cannot be a symlink');
      if (!stat.isFile()) throw new Error('Identity context file must be a regular file');
      if (stat.size > MAX_IDENTITY_FILE_BYTES) throw new Error('Identity context file exceeds maximum size');
      const realTarget = fs.realpathSync(target);
      const realRoot = fs.realpathSync(this.identityDir);
      if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`)) {
        throw new Error('Identity context file target is outside identity directory');
      }
    }

    return target;
  }

  private readFileIfExists(filePath: string): string {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf-8');
  }

  private parseNotes(markdown: string): IdentityNote[] {
    const notes: IdentityNote[] = [];
    const pattern = /<!-- FORGE_NOTE_START id="([^"]+)" created_at="([^"]+)" hash="[^"]+" -->\n## ([^\n]+)\n\n([\s\S]*?)\n\nReason: ([\s\S]*?)\n<!-- FORGE_NOTE_END -->/g;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(markdown)) !== null) {
      notes.push({
        id: match[1],
        createdAt: match[2],
        title: match[3],
        content: match[4],
        reason: match[5],
      });
    }

    return notes;
  }

  private noteHashExists(hash: string): boolean {
    const notes = this.parseNotes(this.readAllowedFile('NOTES.md'));
    return notes.some(note => normalizedHash(note.content) === hash);
  }

  private normalizedFileContent(filename: HighTrustIdentityFilename): string {
    return normalizedContent(this.readAllowedFile(filename));
  }

  private atomicWrite(filePath: string, content: string): void {
    const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(tempPath, content, { encoding: 'utf-8', flag: 'wx' });
    fs.renameSync(tempPath, filePath);
  }

  private recordEvent(eventType: string, input: {
    filename?: string;
    proposalId?: string;
    normalizedHash?: string;
    preview: string;
    metadata?: Record<string, unknown>;
  }): void {
    this.db.prepare(`
      INSERT INTO identity_events
        (id, event_type, filename, proposal_id, normalized_hash, preview, created_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      genId(),
      eventType,
      input.filename ?? null,
      input.proposalId ?? null,
      input.normalizedHash ?? null,
      preview(input.preview),
      now(),
      input.metadata ? JSON.stringify(input.metadata) : null,
    );
  }
}

function isIdentityFilename(filename: string): filename is IdentityFilename {
  return (ALL_IDENTITY_FILES as readonly string[]).includes(filename);
}

function isHighTrustFilename(filename: string): filename is HighTrustIdentityFilename {
  return (HIGH_TRUST_FILES as readonly string[]).includes(filename);
}

/**
 * The full NOTES.md content replaceNotes would write for these notes.
 * Exported so notes maintenance can project the file size while deciding
 * what to keep, without duplicating the format.
 */
export function renderNotesFile(keep: IdentityNote[], pointer?: string): string {
  const parts = [
    '# Notes',
    '',
    'Lower-trust working notes. These are excluded from the core identity read and require review before promotion.',
    '',
  ];
  const cleanPointer = pointer?.trim();
  if (cleanPointer) {
    parts.push(cleanPointer, '');
  }
  for (const note of keep) {
    parts.push(renderNoteBlock(note));
  }
  return parts.join('\n');
}

/** One FORGE_NOTE block (with trailing newline) in the exact appendNote format. */
function renderNoteBlock(note: IdentityNote): string {
  return [
    `<!-- ${NOTE_START} id="${note.id}" created_at="${note.createdAt}" hash="${normalizedHash(note.content)}" -->`,
    `## ${note.title}`,
    '',
    note.content,
    '',
    `Reason: ${note.reason}`,
    `<!-- ${NOTE_END} -->`,
    '',
  ].join('\n');
}

function sectionLines(file: IdentityModelContextFileRead, body: string): string[] {
  return [
    `### ${file.name}`,
    `Trust: ${file.trust}`,
    `Model writable: ${file.modelWritable === 'append-only' ? 'append-only' : 'no'}`,
    '',
    body,
    '',
  ];
}

// Token cost these lines contribute to the joined context (join adds '\n').
function linesTokens(lines: string[]): number {
  return estimateTextTokens(`${lines.join('\n')}\n`);
}

function contextKeepPriority(filename: string): number {
  const index = (CONTEXT_KEEP_PRIORITY as readonly string[]).indexOf(filename);
  return index === -1 ? CONTEXT_KEEP_PRIORITY.length : index;
}

/** Cut text to at most maxBytes of UTF-8, never splitting a multi-byte char. */
function sliceBytes(text: string, maxBytes: number, keep: 'head' | 'tail'): string {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= maxBytes) return text;
  if (maxBytes <= 0) return '';

  if (keep === 'head') {
    let end = maxBytes;
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
    return buf.subarray(0, end).toString('utf-8');
  }

  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString('utf-8');
}

function isSafeModelContextFilename(filename: string): boolean {
  if (!filename || filename.startsWith('.')) return false;
  if (filename.includes('\0')) return false;
  if (path.isAbsolute(filename)) return false;
  if (filename.includes('/') || filename.includes('\\')) return false;
  if (filename.includes('..')) return false;
  if (filename.includes(':')) return false;
  if (/[\x00-\x1F\x7F]/.test(filename)) return false;
  return path.extname(filename).toLowerCase() === '.md';
}

function normalizedContent(content: string): string {
  return content.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizedHash(content: string): string {
  return crypto.createHash('sha256').update(normalizedContent(content)).digest('hex');
}

function preview(content: string): string {
  return content.slice(0, PREVIEW_LENGTH);
}

function genId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

function toProposal(row: RawProposalRow): IdentityProposal {
  return {
    id: row.id,
    filename: row.filename as HighTrustIdentityFilename,
    title: row.title,
    content: row.content,
    reason: row.reason,
    normalizedHash: row.normalized_hash,
    status: row.status as ProposalStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvedAt: row.approved_at,
    rejectedAt: row.rejected_at,
    appliedHash: row.applied_hash,
  };
}

function toEvent(row: RawEventRow): IdentityEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    filename: row.filename,
    proposalId: row.proposal_id,
    normalizedHash: row.normalized_hash,
    preview: row.preview,
    createdAt: row.created_at,
    metadata: row.metadata,
  };
}

interface RawProposalRow {
  id: string;
  filename: string;
  title: string;
  content: string;
  reason: string;
  normalized_hash: string;
  status: string;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  rejected_at: string | null;
  applied_hash: string | null;
}

interface RawEventRow {
  id: string;
  event_type: string;
  filename: string | null;
  proposal_id: string | null;
  normalized_hash: string | null;
  preview: string;
  created_at: string;
  metadata: string | null;
}
