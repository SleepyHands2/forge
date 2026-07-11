import type { ChatMessage, ForgeConfig, LLMRequest, LLMResponse } from '../../types.ts';

interface OpenAIChatResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

/**
 * Minimal OpenAI-compatible chat provider used ONLY as the opt-in cloud
 * fallback (llm.fallback.enabled). The API key is read from the environment
 * variable named by llm.fallback.api_key_env at request time — it never lives
 * in config. Plain text completions only: tools are not forwarded to the
 * cloud, and role:'tool' history is flattened to labeled user messages so a
 * mid-agent-turn fallback still produces a coherent reply.
 */
export class OpenAICompatProvider {
  private readonly config: ForgeConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ForgeConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const fallback = this.config.llm.fallback;
    if (fallback?.enabled !== true || !fallback.model) {
      throw new Error('Cloud fallback is not enabled (llm.fallback).');
    }
    const apiKey = process.env[fallback.api_key_env]?.trim();
    if (!apiKey) {
      throw new Error(`Cloud fallback is enabled but the ${fallback.api_key_env} environment variable is not set.`);
    }

    const model = fallback.model;
    let response: Response;
    try {
      response = await this.fetchImpl(`${fallback.base_url.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: this.buildMessages(request),
        }),
      });
    } catch {
      throw new Error(`Cloud fallback endpoint ${fallback.base_url} is not reachable.`);
    }

    let body: OpenAIChatResponse;
    try {
      body = await response.json() as OpenAIChatResponse;
    } catch {
      throw new Error('Cloud fallback returned invalid JSON.');
    }

    if (!response.ok) {
      const detail = typeof body.error === 'string' ? body.error : body.error?.message;
      throw new Error(`Cloud fallback request failed: ${detail || `HTTP ${response.status}`}`);
    }

    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('Cloud fallback response missing message content.');
    }

    return {
      content,
      provider: 'openai-compatible',
      model: body.model ?? model,
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
    };
  }

  private buildMessages(request: LLMRequest): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
    const out: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
    const hasSystemInMessages = request.messages.some(m => m.role === 'system');
    if (request.system.trim() && !hasSystemInMessages) {
      out.push({ role: 'system', content: request.system });
    }
    for (const msg of request.messages) {
      if (msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant') {
        out.push({ role: msg.role, content: msg.content });
      } else if (msg.role === 'tool') {
        out.push({ role: 'user', content: toolResultAsText(msg) });
      }
    }
    return out;
  }
}

function toolResultAsText(msg: ChatMessage): string {
  const name = msg.tool_name ? ` from tool '${msg.tool_name}'` : '';
  return `[Tool result${name}; untrusted data]\n${msg.content}`;
}
