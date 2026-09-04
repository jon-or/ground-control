import { describe, expect, it } from 'vitest';
import { rosterIsStale, sessionLabel, unreportedSessions } from '../src/roster.js';
import type { Session } from '../src/types.js';

const SESSION = 'a1b2c3d4-0000-4000-8000-000000000000';

describe('rosterIsStale', () => {
  const known = new Set([SESSION]);
  const reports = (): boolean => true;

  it('needs the CLI when a marker was removed', () => {
    expect(rosterIsStale([{ kind: 'deleted', sessionId: SESSION }], known, reports)).toBe(true);
  });

  // A rename over a path the watcher has seen before is a create on one platform and a change on another, so an
  // unlisted session counts whichever kind it arrives as.
  it.each(['created', 'changed'] as const)('needs the CLI for a %s marker on a session it has not listed', (kind) => {
    expect(rosterIsStale([{ kind, sessionId: 'brand-new' }], known, reports)).toBe(true);
  });

  // The board would filter that session out of the list it came back in, so the spawn buys nothing (R2).
  it('does not read the CLI for an unlisted session whose marker claims no phase', () => {
    expect(rosterIsStale([{ kind: 'created', sessionId: 'brand-new' }], known, () => false)).toBe(false);
  });

  it.each(['created', 'changed'] as const)('does not read the CLI for a %s marker on a listed session', (kind) => {
    expect(rosterIsStale([{ kind, sessionId: SESSION }], known, reports)).toBe(false);
  });

  it('needs the CLI when one change in a turn boundary batch moved the list', () => {
    const changes = [
      { kind: 'changed', sessionId: SESSION },
      { kind: 'deleted', sessionId: 'other' },
    ] as const;

    expect(rosterIsStale(changes, known, reports)).toBe(true);
  });

  it('claims nothing to do for an empty batch', () => {
    expect(rosterIsStale([], known, reports)).toBe(false);
  });
});

/** Whole, not cast: a partial literal would go on compiling the day `Session` grows a field. */
const base: Session = {
  agent: 'claude',
  sessionId: SESSION,
  pid: 4242,
  title: null,
  cwd: '/nowhere/checkout',
  startedAt: 0,
  branch: null,
  issueNumber: null,
  transcriptWrittenAt: null,
  activity: null,
  finished: false,
  details: {},
};

const session = (over: Partial<Session>): Session => ({ ...base, ...over });

/**
 * The ladder, as literal strings. Both boards draw it from a copy they cannot import — `media/board.js` and the
 * Chrome overlay are plain scripts — so the same table is asserted in each of their suites. Change one, change all.
 */
const LADDER: [string, Partial<Session>, string][] = [
  ['the title derived from the first prompt', { title: 'Fix the lane divider' }, 'Fix the lane divider'],
  ['what the CLI called it', { details: { name: 'plucky-otter' } }, 'plucky-otter'],
  ['the short id', { details: { shortId: 'a1b2c3d4' } }, 'a1b2c3d4'],
  ['the directory it is working in', { cwd: 'd:/git/orez' }, 'orez'],
  ['the directory, past a trailing separator', { cwd: 'd:/git/orez/' }, 'orez'],
  ['the directory a Windows CLI reported', { cwd: 'D:\\git\\orez' }, 'orez'],
  ['the directory, past a trailing Windows separator', { cwd: 'D:\\git\\orez\\' }, 'orez'],
];

describe('sessionLabel', () => {
  it.each(LADDER)('names a session by %s', (_rung, over, expected) => {
    expect(sessionLabel(session(over))).toBe(expected);
  });

  it('prefers the title over everything the CLI reported', () => {
    expect(sessionLabel(session({ title: 'Fix the lane divider', details: { name: 'plucky-otter', shortId: 'a1b2c3d4' } }))).toBe(
      'Fix the lane divider',
    );
  });

  it('prefers the CLI name over its short id', () => {
    expect(sessionLabel(session({ details: { name: 'plucky-otter', shortId: 'a1b2c3d4' } }))).toBe('plucky-otter');
  });
});

describe('unreportedSessions', () => {
  it('counts the sessions that were already running when the hooks were installed', () => {
    const sessions = [
      session({ startedAt: 10 }),
      session({ startedAt: 30 }),
      session({ startedAt: 10, activity: { phase: 'running', since: 40, event: 'Stop' } }),
    ];

    expect(unreportedSessions(sessions, 20)).toBe(1);
  });

  it('counts nothing once every session reports', () => {
    expect(unreportedSessions([session({ activity: { phase: 'idle', since: 1, event: 'Stop' } })], 20)).toBe(0);
  });
});
