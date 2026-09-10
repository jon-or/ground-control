import { basename } from './paths.js';
import type { ActivityChange } from './agent.js';
import type { Snapshot } from './protocol.js';
import type { Session } from './types.js';

/**
 * Refresh the roster for deleted markers or newly observed sessions. Phase changes on known sessions need no
 * roster read.
 */
export function rosterIsStale(
  changes: readonly ActivityChange[],
  known: ReadonlySet<string>,
  reportsPhase: (sessionId: string) => boolean,
): boolean {
  // Watcher event kinds vary by platform. Require phase evidence before reading an unknown session; neverPrompted would otherwise filter it out (R2).
  return changes.some(
    (change) =>
      change.kind === 'deleted' || (!known.has(change.sessionId) && reportsPhase(change.sessionId)),
  );
}

/** Count phase-less sessions started before hook installation for the one-time restart notice (R25). */
export function unreportedSessions(sessions: readonly Session[], installedAt: number): number {
  return sessions.filter((session) => session.activity === null && session.startedAt < installedAt).length;
}

/** Shared session label fallback: title, CLI name, then working directory. */
export function sessionLabel(session: Session): string {
  return session.title ?? session.details['name'] ?? session.details['shortId'] ?? basename(session.cwd);
}

/** One live session off a snapshot, wherever it is placed. Null where no card carries it. */
export function sessionOf(snapshot: Snapshot | undefined, sessionId: string): Session | null {
  for (const lane of snapshot?.lanes ?? []) {
    for (const card of lane.cards) {
      const found = card.sessions.find((session) => session.sessionId === sessionId);

      if (found) {
        return found;
      }
    }
  }

  return null;
}

/**
 * Resolve the agent from live or historical snapshot rows before checking extension readiness. Unknown IDs
 * fall back to Claude. Keep the lookup in core so both clients share the same testable rule.
 */
export function agentOfSession(snapshot: Snapshot | undefined, sessionId: string): string {
  return agentOfKnownSession(snapshot, sessionId) ?? 'claude';
}

/**
 * The same lookup without the fallback, for a caller that has another source for an ID this snapshot does not
 * carry. A window activated by a link can have no snapshot at all.
 */
export function agentOfKnownSession(snapshot: Snapshot | undefined, sessionId: string): string | null {
  const live = sessionOf(snapshot, sessionId);

  if (live) {
    return live.agent;
  }

  for (const lane of snapshot?.lanes ?? []) {
    for (const card of lane.cards) {
      if (card.lastSession?.sessionId === sessionId) {
        return card.lastSession.agent;
      }
    }
  }

  return null;
}
