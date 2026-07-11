import type { MemoryService } from './memory.ts';

export interface MemoryCommandResult {
  reply: string;
  memoryId?: string;
}

export async function handleMemoryCommand(memory: MemoryService, text: string): Promise<MemoryCommandResult | null> {
  const trimmed = text.trim();
  const remember = trimmed.match(/^\/remember(?:\s+([\s\S]+))?$/i);
  if (remember) {
    const content = remember[1]?.trim();
    if (!content) {
      return { reply: 'Usage: /remember <text to save>' };
    }

    const id = await memory.save({
      type: 'chat',
      content,
      tags: ['chat', 'explicit'],
      confidence: 1.0,
      importance: 0.7,
    });

    return { reply: `Remembered. Memory ID: ${id}`, memoryId: id };
  }

  const forget = trimmed.match(/^\/forget(?:\s+(\S+))?$/i);
  if (forget) {
    const id = forget[1]?.trim();
    if (!id) {
      return { reply: 'Usage: /forget <memory-id>' };
    }

    return {
      reply: memory.remove(id) ? `Forgot memory ${id}.` : `No memory found for ID: ${id}`,
      memoryId: id,
    };
  }

  return null;
}
