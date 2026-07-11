import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { IdentityFileService } from './identity-files.ts';

const SCHEMA = fs.readFileSync(
  new URL('../db/schemas/messages.sql', import.meta.url),
  'utf-8',
);

function withService(fn: (service: IdentityFileService, dir: string, db: Database.Database) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-identity-'));
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  const service = new IdentityFileService({ db, identityDir: dir });

  try {
    fn(service, dir, db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('IdentityFileService', () => {
  it('scaffolds allowlisted identity files and excludes lower-trust notes from identity reads', () => {
    withService((service, dir) => {
      service.scaffold();

      assert.equal(fs.existsSync(path.join(dir, 'IDENTITY.md')), true);
      assert.equal(fs.existsSync(path.join(dir, 'SOUL.md')), true);
      assert.equal(fs.existsSync(path.join(dir, 'USER.md')), true);
      assert.match(fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf-8'), /Lower-trust working notes/);

      const identity = service.readIdentity();
      assert.deepEqual(Object.keys(identity), ['IDENTITY.md', 'SOUL.md', 'USER.md']);
      assert.equal(Object.hasOwn(identity, 'NOTES.md'), false);
    });
  });

  it('reads safe top-level markdown files for model context without expanding writes', () => {
    withService((service, dir) => {
      service.scaffold();
      fs.writeFileSync(path.join(dir, 'RELATIONSHIP.md'), '# Relationship\n\nShared project context.\n');
      fs.writeFileSync(path.join(dir, 'PROJECT.MD'), '# Project\n\nPublic local harness.\n');
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'not markdown');
      fs.writeFileSync(path.join(dir, '.scratch.md'), 'hidden draft');
      fs.writeFileSync(path.join(dir, 'bad..md'), 'unsafe name');
      fs.mkdirSync(path.join(dir, 'nested'));
      fs.writeFileSync(path.join(dir, 'nested', 'NESTED.md'), 'nested markdown');

      try {
        fs.symlinkSync(path.join(dir, 'RELATIONSHIP.md'), path.join(dir, 'LINKED.md'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      }

      const files = service.readModelContextFiles();
      const names = files.map(file => file.name);

      assert.deepEqual(names, [
        'IDENTITY.md',
        'SOUL.md',
        'USER.md',
        'NOTES.md',
        'PROJECT.MD',
        'RELATIONSHIP.md',
      ]);
      assert.equal(files.find(file => file.name === 'IDENTITY.md')?.trust, 'high');
      assert.equal(files.find(file => file.name === 'IDENTITY.md')?.modelWritable, false);
      assert.equal(files.find(file => file.name === 'NOTES.md')?.trust, 'low');
      assert.equal(files.find(file => file.name === 'NOTES.md')?.modelWritable, 'append-only');
      assert.equal(files.find(file => file.name === 'RELATIONSHIP.md')?.trust, 'low');
      assert.equal(files.find(file => file.name === 'RELATIONSHIP.md')?.modelWritable, false);

      const context = service.readModelContext();
      assert.match(context, /Identity Markdown Context/);
      assert.match(context, /safe top-level Markdown files/);
      assert.match(context, /Changes to IDENTITY\.md, SOUL\.md, and USER\.md require user approval/);
      assert.match(context, /must not claim it directly edited/);
      assert.match(context, /### RELATIONSHIP\.md/);
      assert.match(context, /Shared project context/);
      assert.doesNotMatch(context, /notes\.txt/);
      assert.doesNotMatch(context, /hidden draft/);
      assert.doesNotMatch(context, /nested markdown/);
      assert.doesNotMatch(context, /unsafe name/);
      assert.doesNotMatch(context, /LINKED\.md/);
    });
  });

  it('reads recent notes newest first and honors the requested limit', () => {
    withService((service) => {
      service.appendNote({ title: 'First', content: 'first note', reason: 'capture' });
      service.appendNote({ title: 'Second', content: 'second note', reason: 'capture' });
      service.appendNote({ title: 'Third', content: 'third note', reason: 'capture' });

      assert.deepEqual(service.readRecentNotes(2).map(note => note.title), ['Third', 'Second']);
      assert.deepEqual(service.readRecentNotes(0), []);
    });
  });

  it('appends parseable notes, rejects delimiter injection, dedupes normalized content, and caps note size', () => {
    withService((service, dir) => {
      const appended = service.appendNote({
        title: 'Preference',
        content: '  Likes quiet tools  ',
        reason: 'user said so',
      });
      assert.equal(appended.status, 'appended');

      const notes = service.readRecentNotes(1);
      assert.equal(notes[0].title, 'Preference');
      assert.equal(notes[0].content, 'Likes quiet tools');

      const duplicate = service.appendNote({
        title: 'Preference again',
        content: 'LIKES   QUIET TOOLS',
        reason: 'same normalized content',
      });
      assert.equal(duplicate.status, 'duplicate');
      assert.equal(service.readRecentNotes(10).length, 1);
      assert.equal(service.listEvents().at(-1)?.eventType, 'note_duplicate');

      assert.throws(
        () => service.appendNote({ title: 'Bad', content: 'x FORGE_NOTE_START y', reason: 'bad' }),
        /delimiters/,
      );

      fs.writeFileSync(path.join(dir, 'NOTES.md'), `${'# Notes\n'}${'x'.repeat(512 * 1024 - 20)}`);
      assert.throws(
        () => service.appendNote({ title: 'Too much', content: 'new note', reason: 'limit' }),
        /maximum size/,
      );
    });
  });

  it('rejects unsupported proposal filenames, traversal, encoded traversal, absolutes, null bytes, and separators', () => {
    withService((service) => {
      const input = { title: 'Safe', content: 'safe content', reason: 'test' };

      for (const filename of [
        'NOTES.md',
        'OTHER.md',
        '../IDENTITY.md',
        '..%2fIDENTITY.md',
        'dir/IDENTITY.md',
        'dir\\IDENTITY.md',
        `${path.parse(process.cwd()).root}IDENTITY.md`,
        'IDENTITY.md\0',
      ]) {
        assert.throws(
          () => service.createProposal({ filename, ...input }),
          /Identity/,
          filename,
        );
      }
    });
  });

  it('rejects symlinked identity file targets', () => {
    withService((service, dir) => {
      service.scaffold();
      fs.rmSync(path.join(dir, 'IDENTITY.md'));

      try {
        fs.symlinkSync(path.join(dir, 'SOUL.md'), path.join(dir, 'IDENTITY.md'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') {
          return;
        }
        throw error;
      }

      assert.throws(
        () => service.createProposal({
          filename: 'IDENTITY.md',
          title: 'Symlink',
          content: 'should fail',
          reason: 'safety',
        }),
        /symlink/,
      );
    });
  });

  it('creates, dedupes, limits, and rejects proposals with audit events', () => {
    withService((service) => {
      const created = service.createProposal({
        filename: 'IDENTITY.md',
        title: 'Voice',
        content: 'Use concise language',
        reason: 'explicit request',
      });
      assert.equal(created.status, 'created');
      assert.equal(service.listPendingProposals().length, 1);

      const duplicate = service.createProposal({
        filename: 'SOUL.md',
        title: 'Voice duplicate',
        content: ' use   concise language ',
        reason: 'same normalized content',
      });
      assert.equal(duplicate.status, 'duplicate');
      assert.equal(duplicate.existingId, created.proposal?.id);
      assert.ok(service.listEvents().some(event =>
        event.eventType === 'proposal_duplicate_skipped'
        && event.proposalId === created.proposal?.id
        && event.filename === 'SOUL.md',
      ));

      const rejected = service.rejectProposal(created.proposal!.id);
      assert.equal(rejected.status, 'rejected');
      assert.equal(service.rejectProposal(created.proposal!.id).status, 'already_rejected');
      assert.ok(service.listEvents().some(event =>
        event.eventType === 'proposal_rejected'
        && event.proposalId === created.proposal?.id,
      ));

      for (let index = 0; index < 20; index += 1) {
        service.createProposal({
          filename: 'USER.md',
          title: `Pending ${index}`,
          content: `pending proposal ${index}`,
          reason: 'fill queue',
        });
      }

      assert.throws(
        () => service.createProposal({
          filename: 'USER.md',
          title: 'Overflow',
          content: 'one too many',
          reason: 'limit',
        }),
        /Maximum pending/,
      );
    });
  });

  it('skips proposals whose normalized content is already present in the target file', () => {
    withService((service, dir) => {
      service.scaffold();
      fs.appendFileSync(path.join(dir, 'USER.md'), '\nAlready present value\n');

      const result = service.createProposal({
        filename: 'USER.md',
        title: 'Present',
        content: ' already   present value ',
        reason: 'duplicate file content',
      });

      assert.equal(result.status, 'duplicate');
      assert.equal(service.listEvents().at(-1)?.eventType, 'proposal_content_present');
    });
  });

  it('approves proposals atomically, idempotently, and supports user-edited approval content', () => {
    withService((service, dir) => {
      const created = service.createProposal({
        filename: 'SOUL.md',
        title: 'Tone',
        content: 'Draft tone',
        reason: 'initial thought',
      });

      const approved = service.approveProposal(created.proposal!.id, {
        title: 'Edited tone',
        content: 'Final tone',
        reason: 'user edit',
      });
      assert.equal(approved.status, 'approved');
      assert.equal(approved.proposal.content, 'Final tone');

      const file = fs.readFileSync(path.join(dir, 'SOUL.md'), 'utf-8');
      assert.match(file, /FORGE_PROPOSAL_START/);
      assert.match(file, /Edited tone/);
      assert.match(file, /Final tone/);

      const idempotent = service.approveProposal(created.proposal!.id);
      assert.equal(idempotent.status, 'already_approved');
      const after = fs.readFileSync(path.join(dir, 'SOUL.md'), 'utf-8');
      assert.equal(after.match(/FORGE_PROPOSAL_START/g)?.length, 1);
    });
  });

  it('keeps audit event previews at 300 characters', () => {
    withService((service) => {
      service.appendNote({
        title: 'Long preview',
        content: 'x'.repeat(400),
        reason: 'preview cap',
      });

      assert.equal(service.listEvents()[0].preview.length, 300);
    });
  });
});

describe('IdentityFileService notes rewrite', () => {
  it('lists notes oldest first and rewrites NOTES.md to the kept set with a pointer line', () => {
    withService((service, dir) => {
      service.appendNote({ title: 'First', content: 'first note content', reason: 'r1' });
      service.appendNote({ title: 'Second', content: 'second note content', reason: 'r2' });
      service.appendNote({ title: 'Third', content: 'third note content', reason: 'r3' });

      const notes = service.listNotes();
      assert.deepEqual(notes.map(note => note.title), ['First', 'Second', 'Third']);

      service.replaceNotes({
        keep: [notes[1]],
        pointer: 'Archived notes live in long-term memory; search with memory_search.',
      });

      const after = service.listNotes();
      assert.equal(after.length, 1);
      assert.equal(after[0].id, notes[1].id);
      assert.equal(after[0].createdAt, notes[1].createdAt);
      assert.equal(after[0].content, 'second note content');

      const raw = fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf-8');
      assert.match(raw, /Archived notes live in long-term memory/);
      assert.match(raw, /Lower-trust working notes/);
      assert.doesNotMatch(raw, /first note content/);
      assert.doesNotMatch(raw, /third note content/);

      const event = service.listEvents().find(entry => entry.eventType === 'notes_replaced');
      assert.ok(event, 'expected a notes_replaced event');
      assert.match(event.preview, /kept 1 of 3 notes/);
    });
  });

  it('keeps append-time dedupe working against rewritten notes', () => {
    withService((service) => {
      service.appendNote({ title: 'Keep', content: 'kept content survives rewrite', reason: 'r' });
      service.replaceNotes({ keep: service.listNotes() });

      const result = service.appendNote({ title: 'Keep again', content: 'kept content survives rewrite', reason: 'r' });
      assert.equal(result.status, 'duplicate');
    });
  });
});

describe('IdentityFileService.buildModelContext', () => {
  it('matches readModelContext exactly when built without a budget', () => {
    withService((service, dir) => {
      service.scaffold();
      fs.writeFileSync(path.join(dir, 'EXTRA.md'), '# Extra\n\nExtra context.\n');

      const result = service.buildModelContext();

      assert.equal(result.text, service.readModelContext());
      assert.equal(result.truncated, false);
      assert.equal(result.budgetTokens, undefined);
      assert.ok(result.files.every(file => file.status === 'full'));
    });
  });

  it('does not truncate when the budget is generous', () => {
    withService((service) => {
      service.scaffold();

      const result = service.buildModelContext(100000);

      assert.equal(result.text, service.readModelContext());
      assert.equal(result.truncated, false);
      assert.equal(result.budgetTokens, 100000);
    });
  });

  it('truncates NOTES.md keeping the newest tail when it exceeds the budget', () => {
    withService((service, dir) => {
      service.scaffold();
      fs.writeFileSync(
        path.join(dir, 'NOTES.md'),
        `OLDEST-NOTE-MARKER\n\n${'filler note text\n'.repeat(2000)}\nNEWEST-NOTE-MARKER\n`,
      );

      const result = service.buildModelContext(2000);

      assert.equal(result.truncated, true);
      assert.ok(result.estimatedTokens <= 2000, `estimated ${result.estimatedTokens} > budget`);
      assert.ok(result.neededTokens > 2000);
      assert.match(result.text, /NEWEST-NOTE-MARKER/);
      assert.doesNotMatch(result.text, /OLDEST-NOTE-MARKER/);
      assert.match(result.text, /older notes exceeded the identity context budget/);

      const notes = result.files.find(file => file.name === 'NOTES.md');
      assert.equal(notes?.status, 'truncated');
      assert.ok((notes?.includedBytes ?? 0) > 0);
      assert.ok((notes?.includedBytes ?? 0) < (notes?.totalBytes ?? 0));
      assert.ok(result.files.filter(file => file.name !== 'NOTES.md').every(file => file.status === 'full'));
    });
  });

  it('cuts extra files before NOTES.md and keeps high-trust files intact', () => {
    withService((service, dir) => {
      service.scaffold();
      fs.writeFileSync(path.join(dir, 'NOTES.md'), `NOTES-BODY ${'n'.repeat(15000)} NOTES-TAIL-MARKER`);
      fs.writeFileSync(path.join(dir, 'ZEBRA.md'), `ZEBRA-BODY-MARKER ${'z'.repeat(15000)}`);

      const result = service.buildModelContext(1500);

      assert.equal(result.truncated, true);
      assert.ok(result.estimatedTokens <= 1500, `estimated ${result.estimatedTokens} > budget`);
      assert.equal(result.files.find(file => file.name === 'SOUL.md')?.status, 'full');
      assert.equal(result.files.find(file => file.name === 'IDENTITY.md')?.status, 'full');
      assert.equal(result.files.find(file => file.name === 'USER.md')?.status, 'full');
      assert.equal(result.files.find(file => file.name === 'NOTES.md')?.status, 'truncated');
      assert.equal(result.files.find(file => file.name === 'ZEBRA.md')?.status, 'omitted');
      assert.match(result.text, /NOTES-TAIL-MARKER/);
      assert.doesNotMatch(result.text, /ZEBRA-BODY-MARKER/);
    });
  });

  it('preserves SOUL.md and IDENTITY.md ahead of USER.md under a tight budget', () => {
    withService((service, dir) => {
      service.scaffold();
      fs.writeFileSync(path.join(dir, 'SOUL.md'), '# Soul\n\nSOUL-BODY-MARKER core values.\n');
      fs.writeFileSync(path.join(dir, 'IDENTITY.md'), '# Identity\n\nIDENTITY-BODY-MARKER who I am.\n');
      fs.writeFileSync(path.join(dir, 'USER.md'), `USER-HEAD-MARKER ${'u'.repeat(15000)} USER-TAIL-MARKER`);
      fs.writeFileSync(path.join(dir, 'NOTES.md'), `NOTES-BODY-MARKER ${'n'.repeat(15000)}`);

      const result = service.buildModelContext(700);

      assert.ok(result.estimatedTokens <= 700, `estimated ${result.estimatedTokens} > budget`);
      assert.equal(result.files.find(file => file.name === 'SOUL.md')?.status, 'full');
      assert.equal(result.files.find(file => file.name === 'IDENTITY.md')?.status, 'full');
      assert.equal(result.files.find(file => file.name === 'USER.md')?.status, 'truncated');
      assert.equal(result.files.find(file => file.name === 'NOTES.md')?.status, 'omitted');
      assert.match(result.text, /SOUL-BODY-MARKER/);
      assert.match(result.text, /IDENTITY-BODY-MARKER/);
      // USER.md keeps its head (not its tail like NOTES.md).
      assert.match(result.text, /USER-HEAD-MARKER/);
      assert.doesNotMatch(result.text, /USER-TAIL-MARKER/);
      assert.match(result.text, /rest of this file exceeded the identity context budget/);
      assert.doesNotMatch(result.text, /NOTES-BODY-MARKER/);
      // The rendered order is unchanged even though budget is granted by priority.
      assert.ok(result.text.indexOf('### IDENTITY.md') < result.text.indexOf('### SOUL.md'));
    });
  });
});
