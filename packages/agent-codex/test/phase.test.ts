import { describe, expect, it } from 'vitest';
import { activityOf, markerInProfile, phaseOf, readActivity, readMarker } from '../src/phase.js';
import type { ActivityMarker } from '../src/phase.js';
import { HOOK_MARKER_VERSION, markerPathOf } from '../src/hookScript.js';
import { HOME, machine } from './helpers.js';

const NOW = 1_700_000_000_000;

function marker(over: Partial<ActivityMarker> = {}): ActivityMarker {
  return {
    v: HOOK_MARKER_VERSION,
    sessionId: 'thread-1',
    event: 'PostToolUse',
    at: NOW,
    turnAt: NOW - 30_000,
    turnId: 'turn-1',
    pid: 4242,
    startedAt: NOW - 60_000,
    cwd: '/work/repo',
    transcriptPath: '/home/dev/.codex/sessions/2026/09/07/rollout-thread-1.jsonl',
    profileRoot: null,
    model: 'gpt-6-astra',
    permissionMode: 'default',
    source: null,
    toolName: 'Bash',
    reason: null,
    ...over,
  };
}

function withMarker(value: unknown, sessionId = 'thread-1') {
  return machine({ files: { [markerPathOf(HOME, sessionId)]: JSON.stringify(value) } });
}

describe('the phase a Codex event reports', () => {
  it('uses explicit profiles or legacy transcript evidence and rejects ambiguous custom-profile markers', () => {
    const custom = { CODEX_HOME: '/profiles/codex' };
    expect(markerInProfile(marker({ profileRoot: '/profiles/codex' }), HOME, custom)).toBe(true);
    expect(markerInProfile(marker({ profileRoot: '/profiles/elsewhere' }), HOME, custom)).toBe(false);
    expect(markerInProfile(marker({ transcriptPath: '/profiles/codex/sessions/rollout.jsonl' }), HOME, custom)).toBe(true);
    expect(markerInProfile(marker({ transcriptPath: '/profiles/codex/personal/sessions/rollout.jsonl' }), HOME, custom)).toBe(false);
    expect(markerInProfile(marker({ transcriptPath: '/profiles/codex/sessions-other/rollout.jsonl' }), HOME, custom)).toBe(false);
    expect(markerInProfile(marker({ transcriptPath: '/profiles/codex-other/sessions/rollout.jsonl' }), HOME, custom)).toBe(false);
    expect(markerInProfile(marker({ transcriptPath: null }), HOME, custom)).toBe(false);
    expect(markerInProfile(marker({ transcriptPath: null }), HOME, {})).toBe(true);
    const invalid = withMarker(marker({ profileRoot: 'relative' }));
    expect(readMarker(HOME, 'thread-1', invalid.readText, NOW)).toBeNull();
  });
  it('reads work from every event that only happens while a turn is running', () => {
    for (const event of [
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'SubagentStart',
      'SubagentStop',
      'PreCompact',
      'PostCompact',
    ]) {
      expect(phaseOf(marker({ event }))).toBe('running');
    }
  });

  it('maps permission requests to waiting', () => {
    expect(phaseOf(marker({ event: 'PermissionRequest' }))).toBe('waiting');
  });

  it('reads the end of a turn and an interrupt as idle', () => {
    expect(phaseOf(marker({ event: 'Stop' }))).toBe('idle');
    expect(phaseOf(marker({ event: 'Interrupt' }))).toBe('idle');
  });

  it('claims nothing for a session that has only started, or for an event it has never seen', () => {
    expect(phaseOf(marker({ event: 'SessionStart', source: 'startup' }))).toBeNull();
    expect(phaseOf(marker({ event: 'SomethingCodexAddedLater' }))).toBeNull();
    expect(phaseOf(marker({ event: null }))).toBeNull();
  });

  it('counts a running session from the turn rather than from the last event', () => {
    expect(activityOf(marker())).toEqual({ phase: 'running', since: NOW - 30_000, at: NOW, event: 'PostToolUse' });
  });

  it('uses event time when turn time is in the future', () => {
    expect(activityOf(marker({ turnAt: NOW + 10_000 }))?.since).toBe(NOW);
  });

  it('counts an idle session from the event, because no turn is in flight', () => {
    expect(activityOf(marker({ event: 'Stop', turnAt: NOW - 30_000 }))).toEqual({
      phase: 'idle',
      since: NOW,
      at: NOW,
      event: 'Stop',
    });
  });

  it('claims nothing where the marker claims nothing', () => {
    expect(activityOf(marker({ event: 'SessionStart' }))).toBeNull();
  });
});

describe('reading a marker off the machine', () => {
  it('reads the marker written for this session', () => {
    expect(readMarker(HOME, 'thread-1', withMarker(marker()).readText, NOW)?.event).toBe('PostToolUse');
    expect(readActivity(HOME, 'thread-1', withMarker(marker()).readText, NOW)?.phase).toBe('running');
  });

  it('rejects markers whose IDs differ from their filenames', () => {
    expect(readMarker(HOME, 'thread-1', withMarker(marker({ sessionId: 'thread-2' })).readText, NOW)).toBeNull();
  });

  it('refuses a marker from a version whose fields were redefined', () => {
    expect(readMarker(HOME, 'thread-1', withMarker({ ...marker(), v: 99 }).readText, NOW)).toBeNull();
  });

  it('refuses a marker further ahead of the reader than a race could put it', () => {
    expect(readMarker(HOME, 'thread-1', withMarker(marker({ at: NOW + 90_000 })).readText, NOW)).toBeNull();
    expect(readMarker(HOME, 'thread-1', withMarker(marker({ at: NOW + 30_000 })).readText, NOW)).not.toBeNull();
  });

  it('refuses a marker that is not JSON, and reports nothing where there is no marker', () => {
    expect(readMarker(HOME, 'thread-1', machine({ files: { [markerPathOf(HOME, 'thread-1')]: '{' } }).readText, NOW)).toBeNull();
    expect(readMarker(HOME, 'thread-1', machine({}).readText, NOW)).toBeNull();
    expect(readActivity(HOME, 'thread-1', machine({}).readText, NOW)).toBeNull();
  });
});
