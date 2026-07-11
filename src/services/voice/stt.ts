import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage, ForgeConfig } from '../../types.ts';
import type { LLMService } from '../llm.ts';
import { defaultRunBinary, BinaryMissingError, type RunBinary } from './runner.ts';

export interface TranscribeInput {
  /** 16-bit PCM WAV bytes (the web recorder produces 16 kHz mono). */
  data: Buffer;
}

export interface TranscribeResult {
  text: string;
  engine: 'whisper-cpp' | 'native';
}

export interface SttStatus {
  enabled: boolean;
  engine: 'whisper-cpp' | 'native';
  configured: boolean;
  message?: string;
}

export interface SttServiceOptions {
  config: ForgeConfig;
  /** Needed only for the 'native' engine (audio goes to the chat model). */
  llm?: Pick<LLMService, 'complete'>;
  runBinary?: RunBinary;
}

/**
 * Speech-to-text. Default engine shells out to the whisper.cpp CLI on CPU
 * (zero VRAM next to E4B); the 'native' engine sends the audio to the chat
 * model itself, which Gemma 4 E4B supports. Every failure — missing binary,
 * missing model file, timeout, empty output — becomes a clear Error message;
 * nothing here can crash the server.
 */
export class SttService {
  private readonly config: ForgeConfig;
  private readonly llm?: Pick<LLMService, 'complete'>;
  private readonly runBinary: RunBinary;

  constructor(options: SttServiceOptions) {
    this.config = options.config;
    this.llm = options.llm;
    this.runBinary = options.runBinary ?? defaultRunBinary;
  }

  status(): SttStatus {
    const stt = this.config.voice?.stt;
    const enabled = stt?.enabled === true;
    const engine = stt?.engine ?? 'whisper-cpp';
    if (!enabled) {
      return { enabled: false, engine, configured: false, message: 'Speech-to-text is disabled (voice.stt.enabled).' };
    }
    if (engine === 'native') {
      return { enabled, engine, configured: this.llm !== undefined };
    }
    if (!stt?.model) {
      return { enabled, engine, configured: false, message: 'voice.stt.model is not set (path to a ggml whisper model).' };
    }
    if (!fs.existsSync(stt.model)) {
      return { enabled, engine, configured: false, message: `Whisper model not found at ${stt.model}.` };
    }
    return { enabled, engine, configured: true };
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    const stt = this.config.voice?.stt;
    if (stt?.enabled !== true) {
      throw new Error('Speech-to-text is disabled (voice.stt.enabled).');
    }
    if (!isWav(input.data)) {
      throw new Error('Audio must be a WAV file (the web recorder produces 16 kHz mono WAV).');
    }

    if (stt.engine === 'native') {
      return this.transcribeNative(input);
    }
    return this.transcribeWhisper(input);
  }

  private async transcribeWhisper(input: TranscribeInput): Promise<TranscribeResult> {
    const stt = this.config.voice!.stt;
    if (!stt.model) {
      throw new Error('voice.stt.model is not set (path to a ggml whisper model).');
    }
    if (!fs.existsSync(stt.model)) {
      throw new Error(`Whisper model not found at ${stt.model}.`);
    }

    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-stt-'));
    const wavPath = path.join(dir, 'input.wav');
    try {
      await fs.promises.writeFile(wavPath, input.data);
      const args = ['-m', stt.model, '-f', wavPath, '-nt', '-np'];
      if (stt.language && stt.language !== 'auto') args.push('-l', stt.language);

      let stdout: string;
      try {
        ({ stdout } = await this.runBinary(stt.binary, args, { timeoutMs: stt.timeout_ms }));
      } catch (err) {
        if (err instanceof BinaryMissingError) {
          throw new Error(`whisper.cpp binary not found at '${stt.binary}'. Install whisper.cpp and set voice.stt.binary.`);
        }
        throw err;
      }

      const text = stdout.replace(/\s+/g, ' ').trim();
      if (!text) {
        throw new Error('No speech detected in the audio.');
      }
      return { text, engine: 'whisper-cpp' };
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async transcribeNative(input: TranscribeInput): Promise<TranscribeResult> {
    if (!this.llm) {
      throw new Error("The 'native' STT engine requires the chat model, which is unavailable.");
    }
    const message: ChatMessage = {
      role: 'user',
      content: 'Transcribe this audio verbatim. Output only the transcript text, with no commentary.',
      audio: [input.data.toString('base64')],
    };
    const response = await this.llm.complete({
      system: 'You are a transcription engine. Output only the verbatim transcript of the provided audio.',
      messages: [message],
    });
    const text = response.content.replace(/\s+/g, ' ').trim();
    if (!text) {
      throw new Error('The model returned an empty transcript.');
    }
    return { text, engine: 'native' };
  }
}

function isWav(data: Buffer): boolean {
  return data.length >= 12
    && data.toString('ascii', 0, 4) === 'RIFF'
    && data.toString('ascii', 8, 12) === 'WAVE';
}
