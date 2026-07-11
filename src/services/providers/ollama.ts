import type { ForgeConfig, LLMRequest, LLMResponse, LLMToolCall, RawToolCall, ToolDef } from '../../types.ts';
import { OllamaChatStreamAssembler } from './ollama-stream.ts';
import { zodToJsonSchema } from '../tools/schema.ts';

export interface CompleteStreamOptions {
  onToken?: (token: string) => void;
  signal?: AbortSignal;
}

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  audio?: string[];
  tool_calls?: RawToolCall[];
  tool_name?: string;
}

interface OllamaChatResponse {
  model?: string;
  message?: { role?: string; content?: string; tool_calls?: unknown };
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

export interface OllamaHealth {
  provider: 'ollama';
  model: string;
  baseUrl: string;
  ok: boolean;
  status: 'online' | 'offline' | 'error';
  installedModels: string[];
  message?: string;
}

export class OllamaProvider {
  private config: ForgeConfig;
  private fetchImpl: typeof fetch;
  private baseUrl: string;
  private keepAlive: string;
  private options: Record<string, unknown>;

  constructor(config: ForgeConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.baseUrl = config.llm.ollama.base_url;
    this.keepAlive = config.llm.ollama.keep_alive;
    this.options = config.llm.ollama.options;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const model = request.model ?? this.config.llm.model;
    const messages = this.buildMessages(request);
    const tools = request.tools && request.tools.length > 0
      ? request.tools.map(toOllamaTool)
      : undefined;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          options: request.options ? { ...this.options, ...request.options } : this.options,
          keep_alive: this.keepAlive,
          ...(tools ? { tools } : {}),
        }),
      });
    } catch {
      throw new Error(this.offlineMessage(model));
    }

    let body: OllamaChatResponse;
    try {
      body = await response.json() as OllamaChatResponse;
    } catch {
      throw new Error('Ollama returned invalid JSON. Check Ollama logs.');
    }

    if (!response.ok) {
      const msg = body.error || `HTTP ${response.status}`;
      if (msg.toLowerCase().includes('model')) throw new Error(this.missingModelMessage(model));
      throw new Error(`Ollama request failed: ${msg}`);
    }

    const toolCalls = parseToolCalls(body.message?.tool_calls);

    // Tool-call responses may carry an empty content string; only require
    // content when the model did not call any tools.
    if (typeof body.message?.content !== 'string' && toolCalls.length === 0) {
      throw new Error('Ollama response missing message.content.');
    }

    return {
      content: typeof body.message?.content === 'string' ? body.message.content : '',
      provider: 'ollama',
      model,
      inputTokens: body.prompt_eval_count ?? 0,
      outputTokens: body.eval_count ?? 0,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  /**
   * Streaming variant of complete(). Emits content tokens via onToken as they
   * arrive and resolves with the same LLMResponse shape as complete(). Aborting
   * via options.signal rejects with the original abort error so callers can
   * distinguish client disconnects from Ollama failures.
   */
  async completeStream(request: LLMRequest, options: CompleteStreamOptions = {}): Promise<LLMResponse> {
    const model = request.model ?? this.config.llm.model;
    const messages = this.buildMessages(request);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          options: request.options ? { ...this.options, ...request.options } : this.options,
          keep_alive: this.keepAlive,
        }),
        signal: options.signal,
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new Error(this.offlineMessage(model));
    }

    if (!response.ok) {
      // Error responses are a single JSON object even when streaming was requested.
      let msg = `HTTP ${response.status}`;
      try {
        const body = await response.json() as { error?: string };
        if (typeof body?.error === 'string' && body.error) msg = body.error;
      } catch {
        /* keep the HTTP status message */
      }
      if (msg.toLowerCase().includes('model')) throw new Error(this.missingModelMessage(model));
      throw new Error(`Ollama request failed: ${msg}`);
    }

    if (!response.body) {
      throw new Error('Ollama returned no streaming body. Check Ollama logs.');
    }

    const assembler = new OllamaChatStreamAssembler();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const emit = (tokens: string[]): void => {
      if (!options.onToken) return;
      for (const token of tokens) options.onToken(token);
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        emit(assembler.push(decoder.decode(value, { stream: true })));
      }
      emit(assembler.push(decoder.decode()));
      emit(assembler.end());
    } catch (err) {
      await reader.cancel().catch(() => {});
      throw err;
    }

    const final = assembler.result();
    return {
      content: final.content,
      provider: 'ollama',
      model,
      inputTokens: final.inputTokens,
      outputTokens: final.outputTokens,
    };
  }

  async health(): Promise<OllamaHealth> {
    const model = this.config.llm.model;
    try {
      const installedModels = await this.listModels();
      if (!installedModels.includes(model)) {
        return {
          provider: 'ollama',
          model,
          baseUrl: this.baseUrl,
          ok: false,
          status: 'error',
          installedModels,
          message: this.missingModelMessage(model),
        };
      }
      return {
        provider: 'ollama',
        model,
        baseUrl: this.baseUrl,
        ok: true,
        status: 'online',
        installedModels,
        message: `Ollama is online and model ${model} is available.`,
      };
    } catch (err) {
      const status = isNetworkError(err) ? 'offline' : 'error';
      return {
        provider: 'ollama',
        model,
        baseUrl: this.baseUrl,
        ok: false,
        status,
        installedModels: [],
        message: status === 'offline' ? this.offlineMessage(model) : errorMessage(err),
      };
    }
  }

  async listModels(): Promise<string[]> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/tags`);
    } catch {
      throw namedError('OllamaNetworkError', this.offlineMessage(this.config.llm.model));
    }
    if (!response.ok) {
      throw namedError('OllamaHttpError', `Ollama model list failed with HTTP ${response.status}.`);
    }
    let data: OllamaTagsResponse;
    try {
      data = await response.json() as OllamaTagsResponse;
    } catch {
      throw namedError('OllamaInvalidJsonError', 'Ollama returned invalid JSON. Check Ollama logs.');
    }
    return (data.models ?? [])
      .map(m => m.name ?? m.model ?? '')
      .filter((name): name is string => name.length > 0);
  }

  private buildMessages(request: LLMRequest): OllamaChatMessage[] {
    const hasSystemInMessages = request.messages.some(m => m.role === 'system');
    const out: OllamaChatMessage[] = [];
    if (request.system.trim() && !hasSystemInMessages) out.push({ role: 'system', content: request.system });
    for (const msg of request.messages) {
      if (msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool') {
        const outMsg: OllamaChatMessage = { role: msg.role, content: msg.content };
        if (msg.role === 'user' && msg.images && msg.images.length > 0) {
          outMsg.images = msg.images;
        }
        if (msg.role === 'user' && msg.audio && msg.audio.length > 0) {
          outMsg.audio = msg.audio;
        }
        if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
          outMsg.tool_calls = msg.tool_calls;
        }
        if (msg.role === 'tool' && msg.tool_name) {
          outMsg.tool_name = msg.tool_name;
        }
        out.push(outMsg);
      }
    }
    return out;
  }

  private offlineMessage(model: string): string {
    return `Ollama is not reachable at ${this.baseUrl}. Start Ollama and run: ollama run ${model}`;
  }

  private missingModelMessage(model: string): string {
    return `Ollama is reachable, but model ${model} does not appear to be installed. Run: ollama run ${model}`;
  }
}

function toOllamaTool(tool: ToolDef): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: zodToJsonSchema(tool.params),
    },
  };
}

/** Defensive parse of message.tool_calls; malformed entries are dropped, never thrown. */
function parseToolCalls(raw: unknown): LLMToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: LLMToolCall[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const fn = (item as { function?: unknown }).function;
    if (typeof fn !== 'object' || fn === null) continue;
    const { name, arguments: args } = fn as { name?: unknown; arguments?: unknown };
    if (typeof name !== 'string' || name.length === 0) continue;
    calls.push({
      name,
      arguments: typeof args === 'object' && args !== null && !Array.isArray(args)
        ? args as Record<string, unknown>
        : {},
    });
  }
  return calls;
}

function namedError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

function isNetworkError(err: unknown): boolean {
  return err instanceof Error && err.name === 'OllamaNetworkError';
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
