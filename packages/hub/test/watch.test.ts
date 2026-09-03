import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { ActivityChange } from '@ground-control/core';
import { BATCH_MS, watchDir } from '../src/watch.js';
import { tempHome } from './helpers.js';

let home: string;
let dispose: () => void;
let stop: (() => void) | undefined;

beforeEach(() => {
  ({ home, dispose } = tempHome());
});

afterEach(() => {
  stop?.();
  stop = undefined;
  dispose();
});

const dir = (): string => `${home}/activity`;
const marker = (id: string): string => `${dir()}/${id}.json`;

/** A real watcher over a real directory: `fs.watch` is the mechanism under test, so nothing here is faked. */
function watching(): { batches: ActivityChange[][]; next: () => Promise<ActivityChange[]> } {
  const batches: ActivityChange[][] = [];
  const waiting: ((changes: ActivityChange[]) => void)[] = [];

  const handle = watchDir(dir(), (changes) => {
    batches.push(changes);
    waiting.shift()?.(changes);
  });

  stop = handle.dispose;

  return {
    batches,
    next: () =>
      new Promise<ActivityChange[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no batch arrived')), 5_000);

        waiting.push((changes) => {
          clearTimeout(timer);
          resolve(changes);
        });
      }),
  };
}

const settle = (ms = BATCH_MS * 3): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('watchDir', () => {
  it('reports a marker appearing as created', async () => {
    mkdirSync(dir(), { recursive: true });
    const watcher = watching();

    const arrived = watcher.next();
    writeFileSync(marker('a'), '{}');

    expect(await arrived).toEqual([{ kind: 'created', sessionId: 'a' }]);
  });

  it('reports a marker being rewritten as changed', async () => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(marker('a'), '{}');

    const watcher = watching();
    const arrived = watcher.next();
    writeFileSync(marker('a'), '{"phase":"running"}');

    expect(await arrived).toEqual([{ kind: 'changed', sessionId: 'a' }]);
  });

  it('reports a marker being removed as deleted, which is the only kind that moves the roster', async () => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(marker('a'), '{}');

    const watcher = watching();
    const arrived = watcher.next();
    rmSync(marker('a'));

    expect(await arrived).toEqual([{ kind: 'deleted', sessionId: 'a' }]);
  });

  /**
   * `deleted` is the kind that costs a CLI read, so the one that must never be lost is a delete that stands — and it
   * must survive a turn boundary writing other markers at the same moment, which is when a session usually ends.
   */
  it('reports a delete that stands even while other markers are being written', async () => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(marker('ending'), '{}');
    writeFileSync(marker('working'), '{}');

    const watcher = watching();
    const arrived = watcher.next();

    rmSync(marker('ending'));
    writeFileSync(marker('working'), '{"phase":"running"}');
    writeFileSync(marker('fresh'), '{}');

    const changes = await arrived;

    expect(changes.find((c) => c.sessionId === 'ending')?.kind).toBe('deleted');
    expect(changes.find((c) => c.sessionId === 'working')?.kind).toBe('changed');
    expect(changes.find((c) => c.sessionId === 'fresh')?.kind).toBe('created');
  });

  /**
   * The marker is written temp-then-rename, so a phase update can reach the watcher as a file that went away and
   * came back. It reads as `changed`, and that is right rather than merely cheap: the name is a session id, so
   * something wrote that session's marker, which means the session is alive and its card belongs on the board. A
   * session that ended and started afresh carries a new id, which `rosterIsStale` catches as an unlisted session.
   */
  it('reads a marker that is written again before the listing as changed, not as a session that ended', async () => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(marker('a'), '{}');

    const watcher = watching();
    const arrived = watcher.next();

    rmSync(marker('a'));
    writeFileSync(marker('a'), '{"phase":"running"}');

    expect(await arrived).toEqual([{ kind: 'changed', sessionId: 'a' }]);
  });

  /**
   * A session that ends just after a tool completes writes its marker and unlinks it inside one batch. `deleted` is
   * the only kind `rosterIsStale` acts on, so it has to win wherever it lands — keeping the first kind seen would
   * report the create and leave the ended session on the board until the next poll.
   */
  it('reports a marker created and then removed inside one batch as deleted', async () => {
    mkdirSync(dir(), { recursive: true });

    const watcher = watching();
    const arrived = watcher.next();

    writeFileSync(marker('brief'), '{}');
    // Long enough for the create to reach the watcher while the file is still there, and well inside the batch:
    // removing it in the same breath is delivered as one event that already sees it gone, which proves nothing.
    await new Promise((resolve) => setTimeout(resolve, 40));
    rmSync(marker('brief'));

    expect(await arrived).toEqual([{ kind: 'deleted', sessionId: 'brief' }]);
  });

  it('batches a turn boundary into one call rather than one per marker', async () => {
    mkdirSync(dir(), { recursive: true });
    const watcher = watching();

    const arrived = watcher.next();
    writeFileSync(marker('a'), '{}');
    writeFileSync(marker('b'), '{}');
    writeFileSync(marker('c'), '{}');

    const changes = await arrived;

    await settle();

    expect(changes.map((c) => c.sessionId).sort()).toEqual(['a', 'b', 'c']);
    expect(watcher.batches).toHaveLength(1);
  });

  it('ignores a file that is not a marker', async () => {
    mkdirSync(dir(), { recursive: true });
    const watcher = watching();

    writeFileSync(`${dir()}/notes.txt`, 'hello');
    await settle();

    expect(watcher.batches).toEqual([]);
  });

  /**
   * The directory is created by the install and removed when the hooks are turned off, so a watcher armed before
   * either would otherwise be deaf for the life of the process. `fs.watch` throws outright on a missing path.
   */
  it('delivers the first event after a directory that did not exist is created', async () => {
    const watcher = watching();

    mkdirSync(dir(), { recursive: true });
    const arrived = watcher.next();

    // The watcher looks for the directory on its own timer, so the first write may land before it is armed.
    const write = setInterval(() => writeFileSync(marker('a'), '{}'), 200);

    try {
      expect((await arrived).map((c) => c.sessionId)).toEqual(['a']);
    } finally {
      clearInterval(write);
    }
  }, 10_000);

  it('reports nothing more once it is disposed', async () => {
    mkdirSync(dir(), { recursive: true });
    const watcher = watching();

    stop?.();
    stop = undefined;

    writeFileSync(marker('a'), '{}');
    await settle();

    expect(watcher.batches).toEqual([]);
  });

  it('can be disposed before its directory ever appears', () => {
    const handle = watchDir(dir(), () => {});

    expect(() => handle.dispose()).not.toThrow();
  });
});
