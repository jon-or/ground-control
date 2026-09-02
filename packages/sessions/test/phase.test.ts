import { describe, expect, it } from 'vitest';
import { phaseOf, readActivity, unreportedSessions } from '../src/phase.js';
import type { ActivityMarker } from '../src/phase.js';
import { markerPathOf } from '../src/hookScript.js';
import type { Session } from '../src/types.js';
import { HOME } from './helpers.js';

const SESSION = 'a1b2c3d4-0000-4000-8000-000000000000';

/** A marker is the board's own shape, written by the board's own hook, so a case is built rather than recorded. */
function marker(over: Partial<ActivityMarker> = {}): ActivityMarker {
  return {
    v: 1,
    sessionId: SESSION,
    event: 'UserPromptSubmit',
    at: 1_788_000_000_000,
    notificationType: null,
    source: null,
    toolName: null,
    reason: null,
    backgroundTasks: 0,
    ...over,
  };
}

describe('phaseOf', () => {
  it.each(['UserPromptSubmit', 'PostToolBatch', 'PermissionDenied'])('reads %s as running', (event) => {
    expect(phaseOf(marker({ event }))).toBe('running');
  });

  it('reads a permission request as waiting on the developer', () => {
    expect(phaseOf(marker({ event: 'PermissionRequest', toolName: 'Bash' }))).toBe('waiting');
  });

  it('reads an MCP elicitation as waiting', () => {
    expect(phaseOf(marker({ event: 'Elicitation' }))).toBe('waiting');
  });

  it.each(['AskUserQuestion', 'ExitPlanMode'])('reads a %s call as waiting', (toolName) => {
    expect(phaseOf(marker({ event: 'PreToolUse', toolName }))).toBe('waiting');
  });

  it('claims nothing for a tool call that is not a human gate', () => {
    expect(phaseOf(marker({ event: 'PreToolUse', toolName: 'Bash' }))).toBeNull();
  });

  it('claims nothing for a PreToolUse carrying no tool name', () => {
    expect(phaseOf(marker({ event: 'PreToolUse' }))).toBeNull();
  });

  // Notification is not "the agent needs you": the same event carries agent_completed and idle_prompt, so mapping
  // the event wholesale would paint a finished session as needing attention.
  it.each(['permission_prompt', 'worker_permission_prompt', 'agent_needs_input'])(
    'reads a %s notification as waiting',
    (notificationType) => {
      expect(phaseOf(marker({ event: 'Notification', notificationType }))).toBe('waiting');
    },
  );

  it('reads an agent_completed notification as idle', () => {
    expect(phaseOf(marker({ event: 'Notification', notificationType: 'agent_completed' }))).toBe('idle');
  });

  // The 60-second nag fires at a session that is already idle; treating it as waiting would invent a decision.
  it.each(['idle_prompt', 'auth_success', 'push_notification', null])(
    'claims nothing for a %s notification',
    (notificationType) => {
      expect(phaseOf(marker({ event: 'Notification', notificationType }))).toBeNull();
    },
  );

  it('reads a stop with background work still in flight as running', () => {
    expect(phaseOf(marker({ event: 'Stop', backgroundTasks: 2 }))).toBe('running');
  });

  it('reads a stop with nothing in flight as idle', () => {
    expect(phaseOf(marker({ event: 'Stop', backgroundTasks: 0 }))).toBe('idle');
  });

  it('claims nothing for an event it has never seen', () => {
    expect(phaseOf(marker({ event: 'PreModelSwitch' }))).toBeNull();
    expect(phaseOf(marker({ event: null }))).toBeNull();
  });
});

describe('readActivity', () => {
  const at = 1_788_000_000_000;
  const path = markerPathOf(HOME, SESSION);

  const reads = (value: unknown, now = at + 1): ReturnType<typeof readActivity> =>
    readActivity(HOME, SESSION, (p) => (p === path ? JSON.stringify(value) : null), now);

  it('reads the phase and the time the hook observed it', () => {
    expect(reads(marker({ event: 'PostToolBatch', at }))).toEqual({
      phase: 'running',
      at,
      event: 'PostToolBatch',
    });
  });

  it('reports nothing when the session has no marker', () => {
    expect(readActivity(HOME, SESSION, () => null)).toBeNull();
  });

  it('reports nothing for a marker that is not JSON', () => {
    expect(readActivity(HOME, SESSION, () => '{ not json', at)).toBeNull();
  });

  it('reports nothing for a marker missing the fields the board reads', () => {
    expect(reads({ sessionId: SESSION, event: 'Stop' })).toBeNull();
  });

  // A forked transcript reuses records under a new id, so a marker naming a different session is not this one's.
  it('reports nothing for a marker that disagrees with its own file name', () => {
    expect(reads(marker({ sessionId: 'someone-else' }))).toBeNull();
  });

  it('reports nothing for a marker written by a clock the board cannot trust', () => {
    expect(reads(marker({ at: at + 3_600_000 }), at)).toBeNull();
  });

  it('tolerates a marker a little ahead of the reader, which two clocks routinely are', () => {
    expect(reads(marker({ at: at + 30_000 }), at)?.phase).toBe('running');
  });

  // Two extension versions share one `~/.claude`, so a marker whose field set was redefined is not this one's.
  it('reports nothing for a marker written to a different version of the format', () => {
    expect(reads({ ...marker(), v: 2 })).toBeNull();
  });

  it('reports nothing for a marker whose event the board maps to no phase', () => {
    expect(reads(marker({ event: 'Notification', notificationType: 'idle_prompt' }))).toBeNull();
  });
});

describe('unreportedSessions', () => {
  /** Whole, not cast: a partial literal would go on compiling the day `Session` grows a field. */
  const base: Session = {
    agent: 'claude',
    sessionId: SESSION,
    shortId: null,
    name: null,
    title: null,
    cwd: '/nowhere/checkout',
    kind: 'interactive',
    startedAt: 0,
    status: null,
    state: null,
    branch: null,
    issueNumber: null,
    transcriptWrittenAt: null,
    activity: null,
  };

  const session = (over: Partial<Session>): Session => ({ ...base, ...over });

  it('counts the sessions that were already running when the hooks were installed', () => {
    const sessions = [
      session({ startedAt: 10 }),
      session({ startedAt: 30 }),
      session({ startedAt: 10, activity: { phase: 'running', at: 40, event: 'Stop' } }),
    ];

    expect(unreportedSessions(sessions, 20)).toBe(1);
  });

  it('counts nothing once every session reports', () => {
    expect(unreportedSessions([session({ activity: { phase: 'idle', at: 1, event: 'Stop' } })], 20)).toBe(0);
  });
});
