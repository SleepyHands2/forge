import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ForgeConfig } from '../types.ts';

/**
 * Inbound attachment storage for channel adapters (Telegram today). Files are
 * saved under channels.telegram.attachments.dir with generated names — never
 * a remote filename — so a hostile sender cannot influence the path. While
 * the feature is enabled, isPathAllowed treats the resolved dir as an
 * implicit readable root, which is what lets analyze_image read the files
 * without a manual tools.filesystem.readable_dirs entry.
 */

/** Resolved attachments dir when telegram attachments are enabled, else undefined. */
export function resolveAttachmentsDir(config: ForgeConfig): string | undefined {
  const attachments = config.channels?.telegram?.attachments;
  if (attachments?.enabled !== true) return undefined;
  return path.resolve(attachments.dir ?? './attachments');
}

export interface SaveAttachmentInput {
  dir: string;
  bytes: Uint8Array;
  /** Normalized extension including the dot, e.g. '.jpg'. Validated by the caller. */
  extension: string;
  /** Filename prefix, e.g. 'telegram'. Pruning only ever touches files with this prefix. */
  prefix: string;
  /** When set, files with the same prefix older than this are pruned after the save. */
  retentionDays?: number;
}

/** Save attachment bytes under a generated name; returns the absolute file path. */
export async function saveAttachment(input: SaveAttachmentInput): Promise<string> {
  await fs.mkdir(input.dir, { recursive: true });
  const filePath = path.join(input.dir, generateName(input.prefix, input.extension));
  await fs.writeFile(filePath, input.bytes, { flag: 'wx' });
  if (input.retentionDays !== undefined) {
    await pruneAttachments(input.dir, input.prefix, input.retentionDays);
  }
  return filePath;
}

/**
 * Delete files in dir matching `${prefix}-` whose mtime is older than
 * retentionDays. Best-effort: a file that cannot be statted or removed is
 * skipped, never fatal. Returns the number of files deleted.
 */
export async function pruneAttachments(dir: string, prefix: string, retentionDays: number): Promise<number> {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0;
  }
  let deleted = 0;
  for (const entry of entries) {
    if (!entry.startsWith(`${prefix}-`)) continue;
    const entryPath = path.join(dir, entry);
    try {
      const stats = await fs.stat(entryPath);
      if (!stats.isFile() || stats.mtimeMs >= cutoff) continue;
      await fs.unlink(entryPath);
      deleted += 1;
    } catch {
      // Best-effort cleanup; leave the file for the next pass.
    }
  }
  return deleted;
}

function generateName(prefix: string, extension: string): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}-${stamp}-${crypto.randomBytes(3).toString('hex')}${extension}`;
}
