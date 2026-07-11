import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ForgeConfig, ResolvedPaths, ToolDef } from '../../types.ts';

const UNLOAD_TIMEOUT_MS = 10_000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface ImageGenRequest {
  prompt: string;
  width: number;
  height: number;
  steps: number;
  seed: number;
}

/**
 * Backend interface for image generation. The default implementation targets
 * the A1111-compatible txt2img HTTP API served by SD WebUI / SD.Next / Forge
 * webui on localhost; a hosted API can implement the same interface later.
 */
export interface ImageGenBackend {
  readonly name: string;
  generate(request: ImageGenRequest): Promise<Buffer>;
}

export interface ImagegenToolOptions {
  fetchImpl?: typeof fetch;
  backend?: ImageGenBackend;
}

export function createA1111Backend(config: ForgeConfig, fetchImpl: typeof fetch = fetch): ImageGenBackend {
  return {
    name: 'a1111',
    async generate(request: ImageGenRequest): Promise<Buffer> {
      const imagegen = config.imagegen;
      const baseUrl = (imagegen?.base_url ?? 'http://localhost:7860').replace(/\/$/, '');
      const timeoutMs = imagegen?.timeout_ms ?? 180_000;

      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/sdapi/v1/txt2img`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: request.prompt,
            width: request.width,
            height: request.height,
            steps: request.steps,
            seed: request.seed,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (isTimeout(err)) {
          throw new Error(`Image generation timed out after ${timeoutMs}ms. The first image after idle is slower because the SD model has to load; try again.`);
        }
        throw new Error(`Image backend is not reachable at ${baseUrl}. Is the SD WebUI running with --api?`);
      }

      if (!response.ok) {
        throw new Error(`Image backend request failed: HTTP ${response.status}.`);
      }

      let body: { images?: unknown };
      try {
        body = await response.json() as { images?: unknown };
      } catch {
        throw new Error('Image backend returned invalid JSON.');
      }

      const first = Array.isArray(body.images) ? body.images[0] : undefined;
      if (typeof first !== 'string' || first.length === 0) {
        throw new Error('Image backend returned no images.');
      }

      // A1111 may prefix a data URL; strip it before decoding.
      const base64 = first.includes(',') ? first.slice(first.indexOf(',') + 1) : first;
      let bytes: Buffer;
      try {
        bytes = Buffer.from(base64, 'base64');
      } catch {
        throw new Error('Image backend returned invalid base64 image data.');
      }
      if (bytes.length < PNG_MAGIC.length || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
        throw new Error('Image backend did not return a PNG image.');
      }
      return bytes;
    },
  };
}

/**
 * generate_image tool (permission 'network'). On-demand VRAM strategy for
 * 8 GB: SD and E4B are never co-resident — with imagegen.free_vram (default
 * on) the tool first asks Ollama to unload the chat model, the backend loads
 * SD for the generation, and Ollama reloads E4B on the next completion. The
 * PNG is saved under the gitignored images dir and returned as an
 * /api/images/... URL the web UI renders inline.
 */
export function createGenerateImageTool(
  config: ForgeConfig,
  resolved: Pick<ResolvedPaths, 'images'>,
  options: ImagegenToolOptions = {},
): ToolDef {
  const fetchImpl = options.fetchImpl ?? fetch;
  const backend = options.backend ?? createA1111Backend(config, fetchImpl);

  return {
    name: 'generate_image',
    description: 'Generate an image from a text prompt with the local Stable Diffusion backend. Returns an image_url; include that URL in your reply so the user sees the image. Generation takes a while (the chat model is swapped out of VRAM during it).',
    permission: 'network',
    params: z.object({
      prompt: z.string().min(1).describe('What to draw, as a detailed visual description'),
      width: z.number().int().optional().describe('Image width in pixels (default from config)'),
      height: z.number().int().optional().describe('Image height in pixels (default from config)'),
      steps: z.number().int().optional().describe('Diffusion steps (more = slower, higher quality)'),
      seed: z.number().int().optional().describe('Seed for reproducible output (-1 = random)'),
    }),
    handler: async (args) => {
      const imagegen = config.imagegen;
      if (imagegen?.enabled !== true) {
        throw new Error('Image generation is disabled (imagegen.enabled).');
      }

      const request: ImageGenRequest = {
        prompt: String(args.prompt),
        width: snapToMultipleOf8(clampInt(args.width, 64, imagegen.max_size, imagegen.width)),
        height: snapToMultipleOf8(clampInt(args.height, 64, imagegen.max_size, imagegen.height)),
        steps: clampInt(args.steps, 1, imagegen.max_steps, imagegen.steps),
        seed: typeof args.seed === 'number' && Number.isSafeInteger(args.seed) && args.seed >= 0 ? args.seed : -1,
      };

      if (imagegen.free_vram) {
        await unloadChatModel(config, fetchImpl);
      }

      const bytes = await backend.generate(request);

      const file = `gen-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.png`;
      await fs.promises.mkdir(resolved.images, { recursive: true });
      await fs.promises.writeFile(path.join(resolved.images, file), bytes);

      return {
        image_url: `/api/images/${file}`,
        file,
        width: request.width,
        height: request.height,
        steps: request.steps,
        seed: request.seed,
        backend: backend.name,
      };
    },
  };
}

/**
 * Best-effort: ask Ollama to unload the chat model (keep_alive: 0) so SD gets
 * the GPU to itself. Failures are ignored — worse performance, not a broken
 * tool. Ollama reloads the model automatically on the next chat completion.
 */
async function unloadChatModel(config: ForgeConfig, fetchImpl: typeof fetch): Promise<void> {
  try {
    await fetchImpl(`${config.llm.ollama.base_url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.llm.model, messages: [], keep_alive: 0 }),
      signal: AbortSignal.timeout(UNLOAD_TIMEOUT_MS),
    });
  } catch {
    /* best effort */
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/** SD backends require dimensions divisible by 8. */
function snapToMultipleOf8(value: number): number {
  return Math.max(64, Math.floor(value / 8) * 8);
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}
