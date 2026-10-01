import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import * as fs from 'node:fs';
import { rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';

const real = vi.hoisted(() => ({ readFileSync: null as unknown as typeof import('node:fs').readFileSync }));

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();

  real.readFileSync = actual.readFileSync;

  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const { RACY_MS, readCached, writeIfChanged } = await import('../src/fs.js');
const { tempHome } = await import('./helpers.js');

let home: string;
let dispose: () => void;
let path: string;
let clock: MockInstance<() => number>;

beforeEach(() => {
  ({ home, dispose } = tempHome());
  path = `${home}/store.json`;
  vi.mocked(fs.readFileSync).mockClear();
  clock = vi.spyOn(Date, 'now');
});

afterEach(() => {
  clock.mockRestore();
  dispose();
});

/** The newer of the file's modified and change times, which is where the racy window starts. */
const changedAt = (): number => {
  const stats = statSync(path);

  return Math.floor(Math.max(stats.mtimeMs, stats.ctimeMs));
};

/** Put the hub's clock `ms` past the file's last change. */
const after = (ms: number): void => {
  clock.mockReturnValue(changedAt() + ms);
};

/** Write `text`, date it a minute back, and put the clock past the racy window that the change time `utimes` sets starts. */
function settled(text: string, at = new Date(Date.now() - 60_000)): void {
  writeFileSync(path, text);
  utimesSync(path, at, at);
  after(RACY_MS + 1);
}

const reads = (): number => vi.mocked(fs.readFileSync).mock.calls.filter(([file]) => file === path).length;

describe('readCached', () => {
  it('opens an unchanged file once', () => {
    settled('{"a":1}');

    expect(readCached(path)).toBe('{"a":1}');
    expect(readCached(path)).toBe('{"a":1}');
    expect(readCached(path)).toBe('{"a":1}');
    expect(reads()).toBe(1);
  });

  it('reads a file again once it changes', () => {
    settled('{"a":1}');
    readCached(path);
    settled('{"a":12}');

    expect(readCached(path)).toBe('{"a":12}');
    expect(reads()).toBe(2);
  });

  // The modified time and size match; the change time, which `utimes` cannot set back, shows the rewrite.
  it('reads a same-size rewrite again though its modified time is put back', () => {
    const at = new Date(Date.now() - 60_000);

    settled('{"a":1}', at);
    readCached(path);
    // Past NTFS's 1 ms change-time step, which `RACY_MS` covers outside a test whose clock is moved.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    settled('{"a":2}', at);

    expect(readCached(path)).toBe('{"a":2}');
  });

  it('reads a file changed within the racy window again on every access, and keeps it once the window has passed', () => {
    writeFileSync(path, '{"a":1}');
    after(RACY_MS);

    expect(readCached(path)).toBe('{"a":1}');
    expect(readCached(path)).toBe('{"a":1}');
    expect(reads()).toBe(2);

    after(RACY_MS + 1);
    readCached(path);
    readCached(path);

    expect(reads()).toBe(3);
  });

  it('measures the window from before the read, so a slow read does not age a fresh file', () => {
    writeFileSync(path, '{"a":1}');
    const at = changedAt();

    clock.mockReturnValue(at + RACY_MS);
    vi.mocked(fs.readFileSync).mockImplementationOnce((...args: Parameters<typeof fs.readFileSync>) => {
      clock.mockReturnValue(at + RACY_MS * 10);

      return real.readFileSync(...args);
    });
    readCached(path);
    readCached(path);

    expect(reads()).toBe(2);
  });

  it('answers null for a missing file, and the text once it appears', () => {
    expect(readCached(path)).toBeNull();

    settled('{"a":1}');

    expect(readCached(path)).toBe('{"a":1}');

    rmSync(path);

    expect(readCached(path)).toBeNull();
  });

  it('gives the text writeIfChanged wrote', () => {
    settled('{"a":1}');
    readCached(path);

    expect(writeIfChanged(path, '{"a":2}')).toBe(true);
    expect(readCached(path)).toBe('{"a":2}');
    expect(writeIfChanged(path, '{"a":2}')).toBe(false);
  });
});
