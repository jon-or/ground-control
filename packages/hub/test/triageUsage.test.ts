import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { groundControlDirOf } from '@ground-control/core';
import { afterEach, describe, expect, it } from 'vitest';
import { TriageUsage } from '../src/triageUsage.js';
import { tempHome } from './helpers.js';

const homes: (() => void)[] = [];

afterEach(() => {
  while (homes.length) homes.pop()?.();
});

function usage() {
  const made = tempHome();
  homes.push(made.dispose);
  const directory = groundControlDirOf(made.home);
  mkdirSync(directory, { recursive: true });

  return {
    home: made.home,
    path: join(directory, 'triage-usage.json'),
    store: new TriageUsage(made.home),
  };
}

describe('automatic triage usage', () => {
  it('reserves against persisted attempts after a restart', () => {
    const { home, store } = usage();
    expect(store.read(1000)).toEqual([]);
    expect(store.reserve(1000, 2)).toBe('reserved');

    const restarted = new TriageUsage(home);
    expect(restarted.read(2000)).toEqual([1000]);
    expect(restarted.reserve(2000, 2)).toBe('reserved');
    expect(restarted.reserve(3000, 2)).toBe('exhausted');
    expect(new TriageUsage(home).read(3000)).toEqual([1000, 2000]);
  });

  it('releases an attempt exactly 24 hours after it was reserved', () => {
    const { store } = usage();
    expect(store.reserve(1000, 1)).toBe('reserved');
    expect(store.reserve(86_400_999, 1)).toBe('exhausted');
    expect(store.reserve(86_401_000, 1)).toBe('reserved');
    expect(store.read(86_401_000)).toEqual([86_401_000]);
  });

  it('retains future attempts after the clock moves backward', () => {
    const { store } = usage();
    expect(store.reserve(2000, 1)).toBe('reserved');
    expect(store.read(1000)).toEqual([2000]);
    expect(store.reserve(1000, 1)).toBe('exhausted');
  });

  it('refuses automatic attempts when the limit is zero', () => {
    const { store } = usage();
    expect(store.reserve(1000, 0)).toBe('exhausted');
    expect(store.read(1000)).toEqual([]);
  });

  it.each([
    ['truncated JSON', '[1000'],
    ['non-array data', '{}'],
    ['null data', 'null'],
    ['text timestamp', '["1000"]'],
    ['null timestamp', '[null]'],
    ['nonfinite timestamp', '[1e999]'],
    ['negative timestamp', '[-1]'],
    ['invalid entry among valid attempts', '[1000,-1]'],
  ])('refuses %s without resetting stored usage', (_name, contents) => {
    const { path, store } = usage();
    writeFileSync(path, contents);

    expect(store.read(2000)).toBeNull();
    expect(store.reserve(2000, 10)).toBe('unavailable');
    expect(readFileSync(path, 'utf8')).toBe(contents);
  });

  it('refuses usage that cannot be read', () => {
    const { path, store } = usage();
    mkdirSync(path);

    expect(store.read(1000)).toBeNull();
    expect(store.reserve(1000, 10)).toBe('unavailable');
  });

  it('refuses a reservation that cannot be saved and preserves prior usage', () => {
    const { home, path, store } = usage();
    expect(store.reserve(1000, 2)).toBe('reserved');
    // A directory at the atomic writer's temporary path prevents file creation on every platform.
    mkdirSync(`${path}.${process.pid}.tmp`);

    expect(store.reserve(2000, 2)).toBe('unavailable');
    expect(new TriageUsage(home).read(2000)).toEqual([1000]);
  });
});
