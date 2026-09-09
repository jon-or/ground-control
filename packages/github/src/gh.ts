import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import type { Logger } from '@ground-control/core';
import type { Failure, Result } from './types.js';

/** What a call may bound beyond its arguments. Every call carries a deadline; one card's triage carries a signal too. */
export interface GhOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface GhRunner {
  (args: string[], options?: GhOptions): Promise<Result<unknown>>;
}

function classify(err: ExecFileException, stderr: string): Failure {
  if (err.code === 'ENOENT') {
    return {
      kind: 'gh-missing',
      message: 'The GitHub CLI (gh) was not found.',
      remedy: 'Install the GitHub CLI, or set groundControl.github.ghPath to its full path.',
    };
  }

  // `gh auth login` is the logged-out shape; `Bad credentials (HTTP 401)` is the expired-or-revoked-token shape.
  if (/gh auth login|Bad credentials|HTTP 401|requires authentication/i.test(stderr)) {
    return {
      kind: 'not-authenticated',
      message: 'GitHub rejected the credentials the CLI is using.',
      remedy: 'Run `gh auth login` in a terminal — the login may have expired — then refresh the board.',
    };
  }

  // The machine cannot reach the network at all — asleep a moment ago, or on a captive portal. `gh` wraps its own
  // connect failures; the rest are what Go's net stack and HTTP client print underneath, Windows `connectex` included.
  if (
    /error connecting to|dial tcp|no such host|network is unreachable|unreachable network|connectex|i\/o timeout|TLS handshake timeout|context deadline exceeded|Client\.Timeout exceeded|connection (reset|refused)/i.test(
      stderr,
    )
  ) {
    return {
      kind: 'offline',
      message: 'GitHub could not be reached.',
      remedy: 'The board is showing what it last read, and keeps trying on its own.',
      transient: true,
    };
  }

  // Ridden out like a connection that failed outright: a read that ran out of time says nothing about what is wrong,
  // and the deadline is short enough that hitting it is a slow network far more often than it is a broken query.
  if (err.killed === true) {
    return {
      kind: 'timed-out',
      message: 'GitHub did not answer in time.',
      remedy: 'The board is showing what it last read, and keeps trying on its own.',
      transient: true,
    };
  }

  return { kind: 'query-failed', message: stderr.trim() || err.message, remedy: 'Check the query and your network, then refresh.' };
}

/**
 * Runs `gh` and parses stdout as JSON. Never throws — every failure comes back classified. `windowsHide` because the
 * hub that calls this is detached and has no console: without it each poll opens a command prompt on screen.
 */
function spawnGh(ghPath: string): GhRunner {
  return (args, options = {}) =>
    new Promise<Result<unknown>>((resolve) => {
      // A path the platform rejects outright raises before the callback, and a rejection here would surface as an
      // unhandled failure rather than a board notice — or, for a caller that retries, as a loop with no backoff.
      try {
        const child = execFile(
          ghPath,
          args,
          {
            maxBuffer: 32 * 1024 * 1024,
            windowsHide: true,
            ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
          },
          (err, stdout, stderr) => {
            if (err) {
              resolve({
                ok: false,
                error:
                  options.signal?.aborted === true
                    ? {
                        kind: 'query-failed',
                        message: 'The read was stood down before it answered.',
                        remedy: 'Refresh the board to try again.',
                      }
                    : classify(err, stderr),
              });

              return;
            }

            try {
              resolve({ ok: true, value: JSON.parse(stdout) });
            } catch {
              resolve({
                ok: false,
                error: {
                  kind: 'bad-response',
                  message: 'gh returned output that is not JSON.',
                  remedy: 'Run the same gh command in a terminal to see what it printed.',
                },
              });
            }
          },
        );

        // A read the board has abandoned has to stop costing something: a triage queue of two slots cannot afford
        // one held by a `gh` nobody is waiting on any more.
        options.signal?.addEventListener('abort', () => child.kill(), { once: true });
      } catch (err) {
        resolve({
          ok: false,
          error: {
            kind: 'query-failed',
            message: err instanceof Error ? err.message : String(err),
            remedy: 'Check groundControl.github.ghPath, then refresh.',
          },
        });
      }
    });
}

/**
 * Log gh subcommand duration at debug level without query arguments. Return classified failures to the caller,
 * which emits the warning once; logging warnings here would duplicate source failures.
 */
export function makeGhRunner(ghPath: string, log?: Logger): GhRunner {
  const run = spawnGh(ghPath);

  if (log === undefined) {
    return run;
  }

  return async (args, options) => {
    const startedAt = Date.now();
    const result = await run(args, options);
    const what = args.slice(0, 2).join(' ');
    const took = Date.now() - startedAt;

    log.debug(result.ok ? `${what} in ${took}ms` : `${what} failed after ${took}ms: ${result.error.kind}`, 'gh');

    return result;
  };
}
