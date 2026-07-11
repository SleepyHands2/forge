import type { EmbeddingHealth, ForgeConfig } from '../types.ts';

export type OllamaEmbeddingErrorCode =
  | 'disabled'
  | 'misconfigured'
  | 'network'
  | 'timeout'
  | 'http'
  | 'missing-model'
  | 'invalid-json'
  | 'invalid-response'
  | 'dimension-mismatch';

export class OllamaEmbeddingError extends Error {
  readonly code: OllamaEmbeddingErrorCode;
  readonly status?: number;

  constructor(code: OllamaEmbeddingErrorCode, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OllamaEmbeddingError';
    this.code = code;
    this.status = options.status;
  }
}

export interface OllamaEmbeddingProviderOptions {
  fetchImpl?: typeof fetch;
}

export interface EmbeddingProvider {
  readonly enabled: boolean;
  readonly model: string | undefined;
  embed(input: string): Promise<number[]>;
  embedMany(inputs: readonly string[]): Promise<number[][]>;
  health(): Promise<EmbeddingHealth>;
}

interface OllamaEmbedResponse {
  embeddings?: unknown;
  error?: unknown;
}

interface OllamaTagsResponse {
  models?: unknown;
}

interface OllamaModelInfo {
  name: string;
  digest?: string;
}

/** Local-only client. It never uses the configured chat model as a fallback. */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly configuredModel: string | undefined;
  readonly enabled: boolean;

  constructor(config: ForgeConfig, options: OllamaEmbeddingProviderOptions = {}) {
    const embeddings = config.memory.embeddings;
    this.enabled = embeddings?.enabled ?? false;
    this.configuredModel = embeddings?.model?.trim() || undefined;
    this.timeoutMs = embeddings?.request_timeout_ms ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = trimTrailingSlash(config.llm.ollama.base_url);
  }

  get model(): string | undefined {
    return this.configuredModel;
  }

  async embed(input: string): Promise<number[]> {
    const [embedding] = await this.embedMany([input]);
    return embedding;
  }

  async embedMany(inputs: readonly string[]): Promise<number[][]> {
    const model = this.requireModel();
    if (inputs.length === 0) return [];
    if (!inputs.every(input => typeof input === 'string')) {
      throw new OllamaEmbeddingError('invalid-response', 'Ollama embedding input must contain only strings.');
    }

    const response = await this.request('/api/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: inputs }),
    });
    const body = await this.parseResponse<OllamaEmbedResponse>(response);

    if (!response.ok) {
      const detail = typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
      if (isMissingModelError(detail)) {
        throw new OllamaEmbeddingError('missing-model', this.missingModelMessage(), { status: response.status });
      }
      throw new OllamaEmbeddingError('http', `Ollama embedding request failed: ${detail}`, { status: response.status });
    }

    return validateEmbeddings(body.embeddings, inputs.length);
  }

  async health(): Promise<EmbeddingHealth> {
    if (!this.enabled) {
      return this.healthResult(false, 'disabled', [], 'Memory embeddings are disabled; memory recall uses local FTS only.');
    }
    if (!this.configuredModel) {
      return this.healthResult(false, 'protocol-error', [], 'Memory embeddings are enabled, but memory.embeddings.model is not configured.');
    }

    try {
      const models = await this.listModelInfo();
      const installedModels = models.map(model => model.name);
      const selected = models.find(model => matchesConfiguredModel(this.configuredModel!, model.name));
      if (!selected) {
        return this.healthResult(false, 'missing-model', installedModels, this.missingModelMessage());
      }
      return this.healthResult(
        true,
        'online',
        installedModels,
        `Ollama is online and embedding model ${this.configuredModel} is available.`,
        selected.digest,
      );
    } catch (error) {
      const offline = error instanceof OllamaEmbeddingError && (error.code === 'network' || error.code === 'timeout');
      return this.healthResult(
        false,
        offline ? 'offline' : 'protocol-error',
        [],
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async listModelInfo(): Promise<OllamaModelInfo[]> {
    const response = await this.request('/api/tags');
    const body = await this.parseResponse<OllamaTagsResponse>(response);
    if (!response.ok) {
      throw new OllamaEmbeddingError('http', `Ollama model list failed with HTTP ${response.status}.`, { status: response.status });
    }
    if (!Array.isArray(body.models)) {
      throw new OllamaEmbeddingError('invalid-response', 'Ollama model list response is missing models.');
    }

    return body.models.flatMap((model): OllamaModelInfo[] => {
      if (!model || typeof model !== 'object') return [];
      const value = model as { name?: unknown; model?: unknown; digest?: unknown };
      const name = typeof value.name === 'string' ? value.name : value.model;
      if (typeof name !== 'string' || name.trim().length === 0) return [];
      return [{
        name: name.trim(),
        ...(typeof value.digest === 'string' && value.digest.trim() ? { digest: value.digest.trim() } : {}),
      }];
    });
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
    } catch (error) {
      if (timedOut) {
        throw new OllamaEmbeddingError('timeout', `Ollama embedding request timed out after ${this.timeoutMs}ms.`, { cause: error });
      }
      throw new OllamaEmbeddingError('network', this.offlineMessage(), { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async parseResponse<T>(response: Response): Promise<T> {
    try {
      return await response.json() as T;
    } catch (error) {
      throw new OllamaEmbeddingError('invalid-json', 'Ollama returned invalid JSON. Check Ollama logs.', { cause: error });
    }
  }

  private requireModel(): string {
    if (!this.enabled) {
      throw new OllamaEmbeddingError('disabled', 'Memory embeddings are disabled in forge.config.yaml.');
    }
    if (!this.configuredModel) {
      throw new OllamaEmbeddingError('misconfigured', 'Memory embeddings require memory.embeddings.model.');
    }
    return this.configuredModel;
  }

  private healthResult(
    ok: boolean,
    status: EmbeddingHealth['status'],
    installedModels: string[],
    message: string,
    modelRevision?: string,
  ): EmbeddingHealth {
    return {
      provider: 'ollama',
      enabled: this.enabled,
      model: this.configuredModel,
      baseUrl: this.baseUrl,
      ok,
      status,
      installedModels,
      ...(modelRevision ? { modelRevision } : {}),
      message,
    };
  }

  private offlineMessage(): string {
    return `Ollama is not reachable at ${this.baseUrl}. Start Ollama and run: ollama pull ${this.configuredModel ?? '<embedding-model>'}`;
  }

  private missingModelMessage(): string {
    return `Ollama is reachable, but embedding model ${this.configuredModel} does not appear to be installed. Run: ollama pull ${this.configuredModel}`;
  }
}

function validateEmbeddings(value: unknown, expectedCount: number): number[][] {
  if (!Array.isArray(value) || value.length !== expectedCount) {
    throw new OllamaEmbeddingError(
      'invalid-response',
      `Ollama embedding response must contain exactly ${expectedCount} embedding vector${expectedCount === 1 ? '' : 's'}.`,
    );
  }

  const embeddings = value.map((vector, index) => {
    if (!Array.isArray(vector) || vector.length === 0 || !vector.every(item => typeof item === 'number' && Number.isFinite(item))) {
      throw new OllamaEmbeddingError('invalid-response', `Ollama embedding response contains an invalid vector at index ${index}.`);
    }
    return vector;
  });
  const dimensions = embeddings[0]?.length;
  if (embeddings.some(vector => vector.length !== dimensions)) {
    throw new OllamaEmbeddingError('dimension-mismatch', 'Ollama embedding response contains vectors with different dimensions.');
  }
  return embeddings;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function isMissingModelError(message: string): boolean {
  return /model.+(?:not found|does not exist|not installed)|(?:not found|does not exist|not installed).+model/i.test(message);
}

function matchesConfiguredModel(configured: string, installed: string): boolean {
  return configured === installed || (!configured.includes(':') && installed === `${configured}:latest`);
}
