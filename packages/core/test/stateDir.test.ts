import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATION_STALE_MS, formatStatePointer, parseStatePointer, readPointerFromDisk, resolveStateDir, statePointerPathOf } from '../src/stateDir.js';

const HOME = 'C:\\Users\\dev';
const BOOTSTRAP = 'C:/Users/dev/.claude/ground-control';
const NOW = Date.parse('2026-09-09T12:00:00.000Z');

function reader(text: string | null) {
  return (path: string) => (path === statePointerPathOf(HOME) ? text : null);
}

describe('the state pointer', () => {
  it('lives in the bootstrap directory', () => {
    expect(statePointerPathOf(HOME)).toBe(`${BOOTSTRAP}/state-dir.json`);
  });

  it('resolves to the bootstrap directory when there is no pointer', () => {
    expect(resolveStateDir(HOME, reader(null), NOW)).toEqual({ stateDir: BOOTSTRAP, migratingTo: null, interruptedTo: null, problem: null });
  });

  it('collapses dot segments so a pointer cannot name a directory by a roundabout path', () => {
    expect(resolveStateDir(HOME, reader('{"stateDir":"E:/other/../gc/./runs"}'), NOW).stateDir).toBe('E:/gc/runs');
  });

  it('follows a pointer and normalizes its separators and trailing slash', () => {
    expect(resolveStateDir(HOME, reader('{"stateDir":"E:\\\\state\\\\gc\\\\"}'), NOW).stateDir).toBe('E:/state/gc');
    expect(resolveStateDir('/home/dev', (path) => (path === '/home/dev/.claude/ground-control/state-dir.json' ? '{"stateDir":"/srv/gc/"}' : null), NOW).stateDir).toBe('/srv/gc');
  });

  it.each([
    ['not JSON', '{ not json', 'state-dir.json is not JSON.'],
    ['a relative path', '{"stateDir":"relative/state"}', 'state-dir.json is not a usable state pointer.'],
    ['surrounding whitespace', '{"stateDir":" E:/state "}', 'state-dir.json is not a usable state pointer.'],
    ['an empty path', '{"stateDir":""}', 'state-dir.json is not a usable state pointer.'],
    ['a missing field', '{"dir":"E:/state"}', 'state-dir.json is not a usable state pointer.'],
  ])('ignores a pointer with %s and says why', (_case, text, problem) => {
    expect(resolveStateDir(HOME, reader(text), NOW)).toEqual({ stateDir: BOOTSTRAP, migratingTo: null, interruptedTo: null, problem });
  });

  it('reports an existing but unreadable pointer instead of treating the bootstrap directory as current', () => {
    const unreadable = (path: string) => (path === statePointerPathOf(HOME) ? { unreadable: 'EACCES: permission denied' } : null);

    expect(resolveStateDir(HOME, unreadable, NOW)).toEqual({ stateDir: BOOTSTRAP, migratingTo: null, interruptedTo: null, problem: 'state-dir.json exists but cannot be read: EACCES: permission denied' });
  });

  it('reads a pointer from disk, telling a missing file from a directory in its place', () => {
    const home = mkdtempSync(join(tmpdir(), 'gc-pointer-'));

    expect(readPointerFromDisk(statePointerPathOf(home))).toBeNull();

    mkdirSync(statePointerPathOf(home), { recursive: true });
    expect(readPointerFromDisk(statePointerPathOf(home))).toMatchObject({ unreadable: expect.stringContaining('EISDIR') });
    expect(resolveStateDir(home, undefined, NOW).problem).toContain('exists but cannot be read');

    rmSync(home, { recursive: true, force: true });
  });

  it('reports a fresh migration as in progress and a stale one as interrupted', () => {
    const fresh = formatStatePointer({ stateDir: 'E:/old', migration: { to: 'E:/new', startedAt: new Date(NOW - 1000).toISOString() } });
    const stale = formatStatePointer({ stateDir: 'E:/old', migration: { to: 'E:/new', startedAt: new Date(NOW - MIGRATION_STALE_MS - 1).toISOString() } });

    expect(resolveStateDir(HOME, reader(fresh), NOW)).toEqual({ stateDir: 'E:/old', migratingTo: 'E:/new', interruptedTo: null, problem: null });
    expect(resolveStateDir(HOME, reader(stale), NOW)).toEqual({ stateDir: 'E:/old', migratingTo: null, interruptedTo: 'E:/new', problem: null });
  });

  it('treats an unparseable migration start as interrupted rather than blocking hubs forever', () => {
    const text = formatStatePointer({ stateDir: 'E:/old', migration: { to: 'E:/new', startedAt: 'never' } });

    expect(resolveStateDir(HOME, reader(text), NOW).interruptedTo).toBe('E:/new');
  });

  it('round trips through its writer', () => {
    const pointer = { stateDir: 'E:/state', migration: { to: 'F:/next', startedAt: '2026-09-09T12:00:00.000Z' } };

    expect(parseStatePointer(formatStatePointer(pointer))).toEqual(pointer);
    expect(formatStatePointer({ stateDir: 'E:/state' })).toBe('{\n  "stateDir": "E:/state"\n}\n');
  });
});
