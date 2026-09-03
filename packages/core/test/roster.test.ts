import { describe, expect, it } from 'vitest';
import { rosterIsStale, unreportedSessions } from '../src/roster.js';
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

describe('unreportedSessions', () => {
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
