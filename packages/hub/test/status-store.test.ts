import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { groundControlDirOf } from '@ground-control/core';
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
  it('reads nothing on a machine where no session has ever reported a phase', () => {
    expect(makeStatusStore(home).read()).toEqual(new Map());
  });

  it('round trips a reading, so a hub that restarts still has it', () => {
    makeStatusStore(home).write(new Map([['claude:a-session', WAITING]]));

    expect(makeStatusStore(home).read()).toEqual(new Map([['claude:a-session', WAITING]]));
  });

  it('reads nothing from a file the developer has broken, rather than throwing on every render', () => {
    mkdirSync(groundControlDirOf(home), { recursive: true });
    writeFileSync(statusPathOf(home), '{ not json');

    expect(makeStatusStore(home).read()).toEqual(new Map());
  });

  /** One entry the wrong shape is the whole file refused: a phase this build cannot read is not one it may guess at (R24). */
  it('reads nothing from an entry whose phase is not one the board knows', () => {
    mkdirSync(groundControlDirOf(home), { recursive: true });
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

  /** The reading is dated by the event, not by the turn the duration counts from — that is what the archive line is compared against. */
  it('dates a running reading by its own event rather than by the turn it belongs to', () => {
    const live = session({ activity: { phase: 'running', since: 1_000, at: 6_000, event: 'PostToolBatch' } });

    expect(retaining(new Map(), [live]).get('claude:a-session')).toEqual({ phase: 'running', event: 'PostToolBatch', at: 6_000 });
  });

  it('keeps what it held for a session the read did not list, which is the absence it exists for', () => {
    expect(retaining(new Map([['claude:a-session', WAITING]]), [])).toEqual(new Map([['claude:a-session', WAITING]]));
  });

  /** `PostToolBatch` lands on every tool batch, so a reading restamped on each one would rewrite the file through a whole running turn. */
  it('leaves a phase it already holds alone while the same stretch of work reports it again', () => {
    const held = new Map([['claude:a-session', { phase: 'running' as const, event: 'UserPromptSubmit', at: 6_000 }]]);
    const later = session({ activity: { phase: 'running', since: 6_000, at: 30_000, event: 'PostToolBatch' } });

    expect(retaining(held, [later]).get('claude:a-session')).toEqual({ phase: 'running', event: 'UserPromptSubmit', at: 6_000 });
  });

  /** Its new question would otherwise be dated by the old one, and a card's departure between the two would end a reading still standing. */
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

  /** R6 claims no mark for a session the agent itself called finished, so retaining its phase would put one back once the CLI stopped listing it. */
  it('records nothing for a session the agent has called finished', () => {
    const done = session({ finished: true, activity: { phase: 'waiting', since: 5_000, at: 5_000, event: 'PreToolUse' } });

    expect(retaining(new Map(), [done])).toEqual(new Map());
  });

  /** Held, the reading would reach the card as a mark the moment the CLI stopped listing the session, which is the one thing R6 refuses. */
  it('takes away the reading it held once the agent calls that session finished', () => {
    const done = session({ finished: true, activity: { phase: 'waiting', since: 5_000, at: 5_000, event: 'PreToolUse' } });

    expect(retaining(new Map([['claude:a-session', WAITING]]), [done])).toEqual(new Map());
  });

  it('records nothing for a session that reported no phase', () => {
    expect(retaining(new Map(), [session()])).toEqual(new Map());
  });
});

describe('what a clean pair of reads prunes', () => {
  it('keeps a reading whose session is still live, and one whose transcript history still holds it', () => {
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
