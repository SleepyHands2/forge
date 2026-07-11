import { Router } from 'express';
import type { WebContext } from '../server.ts';

const MAX_AUDIO_BYTES = 5 * 1024 * 1024; // ~2.5 min of 16 kHz mono 16-bit WAV

/**
 * Voice I/O: status for the UI, WAV transcription into text (which the client
 * then sends through the normal chat pipeline), and Piper synthesis of reply
 * text to WAV. Failures return clear JSON errors — a missing binary can never
 * take the server down.
 */
export function voiceRoutes(ctx: WebContext): Router {
  const router = Router();

  router.get('/status', (_req, res) => {
    res.json({
      stt: ctx.voice ? ctx.voice.stt.status() : { enabled: false, engine: 'whisper-cpp', configured: false },
      tts: ctx.voice ? ctx.voice.tts.status() : { enabled: false, configured: false },
    });
  });

  router.post('/transcribe', async (req, res) => {
    if (!ctx.voice) {
      res.status(503).json({ error: 'Voice services are not available.' });
      return;
    }
    const body = req.body;
    if (typeof body !== 'object' || body === null || typeof (body as { data?: unknown }).data !== 'string') {
      res.status(400).json({ error: 'data must be a base64 WAV string' });
      return;
    }
    const decoded = decodeBase64((body as { data: string }).data);
    if (!decoded) {
      res.status(400).json({ error: 'data must be valid base64' });
      return;
    }
    if (decoded.length > MAX_AUDIO_BYTES) {
      res.status(400).json({ error: `audio exceeds ${MAX_AUDIO_BYTES} bytes` });
      return;
    }

    try {
      const result = await ctx.voice.stt.transcribe({ data: decoded });
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(422).json({ error: msg });
    }
  });

  router.post('/speak', async (req, res) => {
    if (!ctx.voice) {
      res.status(503).json({ error: 'Voice services are not available.' });
      return;
    }
    const body = req.body;
    if (typeof body !== 'object' || body === null || typeof (body as { text?: unknown }).text !== 'string') {
      res.status(400).json({ error: 'text must be a string' });
      return;
    }

    try {
      const audio = await ctx.voice.tts.synthesize((body as { text: string }).text);
      res.status(200).set({ 'Content-Type': 'audio/wav', 'Content-Length': String(audio.length) });
      res.end(audio);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(422).json({ error: msg });
    }
  });

  return router;
}

function decodeBase64(value: string): Buffer | null {
  if (value.length === 0 || value.startsWith('data:') || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return null;
  }
  try {
    return Buffer.from(value, 'base64');
  } catch {
    return null;
  }
}
