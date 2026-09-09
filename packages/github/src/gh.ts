import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import type { Logger } from '@ground-control/core';
import type { Failure, Result } from './types.js';

/** Optional timeout and cancellation for gh requests. */
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

  // Recognize logged-out, expired-token, and revoked-token errors.
  if (/gh auth login|Bad credentials|HTTP 401|requires authentication/i.test(stderr)) {
    return {
      kind: 'not-authenticated',
      message: 'GitHub rejected the credentials the CLI is using.',
      remedy: 'Run `gh auth login` in a terminal, then refresh the board.',
    };
  }

  // Recognize gh and Go network errors, including Windows connectex failures.
  if (
    /error connecting to|dial tcp|no such host|network is unreachable|unreachable network|connectex|i\/o timeout|TLS handshake timeout|context deadline exceeded|Client\.Timeout exceeded|connection (reset|refused)/i.test(
      stderr,
    )
  ) {
    return {
      kind: 'offline',
      message: 'GitHub could not be reached.',
      remedy: 'Showing cached data when available. Retrying automatically.',
      transient: true,
    };
  }

  // Retry timeouts as transient failures; they do not establish a query error.
  if (err.killed === true) {
    return {
      kind: 'timed-out',
      message: 'GitHub did not answer in time.',
      remedy: 'Showing cached data when available. Retrying automatically.',
      transient: true,
    };
  }

  return { kind: 'query-failed', message: stderr.trim() || err.message, remedy: 'Check the query and your network, then refresh.' };
}

/** Run gh and parse JSON, returning classified failures. windowsHide prevents a console window on each poll. */
function spawnGh(ghPath: string): GhRunner {
  return (args, options = {}) =>
    new Promise<Result<unknown>>((resolve) => {
      // execFile can throw before invoking its callback; return that as a classified failure too.
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
                        message: 'The request was cancelled.',
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

        // Cancel abandoned requests to release triage slots.
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
    const command = args.slice(0, 2).join(' ');
    const elapsedMs = Date.now() - startedAt;

    log.debug(result.ok ? `${command} in ${elapsedMs}ms` : `${command} failed after ${elapsedMs}ms: ${result.error.kind}`, 'gh');

    return result;
  };
}
