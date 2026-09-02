import { z } from 'zod';
import type { ReadText } from './link.js';
import { FUTURE_TOLERANCE_MS, HOOK_MARKER_VERSION, markerPathOf } from './hookScript.js';
import type { ActivityPhase, Session, SessionActivity } from './types.js';

/**
 * What the hook wrote. Every field is a transcription of the payload, so an unfamiliar value reaches `phaseOf`
 * rather than being rejected here — an event the board does not recognise must cost no phase, not a whole session.
 */
const activityMarker = z.object({
  // Pinned, not read: two extension versions share one `~/.claude`, so a marker whose fields were redefined must read
  // as no phase rather than be consumed as this one. An added field is defaulted instead, which costs no session its phase.
  v: z.literal(HOOK_MARKER_VERSION),
  sessionId: z.string(),
  event: z.string().nullable(),
  at: z.number(),
  /** When the stretch of work in flight began: its prompt, or its first event where it resumed without one. Absent from an older marker. */
  turnAt: z.number().nullable().default(null),
  notificationType: z.string().nullable(),
  source: z.string().nullable(),
  toolName: z.string().nullable(),
  reason: z.string().nullable(),
  backgroundTasks: z.number(),
});

export type ActivityMarker = z.infer<typeof activityMarker>;

/** Blocking human gates. A session sitting on one is parked on a decision, which is what R6 exists to surface. */
const WAITING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/**
 * `Notification` is not "the agent needs you": the same event carries `agent_completed` and `idle_prompt`, so
 * mapping it wholesale would paint a finished session as needing attention (`docs/mechanics.md` §20).
 */
const WAITING_NOTIFICATIONS = new Set(['permission_prompt', 'worker_permission_prompt', 'agent_needs_input']);

/**
 * The phase a marker reports, or null to claim nothing. Null is the honest floor and what makes an event the board
 * has never seen safe: the card renders without a phase rather than guessing one (R24).
 */
export function phaseOf(marker: ActivityMarker): ActivityPhase | null {
  switch (marker.event) {
    case 'UserPromptSubmit':
    case 'PostToolBatch':
    case 'PermissionDenied':
      return 'running';

    // Compaction fires mid-turn on a session that is working, so blanking its phase would take a running card back to
    // nothing. Every other source — startup, resume, clear, fork — says a session exists, not what it is doing.
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

    // Background work still in flight is a paused session, not a finished one.
    case 'Stop':
      return marker.backgroundTasks > 0 ? 'running' : 'idle';

    default:
      return null;
  }
}

/**
 * What the card's duration counts from. A running session counts the stretch of work it is in — the prompt that began it, not the last
 * heartbeat, which lands on every tool batch and would hold the number at zero. A stamp later than its own event is a clock step.
 */
function sinceOf(phase: ActivityPhase, marker: ActivityMarker): number {
  return phase === 'running' && marker.turnAt !== null && marker.turnAt <= marker.at ? marker.turnAt : marker.at;
}

/**
 * The session's last reported activity, or null when it has no marker, an unreadable one, or one that claims nothing.
 * Never liveness: the CLI's session list is what proves a session is alive (`docs/mechanics.md` §2).
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

  // A forked transcript reuses records under a new id, so a marker that disagrees with its own file name is not this
  // session's (`docs/mechanics.md` §10).
  if (!marker.success || marker.data.sessionId !== sessionId || marker.data.at > now + FUTURE_TOLERANCE_MS) {
    return null;
  }

  const phase = phaseOf(marker.data);

  // A null event reaches `phaseOf`'s default arm, so a phase at all proves the event was named.
  return phase === null
    ? null
    : { phase, since: sinceOf(phase, marker.data), event: marker.data.event as string };
}

/** One marker file appearing, being rewritten, or being removed. The board's watcher reports a batch of these. */
export interface ActivityChange {
  kind: 'created' | 'changed' | 'deleted';
  sessionId: string;
}

/**
 * Whether a batch of marker changes moved the session list itself, rather than a phase within it. A marker removed is a session that ended or
 * restarted, and one naming a session the board has not listed is a session it can only learn from the CLI. A phase on a listed session is neither.
 */
export function rosterIsStale(
  changes: readonly ActivityChange[],
  known: ReadonlySet<string>,
  reportsPhase: (sessionId: string) => boolean,
): boolean {
  // Kind is not trusted for the unlisted session: a rename over a path a watcher has seen before is a create on one platform and a change on
  // another. A marker claiming no phase is not worth the read — `neverPrompted` would filter that session out of the list it came back in (R2).
  return changes.some(
    (change) =>
      change.kind === 'deleted' || (!known.has(change.sessionId) && reportsPhase(change.sessionId)),
  );
}

/**
 * How many listed sessions cannot report a phase because they were already running when the hooks were installed. The board says so once,
 * above the lanes: a board silently showing nothing for every session looks exactly like a board where nothing is happening (R25).
 */
export function unreportedSessions(sessions: readonly Session[], installedAt: number): number {
  return sessions.filter((session) => session.activity === null && session.startedAt < installedAt).length;
}
