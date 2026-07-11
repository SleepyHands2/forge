/**
 * Incremental assembler for Ollama's streamed /api/chat NDJSON responses.
 *
 * Feed raw text with push() as it arrives from the network (chunks may split
 * JSON lines anywhere), then call end() to flush any trailing line and
 * result() to get the assembled reply. Kept free of fetch/stream plumbing so
 * it can be unit tested with plain strings.
 */

export interface OllamaStreamResult {
  content: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
}

export class OllamaStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OllamaStreamError';
  }
}

interface OllamaStreamChunk {
  model?: string;
  message?: { role?: string; content?: string };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export class OllamaChatStreamAssembler {
  private buffer = '';
  private content = '';
  private model?: string;
  private inputTokens = 0;
  private outputTokens = 0;
  private doneReceived = false;

  /** Consume raw stream text; returns the new content tokens, in order. */
  push(text: string): string[] {
    this.buffer += text;
    const tokens: string[] = [];

    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const token = this.consumeLine(line);
      if (token !== null) tokens.push(token);
      newlineIndex = this.buffer.indexOf('\n');
    }

    return tokens;
  }

  /** Flush a trailing line that arrived without a final newline. */
  end(): string[] {
    const remaining = this.buffer;
    this.buffer = '';
    if (remaining.trim().length === 0) return [];
    const token = this.consumeLine(remaining);
    return token !== null ? [token] : [];
  }

  /** Final assembled reply. Throws unless a done chunk was received. */
  result(): OllamaStreamResult {
    if (!this.doneReceived) {
      throw new OllamaStreamError('Ollama stream ended before completion. Check Ollama logs.');
    }
    return {
      content: this.content,
      model: this.model,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    };
  }

  private consumeLine(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new OllamaStreamError('Ollama returned an invalid streaming chunk. Check Ollama logs.');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new OllamaStreamError('Ollama returned an invalid streaming chunk. Check Ollama logs.');
    }

    const chunk = parsed as OllamaStreamChunk;
    if (typeof chunk.error === 'string' && chunk.error.length > 0) {
      throw new OllamaStreamError(`Ollama stream failed: ${chunk.error}`);
    }

    if (typeof chunk.model === 'string' && chunk.model.length > 0) {
      this.model = chunk.model;
    }

    let token: string | null = null;
    if (typeof chunk.message?.content === 'string' && chunk.message.content.length > 0) {
      token = chunk.message.content;
      this.content += token;
    }

    if (chunk.done === true) {
      this.doneReceived = true;
      if (typeof chunk.prompt_eval_count === 'number') this.inputTokens = chunk.prompt_eval_count;
      if (typeof chunk.eval_count === 'number') this.outputTokens = chunk.eval_count;
    }

    return token;
  }
}
