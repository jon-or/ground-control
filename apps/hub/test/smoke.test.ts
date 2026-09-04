import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { request } from 'node:http';
import type { Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL } from '@ground-control/core';
import { fingerprintOf } from '@ground-control/hub';

const ENTRY = join(import.meta.dirname, '..', 'dist', 'main.js');

if (!existsSync(ENTRY)) {
  throw new Error(`${ENTRY} is not built. Run npm run build at the repo root, or npm run verify, which builds first.`);
}

/** Nothing of the developer's on it, so the hub finds neither `claude` nor `gh` and classifies both (R24, R25). */
const BARE_PATH = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin';

const running: ChildProcess[] = [];
const listening: Server[] = [];
const homes: string[] = [];

afterEach(async () => {
  // Awaited, because on Windows a child still holding `hub.log` open makes removing its home fail.
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

  while (listening.length) {
    const server = listening.pop();

    server?.close();
    server?.closeAllConnections();
  }

  while (homes.length) {
    rmSync(homes.pop() ?? '', { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'gc-app-'));

  homes.push(home);
  mkdirSync(join(home, '.claude', 'ground-control'), { recursive: true });

  return home;
}

function hubJsonPath(home: string): string {
  return join(home, '.claude', 'ground-control', 'hub.json');
}

interface Run {
  child: ChildProcess;
  output: () => string;
  ended: Promise<number>;
}

function run(home: string, ...args: string[]): Run {
  const child = spawn(process.execPath, [ENTRY, `--home=${home}`, ...args], {
    // `--home` is what points the child at this run's own directory; these are what keep a mode that forgot it
    // from silently writing to the developer's real board instead.
    env: { ...process.env, PATH: BARE_PATH, Path: BARE_PATH, USERPROFILE: home, HOME: home },
    windowsHide: true,
  });

  running.push(child);

  let output = '';

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    output += chunk;
  });

  return {
    child,
    output: () => output,
    ended: new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -1))),
  };
}

async function until<T>(what: () => T | null, within = 15_000): Promise<T> {
  const deadline = Date.now() + within;

  for (;;) {
    const answer = what();

    if (answer !== null) {
      return answer;
    }

    if (Date.now() > deadline) {
      throw new Error('the hub never got that far');
    }

    await new Promise((done) => setTimeout(done, 50));
  }
}

interface HubRecordFile {
  port: number;
  token: string;
  pid: number;
  protocol: number;
  fingerprint: string;
}

function record(home: string): HubRecordFile | null {
  if (!existsSync(hubJsonPath(home))) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(hubJsonPath(home), 'utf8')) as HubRecordFile;
  } catch {
    return null;
  }
}

function call(port: number, method: string, path: string, token: string | null, body?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}` };

    if (token !== null) {
      headers.Authorization = `Bearer ${token}`;
      headers['Content-Type'] = 'application/json';
    }

    const outbound = request({ host: '127.0.0.1', port, method, path, headers }, (response) => {
      let text = '';

      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
      });
      response.on('end', () => resolve(`${response.statusCode} ${text}`));
    });

    outbound.on('error', reject);
    outbound.end(body);
  });
}

describe('the hub as its own process', () => {
  it('comes up, reports both missing CLIs to a watching client, and stops when asked', async () => {
    const home = tempHome();
    const hub = run(home);
    const there = await until(() => record(home));

    expect(there.protocol).toBe(PROTOCOL);
    expect(there.fingerprint).toBe(fingerprintOf(home));
    expect(await call(there.port, 'GET', '/hub', null)).toContain('"hub":"ground-control"');

    // The snapshot is what a client sees, and nothing is polled until one says it is watching (R35).
    const frames: string[] = [];
    const events = request(
      {
        host: '127.0.0.1',
        port: there.port,
        path: '/events?client=smoke',
        headers: { Host: `127.0.0.1:${there.port}`, Authorization: `Bearer ${there.token}` },
      },
      (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => frames.push(chunk));
      },
    );

    let broke: string | null = null;

    events.on('error', (error: NodeJS.ErrnoException) => {
      broke = error.code ?? 'the stream failed';
    });
    events.end();
    await until(() => (broke ?? (frames.length > 0 ? true : null)) as true | null);
    expect(broke).toBeNull();

    await call(
      there.port,
      'POST',
      '/actions?client=smoke',
      there.token,
      JSON.stringify({
        type: 'hello',
        hello: { id: 'smoke', hostId: null, workspaceRoot: null, residentRoutes: [], watching: true },
      }),
    );

    await call(there.port, 'POST', '/actions?client=smoke', there.token, JSON.stringify({ type: 'refresh' }));

    // Both CLIs are off this PATH, so a real read names both rather than blanking the board (R24, R25).
    const seen = await until(() => (frames.join('').includes('"kind":"bad-config"') ? frames.join('') : null), 20_000);

    // Both sources are named, rather than one failing quietly behind the other (R24, R25).
    const snapshot = JSON.parse((await call(there.port, 'GET', '/snapshot', there.token)).slice(4)) as {
      failures: { subject: string }[];
    };

    expect(seen).toContain('"subject":"github"');
    expect(snapshot.failures.map((failure) => failure.subject).sort()).toEqual(['github', 'sessions']);

    events.destroy();

    expect(await call(there.port, 'POST', '/shutdown', there.token, '{}')).toContain('200');
    expect(await hub.ended).toBe(0);
    expect(existsSync(hubJsonPath(home))).toBe(false);
    expect(existsSync(join(home, '.claude', 'ground-control', 'hub-exit.json'))).toBe(true);
  });

  it('leaves the hub a home already has alone, and says so', async () => {
    const home = tempHome();

    run(home);

    const there = await until(() => record(home));
    const second = run(home);

    expect(await second.ended).toBe(0);
    expect(second.output()).toContain(`already serving this home on port ${there.port}`);
    expect(record(home)?.port).toBe(there.port);
  });

  /** A killed hub leaves its port to whatever takes it next; that process must never be handed the token. */
  it('never sends the token to a listener that is not this home hub', async () => {
    const home = tempHome();
    const asked: string[] = [];
    const foreign = createServer((incoming, response) => {
      asked.push(
        `${incoming.method} ${incoming.url?.replace(/nonce=[^&]+/, 'nonce=…')} ${incoming.headers.authorization ?? 'no-token'}`,
      );
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({ hub: 'ground-control', protocol: PROTOCOL, fingerprint: fingerprintOf('d:/somebody-else') }),
      );
    });

    listening.push(foreign);
    await new Promise<void>((bound) => foreign.listen(0, '127.0.0.1', bound));

    const stolen = (foreign.address() as { port: number }).port;

    writeFileSync(
      hubJsonPath(home),
      JSON.stringify({
        protocol: PROTOCOL,
        version: '0.0.0',
        port: stolen,
        token: 'the-token-nobody-else-gets',
        pid: 1,
        startedAt: '2026-09-03T10:00:00.000Z',
        fingerprint: fingerprintOf(home),
      }),
    );

    run(home);

    const there = await until(() => {
      const written = record(home);

      return written && written.port !== stolen ? written : null;
    });

    expect(there.port).not.toBe(stolen);
    // Pinned by contents, not scanned: a probe that never happened would satisfy every predicate over an empty list.
    // Two: once before binding, and once when the record it could not claim turned out to name nothing alive.
    expect(asked).toEqual(['GET /hub?nonce=… no-token', 'GET /hub?nonce=… no-token']);
  });

  it('stops the hub a home has when asked from another process', async () => {
    const home = tempHome();
    const hub = run(home);

    await until(() => record(home));

    const stop = run(home, '--stop');

    expect(await stop.ended).toBe(0);
    expect(stop.output()).toContain('Stopped the hub.');
    expect(await hub.ended).toBe(0);
  });

  /**
   * A mode that threw used to drain and exit 0, because the `unhandledRejection` handler reports and deliberately
   * does not exit. Its caller is a menu item telling the developer their browser can now reach the board (R34), and
   * an exit code is all it has to go on.
   */
  it('exits non-zero when it cannot do what it was asked', async () => {
    const home = tempHome();

    // A file where the configuration directory belongs: the first thing every mode does is make that directory.
    rmSync(join(home, '.claude', 'ground-control'), { recursive: true, force: true });
    writeFileSync(join(home, '.claude', 'ground-control'), 'not a directory');

    const hub = run(home);

    expect(await hub.ended).toBe(1);
    expect(hub.output()).toContain('the hub could not do that');
  });

  it('ends itself when nobody has connected for the idle span', async () => {
    const home = tempHome();
    const hub = run(home, '--idle-ms=300');

    await until(() => record(home));

    expect(await hub.ended).toBe(0);
    expect(existsSync(hubJsonPath(home))).toBe(false);
  });
});
