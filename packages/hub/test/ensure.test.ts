import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PROTOCOL } from '@ground-control/core';
import { makeEnsure } from '../src/ensure.js';
import type { EnsureDeps } from '../src/ensure.js';
import type { LiveHub } from '../src/discover.js';
import { dirname } from 'node:path';
import { exitPathOf, logPathOf } from '../src/paths.js';
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
    /** What is running that this client cannot talk to, and whether it was asked to stop. */
    other: null as LiveHub | null,
    stops: 0,
  };

  const deps: EnsureDeps = {
    home,
    start: () => {
      shape.starts += 1;
    },
    findAny: () => Promise.resolve(shape.other ?? shape.answers),
    stop: () => {
      shape.stops += 1;
      shape.other = null;

      return Promise.resolve(true);
    },
    now: () => shape.now,
    sleep: (ms) => {
      shape.now += ms;

      return Promise.resolve();
    },
    find: () => {
      shape.asked += 1;

      return Promise.resolve(shape.asked > shape.answersAfter ? shape.answers : null);
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

  it('reports a start that threw rather than waiting on it', async () => {
    const { ensure } = harness({
      start: () => {
        throw new Error('EACCES');
      },
    });

    expect(await ensure()).toEqual({ failed: 'The board could not start its background process: Error: EACCES' });
  });
});
