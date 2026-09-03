import type { ActivityChange } from './agent.js';
import type { Session } from './types.js';

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
