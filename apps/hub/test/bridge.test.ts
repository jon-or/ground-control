import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeFrame } from '@ground-control/hub';

/**
 * The bundle a client writes into the developer's home, which is what the native-messaging wrapper starts. It is the
 * extension's CommonJS build rather than this package's ESM output: a `.js` dropped into a directory with no
 * `package.json` is CommonJS to node, and that is the file the registration names.
 */
const BUNDLE = join(import.meta.dirname, '..', '..', '..', 'extensions', 'ground-control', 'dist', 'hub.js');
const ENTRY = join(import.meta.dirname, '..', 'dist', 'main.js');

if (!existsSync(BUNDLE) || !existsSync(ENTRY)) {
  throw new Error('Run npm run build at the repo root, or npm run verify, which builds first.');
}

const SYSTEM_PATH = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin';

const running: ChildProcess[] = [];
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(
    running.splice(0).map(
      (child) =>
        new Promise<void>((gone) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            gone();

            return;
          }

          child.once('exit', () => gone());
          child.kill();
        }),
    ),
  );

  while (homes.length) {
    rmSync(homes.pop() ?? '', { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'gc-bridge-'));

  homes.push(home);
  mkdirSync(join(home, '.claude', 'ground-control'), { recursive: true });

  return home;
}

function until<T>(what: () => T | null, within = 20_000): Promise<T> {
  const deadline = Date.now() + within;

  return new Promise((resolve, reject) => {
    const tick = (): void => {
      const answer = what();

      if (answer !== null) {
        resolve(answer);

        return;
      }

      if (Date.now() > deadline) {
        reject(new Error('the bridge never got that far'));

        return;
      }

      setTimeout(tick, 50);
    };

    tick();
  });
}

/** The frames on the wire, decoded the way Chrome would. Reading these is the whole contract with the browser. */
function reader(child: ChildProcess): { messages: { type: string }[]; failed: string } {
  const messages: { type: string }[] = [];
  let buffered = Buffer.alloc(0);
  let failed = '';

  child.stdout?.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);

    for (;;) {
      if (buffered.length < 4) {
        return;
      }

      const length = buffered.readUInt32LE(0);

      if (buffered.length < 4 + length) {
        return;
      }

      messages.push(JSON.parse(buffered.subarray(4, 4 + length).toString('utf8')) as { type: string });
      buffered = buffered.subarray(4 + length);
    }
  });

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    failed += chunk;
  });

  return {
    messages,
    get failed() {
      return failed;
    },
  };
}

function run(command: string, args: string[], env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, [command, ...args], {
    // As in the smoke test: `--home` points the child at the run's directory, and these keep a mode that forgot
    // it from writing to the developer's real board. A caller's own `env` still wins.
    env: { ...process.env, PATH: SYSTEM_PATH, Path: SYSTEM_PATH, USERPROFILE: tmpdir(), HOME: tmpdir(), ...env },
    windowsHide: true,
  });

  running.push(child);

  return child;
}

describe('the bridge Chrome starts', () => {
  it('starts a hub for a home that has none, and relays what it reads to the browser', async () => {
    const home = tempHome();

    copyFileSync(BUNDLE, join(home, '.claude', 'ground-control', 'hub.js'));

    const bridge = run(join(home, '.claude', 'ground-control', 'hub.js'), ['--native-messaging', `--home=${home}`], {});
    const seen = reader(bridge);

    // What the worker sends when the first project board tab connects. Nothing polls until a client is watching.
    bridge.stdin?.write(encodeFrame({ type: 'watching', watching: true }));

    // Both reads reach the browser, on their own cadences: the sources on the long interval, the agents on the
    // short one, so the first frame carries one of them and a later one carries both.
    const relayed = await until(
      () =>
        (seen.messages
          .filter((message) => message.type === 'snapshot' || message.type === 'changed')
          .find(
            (message) =>
              (message as unknown as { snapshot: { failures: unknown[] } }).snapshot.failures.length === 2,
          ) as unknown as { snapshot: { failures: { subject: string }[] } } | undefined) ?? null,
    );

    // Neither CLI is on this PATH, so a real read names both rather than leaving the overlay a blank board (R24, R25).
    expect([...new Set(relayed.snapshot.failures.map((failure) => failure.subject))].sort()).toEqual([
      'github',
      'sessions',
    ]);
    expect(existsSync(join(home, '.claude', 'ground-control', 'hub.json'))).toBe(true);
    expect(seen.failed).toBe('');

    // Chrome closes stdin when the last board tab goes.
    const ended = new Promise<number>((resolve) => bridge.on('exit', (code) => resolve(code ?? -1)));

    bridge.stdin?.end();

    expect(await ended).toBe(0);

    // The hub it started outlives it, for its own idle rule to end (R35). Left running, it holds this home open.
    const stop = run(ENTRY, ['--stop', `--home=${home}`], {});

    await new Promise((done) => stop.on('exit', done));
  });

  it('tells the browser what it refused, rather than dropping it', async () => {
    const home = tempHome();

    copyFileSync(BUNDLE, join(home, '.claude', 'ground-control', 'hub.js'));

    const bridge = run(join(home, '.claude', 'ground-control', 'hub.js'), ['--native-messaging', `--home=${home}`], {});
    const seen = reader(bridge);

    bridge.stdin?.write(encodeFrame({ type: 'open', sessionId: 'a-session' }));

    const notice = await until(
      () => (seen.messages.find((message) => message.type === 'notice') as { message: string } | undefined) ?? null,
    );

    expect(notice.message).toContain('not by asking the hub');

    bridge.stdin?.end();

    // The hub it started outlives it by design, and would hold this home open past the teardown that removes it.
    const stop = run(ENTRY, ['--stop', `--home=${home}`], {});

    await new Promise((done) => stop.on('exit', done));
  });
});
