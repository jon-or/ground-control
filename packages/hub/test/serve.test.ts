import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { bootstrapDirOf, diskReaders, formatStatePointer, statePointerPathOf } from '@ground-control/core';
import { defaultConfig, makeRegistries } from '../src/registry.js';
import { LOGS_KEPT, rotateLog } from '../src/log.js';
import { exitPathOf, hubJsonPathOf, logPathOf } from '../src/paths.js';
import { fingerprintOf, probe } from '../src/discover.js';
import { sanitizeEnvironment, serveHub } from '../src/serve.js';
import type { ServeResult } from '../src/serve.js';
import { captureLog, tempHome } from './helpers.js';

/** Always stop hubs and remove test homes, including after assertion failures. */
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

  if ('refused' in result) {
    throw new Error(`expected this process to be the hub, not to refuse: ${result.refused}`);
  }

  return result.served;
}

async function serving(home: string, over: { idleMs?: number } = {}) {
  const { log, messages: lines } = captureLog();
  const exits: number[] = [];
  const result = await serveHub({
    home,
    version: '1.2.3',
    log,
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
  /** Remove inherited Electron flags before invoking the editor CLI. */
  it('removes inherited Node-mode flags for child editor processes', () => {
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

    const record = JSON.parse(readFileSync(hubJsonPathOf(bootstrapDirOf(home)), 'utf8')) as Record<string, unknown>;

    expect(record.port).toBe(hub.port);
    expect(record.token).toBe(hub.token);
    expect(record.version).toBe('1.2.3');
    expect(record.pid).toBe(process.pid);
    expect(record.fingerprint).toBe(fingerprintOf(bootstrapDirOf(home)));
    expect(await probe(hub.port)).toMatchObject({ hub: 'ground-control', fingerprint: fingerprintOf(bootstrapDirOf(home)) });
  });

  it('serves the directory a pointer names, and refuses while a move is recorded', async () => {
    const home = homeForThisTest();
    const elsewhere = `${home.replace(/\\/g, '/')}/elsewhere`;

    mkdirSync(bootstrapDirOf(home), { recursive: true });
    writeFileSync(statePointerPathOf(home), formatStatePointer({ stateDir: elsewhere }));

    const hub = served((await serving(home)).result);

    expect(JSON.parse(readFileSync(hubJsonPathOf(elsewhere), 'utf8')).port).toBe(hub.port);
    expect(existsSync(hubJsonPathOf(bootstrapDirOf(home)))).toBe(false);
    expect(await probe(hub.port)).toMatchObject({ fingerprint: fingerprintOf(elsewhere) });
    await hub.stop('moving on');

    writeFileSync(statePointerPathOf(home), formatStatePointer({ stateDir: elsewhere, migration: { to: `${home}/next`, startedAt: new Date().toISOString() } }));

    const refused = await serving(home);

    expect(refused.result).toEqual({ refused: `state relocation to ${home.replace(/\\/g, '/')}/next in progress` });
    expect(JSON.parse(readFileSync(exitPathOf(elsewhere), 'utf8')).reason).toBe(`state relocation to ${home.replace(/\\/g, '/')}/next in progress`);
    expect(existsSync(hubJsonPathOf(elsewhere))).toBe(false);
  });

  it('refuses to serve the bootstrap directory while the pointer is unusable', async () => {
    const home = homeForThisTest();

    mkdirSync(bootstrapDirOf(home), { recursive: true });
    writeFileSync(statePointerPathOf(home), '{"stateDir":"relative"}');

    const refused = await serving(home);

    expect(refused.result).toEqual({ refused: 'state-dir.json is not a usable state pointer. Fix or delete the pointer in the bootstrap directory.' });
    expect(existsSync(hubJsonPathOf(bootstrapDirOf(home)))).toBe(false);
    expect(JSON.parse(readFileSync(exitPathOf(bootstrapDirOf(home)), 'utf8')).reason).toContain('not a usable state pointer');
  });

  /** Exclusive record creation prevents a second hub for the same home. */
  it('leaves a home that already has a hub alone', async () => {
    const home = homeForThisTest();
    const first = served((await serving(home)).result);
    const second = await serving(home);

    expect('existing' in second.result && second.result.existing.record.port).toBe(first.port);
    expect(second.lines.join(' ')).toContain('hub already running');
  });

  /** Use the exit record to distinguish duplicate-instance refusal from startup failure. */
  it('records duplicate-instance refusal for client diagnostics', async () => {
    const home = homeForThisTest();
    const first = served((await serving(home)).result);

    await serving(home);

    const exit = JSON.parse(readFileSync(exitPathOf(bootstrapDirOf(home)), 'utf8')) as { code: number; reason: string };

    expect(exit).toMatchObject({ code: 0 });
    expect(exit.reason).toBe(`a hub was already serving this state directory on port ${first.port}`);
  });

  /** A hub that was killed leaves its record behind, and the next one takes the home over rather than refusing. */
  it('takes over a home whose recorded hub is not answering', async () => {
    const home = homeForThisTest();

    mkdirSync(bootstrapDirOf(home), { recursive: true });
    writeFileSync(
      hubJsonPathOf(bootstrapDirOf(home)),
      JSON.stringify({
        protocol: 1,
        version: '0.0.0',
        port: 1,
        token: 'a-token-from-a-hub-that-died',
        pid: 999_999,
        startedAt: '2026-09-03T10:00:00.000Z',
        fingerprint: fingerprintOf(bootstrapDirOf(home)),
      }),
    );

    const hub = served((await serving(home)).result);

    expect(hub.port).not.toBe(1);
    expect(JSON.parse(readFileSync(hubJsonPathOf(bootstrapDirOf(home)), 'utf8')).pid).toBe(process.pid);
  });

  it('removes its connection record and records the exit reason', async () => {
    const home = homeForThisTest();
    const hub = served((await serving(home)).result);

    expect(existsSync(hubJsonPathOf(bootstrapDirOf(home)))).toBe(true);

    await hub.stop('the developer asked');

    expect(existsSync(hubJsonPathOf(bootstrapDirOf(home)))).toBe(false);
    expect(JSON.parse(readFileSync(exitPathOf(bootstrapDirOf(home)), 'utf8'))).toMatchObject({
      code: 0,
      reason: 'the developer asked',
    });
    expect(await probe(hub.port, 200)).toBe('unreachable');
  });

  /** Exit after idle timeout instead of polling without clients (R35). */
  it('ends itself once nobody has been connected for the idle span', async () => {
    const home = homeForThisTest();
    const { result, exits, lines } = await serving(home, { idleMs: 250 });
    const hub = served(result);

    await new Promise((done) => setTimeout(done, 900));

    expect(exits).toEqual([0]);
    expect(lines.join(' ')).toContain('nobody has been connected');
    expect(await probe(hub.port, 200)).toBe('unreachable');
  });

  /** Browser-started hubs have no editor to tell them the window; the stored settings must carry it. */
  it('follows the stored idle window when nothing overrides it, and a new window pushed later applies to the wait in progress', async () => {
    const home = homeForThisTest();
    const stateDir = bootstrapDirOf(home);

    mkdirSync(stateDir, { recursive: true });
    writeFileSync(`${stateDir}/config.json`, JSON.stringify({ ...defaultConfig(makeRegistries(), diskReaders(home, stateDir)), idleExitMs: 3_600_000 }));

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

    try {
      const { result, exits } = await serving(home);
      const hub = served(result);

      // Empty since it started, checked once a minute: after a tick it is still inside the stored hour.
      await vi.advanceTimersByTimeAsync(61_000);
      expect(exits).toEqual([]);

      // Lowering the window to its floor makes the minute already served count at the next check.
      hub.hub.configure({ ...defaultConfig(makeRegistries(), diskReaders(home, stateDir)), idleExitMs: 60_000 });
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(exits).toEqual([0]));
    } finally {
      vi.useRealTimers();
    }
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

  it('writes hub.log without subscribers', async () => {
    const home = homeForThisTest();
    const result = await serveHub({ home, version: '1.2.3', exit: () => {} });
    const hub = served(result);

    later.push(() => hub.stop('the test is over'));

    expect(readFileSync(logPathOf(bootstrapDirOf(home)), 'utf8')).toContain(`listening on 127.0.0.1:${hub.port}`);
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

  it('skips rotation for missing logs', () => {
    expect(rotateLog(`${homeForThisTest()}/never-written.log`, 1)).toBe(false);
  });

  /** Keeping nothing means the current file goes, not that it is renamed to a generation nobody will delete. */
  it('truncates instead of rotating when nothing is to be kept', () => {
    const path = `${homeForThisTest()}/hub.log`;

    writeFileSync(path, 'x'.repeat(2000));
    writeFileSync(`${path}.1`, 'older');
    expect(rotateLog(path, 1000, 0)).toBe(true);
    // Truncated in place, not unlinked: the launcher's stdout handle still points at this file.
    expect(statSync(path).size).toBe(0);
    expect(existsSync(`${path}.1`)).toBe(false);
  });

  it('deletes the generations a lowered count no longer keeps', () => {
    const path = `${homeForThisTest()}/hub.log`;

    for (let index = 1; index <= 6; index++) {
      writeFileSync(`${path}.${index}`, `generation ${index}`);
    }

    writeFileSync(path, 'x'.repeat(2000));
    expect(rotateLog(path, 1000, 2)).toBe(true);
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(readFileSync(`${path}.2`, 'utf8')).toBe('generation 1');
    expect([3, 4, 5, 6].some((index) => existsSync(`${path}.${index}`))).toBe(false);
  });
});
