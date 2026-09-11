import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { HistoricalSession, RetainedActivity, Session } from '@ground-control/core';
import { makeStatusStore, pruned, retaining, statusKeyOf } from '../src/statusStore.js';
import { statusPathOf } from '../src/paths.js';
import { tempHome } from './helpers.js';

let home: string;
let dispose: () => void;

beforeEach(() => {
  ({ home, dispose } = tempHome());
});

afterEach(() => dispose());

const WAITING: RetainedActivity = { phase: 'waiting', event: 'PreToolUse', at: 5_000 };
const FAILED: RetainedActivity = { phase: 'failed', event: 'StopFailure', at: 5_000, error: { kind: 'rate_limit', message: 'resets 12:10pm' } };

function session(over: Partial<Session> = {}): Session {
  return {
    agent: 'claude',
    sessionId: 'a-session',
    pid: 4242,
    title: null,
    cwd: '/work/42-test',
    checkoutRoot: '/work/42-test',
    startedAt: 1_000,
    branch: '42-test',
    repository: 'github.com/org/repo',
    issueNumber: 42,
    transcriptWrittenAt: null,
    activity: null,
    finished: false,
    attachId: null,
    details: {},
    ...over,
  };
}

function saved(over: Partial<HistoricalSession> = {}): HistoricalSession {
  return {
    agent: 'claude',
    sessionId: 'a-session',
    title: null,
    cwd: '/work/42-test',
    branch: '42-test',
    issueNumber: 42,
    repository: 'github.com/org/repo',
    updatedAt: 5_000,
    ...over,
  };
}

describe('the status store', () => {
  it('returns empty state before any phase is recorded', () => {
    expect(makeStatusStore(home).read()).toEqual(new Map());
  });

  it('round trips a reading, so a hub that restarts still has it', () => {
    makeStatusStore(home).write(new Map([['claude:a-session', WAITING]]));

    expect(makeStatusStore(home).read()).toEqual(new Map([['claude:a-session', WAITING]]));
  });

  it('round trips a failure with the error it carries, and reads one saved without an error', () => {
    makeStatusStore(home).write(new Map([['claude:a-session', FAILED], ['codex:b-session', { phase: 'failed', event: 'task_complete', at: 6_000 }]]));

    const read = makeStatusStore(home).read();

    expect(read.get('claude:a-session')).toEqual(FAILED);
    expect(read.get('codex:b-session')).toEqual({ phase: 'failed', event: 'task_complete', at: 6_000 });
    expect(read.get('codex:b-session')).not.toHaveProperty('error');
  });

  it('returns empty state for invalid JSON', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(statusPathOf(home), '{ not json');

    expect(makeStatusStore(home).read()).toEqual(new Map());
  });

  /** Reject invalid stored phase data without guessing a replacement (R24). */
  it('rejects unknown phases', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(statusPathOf(home), JSON.stringify({ entries: { 'claude:a-session': { phase: 'thinking', event: 'Stop', at: 1 } } }));

    expect(makeStatusStore(home).read()).toEqual(new Map());
  });
});

describe('what a roster read retains', () => {
  it('records the phase of a live session, keyed by the agent that reported it', () => {
    const live = session({ activity: { phase: 'waiting', since: 5_000, at: 5_000, event: 'PreToolUse' } });

    expect(retaining(new Map(), [live])).toEqual(new Map([['claude:a-session', WAITING]]));
    expect(statusKeyOf(live)).toBe('claude:a-session');
  });

  it('keeps the error a failed reading carries', () => {
    const live = session({ activity: { phase: 'failed', since: 5_000, at: 5_000, event: 'StopFailure', error: FAILED.error! } });

    expect(retaining(new Map(), [live]).get('claude:a-session')).toEqual(FAILED);
  });

  /** Compare archive times against event timestamps, not turn start times. */
  it('uses event time rather than turn start for retained activity', () => {
    const live = session({ activity: { phase: 'running', since: 1_000, at: 6_000, event: 'PostToolBatch' } });

    expect(retaining(new Map(), [live]).get('claude:a-session')).toEqual({ phase: 'running', event: 'PostToolBatch', at: 6_000 });
  });

  it('keeps what it held for a session the read did not list, which is the absence it exists for', () => {
    expect(retaining(new Map([['claude:a-session', WAITING]]), [])).toEqual(new Map([['claude:a-session', WAITING]]));
  });

  /** Do not rewrite retained state on every tool batch within one turn. */
  it('leaves a phase it already holds alone while the same stretch of work reports it again', () => {
    const held = new Map([['claude:a-session', { phase: 'running' as const, event: 'UserPromptSubmit', at: 6_000 }]]);
    const later = session({ activity: { phase: 'running', since: 6_000, at: 30_000, event: 'PostToolBatch' } });

    expect(retaining(held, [later]).get('claude:a-session')).toEqual({ phase: 'running', event: 'UserPromptSubmit', at: 6_000 });
  });

  /** Update the timestamp for new input requests so an intervening archive does not invalidate current activity. */
  it('dates the same phase again when it belongs to a later stretch of work', () => {
    const held = new Map([['claude:a-session', { phase: 'waiting' as const, event: 'Notification', at: 6_000 }]]);
    const asked = session({ activity: { phase: 'waiting', since: 40_000, at: 40_000, event: 'Notification' } });

    expect(retaining(held, [asked]).get('claude:a-session')?.at).toBe(40_000);
  });

  it('replaces a held reading with the live one', () => {
    const live = session({ activity: { phase: 'idle', since: 9_000, at: 9_000, event: 'Stop' } });

    expect(retaining(new Map([['claude:a-session', WAITING]]), [live]).get('claude:a-session')).toEqual({
      phase: 'idle',
      event: 'Stop',
      at: 9_000,
    });
  });

  /** Do not retain phases for explicitly finished sessions (R6). */
  it('excludes explicitly finished sessions', () => {
    const done = session({ finished: true, activity: { phase: 'waiting', since: 5_000, at: 5_000, event: 'PreToolUse' } });

    expect(retaining(new Map(), [done])).toEqual(new Map());
  });

  /** Remove prior observations for finished sessions so roster removal cannot restore attention (R6). */
  it('takes away the reading it held once the agent calls that session finished', () => {
    const done = session({ finished: true, activity: { phase: 'waiting', since: 5_000, at: 5_000, event: 'PreToolUse' } });

    expect(retaining(new Map([['claude:a-session', WAITING]]), [done])).toEqual(new Map());
  });

  it('excludes sessions without activity', () => {
    expect(retaining(new Map(), [session()])).toEqual(new Map());
  });
});

describe('what a clean pair of reads prunes', () => {
  it('retains observations present in the roster or history', () => {
    const held = new Map([
      ['claude:live', WAITING],
      ['claude:a-session', WAITING],
    ]);

    expect([...pruned(held, [session({ sessionId: 'live' })], [saved()]).keys()]).toEqual(['claude:live', 'claude:a-session']);
  });

  it('drops a reading whose session is in neither, which is a transcript that has gone', () => {
    expect(pruned(new Map([['claude:a-session', WAITING]]), [], [saved({ sessionId: 'another' })])).toEqual(new Map());
  });

  /** Two CLIs can mint the same id, so a Codex session of the same name must not keep a Claude reading alive. */
  it('drops a reading whose id survives under another agent', () => {
    expect(pruned(new Map([['claude:a-session', WAITING]]), [], [saved({ agent: 'codex' })])).toEqual(new Map());
  });
});
