import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import type { Failure, Result } from './types.js';

export interface GhRunner {
  (args: string[]): Promise<Result<unknown>>;
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

  return { kind: 'query-failed', message: stderr.trim() || err.message, remedy: 'Check the query and your network, then refresh.' };
}

/** Runs `gh` and parses stdout as JSON. Never throws — every failure comes back classified. */
export function makeGhRunner(ghPath: string): GhRunner {
  return (args) =>
    new Promise<Result<unknown>>((resolve) => {
      execFile(ghPath, args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: classify(err, stderr) });
          return;
        }

        try {
          resolve({ ok: true, value: JSON.parse(stdout) });
        } catch {
          resolve({
            ok: false,
            error: { kind: 'bad-response', message: 'gh returned output that is not JSON.', remedy: 'Run the same gh command in a terminal to see what it printed.' },
          });
        }
      });
    });
}
