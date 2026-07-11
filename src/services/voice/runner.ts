import { spawn } from 'node:child_process';

export interface RunBinaryOptions {
  timeoutMs: number;
  /** Text piped to the child's stdin (Piper reads its input this way). */
  stdin?: string;
}

export interface RunBinaryResult {
  stdout: string;
  stderr: string;
}

export type RunBinary = (binary: string, args: string[], options: RunBinaryOptions) => Promise<RunBinaryResult>;

export class BinaryMissingError extends Error {
  constructor(binary: string) {
    super(`Binary '${binary}' was not found. Check the configured path.`);
    this.name = 'BinaryMissingError';
  }
}

export class BinaryTimeoutError extends Error {
  constructor(binary: string, timeoutMs: number) {
    super(`'${binary}' timed out after ${timeoutMs}ms.`);
    this.name = 'BinaryTimeoutError';
  }
}

const MAX_OUTPUT_CHARS = 4 * 1024 * 1024;

/**
 * Spawn a local CPU binary with a hard timeout. Non-zero exits reject with
 * stderr included; a missing binary rejects with BinaryMissingError so
 * callers can produce a clear "install it / fix the path" message.
 */
export const defaultRunBinary: RunBinary = (binary, args, options) => {
  return new Promise<RunBinaryResult>((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new BinaryTimeoutError(binary, options.timeoutMs));
    }, options.timeoutMs);

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString('utf-8');
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(() => {
        reject(err.code === 'ENOENT' ? new BinaryMissingError(binary) : err);
      });
    });

    child.on('close', (code) => {
      finish(() => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`'${binary}' exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
      });
    });

    if (options.stdin !== undefined) {
      child.stdin.on('error', () => {}); // child may exit before consuming stdin
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
};
