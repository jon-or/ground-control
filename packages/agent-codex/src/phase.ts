import { z } from 'zod';
import type { ActivityPhase, ReadText, SessionActivity } from '@ground-control/core';
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

/** Derive activity from an existing marker so roster reads do not reread the file. */
export function activityOf(marker: ActivityMarker): SessionActivity | null {
  const phase = phaseOf(marker);

  // `phaseOf` returns null for a null event, so a known phase implies a named event.
  return phase === null ? null : { phase, since: sinceOf(phase, marker), at: marker.at, event: marker.event as string };
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
): SessionActivity | null {
  const marker = readMarker(stateDir, sessionId, readText, now);

  return marker === null || !markerInProfile(marker, home, env) ? null : activityOf(marker);
}
