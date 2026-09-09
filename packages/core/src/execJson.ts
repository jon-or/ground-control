import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter } from 'node:path';
import { normalize } from './paths.js';

/** CLI failure classified for adapter-specific messages and remedies. */
export type ExecFailure = {
  ok: false;
  reason: 'missing' | 'not-executable' | 'failed' | 'unparsable' | 'aborted';
  detail: string;
};

/** CLI text output or failure; text calls do not produce `unparsable`. */
export type TextOutcome = { ok: true; text: string } | ExecFailure;

/** Parsed CLI JSON output or failure. */
export type ExecOutcome = { ok: true; value: unknown } | ExecFailure;

/**
 * Optional CLI execution settings. Use stdin for prompts exceeding the Windows command-line limit of 32,767
 * characters (mechanics M31).
 */
export interface ExecOptions {
  timeoutMs?: number;
  cwd?: string;
  stdin?: string;
  signal?: AbortSignal;
}

export type ExecJson = (path: string, args: string[], options?: ExecOptions) => Promise<ExecOutcome>;

export type ExecText = (path: string, args: string[], options?: ExecOptions) => Promise<TextOutcome>;

/** Bound CLI reads so a hung process produces a failure (R24). */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Limit diagnostic output displayed in the board. */
const DETAIL_LIMIT = 200;

/**
 * Prefer executables over batch shims and extensionless scripts. npm creates both `.cmd` and shell shims; Windows
 * cannot execute the shell script.
 */
const CANDIDATES = process.platform === 'win32' ? ['.exe', '.com', '.cmd', '.bat', ''] : [''];

/** Node refuses to spawn a batch file without a shell, and a shell would parse the configured path. */
const BATCH = /\.(cmd|bat)$/i;

const hasExtension = (path: string): boolean => /\.[A-Za-z0-9]{1,4}$/.test(path);

const isPathLike = (path: string): boolean => /[\\/]/.test(path);

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Search PATH only; a file in the working directory must not override the configured command. */
function searchDirectories(): string[] {
  return (process.env['PATH'] ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => normalize(directory).replace(/\/+$/, ''));
}

/** Resolve an existing file from a path or command name. */
export function resolveOnDisk(path: string): string | null {
  const extensions = hasExtension(path) ? [''] : CANDIDATES;
  const bases = isPathLike(path) ? [normalize(path)] : searchDirectories().map((dir) => `${dir}/${path}`);

  for (const base of bases) {
    for (const extension of extensions) {
      if (isFile(`${base}${extension}`)) {
        return `${base}${extension}`;
      }
    }
  }

  return null;
}

function spawn(path: string, args: string[], options: ExecOptions, resolved: boolean): Promise<TextOutcome> {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<TextOutcome>((resolve) => {
    // Catch synchronous spawn errors as failures. Hide console windows when the detached hub spawns a CLI.
    try {
      const child = execFile(
        path,
        args,
        { maxBuffer: 32 * 1024 * 1024, timeout, windowsHide: true, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) },
        (err, stdout, stderr) => {
        if (err) {
          // Cancellation and timeout both kill the child; report them separately.
          if (options.signal?.aborted === true) {
            resolve({ ok: false, reason: 'aborted', detail: 'command cancelled before completion' });

            return;
          }

          if ('killed' in err && err.killed === true) {
            resolve({ ok: false, reason: 'failed', detail: `timed out after ${timeout / 1000}s` });

            return;
          }

          // The file provably exists when resolution found it, so ENOENT then means Windows will not run it.
          const missing = err.code === 'ENOENT';
          const code = typeof err.code === 'string' ? `${err.code}: ` : '';

          resolve({
            ok: false,
            reason: missing ? (resolved ? 'not-executable' : 'missing') : 'failed',
            detail: `${code}${stderr.trim() || err.message}`.slice(0, DETAIL_LIMIT),
          });

          return;
        }

        resolve({ ok: true, text: stdout });
        },
      );

      // Kill the process on cancellation to stop model usage; print-mode sessions require PID termination (mechanics M31).
      options.signal?.addEventListener('abort', () => child.kill(), { once: true });

      // Send prompts through stdin to avoid command-line limits; end the stream to complete input (M31).
      if (options.stdin !== undefined) {
        // Handle EPIPE if the child exits before reading stdin. The exec callback reports the failure.
        child.stdin?.on('error', () => undefined);
        child.stdin?.end(options.stdin);
      }
    } catch (err) {
      resolve({ ok: false, reason: 'failed', detail: (err instanceof Error ? err.message : String(err)).slice(0, DETAIL_LIMIT) });
    }
  });
}

/**
 * Run a CLI without throwing or invoking a shell. Shells can execute configured path text and rewrite
 * leading-slash arguments on Windows (mechanics M33).
 */
export const runTextCli = async (path: string, args: string[], options: ExecOptions = {}): Promise<TextOutcome> => {
  const resolved = resolveOnDisk(path);

  if (resolved !== null && BATCH.test(resolved)) {
    return { ok: false, reason: 'not-executable', detail: `${resolved} is a batch shim, which cannot be run directly` };
  }

  // Do not spawn cancelled requests.
  if (options.signal?.aborted === true) {
    return { ok: false, reason: 'aborted', detail: 'command cancelled before starting' };
  }

  return spawn(resolved ?? path, args, options, resolved !== null);
};

/** Run a CLI and parse one JSON document, adding `unparsable` to execution failures. */
export const runJsonCli = async (path: string, args: string[], options: ExecOptions = {}): Promise<ExecOutcome> => {
  const outcome = await runTextCli(path, args, options);

  if (!outcome.ok) {
    return outcome;
  }

  try {
    return { ok: true, value: JSON.parse(outcome.text) };
  } catch {
    return { ok: false, reason: 'unparsable', detail: outcome.text.trim().slice(0, DETAIL_LIMIT) };
  }
};
