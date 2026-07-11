import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ForgeConfig, ToolDef } from '../../types.ts';
import { gateAndResolve } from './filesystem.ts';

// Formats Qwen2.5-VL-class models accept via the Ollama images field.
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

const DEFAULT_PROMPT = 'Describe this image in detail. If it contains any text, transcribe it exactly.';

export interface VisionToolOptions {
  fetchImpl?: typeof fetch;
}

/**
 * analyze_image tool (permission 'filesystem'): sends an image file to the
 * dedicated vision model via Ollama /api/generate. The image path is bound by
 * the same readable_dirs allowlist + realpath re-check as read_file; the
 * base64 encoding happens inside the handler so the audit log and the agent
 * context only ever see the path, never image bytes. Ollama evicts the chat
 * model and loads the vision model on its own, so the first call after
 * chatting is slow and there is no VRAM handoff code here.
 */
export function createAnalyzeImageTool(config: ForgeConfig, options: VisionToolOptions = {}): ToolDef {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    name: 'analyze_image',
    description: 'Analyze an image file from an allowlisted directory with the local vision model: describe it, transcribe text in it (OCR), or answer a question about it. Slow on dense images (a separate vision model is swapped into VRAM) — expect up to a few minutes.',
    permission: 'filesystem',
    params: z.object({
      path: z.string().min(1).describe('Absolute path (or path relative to the forge root) of the image file (jpg, png, webp, gif, bmp)'),
      prompt: z.string().optional().describe('What to do with the image, e.g. "transcribe all text and translate it to English" (default: describe it and transcribe any text)'),
    }),
    handler: async (args) => {
      const vision = config.vision;
      if (vision?.enabled !== true) {
        throw new Error('Image analysis is disabled (vision.enabled).');
      }

      const realPath = await gateAndResolve(config, String(args.path));
      const ext = path.extname(realPath).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) {
        throw new Error(`'${realPath}' is not a supported image type (${[...IMAGE_EXTENSIONS].join(', ')}).`);
      }
      const stats = await fs.stat(realPath);
      if (!stats.isFile()) {
        throw new Error(`'${realPath}' is not a regular file.`);
      }
      if (stats.size > vision.max_image_bytes) {
        throw new Error(`Image is ${stats.size} bytes, over the vision.max_image_bytes cap of ${vision.max_image_bytes}.`);
      }

      const image = (await fs.readFile(realPath)).toString('base64');
      const prompt = typeof args.prompt === 'string' && args.prompt.trim().length > 0
        ? args.prompt.trim()
        : DEFAULT_PROMPT;

      const baseUrl = config.llm.ollama.base_url;
      const started = Date.now();
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: vision.model,
            prompt,
            images: [image],
            stream: false,
            options: {
              num_ctx: vision.num_ctx,
              num_predict: vision.num_predict,
              repeat_penalty: vision.repeat_penalty,
            },
          }),
          signal: AbortSignal.timeout(vision.timeout_ms),
        });
      } catch (err) {
        if (isTimeout(err)) {
          throw new Error(`Image analysis timed out after ${vision.timeout_ms}ms. The first call after chatting swaps the vision model into VRAM and is slower; try again.`);
        }
        throw new Error(`Ollama is not reachable at ${baseUrl}.`);
      }

      if (response.status === 404) {
        throw new Error(`Vision model '${vision.model}' is not available on Ollama. Pull it with: ollama pull ${vision.model}`);
      }
      if (!response.ok) {
        throw new Error(`Vision request failed: HTTP ${response.status}.`);
      }

      let body: { response?: unknown; done_reason?: unknown };
      try {
        body = await response.json() as { response?: unknown; done_reason?: unknown };
      } catch {
        throw new Error('Ollama returned invalid JSON for the vision request.');
      }
      if (typeof body.response !== 'string' || body.response.trim().length === 0) {
        throw new Error('The vision model returned an empty analysis.');
      }

      const doneReason = typeof body.done_reason === 'string' ? body.done_reason : 'unknown';
      return {
        path: realPath,
        model: vision.model,
        analysis: body.response.trim(),
        // 'length' means the num_predict cap cut the output short; say so
        // instead of letting a silently truncated analysis pass as complete.
        done_reason: doneReason,
        truncated: doneReason === 'length',
        duration_ms: Date.now() - started,
      };
    },
  };
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}
