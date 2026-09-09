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

/** Use a real directory and fs.watch because watcher behavior is under test. */
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

  /** Preserve final deletions amid concurrent marker writes so session ends trigger roster refresh. */
  it('preserves deletions during concurrent marker writes', async () => {
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

  /** Treat temporary-file replacement as changed while the session ID remains. A restarted session has a new ID and triggers roster discovery. */
  it('reads a marker that is written again before the listing as changed, not as a session that ended', async () => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(marker('a'), '{}');

    const watcher = watching();
    const arrived = watcher.next();

    rmSync(marker('a'));
    writeFileSync(marker('a'), '{"phase":"running"}');

    expect(await arrived).toEqual([{ kind: 'changed', sessionId: 'a' }]);
  });

  /** Preserve deletion after a write in the same batch so ended sessions do not remain until the next poll. */
  it('reports a marker created and then removed inside one batch as deleted', async () => {
    mkdirSync(dir(), { recursive: true });

    const watcher = watching();
    const arrived = watcher.next();

    writeFileSync(marker('brief'), '{}');
    // Let the watcher observe creation before deleting within the same batch.
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

  /** Retry registration when the directory is missing or removed; fs.watch rejects missing paths. */
  it('delivers the first event after a directory that did not exist is created', async () => {
    const watcher = watching();

    mkdirSync(dir(), { recursive: true });
    const arrived = watcher.next();

    // Retry the first write if it precedes watcher registration.
    const write = setInterval(() => writeFileSync(marker('a'), '{}'), 200);

    try {
      expect((await arrived).map((c) => c.sessionId)).toEqual(['a']);
    } finally {
      clearInterval(write);
    }
  }, 10_000);

  it('stops reporting after disposal', async () => {
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
