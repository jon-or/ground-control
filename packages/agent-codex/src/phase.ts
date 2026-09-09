import { z } from 'zod';
import type { ActivityPhase, ReadText, SessionActivity } from '@ground-control/core';
import { FUTURE_TOLERANCE_MS, HOOK_MARKER_VERSION, markerPathOf } from './hookScript.js';

/**
 * What the hook wrote. Every field is a transcription of the payload, so an unfamiliar value reaches `phaseOf` rather than being rejected
 * here — an event the board does not recognise must cost no phase, not a whole session.
 */
const activityMarker = z.object({
  // Pinned, not read: two extension versions share one home, so a marker whose fields were redefined must read as no session rather than be
  // consumed as this one. An added field is defaulted instead, which costs no session its phase.
  v: z.literal(HOOK_MARKER_VERSION),
  sessionId: z.string(),
  event: z.string().nullable(),
  at: z.number(),
  /** When the turn in flight began, from the first event carrying its `turn_id`. Null on an event that belongs to no turn. */
  turnAt: z.number().nullable(),
  turnId: z.string().nullable(),
  /** The Codex process the session runs in, or null where the writer could not walk to it. The roster's only liveness evidence. */
  pid: z.number().int().positive().nullable(),
  startedAt: z.number(),
  cwd: z.string().nullable(),
  transcriptPath: z.string().nullable(),
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
    // A subagent's own bounds are the parent session working, and Codex reports them under the parent's session id.
    case 'SubagentStart':
    case 'SubagentStop':
    // Compaction happens inside a turn, so claiming nothing here would take a running card back to no phase at all.
    case 'PreCompact':
    case 'PostCompact':
      return 'running';

    // The one blocking human gate Codex has. `PreToolUse` fires first and `PostToolUse` after the decision, so the
    // three events in order carry a card into the gate and out of it.
    case 'PermissionRequest':
      return 'waiting';

    case 'Stop':
    case 'Interrupt':
      return 'idle';

    // Startup, resume and fork all say a session exists rather than what it is doing, and so does an event this
    // board has never seen (R24).
    default:
      return null;
  }
}

/**
 * What the card's duration counts from. A running session counts the turn it is in rather than its last heartbeat, which lands on every tool
 * call and would hold the number at zero. A stamp later than its own event is a clock step.
 */
function sinceOf(phase: ActivityPhase, marker: ActivityMarker): number {
  return phase === 'running' && marker.turnAt !== null && marker.turnAt <= marker.at ? marker.turnAt : marker.at;
}

/** The marker for one session, or null when it is absent, unreadable, or not this session's. */
export function readMarker(home: string, sessionId: string, readText: ReadText, now: number = Date.now()): ActivityMarker | null {
  const raw = readText(markerPathOf(home, sessionId));

  if (!raw) {
    return null;
  }

  let parsed;

  try {
    parsed = activityMarker.safeParse(JSON.parse(raw));
  } catch {
    return null;
  }

  // A forked thread reuses records under a new id, so a marker that disagrees with its own file name is not this session's.
  if (!parsed.success || parsed.data.sessionId !== sessionId || parsed.data.at > now + FUTURE_TOLERANCE_MS) {
    return null;
  }

  return parsed.data;
}

/** The phase a marker claims, or null where it claims none. Separate from the read so the roster reads each marker once. */
export function activityOf(marker: ActivityMarker): SessionActivity | null {
  const phase = phaseOf(marker);

  // A null event reaches `phaseOf`'s default arm, so a phase at all proves the event was named.
  return phase === null ? null : { phase, since: sinceOf(phase, marker), at: marker.at, event: marker.event as string };
}

/**
 * The session's last reported activity, or null when it has no marker, an unreadable one, or one that claims nothing. Never liveness — that
 * is the marker's pid, because Codex has no command that lists its live sessions (`docs/mechanics.md` M40).
 */
export function readActivity(
  home: string,
  sessionId: string,
  readText: ReadText,
  now: number = Date.now(),
): SessionActivity | null {
  const marker = readMarker(home, sessionId, readText, now);

  return marker === null ? null : activityOf(marker);
}
