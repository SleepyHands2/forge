import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { ChatMessage, ForgeConfig, LLMRequest } from '../types.ts';
import { IdentityFileService } from './identity-files.ts';
import { IdentityReflectionService } from './identity-reflection.ts';

const SCHEMA = fs.readFileSync(
  new URL('../db/schemas/messages.sql', import.meta.url),
  'utf-8',
);

interface Harness {
  db: Database.Database;
  dir: string;
  identityFiles: IdentityFileService;
  service: IdentityReflectionService;
  llmCalls: LLMRequest[];
  warnings: unknown[][];
  setLlmContent: (content: string) => void;
}

function config(cadenceTurns = 1): ForgeConfig {
  return {
    forge: { name: 'forge-local', version: '0.1.0', root: '.' },
    user: { name: 'Alice' },
    llm: {
      provider: 'ollama',
      model: 'local-model',
      ollama: { base_url: 'http://localhost:11434', keep_alive: '10m', options: {} },
    },
    paths: { dbs: './dbs', identity: './identity', logs: './logs' },
    services: { web: { host: '127.0.0.1', port: 6800, context_window_tokens: 80000, debug_prompt_context: false } },
    memory: { retention_days: 30 },
    identity: { reflection: { enabled: true, cadence_turns: cadenceTurns, recent_notes_in_context: 2 } },
  };
}

async function withHarness(
  fn: (harness: Harness) => Promise<void> | void,
  options: { cadenceTurns?: number } = {},
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-reflection-'));
  const db = new Database(':memory:');
  db.exec(SCHEMA);

  let llmContent = '{"notes":[],"proposals":[]}';
  const llmCalls: LLMRequest[] = [];
  const warnings: unknown[][] = [];
  const identityFiles = new IdentityFileService({ db, identityDir: dir });
  identityFiles.scaffold({
    'IDENTITY.md': '# Identity\n\nYou are forge-local.\n',
    'SOUL.md': '# Soul\n\nBe concise.\n',
    'USER.md': '# User\n\nThe user is Alice.\n',
  });
  fs.writeFileSync(path.join(dir, 'RELATIONSHIP.md'), '# Relationship\n\nThe project uses supervised reflection.\n');

  const service = new IdentityReflectionService({
    db,
    config: config(options.cadenceTurns ?? 1),
    identityFiles,
    llm: {
      async complete(request: LLMRequest) {
        llmCalls.push(request);
        return {
          content: llmContent,
          provider: 'ollama',
          model: 'local-model',
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    },
    readIdentity: () => readIdentity(identityFiles),
    logger: {
      warn: (...args: unknown[]) => warnings.push(args),
    },
  });

  try {
    await fn({
      db,
      dir,
      identityFiles,
      service,
      llmCalls,
      warnings,
      setLlmContent(content: string) {
        llmContent = content;
      },
    });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('identity reflection creates low-trust notes and pending proposals without editing high-trust files', async () => {
  await withHarness(async ({ db, dir, identityFiles, service, llmCalls, setLlmContent }) => {
    setLlmContent(JSON.stringify({
      notes: [{
        title: 'Local reflection preference',
        content: 'The user wants identity reflection to stay local to the configured Ollama model.',
        reason: 'The latest request explicitly forbids cloud providers and new providers.',
      }],
      proposals: [{
        filename: 'USER.md',
        title: 'Review preference',
        content: 'The user prefers durable identity changes to be reviewed as pending proposals.',
        reason: 'The latest request asks to prefer pending proposals for identity file changes.',
      }],
    }));

    insertWebMessage(db, 'web:user:1', 'user', 'Please wire local supervised reflection.', 1);
    insertWebMessage(db, 'web:assistant:1', 'assistant', 'Implemented local reflection wiring.', 2);
    const before = readHighTrustFiles(dir);

    const result = await service.reflectAfterAssistantReply({
      userMessage: 'Please wire local supervised reflection.',
      assistantMessage: 'Implemented local reflection wiring.',
      assistantMessageId: 'web:assistant:1',
    });

    assert.equal(result.status, 'applied');
    assert.equal(result.assistantReplyCount, 1);
    assert.equal(result.notesCreated, 1);
    assert.equal(result.proposalsCreated, 1);
    assert.equal(llmCalls.length, 1);
    assert.match(llmCalls[0].system, /Return strict JSON only/);
    const reflectionPrompt = (llmCalls[0].messages[0] as ChatMessage).content;
    assert.match(reflectionPrompt, /Current identity Markdown context/);
    assert.match(reflectionPrompt, /### RELATIONSHIP\.md/);
    assert.match(reflectionPrompt, /supervised reflection/);
    assert.match(reflectionPrompt, /Latest completed turn/);

    const notes = identityFiles.readRecentNotes(1);
    assert.equal(notes[0].title, 'Local reflection preference');
    assert.match(notes[0].content, /configured Ollama model/);

    const proposals = identityFiles.listPendingProposals();
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].filename, 'USER.md');
    assert.match(proposals[0].content, /pending proposals/);
    assert.deepEqual(readHighTrustFiles(dir), before);
  });
});

test('identity reflection respects cadence using persisted assistant replies', async () => {
  await withHarness(async ({ db, service, llmCalls, setLlmContent }) => {
    setLlmContent(JSON.stringify({
      notes: [{
        title: 'Cadence note',
        content: 'The second completed assistant reply reached the reflection cadence.',
        reason: 'Cadence 2 should run every second assistant reply.',
      }],
      proposals: [],
    }));

    insertWebMessage(db, 'web:user:1', 'user', 'first', 1);
    insertWebMessage(db, 'web:assistant:1', 'assistant', 'first reply', 2);

    const skipped = await service.reflectAfterAssistantReply({
      userMessage: 'first',
      assistantMessage: 'first reply',
      assistantMessageId: 'web:assistant:1',
    });
    assert.equal(skipped.status, 'skipped_cadence');
    assert.equal(skipped.assistantReplyCount, 1);
    assert.equal(llmCalls.length, 0);

    insertWebMessage(db, 'web:user:2', 'user', 'second', 3);
    insertWebMessage(db, 'web:assistant:2', 'assistant', 'second reply', 4);

    const reflected = await service.reflectAfterAssistantReply({
      userMessage: 'second',
      assistantMessage: 'second reply',
      assistantMessageId: 'web:assistant:2',
    });
    assert.equal(reflected.status, 'applied');
    assert.equal(reflected.assistantReplyCount, 2);
    assert.equal(llmCalls.length, 1);
  }, { cadenceTurns: 2 });
});

test('identity reflection ignores invalid JSON output without applying changes', async () => {
  await withHarness(async ({ db, identityFiles, service, llmCalls, warnings, setLlmContent }) => {
    setLlmContent('I would maybe remember something.');
    insertWebMessage(db, 'web:user:1', 'user', 'hello', 1);
    insertWebMessage(db, 'web:assistant:1', 'assistant', 'hello back', 2);

    const result = await service.reflectAfterAssistantReply({
      userMessage: 'hello',
      assistantMessage: 'hello back',
      assistantMessageId: 'web:assistant:1',
    });

    assert.equal(result.status, 'no_output');
    assert.equal(llmCalls.length, 1);
    assert.equal(identityFiles.readRecentNotes(1).length, 0);
    assert.equal(identityFiles.listPendingProposals().length, 0);
    assert.match(String(warnings[0]?.[0] ?? ''), /identity-reflection/);
  });
});

function insertWebMessage(
  db: Database.Database,
  id: string,
  user: 'user' | 'assistant',
  text: string,
  receivedAt: number,
): void {
  db.prepare(`
    INSERT INTO messages (id, channel, channelName, user, userName, text, ts, receivedAt)
    VALUES (?, 'web', 'web', ?, ?, ?, ?, ?)
  `).run(id, user, user, text, String(receivedAt), receivedAt);
}

function readIdentity(identityFiles: IdentityFileService): string {
  return identityFiles.readModelContext();
}

function readHighTrustFiles(dir: string): Record<string, string> {
  return {
    'IDENTITY.md': fs.readFileSync(path.join(dir, 'IDENTITY.md'), 'utf-8'),
    'SOUL.md': fs.readFileSync(path.join(dir, 'SOUL.md'), 'utf-8'),
    'USER.md': fs.readFileSync(path.join(dir, 'USER.md'), 'utf-8'),
  };
}
