import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ForgeConfig, ToolDef } from '../../types.ts';
import { isPathAllowed } from './permissions.ts';

// Byte cap on a single read_file result when tools.filesystem.max_read_bytes
// is not set. Keeps one tool call from flooding the 16k context window.
const DEFAULT_MAX_READ_BYTES = 262_144; // 256 KiB
// Hard cap on directory entries returned by list_dir.
const MAX_LIST_ENTRIES = 500;

export interface FilesystemToolDeps {
  config: ForgeConfig;
}

/**
 * Read-only filesystem tools at the 'filesystem' permission level. Both are
 * additionally bound by the tools.filesystem.readable_dirs allowlist via
 * isPathAllowed: the lexical gate runs on the requested path first (so we
 * never even stat a path outside the allowlist), then again on the realpath,
 * so a symlink inside an allowlisted directory cannot escape it. Nothing here
 * writes: writable_dirs stays reserved for a future write tool.
 */
export function createFilesystemTools(deps: FilesystemToolDeps): ToolDef[] {
  return [
    createReadFileTool(deps),
    createListDirTool(deps),
  ];
}

function createReadFileTool(deps: FilesystemToolDeps): ToolDef {
  return {
    name: 'read_file',
    description: 'Read a text file from an allowlisted directory. Returns the file content as UTF-8 text (truncated past the configured byte cap). Fails on binary files and directories.',
    permission: 'filesystem',
    params: z.object({
      path: z.string().min(1).describe('Absolute path (or path relative to the forge root) of the file to read'),
    }),
    handler: async (args) => {
      const realPath = await gateAndResolve(deps.config, String(args.path));
      const stats = await fs.stat(realPath);
      if (stats.isDirectory()) {
        throw new Error(`'${realPath}' is a directory; use list_dir to see its entries.`);
      }
      if (!stats.isFile()) {
        throw new Error(`'${realPath}' is not a regular file.`);
      }

      const maxBytes = deps.config.tools?.filesystem?.max_read_bytes ?? DEFAULT_MAX_READ_BYTES;
      const truncated = stats.size > maxBytes;
      const buffer = Buffer.alloc(Math.min(stats.size, maxBytes));
      const handle = await fs.open(realPath, 'r');
      try {
        await handle.read(buffer, 0, buffer.length, 0);
      } finally {
        await handle.close();
      }
      if (buffer.includes(0)) {
        throw new Error(`'${realPath}' looks like a binary file; only text files can be read.`);
      }

      return {
        path: realPath,
        size_bytes: stats.size,
        truncated,
        content: buffer.toString('utf-8'),
      };
    },
  };
}

function createListDirTool(deps: FilesystemToolDeps): ToolDef {
  return {
    name: 'list_dir',
    description: 'List the entries of a directory inside an allowlisted directory. Returns names, types (file/dir), and file sizes.',
    permission: 'filesystem',
    params: z.object({
      path: z.string().min(1).describe('Absolute path (or path relative to the forge root) of the directory to list'),
    }),
    handler: async (args) => {
      const realPath = await gateAndResolve(deps.config, String(args.path));
      const stats = await fs.stat(realPath);
      if (!stats.isDirectory()) {
        throw new Error(`'${realPath}' is not a directory; use read_file for files.`);
      }

      const dirents = await fs.readdir(realPath, { withFileTypes: true });
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      const truncated = dirents.length > MAX_LIST_ENTRIES;
      const entries = await Promise.all(dirents.slice(0, MAX_LIST_ENTRIES).map(async dirent => {
        const type = dirent.isDirectory() ? 'dir' as const
          : dirent.isFile() ? 'file' as const
          : 'other' as const;
        let sizeBytes: number | null = null;
        if (type === 'file') {
          try {
            sizeBytes = (await fs.stat(path.join(realPath, dirent.name))).size;
          } catch {
            // Entry vanished or is unreadable; the name is still worth listing.
          }
        }
        return { name: dirent.name, type, size_bytes: sizeBytes };
      }));

      return {
        path: realPath,
        total_entries: dirents.length,
        truncated,
        entries,
      };
    },
  };
}

/**
 * Shared gate: lexical allowlist check on the requested path, then resolve
 * symlinks and re-check the realpath (per the isPathAllowed contract).
 * Exported for other path-taking tools (analyze_image) so every read goes
 * through the identical readable_dirs discipline.
 */
export async function gateAndResolve(config: ForgeConfig, requested: string): Promise<string> {
  const decision = isPathAllowed(config, requested, 'read');
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Path is not allowed.');
  }

  let realPath: string;
  try {
    realPath = await fs.realpath(requested);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Path does not exist: ${requested}`);
    }
    throw error;
  }

  const realDecision = isPathAllowed(config, realPath, 'read');
  if (!realDecision.allowed) {
    throw new Error(`'${requested}' resolves (via symlink) to '${realPath}', which is outside the allowlisted readable directories.`);
  }
  return realPath;
}
