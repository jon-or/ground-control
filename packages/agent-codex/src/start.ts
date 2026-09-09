import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { groundControlDirOf, resolveOnDisk } from '@ground-control/core';
import type { StartProcess, StartedProcess } from './dispatch.js';

/** Poll interval while waiting for thread.started output. */
const POLL_MS = 100;

/** Node refuses to spawn a batch file without a shell, and a shell would parse the configured path. */
const BATCH = /\.(cmd|bat)$/i;

/** Persist dispatch output after hub exit. The hub expires files matching <agent>-dispatch-<id>.log. */
export function dispatchLogPathOf(home: string, id: string): string {
  return `${groundControlDirOf(home)}/codex-dispatch-${id}.log`;
}

/**
 * Spawn detached codex exec with output files, avoiding undrained pipes after hub exit. Read thread.started
 * from stdout to identify the run before it finishes. Convert synchronous spawn errors and child error events
 * into classified failures.
 */
export function makeMachineStarter(home: string = homedir(), id: () => string = randomUUID): StartProcess {
  return function start(path, args, options): Promise<StartedProcess> {
    const failed = (reason: string, detail: string): StartedProcess => ({
      pid: null,
      failure: { reason, detail },
      firstLine: () => Promise.resolve(null),
    });

    const resolved = resolveOnDisk(path);

    if (resolved === null) {
      return Promise.resolve(failed('missing', `no executable at "${path}"`));
    }

    if (BATCH.test(resolved)) {
      return Promise.resolve(
        failed('not-executable', `"${resolved}" is a batch shim, which cannot be started without a shell`),
      );
    }

    // Use unique run IDs; timestamp-only names can collide and associate cards with the wrong threads.
    const log = dispatchLogPathOf(home, id());
    let out: number;
    let err: number;

    try {
      mkdirSync(groundControlDirOf(home), { recursive: true });
      out = openSync(log, 'a');
      // Separate stdout and stderr to prevent interleaved writes corrupting thread.started records (M13).
      err = openSync(`${log}.err`, 'a');
    } catch (error) {
      return Promise.resolve(failed('failed', `could not open ${log}: ${(error as Error).message}`));
    }

    return new Promise<StartedProcess>((resolve) => {
      let settled = false;
      const answer = (started: StartedProcess): void => {
        if (!settled) {
          settled = true;
          closeSync(out);
          closeSync(err);
          resolve(started);
        }
      };

      try {
        const child = spawn(resolved, [...args], {
          cwd: options.cwd,
          detached: true,
          stdio: ['ignore', out, err],
          windowsHide: true,
        });

        // Failed spawn also emits an error event. Handle it to prevent an uncaught exception from terminating
        // the hub.
        child.on('error', (error) => answer(failed('failed', error.message)));

        if (child.pid === undefined) {
          return;
        }

        const pid = child.pid;
        let ended = false;
        child.on('exit', () => {
          ended = true;
        });

        // Allow the hub to exit without waiting for the child.
        child.unref();

        answer({
          pid,
          failure: null,
          firstLine: (wanted) => waitForLine(log, wanted, options, () => ended),
        });
      } catch (error) {
        // A resolved shim path can still cause spawn to throw synchronously.
        answer(failed('not-executable', (error as Error).message));
      }
    });
  };
}

/**
 * Read the first matching log line, or null on exit, timeout, or cancellation. Continue from the previous
 * offset to avoid rereading growing logs on each poll.
 */
async function waitForLine(
  log: string,
  wanted: (line: string) => boolean,
  options: { timeoutMs: number; signal: AbortSignal },
  hasEnded: () => boolean,
): Promise<string | null> {
  const until = Date.now() + options.timeoutMs;
  let read = 0;
  let partialLine = '';

  for (;;) {
    let size: number;

    try {
      size = statSync(log).size;
    } catch {
      size = read;
    }

    if (size > read) {
      const file = openSync(log, 'r');

      try {
        const buffer = Buffer.alloc(size - read);
        const got = readSync(file, buffer, 0, buffer.length, read);
        read += got;
        partialLine += buffer.subarray(0, got).toString('utf8');
      } finally {
        closeSync(file);
      }

      const lines = partialLine.split('\n');
      // Retain the incomplete final line for the next poll.
      partialLine = lines.pop() ?? '';

      const found = lines.find((line) => wanted(line));

      if (found !== undefined) {
        return found;
      }
    }

    // Read output before checking exit so fast processes still return their final records.
    if (hasEnded() || options.signal.aborted || Date.now() >= until) {
      return null;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * Terminate the dispatched process and its children. Windows requires taskkill /T; process.kill alone can leave
 * tools running. Return false if no process was stopped.
 */
export function killOnMachine(pid: number): boolean {
  if (process.platform === 'win32') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- loaded here so the POSIX path costs nothing.
      const { execFileSync } = require('node:child_process') as typeof import('node:child_process');

      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000, stdio: 'ignore' });

      return true;
    } catch {
      return false;
    }
  }

  try {
    // Signal the detached process group, including child tools.
    process.kill(-pid);

    return true;
  } catch {
    try {
      process.kill(pid);

      return true;
    } catch {
      return false;
    }
  }
}
