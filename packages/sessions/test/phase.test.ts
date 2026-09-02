import { describe, expect, it } from 'vitest';
import { phaseOf, readActivity, rosterIsStale, unreportedSessions } from '../src/phase.js';
import type { ActivityMarker } from '../src/phase.js';
import { HOOK_MARKER_VERSION, markerPathOf } from '../src/hookScript.js';
import type { Session } from '../src/types.js';
import { HOME } from './helpers.js';

const SESSION = 'a1b2c3d4-0000-4000-8000-000000000000';

/** A marker is the board's own shape, written by the board's own hook, so a case is built rather than recorded. */
function marker(over: Partial<ActivityMarker> = {}): ActivityMarker {
  return {
    v: HOOK_MARKER_VERSION,
    sessionId: SESSION,
    event: 'UserPromptSubmit',
    at: 1_788_000_000_000,
    turnAt: null,
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

  // Compaction fires SessionStart mid-turn on a working session, so the one source that must not blank the card is
  // the one that arrives while it is busy.
  it('reads a compaction as running', () => {
    expect(phaseOf(marker({ event: 'SessionStart', source: 'compact' }))).toBe('running');
  });

  it.each(['startup', 'resume', 'clear', 'fork'])('claims nothing for a %s session start', (source) => {
    expect(phaseOf(marker({ event: 'SessionStart', source }))).toBeNull();
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
      since: at,
      event: 'PostToolBatch',
    });
  });

  // A heartbeat lands on every tool batch, so an event-time anchor holds a busy card's duration at zero all turn.
  it('counts a running session from the turn it is in, not from the heartbeat that reported it', () => {
    expect(reads(marker({ event: 'PostToolBatch', at, turnAt: at - 600_000 }))?.since).toBe(at - 600_000);
  });

  it.each([
    ['waiting', 'PermissionRequest'],
    ['idle', 'Stop'],
  ])('counts a %s session from the event that reported it', (phase, event) => {
    const activity = reads(marker({ event, at, turnAt: at - 600_000 }));

    expect(activity?.phase).toBe(phase);
    expect(activity?.since).toBe(at);
  });

  it('counts from the event when no turn is in flight', () => {
    expect(reads(marker({ event: 'PostToolBatch', at, turnAt: null }))?.since).toBe(at);
  });

  // An older extension's marker carries no turn at all, and a session losing its phase over an added field is a card
  // that goes blank on an upgrade until the developer prompts it.
  it('keeps the phase of a marker written before the turn was recorded, and counts from the event', () => {
    const older = { ...marker({ event: 'PostToolBatch', at }) } as Record<string, unknown>;

    delete older.turnAt;

    expect(reads(older)).toEqual({ phase: 'running', since: at, event: 'PostToolBatch' });
  });

  // A turn cannot have begun after the event that rode on it; a stamp saying so came from a clock that moved.
  it('counts from the event when the turn stamp is later than the event itself', () => {
    expect(reads(marker({ event: 'PostToolBatch', at, turnAt: at + 5_000 }))?.since).toBe(at);
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
    expect(reads({ ...marker(), v: HOOK_MARKER_VERSION + 1 })).toBeNull();
  });

  it('reports nothing for a marker whose event the board maps to no phase', () => {
    expect(reads(marker({ event: 'Notification', notificationType: 'idle_prompt' }))).toBeNull();
  });
});

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
      session({ startedAt: 10, activity: { phase: 'running', since: 40, event: 'Stop' } }),
    ];

    expect(unreportedSessions(sessions, 20)).toBe(1);
  });

  it('counts nothing once every session reports', () => {
    expect(unreportedSessions([session({ activity: { phase: 'idle', since: 1, event: 'Stop' } })], 20)).toBe(0);
  });
});
