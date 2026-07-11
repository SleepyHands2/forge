import path from 'node:path';
import type { ForgeConfig } from '../types.ts';
import { resolveAttachmentsDir, saveAttachment } from '../services/attachments.ts';
import { isLevelEnabled } from '../services/tools/permissions.ts';
import type { ChannelAdapter, InboundHandler, InboundMessage } from './types.ts';

const TELEGRAM_MESSAGE_LIMIT = 4096;
const POLL_ERROR_BACKOFF_MS = 3000;
const GET_FILE_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_FILE_BYTES = 10_485_760;

// Mirrors the analyze_image allowlist in vision.ts: only save what the
// vision tool could actually open.
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
};

interface TelegramPhotoSize {
  file_id?: string;
  file_size?: number;
}

interface TelegramDocument {
  file_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat?: { id?: number | string; type?: string };
    from?: { first_name?: string; username?: string };
    text?: string;
    caption?: string;
    photo?: TelegramPhotoSize[];
    document?: TelegramDocument;
  };
}

type MediaPick =
  | { status: 'download'; fileId: string; extension: string; kind: 'photo' | 'document' }
  | { status: 'too_large'; declaredBytes: number };

interface TelegramLogger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface TelegramAdapterOptions {
  config: ForgeConfig;
  handler: InboundHandler;
  fetchImpl?: typeof fetch;
  logger?: TelegramLogger;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Telegram channel via the Bot API with long polling (no public URL or
 * webhook needed for a local-first install). Inbound text messages from
 * allowlisted chats run through the shared chat pipeline; replies are sent
 * back with sendMessage, split at Telegram's 4096-character limit.
 *
 * When channels.telegram.attachments is enabled, inbound photos (and images
 * sent as files) are downloaded into the attachments dir under a generated
 * name, and the turn tells the model where the file landed so it can call
 * analyze_image itself — the image never enters the chat model's context as
 * pixels (the main model's vision projector is broken; the vision model is a
 * separate tool). With attachments off, non-text messages are dropped
 * exactly as before.
 *
 * Security: chats not in channels.telegram.allowed_chat_ids never reach the
 * pipeline — the bot answers once with the chat id so the owner can allowlist
 * themselves, then only logs further attempts.
 */
export class TelegramAdapter implements ChannelAdapter {
  readonly name = 'telegram';

  private readonly config: ForgeConfig;
  private readonly handler: InboundHandler;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: TelegramLogger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly notifiedChats = new Set<string>();
  private offset = 0;
  private running = false;
  private loop: Promise<void> | null = null;

  constructor(options: TelegramAdapterOptions) {
    this.config = options.config;
    this.handler = options.handler;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger ?? console;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  async start(): Promise<void> {
    this.token(); // fail fast with a clear message before the loop starts
    if (this.running) return;
    this.running = true;
    this.logger.log('[telegram] Bridge started (long polling).');
    this.loop = this.pollLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop?.catch(() => {});
    this.loop = null;
  }

  /** One getUpdates round-trip; exposed for tests. Returns processed update count. */
  async pollOnce(): Promise<number> {
    const telegram = this.config.channels?.telegram;
    const timeoutS = telegram?.poll_timeout_s ?? 30;
    const url = `${this.apiBase()}/getUpdates?timeout=${timeoutS}&offset=${this.offset + 1}`;

    const response = await this.fetchImpl(url, {
      signal: AbortSignal.timeout((timeoutS + 15) * 1000),
    });
    if (!response.ok) {
      throw new Error(`Telegram getUpdates failed: HTTP ${response.status}`);
    }
    const body = await response.json() as { ok?: boolean; result?: unknown; description?: string };
    if (body.ok !== true || !Array.isArray(body.result)) {
      throw new Error(`Telegram getUpdates failed: ${body.description ?? 'unexpected response'}`);
    }

    let processed = 0;
    for (const update of body.result as TelegramUpdate[]) {
      if (typeof update.update_id === 'number') {
        this.offset = Math.max(this.offset, update.update_id);
      }
      await this.handleUpdate(update);
      processed += 1;
    }
    return processed;
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (err) {
        if (!this.running) return;
        this.logger.warn('[telegram] Poll failed:', err instanceof Error ? err.message : String(err));
        await this.sleep(POLL_ERROR_BACKOFF_MS);
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const chatId = message?.chat?.id;
    if (!message || chatId === undefined || chatId === null) return;

    const text = typeof message.text === 'string' && message.text.trim().length > 0 ? message.text : undefined;
    // pickMedia is pure config + message inspection: nothing is downloaded
    // before the allowlist check below.
    const media = text === undefined ? this.pickMedia(message) : undefined;
    if (text === undefined && media === undefined) return;
    const chat = String(chatId);

    const allowed = (this.config.channels?.telegram?.allowed_chat_ids ?? []).map(String);
    if (!allowed.includes(chat)) {
      this.logger.warn(`[telegram] Rejected message from non-allowlisted chat ${chat}.`);
      if (!this.notifiedChats.has(chat)) {
        this.notifiedChats.add(chat);
        await this.sendMessage(chat, `This Forge instance has not allowed this chat. To allow it, add chat id ${chat} to channels.telegram.allowed_chat_ids in forge.config.yaml.`).catch(() => {});
      }
      return;
    }

    const userName = message.from?.first_name || message.from?.username || this.config.user.name;

    let inbound: InboundMessage;
    if (media !== undefined) {
      if (media.status === 'too_large') {
        const cap = this.config.channels?.telegram?.attachments?.max_file_bytes ?? DEFAULT_MAX_FILE_BYTES;
        await this.sendMessage(chat, `That image is ${media.declaredBytes} bytes, over this Forge's attachment cap of ${cap} bytes, so it was not downloaded.`).catch(() => {});
        return;
      }
      try {
        inbound = await this.downloadToInbound(chat, userName, message, media);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn('[telegram] Attachment download failed:', msg);
        await this.sendMessage(chat, `I couldn't fetch that image from Telegram: ${msg}`).catch(() => {});
        return;
      }
    } else {
      inbound = { channel: 'telegram', chatId: chat, userName, text: text as string };
    }

    let reply: string;
    try {
      reply = await this.handler(inbound);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn('[telegram] Turn failed:', msg);
      reply = `Something went wrong handling that message: ${msg}`;
    }

    try {
      await this.sendMessage(chat, reply);
    } catch (err) {
      this.logger.warn('[telegram] sendMessage failed:', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Decide whether a non-text message carries an image we should download.
   * Returns undefined for anything that should be silently dropped: the
   * feature is off, the message has no media, or the document is not an
   * image the vision model could open.
   */
  private pickMedia(message: NonNullable<TelegramUpdate['message']>): MediaPick | undefined {
    const attachments = this.config.channels?.telegram?.attachments;
    if (attachments?.enabled !== true) return undefined;
    const cap = attachments.max_file_bytes ?? DEFAULT_MAX_FILE_BYTES;

    const photos = (message.photo ?? []).filter(p => typeof p.file_id === 'string');
    if (photos.length > 0) {
      // Telegram lists photo sizes smallest-first; take the largest under the cap.
      const usable = photos.filter(p => typeof p.file_size !== 'number' || p.file_size <= cap);
      const best = usable[usable.length - 1];
      if (!best) {
        return { status: 'too_large', declaredBytes: photos[photos.length - 1].file_size ?? 0 };
      }
      return { status: 'download', fileId: best.file_id as string, extension: '.jpg', kind: 'photo' };
    }

    const document = message.document;
    if (document && typeof document.file_id === 'string') {
      const extension = documentImageExtension(document);
      if (!extension) return undefined;
      if (typeof document.file_size === 'number' && document.file_size > cap) {
        return { status: 'too_large', declaredBytes: document.file_size };
      }
      return { status: 'download', fileId: document.file_id, extension, kind: 'document' };
    }
    return undefined;
  }

  /** Download the picked media, save it to the attachments dir, and build the turn input. */
  private async downloadToInbound(
    chat: string,
    userName: string,
    message: NonNullable<TelegramUpdate['message']>,
    media: Extract<MediaPick, { status: 'download' }>,
  ): Promise<InboundMessage> {
    const attachments = this.config.channels?.telegram?.attachments;
    const cap = attachments?.max_file_bytes ?? DEFAULT_MAX_FILE_BYTES;
    const dir = resolveAttachmentsDir(this.config);
    if (!dir) throw new Error('Attachments are disabled (channels.telegram.attachments.enabled).');

    const bytes = await this.downloadFile(media.fileId, cap);
    const savedPath = await saveAttachment({
      dir,
      bytes,
      extension: media.extension,
      prefix: 'telegram',
      retentionDays: attachments?.retention_days ?? 7,
    });

    const caption = typeof message.caption === 'string' && message.caption.trim().length > 0
      ? message.caption.trim()
      : undefined;
    const fileName = path.basename(savedPath);
    // The model must be able to open the file for analyze_image to work;
    // when that chain is broken, say so instead of inviting a failing call.
    const visionReady = this.config.vision?.enabled === true && isLevelEnabled(this.config, 'filesystem');
    const lines = [`The user sent a photo over Telegram. It is saved at: ${savedPath}`];
    lines.push(visionReady
      ? 'Call the analyze_image tool with that exact path to see it; choose the prompt from what the user is asking for.'
      : 'Image analysis is unavailable right now (vision or filesystem tools are disabled), so tell the user you received the photo but cannot view it.');
    if (caption) lines.push(`The user's caption: ${caption}`);

    return {
      channel: 'telegram',
      chatId: chat,
      userName,
      text: caption ? `[Photo: ${fileName}] ${caption}` : `[Photo: ${fileName}]`,
      llmText: lines.join('\n'),
      attachmentsMeta: [{ type: media.kind, path: savedPath, bytes: bytes.byteLength, telegram_file_id: media.fileId }],
    };
  }

  /** getFile + file download with the size cap enforced before, during, and after the fetch. */
  private async downloadFile(fileId: string, cap: number): Promise<Uint8Array> {
    const infoResponse = await this.fetchImpl(`${this.apiBase()}/getFile?file_id=${encodeURIComponent(fileId)}`, {
      signal: AbortSignal.timeout(GET_FILE_TIMEOUT_MS),
    });
    if (!infoResponse.ok) {
      throw new Error(`Telegram getFile failed: HTTP ${infoResponse.status}`);
    }
    const info = await infoResponse.json() as { ok?: boolean; result?: { file_path?: string; file_size?: number } };
    const filePath = info.result?.file_path;
    if (info.ok !== true || typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error('Telegram getFile returned no file path.');
    }
    if (typeof info.result?.file_size === 'number' && info.result.file_size > cap) {
      throw new Error(`File is ${info.result.file_size} bytes, over the attachments.max_file_bytes cap of ${cap}.`);
    }

    const base = (this.config.channels?.telegram?.api_base_url ?? 'https://api.telegram.org').replace(/\/$/, '');
    const fileResponse = await this.fetchImpl(`${base}/file/bot${this.token()}/${filePath}`, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!fileResponse.ok) {
      throw new Error(`Telegram file download failed: HTTP ${fileResponse.status}`);
    }
    const declared = Number(fileResponse.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > cap) {
      throw new Error(`File is ${declared} bytes, over the attachments.max_file_bytes cap of ${cap}.`);
    }
    const bytes = new Uint8Array(await fileResponse.arrayBuffer());
    if (bytes.byteLength > cap) {
      throw new Error(`File is ${bytes.byteLength} bytes, over the attachments.max_file_bytes cap of ${cap}.`);
    }
    return bytes;
  }

  /** Send text to a chat, splitting at Telegram's message limit. Public so the scheduler can deliver job output. */
  async sendMessage(chatId: string, text: string): Promise<void> {
    const content = text.trim() || '(empty reply)';
    for (const part of splitMessage(content, TELEGRAM_MESSAGE_LIMIT)) {
      const response = await this.fetchImpl(`${this.apiBase()}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: part }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(`Telegram sendMessage failed: HTTP ${response.status}`);
      }
    }
  }

  private apiBase(): string {
    const base = (this.config.channels?.telegram?.api_base_url ?? 'https://api.telegram.org').replace(/\/$/, '');
    return `${base}/bot${this.token()}`;
  }

  private token(): string {
    const telegram = this.config.channels?.telegram;
    const envName = telegram?.token_env ?? 'FORGE_TELEGRAM_TOKEN';
    const token = process.env[envName]?.trim() || telegram?.token?.trim();
    if (!token) {
      throw new Error(`Telegram bridge is enabled but no bot token was found. Set the ${envName} environment variable (or channels.telegram.token).`);
    }
    return token;
  }
}

/** Extension for a document that is an image the vision model can open, else undefined. */
function documentImageExtension(document: TelegramDocument): string | undefined {
  const fromMime = document.mime_type ? MIME_TO_EXTENSION[document.mime_type.toLowerCase()] : undefined;
  if (fromMime) return fromMime;
  const ext = document.file_name ? path.extname(document.file_name).toLowerCase() : '';
  return IMAGE_EXTENSIONS.has(ext) ? ext : undefined;
}

export function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    // Prefer a newline break near the limit, then a space, then hard cut.
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit / 2) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}
