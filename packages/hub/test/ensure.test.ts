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

/**
 * Time is stepped by the waiting itself: `sleep` is what advances the clock, so a test drives the whole five-second
 * wait in no time at all and the budget windows are exact rather than approximate.
 */
function harness(over: Partial<EnsureDeps> = {}) {
  const shape = {
    starts: 0,
    now: 0,
    asked: 0,
    answers: null as LiveHub | null,
    answersAfter: 0,
    /** A hub of another protocol: running, this developer's, and not one this client can speak to. */
    other: null as LiveHub | null,
    stops: 0,
    /** Which hub each stop was aimed at, so a stop of whatever the record names now is not mistaken for a hit. */
    stopped: [] as number[],
    /** What answers once a hub has been started, so a restart is a different hub from the one stood down. */
    startsWith: null as LiveHub | null,
    /** Whether the bundle on disk was written after the running hub bound, and what a look finds when none does. */
    bundleIsNewer: false,
    miss: { miss: { why: 'no-record' } } as Found,
  };

  const deps: EnsureDeps = {
    home,
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
  it('uses the one already answering, and starts nothing', async () => {
    const { shape, ensure } = harness();

    shape.answers = LIVE;

    expect(await ensure()).toEqual({ hub: LIVE });
    expect(shape.starts).toBe(0);
  });

  it('starts one and returns it once it answers', async () => {
    const { shape, ensure } = harness();

    shape.answers = LIVE;
    // Not on the first ask: a hub is spawned and then binds, so an answer that was there all along proves nothing.
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

  /** No file at all is what a killed hub leaves, and it is the one thing worth saying about a hub that will not start. */
  it('says a hub left no reason when there is no record of one', async () => {
    const { ensure } = harness();
    const answer = await ensure();

    expect('failed' in answer && answer.failed).toContain('killed process');
  });

  it('refuses a second start inside the minute rather than spawning again', async () => {
    const { shape, ensure } = harness();

    await ensure();
    expect(shape.starts).toBe(1);

    // The five-second wait already moved the clock, so this second call is well inside the minute.
    const answer = await ensure();

    expect(shape.starts).toBe(1);
    expect('failed' in answer && answer.failed).toContain('keeps stopping');
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
    expect('failed' in answer && answer.failed).toContain('keeps stopping');
  });

  /**
   * A hub of another protocol is running. Newer wins, the same rule the bundle on disk follows, so this client stops
   * it and starts its own — without this it would spawn a hub that stands down, five seconds at a time, forever.
   */
  it('stops a hub of an older protocol and starts its own', async () => {
    const { shape, ensure } = harness();

    shape.other = { ...LIVE, identity: { ...LIVE.identity, protocol: PROTOCOL - 1 } };
    shape.answers = LIVE;
    shape.answersAfter = 1;

    expect(await ensure()).toEqual({ hub: LIVE });
    expect(shape.stops).toBe(1);
    expect(shape.starts).toBe(1);
  });

  /** The other direction has nothing to start: the bundle on disk is the newer hub's, so a spawn stands down. */
  it('says so and starts nothing when the hub running is newer than this client', async () => {
    const { shape, ensure } = harness();

    shape.other = { ...LIVE, identity: { ...LIVE.identity, protocol: PROTOCOL + 1 } };

    const answer = await ensure();

    expect('failed' in answer && answer.failed).toContain('newer Ground Control');
    expect(shape.starts).toBe(0);
    expect(shape.stops).toBe(0);
  });

  /** Killing a working hub is a thing developers do, and waiting a minute for the board to come back is not it. */
  it('starts one again the moment a hub that was working goes away', async () => {
    const { shape, ensure } = harness();

    shape.answers = LIVE;
    shape.answersAfter = 1;

    expect(await ensure()).toEqual({ hub: LIVE });
    expect(shape.starts).toBe(1);

    // Killed: the next two asks answer nothing, which is what the board sees a second after a hub is stopped.
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

  /**
   * The wait is five seconds of waiting, not fifty sleeps of a tenth. A look can spend its own deadline twice over
   * against a port held by something that never answers, and counting the sleeps would stretch this into minutes.
   */
  it('gives the start five seconds of the clock however long each look takes', async () => {
    // Each look spends its own deadline twice, the way a port held by something that never answers makes it.
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

    expect(await ensure()).toEqual({ failed: 'The board could not start its background process: Error: EACCES' });
  });
});

/**
 * The hub runs from a file on disk, and an extension that carries a newer one replaces that file — but the hub that
 * is already up goes on running the copy it started with. Nothing else would ever stand it down, so a fix shipped in
 * an update would reach a machine only when the developer stopped the process by hand (R35).
 */
describe('a hub still running an older copy of itself', () => {
  it('is stood down, and the newer one started in its place', async () => {
    const { shape, ensure } = harness();
    const fresh = { ...LIVE, record: { ...LIVE.record, port: 9999 } } as LiveHub;

    shape.answers = LIVE;
    shape.bundleIsNewer = true;
    shape.startsWith = fresh;

    expect(await ensure()).toEqual({ hub: fresh });
    // The hub that was found, by its own record — never whatever the record names by the time the stop goes out.
    expect(shape.stopped).toEqual([LIVE.record.port]);
    expect(shape.starts).toBe(1);
  });

  /** A stop with no start left behind it would leave the board with nothing, which is worse than an older hub. */
  it('is left running once this client has spent its starts', async () => {
    const { shape, ensure } = harness();

    shape.bundleIsNewer = true;

    // Two starts that answered nothing, which is what spends the budget. Only then does the older hub turn up.
    await ensure();
    shape.now += 61_000;
    await ensure();

    shape.answers = LIVE;
    shape.now += 1000;

    expect(await ensure()).toEqual({ hub: LIVE });
    expect(shape.stops).toBe(0);
  });

  /** A stop that hit nothing is a hub another client has already replaced, and the replacement is the one to use. */
  it('takes the hub answering now when its own stop found nothing to stop', async () => {
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

/**
 * The spawned hub stands down when something is already serving the home, and says so only in its own log. To the
 * client that spawned it that is indistinguishable from a hub that died on startup, and the developer is sent to a
 * log describing neither.
 */
describe('something serving this home that will not take this client', () => {
  const held = { ...LIVE.record, port: 4321, pid: 6789 };

  /**
   * Every one of these is a process that is up and did not become this client's hub. The remedy is the same for all
   * of them — end it — and which one it was is the whole of what a developer has to go on.
   */
  const misses: [string, Found, string][] = [
    ['a hub holding a token this client cannot prove', { miss: { why: 'unproven', record: held } }, 'cannot verify'],
    ['a listener that will not answer', { miss: { why: 'silent', record: held } }, 'will not answer'],
    ['something that is not a hub', { miss: { why: 'not-a-hub', record: held } }, 'not Ground Control'],
    ['a hub tracking another home', { miss: { why: 'another-home', record: held } }, 'different home'],
  ];

  /**
   * The port is the record's in every case. The pid is not: only a listener that proved it holds the token wrote
   * the record being read, and naming a pid from any other miss points at a hub that is gone — or, once the number
   * has been handed out again, at something else entirely.
   */
  it.each(misses)('names %s by the port it holds, and never by a pid', async (_what, look, said) => {
    const { shape, ensure } = harness();

    shape.miss = look;

    const answer = await ensure();

    expect('failed' in answer && answer.failed).toContain(said);
    expect('failed' in answer && answer.failed).toContain('4321');
    expect('failed' in answer && answer.failed).not.toContain('6789');
    expect('failed' in answer && answer.failed).not.toContain('never answered');
  });

  /** The one listener that proved it wrote the record, so the one whose pid is the process to stop. */
  it('names a hub of another version by its pid as well, because that one proved the record is its own', async () => {
    const { shape, ensure } = harness();

    shape.miss = { miss: { why: 'another-protocol', hub: { ...LIVE, record: held } } };

    const answer = await ensure();

    expect('failed' in answer && answer.failed).toContain('another version');
    expect('failed' in answer && answer.failed).toContain('pid 6789');
  });

  /**
   * Nothing holds the port the record names, which is a hub that died rather than one in the way. The port it left
   * is not one a new hub would take — every hub binds whatever is free — so the failure does not name it.
   */
  it('says the hub it started never recorded itself when nothing holds the recorded port', async () => {
    const { shape, ensure } = harness();

    shape.miss = { miss: { why: 'unreachable', record: held } };

    const answer = await ensure();

    expect('failed' in answer && answer.failed).toContain('never recorded itself');
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

  /**
   * The one way this rule leaves a board worse off than leaving the old hub alone: the hub it had is stopped and the
   * copy that replaced it does not run. Nothing else on the machine says so, so the failure has to.
   */
  it('is not what is said when the hub this client stopped never came back', async () => {
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
    expect('failed' in answer && answer.failed).toContain('never answered');
  });
});

/**
 * The one comparison that decides whether a working hub is stopped. Both times are file times from the same
 * filesystem — the bundle against the record its hub wrote as it bound — so a machine whose clock disagrees with the
 * one its files are stamped by cannot make every hub look out of date and churn one forever.
 */
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

    expect(bundleIsNewer(home)).toBe(true);
  });

  it('is false when the hub bound after the bundle was written', () => {
    write(bundlePathOf(home), NOON);
    write(hubJsonPathOf(home), NOON + 60_000);

    expect(bundleIsNewer(home)).toBe(false);
  });

  /** A client carrying no bundle of its own has nothing better to offer, so it displaces nothing. */
  it('is false when there is no bundle on disk', () => {
    write(hubJsonPathOf(home), NOON);

    expect(bundleIsNewer(home)).toBe(false);
  });

  /** No record is no hub to displace, and the start that follows is the ordinary one. */
  it('is false when no hub has left a record', () => {
    write(bundlePathOf(home), NOON);

    expect(bundleIsNewer(home)).toBe(false);
  });

  /** The stable state after a restart: the hub wrote its record from the bundle it is running. Nothing to replace. */
  it('is false when the two were written at the same moment', () => {
    write(bundlePathOf(home), NOON);
    write(hubJsonPathOf(home), NOON);

    expect(bundleIsNewer(home)).toBe(false);
  });
});
