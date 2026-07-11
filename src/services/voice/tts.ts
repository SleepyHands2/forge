import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ForgeConfig } from '../../types.ts';
import { defaultRunBinary, BinaryMissingError, type RunBinary } from './runner.ts';

export interface TtsStatus {
  enabled: boolean;
  configured: boolean;
  message?: string;
}

export interface TtsServiceOptions {
  config: ForgeConfig;
  runBinary?: RunBinary;
}

/**
 * Text-to-speech via the Piper CLI (CPU, zero VRAM). Text is piped to stdin,
 * Piper writes a WAV file, and the bytes are returned for the web UI to play.
 * Missing binaries or models produce clear errors, never crashes.
 */
export class TtsService {
  private readonly config: ForgeConfig;
  private readonly runBinary: RunBinary;

  constructor(options: TtsServiceOptions) {
    this.config = options.config;
    this.runBinary = options.runBinary ?? defaultRunBinary;
  }

  status(): TtsStatus {
    const tts = this.config.voice?.tts;
    if (tts?.enabled !== true) {
      return { enabled: false, configured: false, message: 'Text-to-speech is disabled (voice.tts.enabled).' };
    }
    if (!tts.model) {
      return { enabled: true, configured: false, message: 'voice.tts.model is not set (path to a Piper voice .onnx).' };
    }
    if (!fs.existsSync(tts.model)) {
      return { enabled: true, configured: false, message: `Piper voice model not found at ${tts.model}.` };
    }
    return { enabled: true, configured: true };
  }

  async synthesize(text: string): Promise<Buffer> {
    const tts = this.config.voice?.tts;
    if (tts?.enabled !== true) {
      throw new Error('Text-to-speech is disabled (voice.tts.enabled).');
    }
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error('Nothing to speak: the text is empty.');
    }
    const maxChars = tts.max_chars ?? 2000;
    if (trimmed.length > maxChars) {
      throw new Error(`Text exceeds the ${maxChars} character synthesis limit.`);
    }
    if (!tts.model) {
      throw new Error('voice.tts.model is not set (path to a Piper voice .onnx).');
    }
    if (!fs.existsSync(tts.model)) {
      throw new Error(`Piper voice model not found at ${tts.model}.`);
    }

    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-tts-'));
    const outPath = path.join(dir, 'output.wav');
    try {
      try {
        await this.runBinary(
          tts.binary,
          ['--model', tts.model, '--output_file', outPath],
          { timeoutMs: tts.timeout_ms, stdin: trimmed },
        );
      } catch (err) {
        if (err instanceof BinaryMissingError) {
          throw new Error(`Piper binary not found at '${tts.binary}'. Install Piper and set voice.tts.binary.`);
        }
        throw err;
      }

      let audio: Buffer;
      try {
        audio = await fs.promises.readFile(outPath);
      } catch {
        throw new Error('Piper did not produce an audio file.');
      }
      if (audio.length === 0) {
        throw new Error('Piper produced an empty audio file.');
      }
      return audio;
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
