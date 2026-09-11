import { describe, expect, it } from 'vitest';
import { phaseOf, readActivity } from '../src/phase.js';
import type { ActivityMarker } from '../src/phase.js';
import type { Session } from '@ground-control/core';
import { HOOK_MARKER_VERSION, markerPathOf } from '../src/hookScript.js';
import { STATE_DIR } from './helpers.js';

const SESSION = 'a1b2c3d4-0000-4000-8000-000000000000';

/** Construct markers directly because the board owns their format. */
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
    error: null,
    errorMessage: null,
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

  // SessionStart during compaction must preserve the running phase.
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

  // Distinguish input requests from completion and idle notifications.
  it.each(['permission_prompt', 'worker_permission_prompt', 'agent_needs_input'])(
    'reads a %s notification as waiting',
    (notificationType) => {
      expect(phaseOf(marker({ event: 'Notification', notificationType }))).toBe('waiting');
    },
  );

  // Idle reminders need no user decision, and agent_completed reports another job's finish (M20): neither maps to a phase.
  it.each(['idle_prompt', 'auth_success', 'push_notification', 'agent_completed', null])(
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

  it('reads a stop failure as failed, whatever the error kind', () => {
    expect(phaseOf(marker({ event: 'StopFailure', error: 'rate_limit' }))).toBe('failed');
    expect(phaseOf(marker({ event: 'StopFailure', error: null }))).toBe('failed');
  });

  it('claims nothing for an event it has never seen', () => {
    expect(phaseOf(marker({ event: 'PreModelSwitch' }))).toBeNull();
    expect(phaseOf(marker({ event: null }))).toBeNull();
  });
});

describe('readActivity', () => {
  const at = 1_788_000_000_000;
  const path = markerPathOf(STATE_DIR, SESSION);

  const reads = (value: unknown, now = at + 1): ReturnType<typeof readActivity> =>
    readActivity(STATE_DIR, SESSION, (p) => (p === path ? JSON.stringify(value) : null), now);

  it('reads the phase and the time the hook observed it', () => {
    expect(reads(marker({ event: 'PostToolBatch', at }))).toEqual({
      phase: 'running',
      since: at,
      at,
      event: 'PostToolBatch',
    });
  });

  it('carries the error kind and the agent text on a failed turn, and counts from the failure', () => {
    const text = 'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.';

    expect(reads(marker({ event: 'StopFailure', at, turnAt: at - 600_000, error: 'overloaded', errorMessage: text }))).toEqual({
      phase: 'failed',
      since: at,
      at,
      event: 'StopFailure',
      error: { kind: 'overloaded', message: text },
    });
  });

  it('names an unclassified failure the way the CLI does, and reads a marker written before the error fields existed', () => {
    const { error: _kind, errorMessage: _text, ...older } = marker({ event: 'StopFailure', at });

    expect(reads(older)?.error).toEqual({ kind: 'unknown', message: null });
    expect(reads(marker({ event: 'PostToolBatch', at }))?.error).toBeUndefined();
  });

  // Tool-batch events must not reset running duration.
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

  // Older markers lack turnAt; default it without losing the activity phase.
  it('keeps the phase of a marker written before the turn was recorded, and counts from the event', () => {
    const older = { ...marker({ event: 'PostToolBatch', at }) } as Record<string, unknown>;

    delete older.turnAt;

    expect(reads(older)).toEqual({ phase: 'running', since: at, at: at, event: 'PostToolBatch' });
  });

  // Ignore turn timestamps later than their event after clock changes.
  it('counts from the event when the turn stamp is later than the event itself', () => {
    expect(reads(marker({ event: 'PostToolBatch', at, turnAt: at + 5_000 }))?.since).toBe(at);
  });

  it('reports nothing when the session has no marker', () => {
    expect(readActivity(STATE_DIR, SESSION, () => null)).toBeNull();
  });

  it('reports nothing for a marker that is not JSON', () => {
    expect(readActivity(STATE_DIR, SESSION, () => '{ not json', at)).toBeNull();
  });

  it('reports nothing for a marker missing the fields the board reads', () => {
    expect(reads({ sessionId: SESSION, event: 'Stop' })).toBeNull();
  });

  // Reject markers naming another session, as reused fork records can do.
  it('reports nothing for a marker that disagrees with its own file name', () => {
    expect(reads(marker({ sessionId: 'someone-else' }))).toBeNull();
  });

  it('reports nothing for a marker written by a clock the board cannot trust', () => {
    expect(reads(marker({ at: at + 3_600_000 }), at)).toBeNull();
  });

  it('tolerates a marker a little ahead of the reader, which two clocks routinely are', () => {
    expect(reads(marker({ at: at + 30_000 }), at)?.phase).toBe('running');
  });

  // Shared-home readers must reject incompatible marker versions.
  it('reports nothing for a marker written to a different version of the format', () => {
    expect(reads({ ...marker(), v: HOOK_MARKER_VERSION + 1 })).toBeNull();
  });

  it('reports nothing for a marker whose event the board maps to no phase', () => {
    expect(reads(marker({ event: 'Notification', notificationType: 'idle_prompt' }))).toBeNull();
  });
});
