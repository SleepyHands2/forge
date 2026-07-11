import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { IdentityFileService } from './identity-files.ts';
import {
  IdentityNotesMaintenanceService,
  NOTES_ARCHIVE_POINTER,
  parseSortPlan,
} from './identity-notes-maintenance.ts';
import type { SaveMemoryInput } from './memory.ts';
import type { ForgeConfig, LLMRequest, LLMResponse } from '../types.ts';

const SCHEMA = fs.readFileSync(
  new URL('../db/schemas/messages.sql', import.meta.url),
  'utf-8',
);

function config(notesMaintenance: Record<string, unknown> = {}): ForgeConfig {
  return {
    forge: { name: 'forge-local', version: '0.1.0', root: '.' },
    user: { name: 'tester' },
    llm: {
      provider: 'ollama',
      model: 'local-model',
      ollama: { base_url: 'http://localhost:11434', keep_alive: '10m', options: {} },
    },
    paths: { dbs: './dbs', identity: './identity', logs: './logs' },
    services: { web: { host: '127.0.0.1', port: 6800, context_window_tokens: 80000, debug_prompt_context: false } },
    memory: { retention_days: 30 },
    identity: {
      reflection: { enabled: false, cadence_turns: 1, recent_notes_in_context: 5 },
      notes_maintenance: {
        enabled: true,
        interval_days: 1,
        max_bytes: 2048,
        keep_recent: 1,
        max_promotions: 2,
        ...notesMaintenance,
      },
    },
  } as ForgeConfig;
}

interface Env {
  service: IdentityNotesMaintenanceService;
  identityFiles: IdentityFileService;
  saves: SaveMemoryInput[];
  llmCalls: () => number;
  llmRequests: LLMRequest[];
  notesRaw: () => string;
  cleanup: () => void;
}

function makeEnv(options: {
  notesMaintenance?: Record<string, unknown>;
  llmContent?: () => string;
  saveImpl?: (input: SaveMemoryInput) => Promise<string>;
} = {}): Env {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-notes-maint-'));
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  const identityFiles = new IdentityFileService({ db, identityDir: dir });
  identityFiles.scaffold();

  const saves: SaveMemoryInput[] = [];
  const llmRequests: LLMRequest[] = [];
  const service = new IdentityNotesMaintenanceService({
    config: config(options.notesMaintenance),
    identityFiles,
    memory: {
      save: async (input: SaveMemoryInput): Promise<string> => {
        if (options.saveImpl) return options.saveImpl(input);
        saves.push(input);
        return `mem-${saves.length}`;
      },
    },
    llm: {
      complete: async (request: LLMRequest): Promise<LLMResponse> => {
        llmRequests.push(request);
        if (!options.llmContent) throw new Error('unexpected LLM call');
        return { content: options.llmContent(), provider: 'ollama', model: 'test', inputTokens: 0, outputTokens: 0 };
      },
    },
    logger: { warn: () => {} },
  });

  return {
    service,
    identityFiles,
    saves,
    llmCalls: () => llmRequests.length,
    llmRequests,
    notesRaw: () => fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf-8'),
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Appends `count` distinct ~600-byte notes and returns them oldest first. */
function seedNotes(identityFiles: IdentityFileService, count: number): ReturnType<IdentityFileService['listNotes']> {
  for (let index = 1; index <= count; index += 1) {
    identityFiles.appendNote({
      title: `Note ${index}`,
      content: `note-${index}-content ${'x'.repeat(560)}`,
      reason: `reason ${index}`,
    });
  }
  return identityFiles.listNotes();
}

describe('IdentityNotesMaintenanceService', () => {
  it('reports disabled without touching anything when the feature is off', async () => {
    const env = makeEnv({ notesMaintenance: { enabled: false } });
    try {
      seedNotes(env.identityFiles, 4);
      const before = env.notesRaw();

      const result = await env.service.run();

      assert.equal(result.status, 'disabled');
      assert.equal(env.service.enabled(), false);
      assert.equal(env.llmCalls(), 0);
      assert.equal(env.notesRaw(), before);
    } finally {
      env.cleanup();
    }
  });

  it('skips without an LLM call while NOTES.md is under max_bytes', async () => {
    const env = makeEnv();
    try {
      const result = await env.service.run();

      assert.equal(result.status, 'under_budget');
      assert.equal(env.llmCalls(), 0);
      assert.equal(env.saves.length, 0);
    } finally {
      env.cleanup();
    }
  });

  it('applies the three-way sort: promote proposes and archives, archive saves to memory, keep stays', async () => {
    let planJson = '';
    const env = makeEnv({ llmContent: () => planJson });
    try {
      const notes = seedNotes(env.identityFiles, 4);
      planJson = JSON.stringify({
        decisions: [
          { id: notes[0].id, action: 'promote' },
          { id: notes[1].id, action: 'archive' },
          { id: notes[2].id, action: 'keep' },
        ],
      });

      const result = await env.service.run();

      assert.equal(result.status, 'ok');
      assert.equal(result.promoted, 1);
      assert.equal(result.archived, 2);
      assert.equal(result.kept, 2);

      const pending = env.identityFiles.listPendingProposals();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].filename, 'IDENTITY.md');
      assert.equal(pending[0].title, 'Note 1');

      // The sort call raises num_predict (hidden thinking tokens count
      // against it) and pins a low temperature for stable JSON.
      assert.equal(env.llmRequests.length, 1);
      assert.deepEqual(env.llmRequests[0].options, { num_predict: 3072, temperature: 0.2 });

      assert.equal(env.saves.length, 2);
      for (const save of env.saves) {
        assert.equal(save.type, 'identity-note');
        assert.deepEqual(save.tags, ['identity-note']);
      }
      assert.ok(env.saves.some(save => save.content.includes('note-1-content')));
      assert.ok(env.saves.some(save => save.content.includes('note-2-content')));

      const raw = env.notesRaw();
      assert.ok(raw.includes(NOTES_ARCHIVE_POINTER));
      assert.doesNotMatch(raw, /note-1-content/);
      assert.doesNotMatch(raw, /note-2-content/);
      assert.match(raw, /note-3-content/);
      assert.match(raw, /note-4-content/);
    } finally {
      env.cleanup();
    }
  });

  it('changes nothing when the model output is not a parseable plan', async () => {
    const env = makeEnv({ llmContent: () => 'I would rather not classify these notes.' });
    try {
      seedNotes(env.identityFiles, 4);
      const before = env.notesRaw();

      const result = await env.service.run();

      assert.equal(result.status, 'no_output');
      assert.equal(env.saves.length, 0);
      assert.equal(env.notesRaw(), before);
      assert.deepEqual(env.identityFiles.listPendingProposals(), []);
    } finally {
      env.cleanup();
    }
  });

  it('keeps a note in NOTES.md when its archive save fails', async () => {
    let planJson = '';
    const saved: SaveMemoryInput[] = [];
    const env = makeEnv({
      llmContent: () => planJson,
      saveImpl: async (input) => {
        if (input.content.includes('note-1-content')) throw new Error('memory store offline');
        saved.push(input);
        return `mem-${saved.length}`;
      },
    });
    try {
      const notes = seedNotes(env.identityFiles, 4);
      planJson = JSON.stringify({
        decisions: [
          { id: notes[0].id, action: 'archive' },
          { id: notes[1].id, action: 'archive' },
        ],
      });

      const result = await env.service.run();

      assert.equal(result.status, 'ok');
      assert.equal(result.archived, 1);
      assert.equal(result.kept, 3);
      assert.match(env.notesRaw(), /note-1-content/);
      assert.doesNotMatch(env.notesRaw(), /note-2-content/);
    } finally {
      env.cleanup();
    }
  });

  it('archives the oldest kept candidates mechanically when the plan leaves the file over budget', async () => {
    let planJson = '';
    const env = makeEnv({ llmContent: () => planJson });
    try {
      const notes = seedNotes(env.identityFiles, 4);
      planJson = JSON.stringify({
        decisions: notes.slice(0, 3).map(note => ({ id: note.id, action: 'keep' })),
      });

      const result = await env.service.run();

      assert.equal(result.status, 'ok');
      assert.equal(result.promoted, 0);
      assert.ok(result.archived >= 1, 'expected the overflow guard to archive at least one note');
      assert.ok(env.saves.some(save => save.content.includes('note-1-content')), 'oldest note archived first');
      // The protected working set (newest note) always survives.
      assert.match(env.notesRaw(), /note-4-content/);
      assert.ok(Buffer.byteLength(env.notesRaw(), 'utf-8') <= 2048);
    } finally {
      env.cleanup();
    }
  });

  it('caps promotions at max_promotions and archives the overflow anyway', async () => {
    let planJson = '';
    const env = makeEnv({ notesMaintenance: { max_promotions: 1 }, llmContent: () => planJson });
    try {
      const notes = seedNotes(env.identityFiles, 4);
      planJson = JSON.stringify({
        decisions: [
          { id: notes[0].id, action: 'promote' },
          { id: notes[1].id, action: 'promote' },
          { id: notes[2].id, action: 'archive' },
        ],
      });

      const result = await env.service.run();

      assert.equal(result.promoted, 1);
      assert.equal(result.archived, 3);
      assert.equal(env.identityFiles.listPendingProposals().length, 1);
    } finally {
      env.cleanup();
    }
  });
});

describe('parseSortPlan', () => {
  it('parses plain and fenced JSON and ignores malformed entries', () => {
    const fenced = '```json\n{"decisions":[{"id":"a","action":"archive"},{"id":"","action":"keep"},{"id":"b","action":"burn"},{"id":"c","action":"promote"}]}\n```';
    const plan = parseSortPlan(fenced);
    assert.ok(plan);
    assert.equal(plan.get('a'), 'archive');
    assert.equal(plan.get('c'), 'promote');
    assert.equal(plan.size, 2);
  });

  it('returns null for non-JSON output or a missing decisions array', () => {
    assert.equal(parseSortPlan('no json here'), null);
    assert.equal(parseSortPlan('{"decisions":"nope"}'), null);
  });
});
