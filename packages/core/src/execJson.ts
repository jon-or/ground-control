import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter } from 'node:path';
import { normalize } from './paths.js';

/** Why a call did not run. An adapter turns a reason into wording naming its own CLI and its own setting. */
export type ExecFailure = {
  ok: false;
  reason: 'missing' | 'not-executable' | 'failed' | 'unparsable' | 'aborted';
  detail: string;
};

/** What a CLI printed, or why it did not print it. `unparsable` never reaches here — there is nothing to parse. */
export type TextOutcome = { ok: true; text: string } | ExecFailure;

/** The same, once the text has been read as one JSON document. */
export type ExecOutcome = { ok: true; value: unknown } | ExecFailure;

/**
 * How a call is run beyond its arguments. Every field is optional and the defaults are what a roster read has always
 * used, so a caller that wants none of it passes none. `stdin` is what keeps a long prompt off a command line
 * Windows caps at 32,767 characters (`docs/mechanics.md` §31), and `signal` is what lets a queued run be abandoned.
 */
export interface ExecOptions {
  timeoutMs?: number;
  cwd?: string;
  stdin?: string;
  signal?: AbortSignal;
}

export type ExecJson = (path: string, args: string[], options?: ExecOptions) => Promise<ExecOutcome>;

export type ExecText = (path: string, args: string[], options?: ExecOptions) => Promise<TextOutcome>;

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

function spawn(path: string, args: string[], options: ExecOptions, resolved: boolean): Promise<TextOutcome> {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<TextOutcome>((resolve) => {
    // A path Windows rejects outright raises before the callback, and a rejected promise here would surface as an
    // unhandled failure rather than a board notice. `windowsHide` because the hub is detached and has no console of
    // its own: without it every poll opens a command prompt on the developer's screen.
    try {
      const child = execFile(
        path,
        args,
        { maxBuffer: 32 * 1024 * 1024, timeout, windowsHide: true, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) },
        (err, stdout, stderr) => {
        if (err) {
          // An abort and a timeout both arrive as a killed child, and they are different things to a caller: one is
          // the board standing a run down, the other is a CLI that would not answer.
          if (options.signal?.aborted === true) {
            resolve({ ok: false, reason: 'aborted', detail: 'the run was stood down before it answered' });

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

      // Abandoning a run has to reach the process, not just the promise: a classifier the board has stood down would
      // otherwise go on spending until it answered nobody (`docs/mechanics.md` §31 — a `-p` session is killable only
      // by pid). `once`, so a settled run leaves no listener on a signal the caller may reuse.
      options.signal?.addEventListener('abort', () => child.kill(), { once: true });

      // The prompt is written rather than passed, because argv is capped and evidence is not (§31). A closed stdin
      // is what tells a CLI reading from it that the input is complete.
      if (options.stdin !== undefined) {
        // A child that dies before draining a long prompt makes this an EPIPE, which is an unhandled 'error' event
        // on the stream and takes the process with it. The callback above is what reports the failure.
        child.stdin?.on('error', () => undefined);
        child.stdin?.end(options.stdin);
      }
    } catch (err) {
      resolve({ ok: false, reason: 'failed', detail: (err instanceof Error ? err.message : String(err)).slice(0, DETAIL_LIMIT) });
    }
  });
}

/**
 * Runs a CLI for whatever it prints. Never throws, and never through a shell: the path is developer configuration,
 * and a shell would let a crafted one run something else entirely — which on Windows also rewrites a leading `/` in
 * an argument into a filesystem path, silently turning a slash command into prose (`docs/mechanics.md` §33).
 */
export const runTextCli = async (path: string, args: string[], options: ExecOptions = {}): Promise<TextOutcome> => {
  const resolved = resolveOnDisk(path);

  if (resolved !== null && BATCH.test(resolved)) {
    return { ok: false, reason: 'not-executable', detail: `${resolved} is a batch shim, which cannot be run directly` };
  }

  // Nothing is spawned for a run already stood down, so a queue drained on shutdown starts no process at all.
  if (options.signal?.aborted === true) {
    return { ok: false, reason: 'aborted', detail: 'the run was stood down before it started' };
  }

  return spawn(resolved ?? path, args, options, resolved !== null);
};

/** Runs a CLI that prints one JSON document and parses it. Every refusal is `runTextCli`'s, plus one of its own. */
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
