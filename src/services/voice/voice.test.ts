import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { SttService } from './stt.ts';
import { TtsService } from './tts.ts';
import { BinaryMissingError, BinaryTimeoutError, type RunBinary } from './runner.ts';
import { LLMService } from '../llm.ts';
import type { ForgeConfig, LLMRequest, LLMResponse, VoiceConfig } from '../../types.ts';

function config(voice: {
  stt?: Partial<VoiceConfig['stt']>;
  tts?: Partial<VoiceConfig['tts']>;
} = {}): ForgeConfig {
  return {
    forge: { name: 'forge-local', version: '0.1.0', root: '.' },
    user: { name: 'tester' },
    llm: {
      provider: 'ollama',
      model: 'local-model',
      ollama: { base_url: 'http://localhost:11434', keep_alive: '10m', options: {} },
    },
    paths: { dbs: './dbs', identity: './identity', logs: './logs' },
    services: { web: { host: '127.0.0.1', port: 6800, context_window_tokens: 80000, debug_prompt_context: false } },
    memory: { retention_days: 30 },
    voice: {
      stt: {
        enabled: true,
        engine: 'whisper-cpp',
        binary: 'whisper-cli',
        model: MODEL_FILE, // any existing file satisfies the model-exists check
        language: 'auto',
        timeout_ms: 60_000,
        ...voice.stt,
      },
      tts: {
        enabled: true,
        binary: 'piper',
        model: MODEL_FILE,
        timeout_ms: 30_000,
        max_chars: 2000,
        ...voice.tts,
      },
    },
  };
}

const MODEL_FILE = fileURLToPath(import.meta.url);

function wavBytes(): Buffer {
  // Minimal RIFF/WAVE header followed by a little silence.
  const header = Buffer.from('RIFF\x24\x00\x00\x00WAVE', 'binary');
  return Buffer.concat([header, Buffer.alloc(64)]);
}

interface BinaryCall {
  binary: string;
  args: string[];
  stdin?: string;
  timeoutMs: number;
}

function mockRunBinary(behavior: {
  stdout?: string;
  error?: Error;
  onCall?: (call: BinaryCall) => void;
}): { calls: BinaryCall[]; run: RunBinary } {
  const calls: BinaryCall[] = [];
  return {
    calls,
    run: async (binary, args, options) => {
      const call = { binary, args, stdin: options.stdin, timeoutMs: options.timeoutMs };
      calls.push(call);
      behavior.onCall?.(call);
      if (behavior.error) throw behavior.error;
      return { stdout: behavior.stdout ?? '', stderr: '' };
    },
  };
}

// --- STT ---------------------------------------------------------------------

test('stt transcribes a WAV through whisper.cpp with the configured model and language', async () => {
  const mock = mockRunBinary({ stdout: '  Hello   from the microphone. \n' });
  const stt = new SttService({ config: config({ stt: { language: 'en' } }), runBinary: mock.run });

  const result = await stt.transcribe({ data: wavBytes() });

  assert.deepEqual(result, { text: 'Hello from the microphone.', engine: 'whisper-cpp' });
  assert.equal(mock.calls.length, 1);
  const call = mock.calls[0];
  assert.equal(call.binary, 'whisper-cli');
  assert.equal(call.args[0], '-m');
  assert.equal(call.args[1], MODEL_FILE);
  assert.equal(call.args[2], '-f');
  assert.match(call.args[3], /forge-stt-.*input\.wav/);
  assert.ok(call.args.includes('-nt'));
  assert.deepEqual(call.args.slice(-2), ['-l', 'en']);
  // The temp WAV is cleaned up after transcription.
  assert.equal(fs.existsSync(call.args[3]), false);
});

test('stt fails gracefully: missing binary, missing model, timeout, empty output, bad input', async () => {
  const missingBinary = new SttService({
    config: config(),
    runBinary: mockRunBinary({ error: new BinaryMissingError('whisper-cli') }).run,
  });
  await assert.rejects(missingBinary.transcribe({ data: wavBytes() }), /whisper\.cpp binary not found at 'whisper-cli'/);

  const missingModel = new SttService({
    config: config({ stt: { model: 'Z:\\nope\\ggml-missing.bin' } }),
    runBinary: mockRunBinary({ stdout: 'never' }).run,
  });
  await assert.rejects(missingModel.transcribe({ data: wavBytes() }), /Whisper model not found/);

  const unsetModel = new SttService({
    config: config({ stt: { model: '' } }),
    runBinary: mockRunBinary({ stdout: 'never' }).run,
  });
  await assert.rejects(unsetModel.transcribe({ data: wavBytes() }), /voice\.stt\.model is not set/);

  const timedOut = new SttService({
    config: config(),
    runBinary: mockRunBinary({ error: new BinaryTimeoutError('whisper-cli', 60_000) }).run,
  });
  await assert.rejects(timedOut.transcribe({ data: wavBytes() }), /timed out after 60000ms/);

  const silent = new SttService({ config: config(), runBinary: mockRunBinary({ stdout: '   \n' }).run });
  await assert.rejects(silent.transcribe({ data: wavBytes() }), /No speech detected/);

  const notWav = new SttService({ config: config(), runBinary: mockRunBinary({ stdout: 'x' }).run });
  await assert.rejects(notWav.transcribe({ data: Buffer.from('not audio') }), /must be a WAV/);

  const disabled = new SttService({
    config: config({ stt: { enabled: false } }),
    runBinary: mockRunBinary({ stdout: 'never' }).run,
  });
  await assert.rejects(disabled.transcribe({ data: wavBytes() }), /disabled/);
});

test('stt native engine sends the audio to the chat model and returns its transcript', async () => {
  const requests: LLMRequest[] = [];
  const llm = {
    async complete(req: LLMRequest): Promise<LLMResponse> {
      requests.push(req);
      return { content: ' Transcribed by the model. ', provider: 'ollama', model: 'local-model', inputTokens: 1, outputTokens: 1 };
    },
  };
  const stt = new SttService({ config: config({ stt: { engine: 'native' } }), llm });

  const audio = wavBytes();
  const result = await stt.transcribe({ data: audio });

  assert.deepEqual(result, { text: 'Transcribed by the model.', engine: 'native' });
  assert.equal(requests.length, 1);
  const message = requests[0].messages[0];
  assert.equal(message.role, 'user');
  assert.deepEqual(message.audio, [audio.toString('base64')]);
  assert.match(requests[0].system, /transcription engine/i);
});

test('stt status reports enabled/configured states without running anything', () => {
  assert.equal(new SttService({ config: config() }).status().configured, true);
  assert.equal(new SttService({ config: config({ stt: { enabled: false } }) }).status().enabled, false);
  const missing = new SttService({ config: config({ stt: { model: 'Z:\\nope.bin' } }) }).status();
  assert.equal(missing.configured, false);
  assert.match(missing.message ?? '', /not found/);
});

// --- TTS ---------------------------------------------------------------------

test('tts synthesizes text through piper via stdin and returns the WAV bytes', async () => {
  const audio = Buffer.from('RIFFfakewavWAVEdata');
  const mock = mockRunBinary({
    onCall: (call) => {
      const outIndex = call.args.indexOf('--output_file');
      fs.writeFileSync(call.args[outIndex + 1], audio);
    },
  });
  const tts = new TtsService({ config: config(), runBinary: mock.run });

  const result = await tts.synthesize('Hello from Forge.');

  assert.deepEqual(result, audio);
  const call = mock.calls[0];
  assert.equal(call.binary, 'piper');
  assert.deepEqual(call.args.slice(0, 2), ['--model', MODEL_FILE]);
  assert.equal(call.stdin, 'Hello from Forge.');
  // Temp output is cleaned up after the bytes are read.
  assert.equal(fs.existsSync(call.args[call.args.indexOf('--output_file') + 1]), false);
});

test('tts fails gracefully: disabled, empty text, over cap, missing binary/model, no output file', async () => {
  const disabled = new TtsService({ config: config({ tts: { enabled: false } }), runBinary: mockRunBinary({}).run });
  await assert.rejects(disabled.synthesize('hi'), /disabled/);

  const tts = new TtsService({ config: config({ tts: { max_chars: 10 } }), runBinary: mockRunBinary({}).run });
  await assert.rejects(tts.synthesize('   '), /empty/);
  await assert.rejects(tts.synthesize('this is longer than ten characters'), /10 character/);

  const missingBinary = new TtsService({
    config: config(),
    runBinary: mockRunBinary({ error: new BinaryMissingError('piper') }).run,
  });
  await assert.rejects(missingBinary.synthesize('hello'), /Piper binary not found at 'piper'/);

  const missingModel = new TtsService({
    config: config({ tts: { model: 'Z:\\nope\\voice.onnx' } }),
    runBinary: mockRunBinary({}).run,
  });
  await assert.rejects(missingModel.synthesize('hello'), /voice model not found/);

  // Binary "succeeds" but writes nothing.
  const noOutput = new TtsService({ config: config(), runBinary: mockRunBinary({}).run });
  await assert.rejects(noOutput.synthesize('hello'), /did not produce an audio file/);
});

// --- native audio passthrough to Ollama -------------------------------------------

test('LLMService passes user message audio through to Ollama', async () => {
  let messages: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    messages = (JSON.parse(String(init?.body ?? '{}')) as { messages: Array<Record<string, unknown>> }).messages;
    return new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 });
  };
  const service = new LLMService(config(), { fetchImpl });

  await service.complete({
    system: 's',
    messages: [{ role: 'user', content: 'transcribe', audio: ['QUJD'] }],
  });

  assert.deepEqual(messages, [
    { role: 'system', content: 's' },
    { role: 'user', content: 'transcribe', audio: ['QUJD'] },
  ]);
});
