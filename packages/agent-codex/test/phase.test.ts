import { describe, expect, it } from 'vitest';
import { ROLLOUT_TAIL_BYTES, activityOf, markerInProfile, phaseOf, readActivity, readMarker, turnEndOf } from '../src/phase.js';
import type { ActivityMarker } from '../src/phase.js';
import { HOOK_MARKER_VERSION, markerPathOf } from '../src/hookScript.js';
import { HOME, STATE_DIR, fixture, machine } from './helpers.js';

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
  return machine({ files: { [markerPathOf(STATE_DIR, sessionId)]: JSON.stringify(value) } });
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
    expect(readMarker(STATE_DIR, 'thread-1', invalid.readText, NOW)).toBeNull();
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

/** The rollout records after a turn ended on a usage limit, as one JSONL tail. */
const ENDED = (fixture('rollout-turn-end') as unknown[]).map((record) => JSON.stringify(record)).join('\n') + '\n';
const ENDED_AT = Date.parse('2026-09-10T15:40:12.924Z');
const LIMIT_TEXT =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 16th, 2026 7:40 AM.";

function record(payload: Record<string, unknown>, timestamp = '2026-09-10T15:40:12.924Z'): string {
  return `${JSON.stringify({ timestamp, ordinal: 1, type: 'event_msg', payload })}\n`;
}

describe('the end of a turn, read from the rollout', () => {
  it('reads a task_complete carrying an error as the failure it records, dated when Codex wrote it', () => {
    expect(turnEndOf(ENDED, 'turn-1')).toEqual({
      phase: 'failed',
      since: ENDED_AT,
      at: ENDED_AT,
      event: 'task_complete',
      error: { kind: 'usage_limit_exceeded', message: LIMIT_TEXT },
    });
  });

  it('reads a task_complete without an error, and an abort, as idle', () => {
    expect(turnEndOf(record({ type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'Done.' }), 'turn-1')?.phase).toBe('idle');
    expect(turnEndOf(record({ type: 'turn_aborted', turn_id: 'turn-1', reason: 'interrupted' }), 'turn-1')?.phase).toBe('idle');
  });

  it('names a struct-variant error by its variant, and an untyped one as other', () => {
    const struct = record({
      type: 'task_complete',
      turn_id: 'turn-1',
      error: { message: 'boom', codex_error_info: { http_connection_failed: { http_status_code: 503 } } },
    });
    const untyped = record({ type: 'task_complete', turn_id: 'turn-1', error: { message: 'boom', codex_error_info: null } });

    expect(turnEndOf(struct, 'turn-1')?.error?.kind).toBe('http_connection_failed');
    expect(turnEndOf(untyped, 'turn-1')?.error?.kind).toBe('other');
  });

  it('answers only for the turn asked about, and says nothing while that turn has no end', () => {
    expect(turnEndOf(ENDED, 'turn-2')).toBeNull();
    expect(turnEndOf(record({ type: 'task_started', turn_id: 'turn-1' }), 'turn-1')).toBeNull();
    expect(turnEndOf(null, 'turn-1')).toBeNull();
  });

  it('skips the partial record a tail read starts in, and records it cannot parse', () => {
    expect(turnEndOf(`${ENDED.slice(200)}not json\n`, 'turn-1')?.phase).toBe('failed');
    expect(turnEndOf(record({ type: 'task_complete', turn_id: 'turn-1' }).slice(10), 'turn-1')).toBeNull();
  });
});

describe('a running marker checked against its rollout', () => {
  const path = '/home/dev/.codex/sessions/2026/09/07/rollout-thread-1.jsonl';
  const running = marker({ event: 'UserPromptSubmit', at: ENDED_AT - 1_500, turnAt: ENDED_AT - 1_500, turnId: 'turn-1', transcriptPath: path });

  it('reports the failure the rollout recorded after the last hook event', () => {
    const { readTail } = machine({ files: { [path]: ENDED } });

    expect(activityOf(running, readTail)).toMatchObject({ phase: 'failed', event: 'task_complete', error: { kind: 'usage_limit_exceeded' } });
  });

  it('reads no more of the rollout than the tail it needs', () => {
    const asked: number[] = [];

    activityOf(running, (_path, bytes) => {
      asked.push(bytes);

      return ENDED;
    });

    expect(asked).toEqual([ROLLOUT_TAIL_BYTES]);
  });

  it('keeps running while the rollout has no end for its turn, or cannot be read', () => {
    const other = machine({ files: { [path]: record({ type: 'task_complete', turn_id: 'turn-0', error: { message: 'old', codex_error_info: 'other' } }) } });

    expect(activityOf(running, other.readTail)?.phase).toBe('running');
    expect(activityOf(running, machine({}).readTail)?.phase).toBe('running');
  });

  it('stops reading at the start of its own turn, so an earlier turn on the same id cannot end this one', () => {
    const earlier = record({ type: 'task_complete', turn_id: 'turn-1', error: { message: 'old', codex_error_info: 'other' } }, '2026-09-10T15:00:00.000Z');
    const started = record({ type: 'task_started', turn_id: 'turn-1' }, '2026-09-10T15:40:11.293Z');

    expect(activityOf(running, machine({ files: { [path]: earlier + started } }).readTail)?.phase).toBe('running');
  });

  it('does not open the rollout for a marker outside a turn, or one that already left running', () => {
    const opened = () => {
      throw new Error('read');
    };

    expect(activityOf(marker({ event: 'Stop', turnId: null }), opened)?.phase).toBe('idle');
    expect(activityOf(marker({ event: 'PermissionRequest', turnId: 'turn-1', transcriptPath: path }), opened)?.phase).toBe('waiting');
    expect(activityOf(marker({ event: 'PostToolUse', turnId: null, transcriptPath: path }), opened)?.phase).toBe('running');
  });

  it('is what the activity reader reports', () => {
    const deps = machine({ files: { [markerPathOf(STATE_DIR, 'thread-1')]: JSON.stringify(running), [path]: ENDED } });

    expect(readActivity(STATE_DIR, HOME, 'thread-1', deps.readText, ENDED_AT + 1, {}, deps.readTail)?.phase).toBe('failed');
  });
});

describe('reading a marker off the machine', () => {
  it('reads the marker written for this session', () => {
    expect(readMarker(STATE_DIR, 'thread-1', withMarker(marker()).readText, NOW)?.event).toBe('PostToolUse');
    expect(readActivity(STATE_DIR, HOME, 'thread-1', withMarker(marker()).readText, NOW)?.phase).toBe('running');
  });

  it('rejects markers whose IDs differ from their filenames', () => {
    expect(readMarker(STATE_DIR, 'thread-1', withMarker(marker({ sessionId: 'thread-2' })).readText, NOW)).toBeNull();
  });

  it('refuses a marker from a version whose fields were redefined', () => {
    expect(readMarker(STATE_DIR, 'thread-1', withMarker({ ...marker(), v: 99 }).readText, NOW)).toBeNull();
  });

  it('refuses a marker further ahead of the reader than a race could put it', () => {
    expect(readMarker(STATE_DIR, 'thread-1', withMarker(marker({ at: NOW + 90_000 })).readText, NOW)).toBeNull();
    expect(readMarker(STATE_DIR, 'thread-1', withMarker(marker({ at: NOW + 30_000 })).readText, NOW)).not.toBeNull();
  });

  it('refuses a marker that is not JSON, and reports nothing where there is no marker', () => {
    expect(readMarker(STATE_DIR, 'thread-1', machine({ files: { [markerPathOf(STATE_DIR, 'thread-1')]: '{' } }).readText, NOW)).toBeNull();
    expect(readMarker(STATE_DIR, 'thread-1', machine({}).readText, NOW)).toBeNull();
    expect(readActivity(STATE_DIR, HOME, 'thread-1', machine({}).readText, NOW)).toBeNull();
  });
});
