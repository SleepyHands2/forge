import type { ForgeConfig, LLMRequest, LLMResponse } from '../types.ts';
import { OllamaProvider, type CompleteStreamOptions, type OllamaHealth } from './providers/ollama.ts';
import { OpenAICompatProvider } from './providers/openai-compat.ts';

export interface LLMServiceOptions {
  fetchImpl?: typeof fetch;
}

export class LLMService {
  private provider: OllamaProvider;
  private fallback: OpenAICompatProvider | null;

  constructor(config: ForgeConfig, options: LLMServiceOptions = {}) {
    this.provider = new OllamaProvider(config, options.fetchImpl);
    // The fallback provider exists only when explicitly enabled; the default
    // path never touches the network beyond local Ollama.
    this.fallback = config.llm.fallback?.enabled === true
      ? new OpenAICompatProvider(config, options.fetchImpl)
      : null;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    if (!this.fallback) {
      return this.provider.complete(request);
    }
    try {
      return await this.provider.complete(request);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[llm] Local Ollama failed; using cloud fallback:', msg);
      return this.fallback.complete(request);
    }
  }

  completeStream(request: LLMRequest, options?: CompleteStreamOptions): Promise<LLMResponse> {
    return this.provider.completeStream(request, options);
  }

  health(): Promise<OllamaHealth> {
    return this.provider.health();
  }

  listModels(): Promise<string[]> {
    return this.provider.listModels();
  }
}
