import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter } from 'node:path';
import { normalize } from './paths.js';

/** Why a call did not produce JSON. An adapter turns a reason into wording naming its own CLI and its own setting. */
export type ExecOutcome =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'missing' | 'not-executable' | 'failed' | 'unparsable'; detail: string };

export type ExecJson = (path: string, args: string[]) => Promise<ExecOutcome>;

/** A hung CLI would leave the board with no sessions and no explanation, which R24 forbids more than an error does. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Enough of the CLI's own output to diagnose from, and not enough to fill a webview. */
const DETAIL_LIMIT = 200;

/**
 * Real executables first so a shim never shadows one, then the batch shims, then no extension at all — npm writes
 * both a `.cmd` and an extensionless shell script, and the script is the one Windows cannot run.
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

/**
 * Where a bare command is looked for: the directories PATH names, and never the working directory. Probing the
 * working directory would both miss the real command and let an unrelated file there decide the verdict.
 */
function searchDirectories(): string[] {
  return (process.env['PATH'] ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => normalize(directory).replace(/\/+$/, ''));
}

/** The file this path or bare name names, or null when nothing on disk answers to it. */
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

function spawn(path: string, args: string[], timeout: number, resolved: boolean): Promise<ExecOutcome> {
  return new Promise<ExecOutcome>((resolve) => {
    // A path Windows rejects outright raises before the callback, and a rejected promise here would surface as an
    // unhandled failure rather than a board notice. `windowsHide` because the hub is detached and has no console of
    // its own: without it every poll opens a command prompt on the developer's screen.
    try {
      execFile(path, args, { maxBuffer: 32 * 1024 * 1024, timeout, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
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

        try {
          resolve({ ok: true, value: JSON.parse(stdout) });
        } catch {
          resolve({ ok: false, reason: 'unparsable', detail: stdout.trim().slice(0, DETAIL_LIMIT) });
        }
      });
    } catch (err) {
      resolve({ ok: false, reason: 'failed', detail: (err instanceof Error ? err.message : String(err)).slice(0, DETAIL_LIMIT) });
    }
  });
}

/**
 * Runs a CLI that prints one JSON document and parses it. Never throws, and never through a shell: the path is
 * developer configuration, and a shell would let a crafted one run something else entirely.
 */
export const runJsonCli = async (path: string, args: string[], timeout = DEFAULT_TIMEOUT_MS): Promise<ExecOutcome> => {
  const resolved = resolveOnDisk(path);

  if (resolved !== null && BATCH.test(resolved)) {
    return { ok: false, reason: 'not-executable', detail: `${resolved} is a batch shim, which cannot be run directly` };
  }

  return spawn(resolved ?? path, args, timeout, resolved !== null);
};
