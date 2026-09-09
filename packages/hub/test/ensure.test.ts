import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { PROTOCOL } from '@ground-control/core';
import { START_POLL_MS, START_TIMEOUT_MS, bundleIsNewer, makeEnsure } from '../src/ensure.js';
import type { EnsureDeps } from '../src/ensure.js';
import type { Found, LiveHub } from '../src/discover.js';
import { dirname } from 'node:path';
import { bundlePathOf, exitPathOf, hubJsonPathOf, logPathOf } from '../src/paths.js';
import { tempHome } from './helpers.js';

let home: string;
let dispose: () => void;

beforeEach(() => {
  ({ home, dispose } = tempHome());
});

afterEach(() => dispose());

const LIVE = {
  record: { protocol: 1, version: '1.0.0', port: 4321, token: 't', pid: 9, startedAt: '', fingerprint: 'f' },
  identity: { hub: 'ground-control', protocol: 1, fingerprint: 'f' },
} as LiveHub;

/** A second hub, so a stop can be told from a stop of the one the client had actually found. */
const OTHER = { ...LIVE, record: { ...LIVE.record, port: 5678, token: 'another' } } as LiveHub;

/** Advance the fake clock through sleep calls to test exact startup and restart limits. */
function harness(over: Partial<EnsureDeps> = {}) {
  const shape = {
    starts: 0,
    now: 0,
    asked: 0,
    answers: null as LiveHub | null,
    answersAfter: 0,
    /** Authenticated hub with an incompatible protocol. */
    other: null as LiveHub | null,
    stops: 0,
    /** Record shutdown targets to detect accidental replacement shutdown. */
    stopped: [] as number[],
    /** Return a distinct hub after replacement starts. */
    startsWith: null as LiveHub | null,
    /** Whether the bundle on disk was written after the running hub bound, and what a look finds when none does. */
    bundleIsNewer: false,
    miss: { miss: { why: 'no-record' } } as Found,
  };

  const deps: EnsureDeps = {
    stateDir: () => home,
    start: () => {
      shape.starts += 1;

      if (shape.startsWith !== null) {
        shape.answers = shape.startsWith;
      }
    },
    stop: (hub) => {
      shape.stops += 1;
      shape.stopped.push(hub.record.port);

      shape.other = null;

      return Promise.resolve(true);
    },
    bundleIsNewer: () => shape.bundleIsNewer,
    now: () => shape.now,
    sleep: (ms) => {
      shape.now += ms;

      return Promise.resolve();
    },
    look: () => {
      shape.asked += 1;

      if (shape.other !== null) {
        return Promise.resolve({ miss: { why: 'another-protocol', hub: shape.other } } as Found);
      }

      const hub = shape.asked > shape.answersAfter ? shape.answers : null;

      return Promise.resolve(hub ? { hub } : shape.miss);
    },
    ...over,
  };

  return { shape, ensure: makeEnsure(deps) };
}

describe('getting a hub to talk to', () => {
  it('reuses an existing hub without starting another', async () => {
    const { shape, ensure } = harness();

    shape.answers = LIVE;

    expect(await ensure()).toEqual({ hub: LIVE });
    expect(shape.starts).toBe(0);
  });

  it('resolves the state directory again on every attempt, so a moved pointer is followed', async () => {
    const dirs = [`${home}/first`, `${home}/second`];
    const looked: string[] = [];
    const { shape, ensure } = harness({
      stateDir: () => dirs.shift() ?? `${home}/second`,
      look: (where) => {
        looked.push(where);

        return Promise.resolve({ hub: LIVE });
      },
    });

    await ensure();
    await ensure();

    expect(looked).toEqual([`${home}/first`, `${home}/second`]);
    expect(shape.starts).toBe(0);
  });

  it('starts one and returns it once it answers', async () => {
    const { shape, ensure } = harness();

    shape.answers = LIVE;
    // Make the hub appear only after startup to test discovery polling.
    shape.answersAfter = 3;

    expect(await ensure()).toEqual({ hub: LIVE });
    expect(shape.starts).toBe(1);
    // Written out rather than read from the source: five seconds is the wait a developer sits through.
    expect(shape.now).toBeLessThan(5000);
  });

  it('gives up after the wait, and names the reason the last one stopped', async () => {
    mkdirSync(dirname(exitPathOf(home)), { recursive: true });
    writeFileSync(exitPathOf(home), JSON.stringify({ code: 0, at: '', reason: 'nobody has been watching' }));

    const { shape, ensure } = harness();
    const answer = await ensure();

    expect('failed' in answer && answer.failed).toContain('nobody has been watching');
    expect('failed' in answer && answer.failed).toContain(logPathOf(home));
    expect(shape.now).toBe(5000);
  });

  /** Report missing exit diagnostics when no exit record exists. */
  it('reports a missing exit reason', async () => {
    const { ensure } = harness();
    const answer = await ensure();

    expect('failed' in answer && answer.failed).toContain('No exit reason recorded');
  });

  it('refuses a second start inside the minute rather than spawning again', async () => {
    const { shape, ensure } = harness();

    await ensure();
    expect(shape.starts).toBe(1);

    // The five-second wait already moved the clock, so this second call is well inside the minute.
    const answer = await ensure();

    expect(shape.starts).toBe(1);
    expect('failed' in answer && answer.failed).toContain('repeatedly exited');
  });

  it('tries again once the minute has passed, and stops after three inside five', async () => {
    const { shape, ensure } = harness();

    for (let attempt = 0; attempt < 3; attempt++) {
      await ensure();
      shape.now += 61_000;
    }

    expect(shape.starts).toBe(3);

    const answer = await ensure();

    expect(shape.starts).toBe(3);
    expect('failed' in answer && answer.failed).toContain('repeatedly exited');
  });

  /** Stop an older-protocol hub before starting its replacement to avoid repeated duplicate-instance refusals. */
  it('replaces older-protocol hubs', async () => {
    const { shape, ensure } = harness();

    shape.other = { ...LIVE, identity: { ...LIVE.identity, protocol: PROTOCOL - 1 } };
    shape.answers = LIVE;
    shape.answersAfter = 1;

    expect(await ensure()).toEqual({ hub: LIVE });
    expect(shape.stops).toBe(1);
    expect(shape.starts).toBe(1);
  });

  /** Do not start an older bundle while a newer-protocol hub is running. */
  it('refuses startup while a newer-protocol hub is running', async () => {
    const { shape, ensure } = harness();

    shape.other = { ...LIVE, identity: { ...LIVE.identity, protocol: PROTOCOL + 1 } };

    const answer = await ensure();

    expect('failed' in answer && answer.failed).toContain('newer Ground Control');
    expect(shape.starts).toBe(0);
    expect(shape.stops).toBe(0);
  });

  /** Killing a working hub is a thing developers do, and waiting a minute for the board to come back is not it. */
  it('restarts after a previously connected hub exits', async () => {
    const { shape, ensure } = harness();

    shape.answers = LIVE;
    shape.answersAfter = 1;

    expect(await ensure()).toEqual({ hub: LIVE });
    expect(shape.starts).toBe(1);

    // Simulate failed probes immediately after stopping the hub.
    shape.answersAfter = shape.asked + 2;
    shape.now += 1000;

    expect(await ensure()).toEqual({ hub: LIVE });
    expect(shape.starts).toBe(2);
  });

  /** The budget is a window, not a lifetime allowance: a developer at their desk all day gets a hub again. */
  it('starts again once the five minutes have gone by', async () => {
    const { shape, ensure } = harness();

    for (let attempt = 0; attempt < 3; attempt++) {
      await ensure();
      shape.now += 61_000;
    }

    expect((await ensure()) as { failed: string }).toHaveProperty('failed');

    shape.now += 5 * 60_000;
    await ensure();

    expect(shape.starts).toBe(4);
  });

  /** A window with a board and a settings listener asks at once, and two starts would race for the same record. */
  it('shares one attempt between callers that ask at the same time', async () => {
    const { shape, ensure } = harness();

    const both = await Promise.all([ensure(), ensure()]);

    expect(shape.starts).toBe(1);
    expect(both[0]).toBe(both[1]);
  });

  /** Count probe duration toward the startup deadline instead of counting only sleep intervals. */
  it('gives the start five seconds of the clock however long each look takes', async () => {
    // Simulate both silent-probe timeouts during each discovery call.
    const { shape, ensure } = harness({
      look: () => {
        shape.asked += 1;
        shape.now += 3500;

        return Promise.resolve({ miss: { why: 'silent', record: LIVE.record } } as Found);
      },
    });

    await ensure();

    // One look before the start, two inside the wait, one after it. Counting sleeps would have made it fifty-two.
    expect(shape.asked).toBe(4);
  });

  it('reports a start that threw rather than waiting on it', async () => {
    const { ensure } = harness({
      start: () => {
        throw new Error('EACCES');
      },
    });

    expect(await ensure()).toEqual({ failed: 'Could not start the hub: Error: EACCES' });
  });
});

/** Replace the running process when its bundle is updated so installed fixes take effect (R35). */
describe('a hub still running an older copy of itself', () => {
  it('replaces the running hub with a newer bundle', async () => {
    const { shape, ensure } = harness();
    const fresh = { ...LIVE, record: { ...LIVE.record, port: 9999 } } as LiveHub;

    shape.answers = LIVE;
    shape.bundleIsNewer = true;
    shape.startsWith = fresh;

    expect(await ensure()).toEqual({ hub: fresh });
    // Stop the discovered hub, not a later replacement in the record.
    expect(shape.stopped).toEqual([LIVE.record.port]);
    expect(shape.starts).toBe(1);
  });

  /** Keep the existing hub when the restart limit would prevent a replacement. */
  it('is left running once this client has spent its starts', async () => {
    const { shape, ensure } = harness();

    shape.bundleIsNewer = true;

    // Exhaust the restart limit before discovering the older hub.
    await ensure();
    shape.now += 61_000;
    await ensure();

    shape.answers = LIVE;
    shape.now += 1000;

    expect(await ensure()).toEqual({ hub: LIVE });
    expect(shape.stops).toBe(0);
  });

  /** Use a replacement hub discovered after the stop request fails. */
  it('rechecks discovery after a failed stop request', async () => {
    const { shape, ensure } = harness({
      stop: () => {
        shape.answers = OTHER;

        return Promise.resolve(false);
      },
    });

    shape.answers = LIVE;
    shape.bundleIsNewer = true;

    expect(await ensure()).toEqual({ hub: OTHER });
    expect(shape.starts).toBe(0);
  });
});

/** Distinguish duplicate-instance refusal from startup failure using the recorded exit reason. */
describe('something serving this home that will not take this client', () => {
  const held = { ...LIVE.record, port: 4321, pid: 6789 };

  /** Verify diagnostics for running listeners that cannot serve this client. */
  const misses: [string, Found, string][] = [
    ['a hub holding a token this client cannot prove', { miss: { why: 'unproven', record: held } }, 'Could not verify'],
    ['a listener that will not answer', { miss: { why: 'silent', record: held } }, 'did not respond'],
    [
      'something that is not a hub',
      { miss: { why: 'not-a-hub', record: held, saw: { status: 502, said: 'Proxy Error' } } },
      'not as Ground Control',
    ],
    ['a hub tracking another home', { miss: { why: 'another-home', record: held } }, 'different state directory'],
  ];

  /** Report the recorded port for all failures, but report a PID only after authenticating the listener. */
  it.each(misses)('names %s by the port it holds, and never by a pid', async (_what, look, said) => {
    const { shape, ensure } = harness();

    shape.miss = look;

    const answer = await ensure();

    expect('failed' in answer && answer.failed).toContain(said);
    expect('failed' in answer && answer.failed).toContain('4321');
    expect('failed' in answer && answer.failed).not.toContain('6789');
    expect('failed' in answer && answer.failed).not.toContain('The hub started but did not respond');
  });

  /** Include the unexpected response to distinguish another service from a stale record. */
  it('includes unexpected listener response details', async () => {
    const { shape, ensure } = harness();

    shape.miss = { miss: { why: 'not-a-hub', record: held, saw: { status: 502, said: 'Proxy Error' } } };

    const answer = await ensure();

    expect('failed' in answer && answer.failed).toContain('HTTP 502');
    expect('failed' in answer && answer.failed).toContain('Proxy Error');
  });

  /** Include duplicate-instance refusal from hub-exit.json when another hub is already running. */
  it('reports a duplicate-instance startup refusal', async () => {
    const { shape, ensure } = harness();

    mkdirSync(dirname(exitPathOf(home)), { recursive: true });
    writeFileSync(
      exitPathOf(home),
      JSON.stringify({ code: 0, at: '', reason: 'a hub was already serving this state directory on port 4321' }),
    );

    shape.miss = { miss: { why: 'not-a-hub', record: held, saw: { status: 404, said: '' } } };

    const answer = await ensure();

    expect('failed' in answer && answer.failed).toContain('this window cannot connect to it');
  });

  /** The one listener that proved it wrote the record, so the one whose pid is the process to stop. */
  it('includes the authenticated incompatible hub PID', async () => {
    const { shape, ensure } = harness();

    shape.miss = { miss: { why: 'another-protocol', hub: { ...LIVE, record: held } } };

    const answer = await ensure();

    expect('failed' in answer && answer.failed).toContain('Another hub version');
    expect('failed' in answer && answer.failed).toContain('pid 6789');
  });

  /** An unreachable stale port does not block binding a new ephemeral port; omit that port from recovery instructions. */
  it('reports an unreachable recorded hub', async () => {
    const { shape, ensure } = harness();

    shape.miss = { miss: { why: 'unreachable', record: held } };

    const answer = await ensure();

    expect('failed' in answer && answer.failed).toContain('Could not connect to the recorded hub');
    expect('failed' in answer && answer.failed).not.toContain('4321');
  });

  /** The start ran long rather than failing. Connecting beats telling the developer about a race they cannot see. */
  it('takes the hub that turned up while this was giving up on it', async () => {
    const { shape, ensure } = harness();

    shape.answers = LIVE;
    // One look before the start, then one per poll of the wait: the hub turns up on the look after all of those.
    shape.answersAfter = 1 + START_TIMEOUT_MS / START_POLL_MS;

    expect(await ensure()).toEqual({ hub: LIVE });
  });

  /** Report failure when the replacement cannot start after the old hub stops. */
  it('distinguishes failed replacement from duplicate-instance refusal', async () => {
    let up: Found = { hub: LIVE };
    let stops = 0;

    const { shape, ensure } = harness({
      look: () => Promise.resolve(up),
      stop: () => {
        stops += 1;
        up = { miss: { why: 'no-record' } };

        return Promise.resolve(true);
      },
    });

    shape.bundleIsNewer = true;

    const answer = await ensure();

    expect(stops).toBe(1);
    expect(shape.starts).toBe(1);
    expect('failed' in answer && answer.failed).toContain('did not respond');
  });
});

/** Compare bundle and record mtimes from the same filesystem so clock differences cannot trigger repeated replacement. */
describe('whether the hub on disk is newer than the hub that is running', () => {
  function write(path: string, at: number): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'x');
    utimesSync(path, new Date(at), new Date(at));
  }

  const NOON = Date.parse('2026-01-01T12:00:00.000Z');

  it('is true when the bundle was written after the record', () => {
    write(hubJsonPathOf(home), NOON);
    write(bundlePathOf(home), NOON + 60_000);

    expect(bundleIsNewer(home, home)).toBe(true);
  });

  it('is false when the hub bound after the bundle was written', () => {
    write(bundlePathOf(home), NOON);
    write(hubJsonPathOf(home), NOON + 60_000);

    expect(bundleIsNewer(home, home)).toBe(false);
  });

  /** Keep the running hub when the client has no replacement bundle. */
  it('is false when there is no bundle on disk', () => {
    write(hubJsonPathOf(home), NOON);

    expect(bundleIsNewer(home, home)).toBe(false);
  });

  /** No record is no hub to displace, and the start that follows is the ordinary one. */
  it('is false when no hub has left a record', () => {
    write(bundlePathOf(home), NOON);

    expect(bundleIsNewer(home, home)).toBe(false);
  });

  /** The stable state after a restart: the hub wrote its record from the bundle it is running. Nothing to replace. */
  it('is false when the two were written at the same moment', () => {
    write(bundlePathOf(home), NOON);
    write(hubJsonPathOf(home), NOON);

    expect(bundleIsNewer(home, home)).toBe(false);
  });
});
