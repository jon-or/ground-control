import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { groundControlDirOf } from '@ground-control/core';
import { LOGS_KEPT, rotateLog } from '../src/log.js';
import { exitPathOf, hubJsonPathOf, logPathOf } from '../src/paths.js';
import { fingerprintOf, probe } from '../src/discover.js';
import { sanitizeEnvironment, serveHub } from '../src/serve.js';
import type { ServeResult } from '../src/serve.js';
import { tempHome } from './helpers.js';

/**
 * Every hub and every home this file makes, torn down whatever the test did. Without it an assertion that fails
 * before its own `stop()` leaves a listening socket, a live loop with watchers, and a home deleted underneath it.
 */
const later: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  while (later.length) {
    await later.pop()?.();
  }
});

function served(result: ServeResult) {
  if ('existing' in result) {
    throw new Error(`expected this process to be the hub, not to find one on port ${result.existing.record.port}`);
  }

  return result.served;
}

async function serving(home: string, over: { idleMs?: number } = {}) {
  const lines: string[] = [];
  const exits: number[] = [];
  const result = await serveHub({
    home,
    version: '1.2.3',
    log: (line) => lines.push(line),
    exit: (code) => exits.push(code),
    ...over,
  });

  if ('served' in result) {
    later.push(() => result.served.stop('the test is over'));
  }

  return { result, lines, exits };
}

function homeForThisTest(): string {
  const { home, dispose } = tempHome();

  later.push(dispose);

  return home;
}

/** A client as the server counts one: a stream held open, and a hello over it. */
async function connectClient(port: number, token: string, id: string): Promise<() => void> {
  const events = request(
    {
      host: '127.0.0.1',
      port,
      path: `/events?client=${id}`,
      headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}` },
    },
    () => {},
  );

  events.end();
  later.push(() => void events.destroy());

  await new Promise<void>((ready) => events.once('response', () => ready()));
  await new Promise<void>((sent) => {
    const hello = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: `/actions?client=${id}`,
        headers: {
          Host: `127.0.0.1:${port}`,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
      (response) => response.on('end', () => sent()).resume(),
    );

    hello.end(
      JSON.stringify({
        type: 'hello',
        hello: { id, hostId: null, workspaceRoot: null, residentRoutes: [], watching: true },
      }),
    );
  });

  return () => void events.destroy();
}

describe('what a hub refuses to inherit', () => {
  /** VS Code spawns the hub as its own executable running as node; these would make its own `code` do the same. */
  it('drops the variables that would make its own spawns run as node', () => {
    const env = {
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
      VSCODE_PID: '4242',
      NODE_OPTIONS: '--require ./thing.js',
      PATH: 'c:/windows',
      NODE_ENV: 'production',
    };

    expect(sanitizeEnvironment(env).sort()).toEqual([
      'ELECTRON_NO_ATTACH_CONSOLE',
      'ELECTRON_RUN_AS_NODE',
      'NODE_OPTIONS',
      'VSCODE_PID',
    ]);
    expect(env).toEqual({ PATH: 'c:/windows', NODE_ENV: 'production' });
  });
});

describe('starting a hub for a home', () => {
  it('binds first and records the port afterwards, so the record always describes a listener', async () => {
    const home = homeForThisTest();
    const hub = served((await serving(home)).result);

    const record = JSON.parse(readFileSync(hubJsonPathOf(home), 'utf8')) as Record<string, unknown>;

    expect(record.port).toBe(hub.port);
    expect(record.token).toBe(hub.token);
    expect(record.version).toBe('1.2.3');
    expect(record.pid).toBe(process.pid);
    expect(record.fingerprint).toBe(fingerprintOf(home));
    expect(await probe(hub.port)).toMatchObject({ hub: 'ground-control', fingerprint: fingerprintOf(home) });
  });

  /** Single instance is the record, claimed by exclusive create: the second process has nothing to do. */
  it('leaves a home that already has a hub alone', async () => {
    const home = homeForThisTest();
    const first = served((await serving(home)).result);
    const second = await serving(home);

    expect('existing' in second.result && second.result.existing.record.port).toBe(first.port);
    expect(second.lines.join(' ')).toContain('already serving');
  });

  /**
   * The client that spawned it waits for a hub and gets none, and a spawn that died leaves the same silence. Only
   * this file tells the two apart, and without it the board tells a developer to go stop a stranger while their own
   * hub is up and only that window cannot reach it.
   */
  it('leaves the reason it stood down where a client reads why its start came to nothing', async () => {
    const home = homeForThisTest();
    const first = served((await serving(home)).result);

    await serving(home);

    const exit = JSON.parse(readFileSync(exitPathOf(home), 'utf8')) as { code: number; reason: string };

    expect(exit).toMatchObject({ code: 0 });
    expect(exit.reason).toBe(`a hub was already serving this home on port ${first.port}`);
  });

  /** A hub that was killed leaves its record behind, and the next one takes the home over rather than refusing. */
  it('takes over a home whose recorded hub is not answering', async () => {
    const home = homeForThisTest();

    mkdirSync(groundControlDirOf(home), { recursive: true });
    writeFileSync(
      hubJsonPathOf(home),
      JSON.stringify({
        protocol: 1,
        version: '0.0.0',
        port: 1,
        token: 'a-token-from-a-hub-that-died',
        pid: 999_999,
        startedAt: '2026-09-03T10:00:00.000Z',
        fingerprint: fingerprintOf(home),
      }),
    );

    const hub = served((await serving(home)).result);

    expect(hub.port).not.toBe(1);
    expect(JSON.parse(readFileSync(hubJsonPathOf(home), 'utf8')).pid).toBe(process.pid);
  });

  it('takes the record away when it stops, and says why it went', async () => {
    const home = homeForThisTest();
    const hub = served((await serving(home)).result);

    expect(existsSync(hubJsonPathOf(home))).toBe(true);

    await hub.stop('the developer asked');

    expect(existsSync(hubJsonPathOf(home))).toBe(false);
    expect(JSON.parse(readFileSync(exitPathOf(home), 'utf8'))).toMatchObject({
      code: 0,
      reason: 'the developer asked',
    });
    expect(await probe(hub.port, 200)).toBe('unreachable');
  });

  /** R35: a hub nobody is watching costs a developer nothing, so it goes rather than polling for nobody. */
  it('ends itself once nobody has been connected for the idle span', async () => {
    const home = homeForThisTest();
    const { result, exits, lines } = await serving(home, { idleMs: 250 });
    const hub = served(result);

    await new Promise((done) => setTimeout(done, 900));

    expect(exits).toEqual([0]);
    expect(lines.join(' ')).toContain('nobody has been watching');
    expect(await probe(hub.port, 200)).toBe('unreachable');
  });

  /** The other half of R35, and the one a regression would cost a developer: a board open must keep the hub alive. */
  it('stays up while a client is connected, however long the idle span is', async () => {
    const home = homeForThisTest();
    const { result, exits } = await serving(home, { idleMs: 250 });
    const hub = served(result);

    const leave = await connectClient(hub.port, hub.token, 'a-board');

    await new Promise((done) => setTimeout(done, 900));

    expect(exits).toEqual([]);
    expect(await probe(hub.port)).toMatchObject({ hub: 'ground-control' });

    leave();
    await new Promise((done) => setTimeout(done, 900));

    expect(exits).toEqual([0]);
  });

  it('writes its own lines to hub.log when nothing else is listening to it', async () => {
    const home = homeForThisTest();
    const result = await serveHub({ home, version: '1.2.3', exit: () => {} });
    const hub = served(result);

    later.push(() => hub.stop('the test is over'));

    expect(readFileSync(logPathOf(home), 'utf8')).toContain(`listening on 127.0.0.1:${hub.port}`);
  });
});

describe('the hub log', () => {
  it('moves aside once it is past the limit, oldest dropped first', () => {
    {
      const path = `${homeForThisTest()}/hub.log`;

      writeFileSync(path, 'x'.repeat(100));
      expect(rotateLog(path, 1000)).toBe(false);

      writeFileSync(path, 'x'.repeat(2000));
      expect(rotateLog(path, 1000, LOGS_KEPT)).toBe(true);
      expect(existsSync(path)).toBe(false);
      expect(statSync(`${path}.1`).size).toBe(2000);

      writeFileSync(path, 'y'.repeat(2000));
      rotateLog(path, 1000, LOGS_KEPT);
      expect(readFileSync(`${path}.1`, 'utf8')[0]).toBe('y');
      expect(readFileSync(`${path}.2`, 'utf8')[0]).toBe('x');

      writeFileSync(path, 'z'.repeat(2000));
      rotateLog(path, 1000, LOGS_KEPT);
      expect(existsSync(`${path}.3`)).toBe(false);
      expect(readFileSync(`${path}.2`, 'utf8')[0]).toBe('y');
    }
  });

  it('does nothing about a log that is not there', () => {
    expect(rotateLog(`${homeForThisTest()}/never-written.log`, 1)).toBe(false);
  });
});
