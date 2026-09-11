import { z } from 'zod';
import type { ActivityError, ActivityPhase, ReadTail, ReadText, SessionActivity } from '@ground-control/core';
import { scopeDirectory } from '@ground-control/core';
import { FUTURE_TOLERANCE_MS, HOOK_MARKER_VERSION, codexHomeOf, markerPathOf } from './hookScript.js';

/**
 * Validate hook marker structure while allowing unfamiliar event values. Unsupported events have no phase; they
 * do not invalidate the session.
 */
const activityMarker = z.object({
  // Reject incompatible marker versions because extension versions share one home. Default additive fields when
  // compatibility permits.
  v: z.literal(HOOK_MARKER_VERSION),
  sessionId: z.string(),
  event: z.string().nullable(),
  at: z.number(),
  /** Timestamp of the first event with this `turn_id`. Null for events outside a turn. */
  turnAt: z.number().nullable(),
  turnId: z.string().nullable(),
  /** Codex process ID, or null when process ancestry could not be resolved. Used to check liveness. */
  pid: z.number().int().positive().nullable(),
  startedAt: z.number(),
  cwd: z.string().nullable(),
  transcriptPath: z.string().nullable(),
  profileRoot: z.string().refine((value) => scopeDirectory(value) !== null).nullable().default(null),
  model: z.string().nullable(),
  permissionMode: z.string().nullable(),
  source: z.string().nullable(),
  toolName: z.string().nullable(),
  reason: z.string().nullable(),
});

export type ActivityMarker = z.infer<typeof activityMarker>;

/**
 * Map measured hook events to phases; return null for unsupported events (R24, mechanics M40).
 */
export function phaseOf(marker: ActivityMarker): ActivityPhase | null {
  switch (marker.event) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
    // Subagent events report parent-session work under the parent session ID.
    case 'SubagentStart':
    case 'SubagentStop':
    // Compaction occurs during a running turn.
    case 'PreCompact':
    case 'PostCompact':
      return 'running';

    // `PermissionRequest` waits for user input, between `PreToolUse` and `PostToolUse`.
    case 'PermissionRequest':
      return 'waiting';

    case 'Stop':
    case 'Interrupt':
      return 'idle';

    // Startup, resume, fork, and unknown events do not establish an activity phase (R24).
    default:
      return null;
  }
}

/**
 * Measure running duration from the turn start, not each tool event. Ignore turn timestamps later than the
 * event to handle clock changes.
 */
function sinceOf(phase: ActivityPhase, marker: ActivityMarker): number {
  return phase === 'running' && marker.turnAt !== null && marker.turnAt <= marker.at ? marker.turnAt : marker.at;
}

/** The marker for one session, or null when it is absent, unreadable, or not this session's. */
export function readMarker(stateDir: string, sessionId: string, readText: ReadText, now: number = Date.now()): ActivityMarker | null {
  const raw = readText(markerPathOf(stateDir, sessionId));

  if (!raw) {
    return null;
  }

  let parsed;

  try {
    parsed = activityMarker.safeParse(JSON.parse(raw));
  } catch {
    return null;
  }

  // Forks reuse thread records; reject markers whose session ID differs from their filename.
  if (!parsed.success || parsed.data.sessionId !== sessionId || parsed.data.at > now + FUTURE_TOLERANCE_MS) {
    return null;
  }

  return parsed.data;
}

/** Bytes of rollout read for a turn's end; the token_count records before a `task_complete` run a few kilobytes each. */
export const ROLLOUT_TAIL_BYTES = 64 * 1024;

/** The rollout records that start or end a turn. Codex writes `task_complete` for TurnComplete (M55). */
const turnRecord = z.object({
  timestamp: z.string(),
  type: z.literal('event_msg'),
  payload: z.discriminatedUnion('type', [
    z.object({ type: z.literal('task_started'), turn_id: z.string() }),
    z.object({
      type: z.literal('task_complete'),
      turn_id: z.string(),
      error: z
        .object({
          message: z.string(),
          // Externally tagged: a bare string for unit variants, `{ variant: fields }` for the rest.
          codex_error_info: z.union([z.string(), z.record(z.string(), z.unknown())]).nullable().default(null),
        })
        .nullable()
        .default(null),
    }),
    z.object({ type: z.literal('turn_aborted'), turn_id: z.string().nullable().default(null) }),
  ]),
});

type TurnPayload = z.infer<typeof turnRecord>['payload'];

function errorOf(error: Extract<TurnPayload, { type: 'task_complete' }>['error']): ActivityError | null {
  if (error === null) {
    return null;
  }

  const info = error.codex_error_info;
  const kind = typeof info === 'string' ? info : info === null ? 'other' : (Object.keys(info)[0] ?? 'other');

  return { kind, message: error.message };
}

/**
 * The end of the marker's turn from the rollout tail, or null while it runs. No hook fires for a turn that ends
 * on an error, and `Error` events are not persisted; `task_complete` carries the terminal error (M55).
 */
export function turnEndOf(tail: string | null, turnId: string): SessionActivity | null {
  if (tail === null) {
    return null;
  }

  const lines = tail.split('\n');

  // Newest first, back to the turn's own start. A tail that begins mid-record leaves a first line the parse skips.
  for (let index = lines.length - 1; index >= 0; index--) {
    let parsed;

    try {
      parsed = turnRecord.safeParse(JSON.parse(lines[index]!));
    } catch {
      continue;
    }

    if (!parsed.success || parsed.data.payload.turn_id !== turnId) {
      continue;
    }

    const { payload } = parsed.data;
    const at = Date.parse(parsed.data.timestamp);

    if (payload.type === 'task_started' || Number.isNaN(at)) {
      return null;
    }

    const error = payload.type === 'task_complete' ? errorOf(payload.error) : null;

    return error === null ? { phase: 'idle', since: at, at, event: payload.type } : { phase: 'failed', since: at, at, event: payload.type, error };
  }

  return null;
}

/** Derive activity from a marker; a running one also consults the rollout, because a failed turn leaves no hook event. */
export function activityOf(marker: ActivityMarker, readTail?: ReadTail): SessionActivity | null {
  const phase = phaseOf(marker);

  // `phaseOf` returns null for a null event, so a known phase implies a named event.
  if (phase === null) {
    return null;
  }

  const activity: SessionActivity = { phase, since: sinceOf(phase, marker), at: marker.at, event: marker.event as string };

  if (phase !== 'running' || readTail === undefined || marker.turnId === null || marker.transcriptPath === null) {
    return activity;
  }

  return turnEndOf(readTail(marker.transcriptPath, ROLLOUT_TAIL_BYTES), marker.turnId) ?? activity;
}

/** Old markers can prove their profile through a transcript; ambiguous legacy markers belong only to the default. */
export function markerInProfile(marker: ActivityMarker, home: string, env: NodeJS.ProcessEnv): boolean {
  const root = scopeDirectory(codexHomeOf(home, env));
  if (root === null) return false;
  if (marker.profileRoot !== null) return scopeDirectory(marker.profileRoot) === root;
  if (marker.transcriptPath !== null) {
    const transcript = scopeDirectory(marker.transcriptPath);
    const sessions = `${root.endsWith('/') ? root : `${root}/`}sessions/`;
    return transcript !== null && transcript.startsWith(sessions);
  }
  return root === scopeDirectory(codexHomeOf(home));
}

/**
 * Read the last activity, or null for missing, invalid, or unsupported markers. The marker PID establishes
 * liveness; Codex cannot list live sessions (M40).
 */
export function readActivity(
  stateDir: string,
  home: string,
  sessionId: string,
  readText: ReadText,
  now: number = Date.now(),
  env: NodeJS.ProcessEnv = {},
  readTail?: ReadTail,
): SessionActivity | null {
  const marker = readMarker(stateDir, sessionId, readText, now);

  return marker === null || !markerInProfile(marker, home, env) ? null : activityOf(marker, readTail);
}
