import { describe, expect, it } from 'vitest';
import { agentOfSession, rosterIsStale, sessionLabel, unreportedSessions } from '../src/roster.js';
import type { Session } from '../src/types.js';

const SESSION = 'a1b2c3d4-0000-4000-8000-000000000000';

describe('rosterIsStale', () => {
  const known = new Set([SESSION]);
  const reports = (): boolean => true;

  it('needs the CLI when a marker was removed', () => {
    expect(rosterIsStale([{ kind: 'deleted', sessionId: SESSION }], known, reports)).toBe(true);
  });

  // Watcher create/change events vary across platforms; either may identify a new session.
  it.each(['created', 'changed'] as const)('needs the CLI for a %s marker on a session it has not listed', (kind) => {
    expect(rosterIsStale([{ kind, sessionId: 'brand-new' }], known, reports)).toBe(true);
  });

  // An unprompted session without a phase would be filtered from the roster (R2).
  it('skips roster reads for unknown sessions without phase evidence', () => {
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

  it('skips roster reads for empty marker batches', () => {
    expect(rosterIsStale([], known, reports)).toBe(false);
  });
});

/** Use complete Session objects so type changes fail compilation. */
const base: Session = {
  agent: 'claude',
  sessionId: SESSION,
  pid: 4242,
  title: null,
  cwd: '/nowhere/checkout',
  checkoutRoot: null,
  startedAt: 0,
  branch: null,
  repository: null,
  issueNumber: null,
  transcriptWrittenAt: null,
  activity: null,
  finished: false,
  attachId: null,
  details: {},
};

const session = (over: Partial<Session>): Session => ({ ...base, ...over });

/** Keep the same literal session-label table in core and both client suites. */
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
      session({ startedAt: 10, activity: { phase: 'running', since: 40, at: 40, event: 'Stop' } }),
    ];

    expect(unreportedSessions(sessions, 20)).toBe(1);
  });

  it('counts nothing once every session reports', () => {
    expect(unreportedSessions([session({ activity: { phase: 'idle', since: 1, at: 1, event: 'Stop' } })], 20)).toBe(0);
  });
});

describe('which agent reported a session', () => {
  const session = (agent: string, sessionId: string) => ({ agent, sessionId }) as never;
  const snapshot = (cards: unknown[]): never => ({ lanes: [{ id: 'build', cards }] }) as never;

  it('reads it off a live session on a card', () => {
    expect(agentOfSession(snapshot([{ sessions: [session('codex', 'a'), session('claude', 'b')] }]), 'a')).toBe('codex');
    expect(agentOfSession(snapshot([{ sessions: [session('codex', 'a'), session('claude', 'b')] }]), 'b')).toBe('claude');
  });

  it('reads it off the saved session a card carries when no live one matches', () => {
    expect(agentOfSession(snapshot([{ sessions: [], lastSession: session('codex', 'c') }]), 'c')).toBe('codex');
  });

  it('answers Claude for an id the snapshot does not carry, which is the only answer available', () => {
    // A session id says nothing about which CLI produced it, and the hub refuses one it does not know anyway.
    expect(agentOfSession(snapshot([{ sessions: [session('codex', 'a')] }]), 'unknown')).toBe('claude');
    expect(agentOfSession(undefined, 'a')).toBe('claude');
  });

  it('looks past a card that carries neither', () => {
    expect(agentOfSession(snapshot([{ sessions: [] }, { sessions: [session('codex', 'a')] }]), 'a')).toBe('codex');
  });
});
