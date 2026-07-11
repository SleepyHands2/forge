import assert from 'node:assert/strict';
import test from 'node:test';
import { handleMemoryCommand } from './memory-commands.ts';
import type { MemoryService, SaveMemoryInput } from './memory.ts';

function fakeMemory() {
  const saved: SaveMemoryInput[] = [];
  const removed: string[] = [];
  return {
    saved,
    removed,
    service: {
      async save(input: SaveMemoryInput) {
        saved.push(input);
        return 'mem-1';
      },
      remove(id: string) {
        removed.push(id);
        return id === 'mem-1';
      },
    } as unknown as MemoryService,
  };
}

test('handleMemoryCommand saves only explicit /remember content', async () => {
  const memory = fakeMemory();

  assert.equal(await handleMemoryCommand(memory.service, 'please remember this'), null);
  const result = await handleMemoryCommand(memory.service, '/remember likes quiet mornings');

  assert.deepEqual(result, { reply: 'Remembered. Memory ID: mem-1', memoryId: 'mem-1' });
  assert.deepEqual(memory.saved, [{
    type: 'chat',
    content: 'likes quiet mornings',
    tags: ['chat', 'explicit'],
    confidence: 1.0,
    importance: 0.7,
  }]);
});

test('handleMemoryCommand forgets only by exact memory id', async () => {
  const memory = fakeMemory();

  assert.deepEqual(await handleMemoryCommand(memory.service, '/forget'), { reply: 'Usage: /forget <memory-id>' });
  assert.deepEqual(await handleMemoryCommand(memory.service, '/forget mem-1'), { reply: 'Forgot memory mem-1.', memoryId: 'mem-1' });
  assert.deepEqual(await handleMemoryCommand(memory.service, '/forget missing'), { reply: 'No memory found for ID: missing', memoryId: 'missing' });
  assert.deepEqual(memory.removed, ['mem-1', 'missing']);
});
