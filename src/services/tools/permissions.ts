import path from 'node:path';
import type { ForgeConfig, ToolDef, ToolPermission } from '../../types.ts';
import { resolveAttachmentsDir } from '../attachments.ts';

export interface PermissionDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Gate a tool call against the config. Deny-by-default: tools run only when
 * the master switch AND the tool's permission level are both explicitly on.
 * This is checked at call time even for tools that were advertised to the
 * model, so a config change (or a model inventing a call) can never escalate.
 */
export function checkToolPermission(config: ForgeConfig, tool: Pick<ToolDef, 'name' | 'permission'>): PermissionDecision {
  const tools = config.tools;
  if (tools?.enabled !== true) {
    return { allowed: false, reason: 'Tools are disabled (tools.enabled is false).' };
  }
  if (tools.levels?.[tool.permission] !== true) {
    return { allowed: false, reason: `Permission level '${tool.permission}' is disabled (tools.levels.${tool.permission} is false).` };
  }
  return { allowed: true };
}

export function isLevelEnabled(config: ForgeConfig, level: ToolPermission): boolean {
  return config.tools?.enabled === true && config.tools.levels?.[level] === true;
}

/**
 * Path gate for the filesystem permission level. No filesystem tool ships yet,
 * but every future one must route file access through this check.
 *
 * A path is allowed only when the filesystem level is on AND the resolved
 * target sits inside one of the configured allowlist directories for the
 * requested mode. Empty allowlists deny everything. The check is lexical
 * (resolved absolute paths, case-insensitive on Windows); callers that follow
 * symlinks must re-check the realpath they end up at.
 *
 * While channels.telegram.attachments is enabled, its resolved dir is an
 * implicit READ root (downloads must be readable by analyze_image without
 * machine-specific readable_dirs entries). Never an implicit write root.
 */
export function isPathAllowed(
  config: ForgeConfig,
  targetPath: string,
  mode: 'read' | 'write',
): PermissionDecision {
  if (!isLevelEnabled(config, 'filesystem')) {
    return { allowed: false, reason: 'Filesystem tools are disabled.' };
  }
  if (targetPath.includes('\0')) {
    return { allowed: false, reason: 'Path contains a null byte.' };
  }

  const dirs = mode === 'read'
    ? [...(config.tools?.filesystem?.readable_dirs ?? [])]
    : [...(config.tools?.filesystem?.writable_dirs ?? [])];
  if (mode === 'read') {
    const attachmentsDir = resolveAttachmentsDir(config);
    if (attachmentsDir) dirs.push(attachmentsDir);
  }
  if (dirs.length === 0) {
    return { allowed: false, reason: `No ${mode === 'read' ? 'readable' : 'writable'} directories are allowlisted (tools.filesystem).` };
  }

  const target = normalizeForCompare(path.resolve(targetPath));
  for (const dir of dirs) {
    const base = normalizeForCompare(path.resolve(dir));
    const relative = path.relative(base, target);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      return { allowed: true };
    }
  }
  return { allowed: false, reason: `Path is outside the allowlisted ${mode === 'read' ? 'readable' : 'writable'} directories.` };
}

function normalizeForCompare(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}
