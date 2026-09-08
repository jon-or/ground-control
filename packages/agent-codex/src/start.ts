import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { groundControlDirOf, resolveOnDisk } from '@ground-control/core';
import type { StartProcess, StartedProcess } from './dispatch.js';

/** How often the log a dispatched run writes is read while waiting for it to name its thread. */
const POLL_MS = 100;

/** Node refuses to spawn a batch file without a shell, and a shell would parse the configured path. */
const BATCH = /\.(cmd|bat)$/i;

/**
 * Where a dispatched run's own output goes, so the board can read what it printed after the hub let go of it. The
 * `<agent>-dispatch-<id>.log` shape is what the hub's own sweep ages out of that directory.
 */
export function dispatchLogPathOf(home: string, id: string): string {
  return `${groundControlDirOf(home)}/codex-dispatch-${id}.log`;
}

/**
 * Starts `codex exec` and leaves it running. Detached, with its output going to a file rather than to a pipe: the
 * run outlives the hub that started it, and a pipe nobody drains fills and blocks the child at about 64 kB — which
 * would stall the work partway through with no sign of why.
 *
 * The file is also how the thread id is read. `--json` prints `thread.started` before the first turn, so the wait
 * here is the second or so Codex takes to open a thread, not the length of the work.
 *
 * Never throws. Every way a spawn can fail comes back as a named reason: a path that resolves to nothing, a batch
 * shim Node will not spawn without a shell, a directory that has gone, and the `error` event that arrives a tick
 * after a failed spawn — which, unhandled on a detached child, would take the hub down with it.
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

    // One name per run, not one per millisecond: two dispatches resolving in the same tick shared a clock-keyed
    // file, and each then read the other's `thread.started` — so each card recorded the other's thread.
    const log = dispatchLogPathOf(home, id());
    let out: number;
    let err: number;

    try {
      mkdirSync(groundControlDirOf(home), { recursive: true });
      out = openSync(log, 'a');
      // Its own descriptor: two writers appending to one file tear a line, and a torn `thread.started` reads as a
      // run that never named its thread. Codex's stderr is noisy by design (`docs/mechanics.md` §13).
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

        // A failed spawn reports twice: no pid here, and an `error` event on the next tick. Unhandled on a child,
        // that event is an uncaught exception, and the hub answers one of those by exiting.
        child.on('error', (error) => answer(failed('failed', error.message)));

        if (child.pid === undefined) {
          return;
        }

        const pid = child.pid;
        let ended = false;
        child.on('exit', () => {
          ended = true;
        });

        // The board is not this run's parent for the rest of its life: it answers the card and lets go.
        child.unref();

        answer({
          pid,
          failure: null,
          firstLine: (wanted) => waitForLine(log, wanted, options, () => ended),
        });
      } catch (error) {
        // `spawn` throws synchronously for a shim Node will not run, which a resolved path can still be.
        answer(failed('not-executable', (error as Error).message));
      }
    });
  };
}

/**
 * The first line of the run's log that the caller recognises, or null once the run has ended, its budget has gone,
 * or its signal has. Read forward from where the last poll stopped: the failure path otherwise re-reads a growing
 * transcript every tenth of a second for the whole budget.
 */
async function waitForLine(
  log: string,
  wanted: (line: string) => boolean,
  options: { timeoutMs: number; signal: AbortSignal },
  hasEnded: () => boolean,
): Promise<string | null> {
  const until = Date.now() + options.timeoutMs;
  let read = 0;
  let held = '';

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
        held += buffer.subarray(0, got).toString('utf8');
      } finally {
        closeSync(file);
      }

      const lines = held.split('\n');
      // The last element is whatever the run has written since its last newline, which is not a line yet.
      held = lines.pop() ?? '';

      const found = lines.find((line) => wanted(line));

      if (found !== undefined) {
        return found;
      }
    }

    // Checked after the read, so a run that printed and exited in one tick still has its output read.
    if (hasEnded() || options.signal.aborted || Date.now() >= until) {
      return null;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * Ends a dispatched run and the tools it started. `process.kill` reaches one process, so on Windows a run stopped
 * mid-tool left its shell child finishing the work while the board said it had stopped — `taskkill /T` is what
 * takes the tree. False when nothing was there to end, which a stop must not report as a stop.
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
    // The group the detached child leads, so the tools it started go with it.
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
