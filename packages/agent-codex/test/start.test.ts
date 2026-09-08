import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { groundControlDirOf } from '@ground-control/core';
import { dispatchLogPathOf, killOnMachine, makeMachineStarter } from '../src/start.js';

const STARTED = '{"type":"thread.started","thread_id":"01a07d5a-b5bd-7762-8ef8-4202ce964f31"}';
const started = (line: string) => line.includes('thread.started');

let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'gc-codex-start-'));
});

afterAll(() => {
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // A process that has just exited can still hold its own log open on Windows.
  }
});

const options = () => ({ cwd: process.cwd(), timeoutMs: 15_000, signal: new AbortController().signal });

describe('starting a run and letting go of it', () => {
  it('reads the thread id out of what the run printed, and answers with its process', async () => {
    // A real child process: the whole point of this layer is the spawn, so a fake here would test nothing.
    const start = makeMachineStarter(home, () => 'run-1');
    const running = await start(process.execPath, ['-e', `console.log(${JSON.stringify(STARTED)})`], options());

    expect(running.failure).toBeNull();
    expect(running.pid).toBeGreaterThan(0);
    expect(await running.firstLine(started)).toBe(STARTED);
  });

  it('writes the run own output to a file, so nothing is lost when the board lets go', () => {
    // A pipe nobody drains blocks the child at about 64 kB, which would stall the work with no sign of why.
    expect(readFileSync(dispatchLogPathOf(home, 'run-1'), 'utf8')).toContain('thread.started');
  });

  it('answers with nothing when the run ends without ever naming a thread', async () => {
    const start = makeMachineStarter(home, () => 'run-2');
    const running = await start(process.execPath, ['-e', 'console.log("nothing of the sort")'], {
      ...options(),
      timeoutMs: 1_500,
    });

    expect(running.failure).toBeNull();
    expect(await running.firstLine(started)).toBeNull();
  });

  it('gives up on the signal rather than spending the whole budget', async () => {
    const controller = new AbortController();
    const start = makeMachineStarter(home, () => 'run-3');
    const running = await start(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      ...options(),
      timeoutMs: 60_000,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 300);
    const at = Date.now();

    expect(await running.firstLine(started)).toBeNull();
    expect(Date.now() - at).toBeLessThan(10_000);

    process.kill(running.pid!);
  });

  it('names a CLI that is not on the machine, and starts nothing', async () => {
    const start = makeMachineStarter(home, () => 'run-4');
    const running = await start('no-such-codex-anywhere', [], options());

    expect(running.pid).toBeNull();
    expect(running.failure).toMatchObject({ reason: 'missing' });
    expect(existsSync(dispatchLogPathOf(home, 'run-4'))).toBe(false);
  });

  it('keeps each run log under the board own directory, named for when it started', () => {
    const logs = readdirSync(groundControlDirOf(home)).filter((name) => name.startsWith('codex-dispatch-'));

    expect(logs).toContain('codex-dispatch-run-1.log');
    expect(logs).toContain('codex-dispatch-run-2.log');
  });
});

describe('ending a run', () => {
  it('reports a process that was not there to signal', () => {
    // Above every pid Windows or Linux will assign, so nothing can be holding it.
    expect(killOnMachine(0x7ffffffe)).toBe(false);
  });

  /**
   * A dispatched run spawns its tools as children, and `process.kill` reaches only the one process — a run stopped
   * mid-tool left its shell finishing the work while the board reported it stopped. So the tree is what must go.
   */
  it('ends the run and the tool it had started, not just the process the board holds', async () => {
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);

        return true;
      } catch {
        return false;
      }
    };

    const grandchild = join(home, 'tool.mjs');
    const child = join(home, 'run.mjs');
    const claimed = join(home, 'tool.pid');

    writeFileSync(grandchild, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(claimed)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
    writeFileSync(child, `import { spawn } from 'node:child_process';\nspawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' });\nsetInterval(() => {}, 1000);\n`);

    const running = (await import('node:child_process')).spawn(process.execPath, [child], { detached: true, stdio: 'ignore' });

    for (let waited = 0; waited < 100 && !existsSync(claimed); waited++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }

    const tool = Number.parseInt(readFileSync(claimed, 'utf8'), 10);

    expect(alive(tool)).toBe(true);
    expect(killOnMachine(running.pid!)).toBe(true);

    for (let waited = 0; waited < 100 && (alive(running.pid!) || alive(tool)); waited++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }

    expect(alive(running.pid!)).toBe(false);
    expect(alive(tool)).toBe(false);
  });
});

describe('the ways a run cannot be started', () => {
  it('refuses a batch shim by name rather than throwing, which spawn does for one', async () => {
    // `resolveOnDisk` will hand back a `.cmd` where one is on PATH, and Node refuses to spawn it without a shell —
    // synchronously, which would break the dispatcher's promise never to throw.
    const shim = join(home, 'codex.cmd');
    writeFileSync(shim, '@echo off\r\n');
    const running = await makeMachineStarter(home, () => 'shim')(shim, [], options());

    expect(running.pid).toBeNull();
    expect(running.failure).toMatchObject({ reason: 'not-executable' });
  });

  it('names a spawn that failed after it was asked for, rather than letting the hub take it', async () => {
    // A failed spawn reports twice: no pid, and an `error` event a tick later. Unhandled on a child, that event is
    // an uncaught exception, and the hub answers one of those by exiting — so a torn-down worktree took it down.
    const running = await makeMachineStarter(home, () => 'gone')(process.execPath, ['-e', ''], {
      ...options(),
      cwd: join(home, 'no-such-directory-at-all'),
    });

    expect(running.pid).toBeNull();
    expect(running.failure?.reason).toBe('failed');
    expect(await running.firstLine(started)).toBeNull();
  });

  it('stops waiting as soon as the run has gone, rather than spending its whole budget', async () => {
    const at = Date.now();
    const running = await makeMachineStarter(home, () => 'quick')(process.execPath, ['-e', 'console.log("nope")'], {
      ...options(),
      timeoutMs: 30_000,
    });

    expect(await running.firstLine(started)).toBeNull();
    // Without watching for the exit this waited out the full budget, which is 30 s on a real dispatch.
    expect(Date.now() - at).toBeLessThan(10_000);
  });

  it('keeps the run own noise out of the line it reads', () => {
    // Codex's stderr is noisy by design (§13), and two writers appending to one file tear a line.
    expect(existsSync(`${dispatchLogPathOf(home, 'run-1')}.err`)).toBe(true);
  });
});
