import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from './manager.ts';

interface FtsRow {
  id: string;
  text: string;
}

test('messages FTS triggers track inserts, updates, and deletes', () => {
  const dbDir = mkdtempSync(path.join(os.tmpdir(), 'forge-messages-fts-'));
  const manager = new DatabaseManager(dbDir);
  const db = manager.open('messages');

  try {
    db.prepare(`
      INSERT INTO messages (id, channel, channelName, user, userName, text, ts, receivedAt)
      VALUES ('msg-1', 'web', 'web', 'user', 'Alice', 'alpha bravo', '1', 1)
    `).run();
    assert.deepEqual(search(db, 'alpha'), [{ id: 'msg-1', text: 'alpha bravo' }]);

    db.prepare("UPDATE messages SET text = 'charlie delta' WHERE id = 'msg-1'").run();
    assert.deepEqual(search(db, 'alpha'), []);
    assert.deepEqual(search(db, 'charlie'), [{ id: 'msg-1', text: 'charlie delta' }]);

    db.prepare("DELETE FROM messages WHERE id = 'msg-1'").run();
    assert.deepEqual(search(db, 'charlie'), []);
  } finally {
    manager.closeAll();
    rmSync(dbDir, { recursive: true, force: true });
  }
});

function search(db: ReturnType<DatabaseManager['open']>, term: string): FtsRow[] {
  return db.prepare(`
    SELECT id, text
    FROM messages_fts
    WHERE messages_fts MATCH ?
    ORDER BY rowid
  `).all(term) as FtsRow[];
}
