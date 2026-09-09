import { z } from 'zod';
import type { ActivityChange, ActivityPhase, ReadText, Session, SessionActivity } from '@ground-control/core';
import { FUTURE_TOLERANCE_MS, HOOK_MARKER_VERSION, markerPathOf } from './hookScript.js';

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
  /**
   * Turn start: the prompt timestamp, or the first event after resuming without a prompt. Defaults to null for
   * older markers.
   */
  turnAt: z.number().nullable().default(null),
  notificationType: z.string().nullable(),
  source: z.string().nullable(),
  toolName: z.string().nullable(),
  reason: z.string().nullable(),
  backgroundTasks: z.number(),
});

export type ActivityMarker = z.infer<typeof activityMarker>;

/** Tools that wait for a user decision (R6). */
const WAITING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** `Notification` also reports completion and idle events; only these types require user input (M20). */
const WAITING_NOTIFICATIONS = new Set(['permission_prompt', 'worker_permission_prompt', 'agent_needs_input']);

/** Return the reported phase, or null for unsupported events (R24). */
export function phaseOf(marker: ActivityMarker): ActivityPhase | null {
  switch (marker.event) {
    case 'UserPromptSubmit':
    case 'PostToolBatch':
    case 'PermissionDenied':
      return 'running';

    // Compaction occurs during a running turn. Other SessionStart sources report existence without an activity
    // phase.
    case 'SessionStart':
      return marker.source === 'compact' ? 'running' : null;

    case 'PermissionRequest':
    case 'Elicitation':
      return 'waiting';

    case 'PreToolUse':
      return marker.toolName !== null && WAITING_TOOLS.has(marker.toolName) ? 'waiting' : null;

    case 'Notification':
      if (marker.notificationType !== null && WAITING_NOTIFICATIONS.has(marker.notificationType)) {
        return 'waiting';
      }

      return marker.notificationType === 'agent_completed' ? 'idle' : null;

    // Pending background tasks keep the phase running after Stop.
    case 'Stop':
      return marker.backgroundTasks > 0 ? 'running' : 'idle';

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

/**
 * Read the last activity, or null for missing, invalid, or unsupported markers. Only the CLI session list
 * establishes liveness (M2).
 */
export function readActivity(
  home: string,
  sessionId: string,
  readText: ReadText,
  now: number = Date.now(),
): SessionActivity | null {
  const raw = readText(markerPathOf(home, sessionId));

  if (!raw) {
    return null;
  }

  let marker;

  try {
    marker = activityMarker.safeParse(JSON.parse(raw));
  } catch {
    return null;
  }

  // Forks reuse transcript records; reject markers whose session ID differs from their filename (M10).
  if (!marker.success || marker.data.sessionId !== sessionId || marker.data.at > now + FUTURE_TOLERANCE_MS) {
    return null;
  }

  const phase = phaseOf(marker.data);

  // `phaseOf` returns null for a null event, so a known phase implies a named event.
  return phase === null
    ? null
    : { phase, since: sinceOf(phase, marker.data), at: marker.data.at, event: marker.data.event as string };
}
