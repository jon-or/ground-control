import { dirKey, repositoryKey } from '@ground-control/core';
import { retainedPhase } from './lanes.js';
import type { HistoricalSession, RetainedActivity } from '@ground-control/core';
import type { BoardCard, IssueCard, Session } from './types.js';

/** Sessions bucketed by whatever they have in common, each bucket newest first. */
function groupSessions<K>(sessions: Session[], keyOf: (session: Session) => K): Map<K, Session[]> {
  const groups = new Map<K, Session[]>();

  for (const session of sessions) {
    const key = keyOf(session);
    const group = groups.get(key);

    if (group) {
      group.push(session);
    } else {
      groups.set(key, [session]);
    }
  }

  for (const group of groups.values()) {
    group.sort((a, b) => b.startedAt - a.startedAt);
  }

  return groups;
}

/**
 * What a session with no issue has in common with the others beside it. The repository and the branch, so a worktree
 * or a branch switch is a card of its own; the checkout directory where git names neither.
 */
function checkoutKey(session: Session): string {
  return session.repository !== null && session.branch !== null
    ? `${session.repository}#${session.branch}`
    : dirKey(session.checkoutRoot ?? session.cwd);
}

/**
 * One session with the board's own last reading of it, where the marker it left carries no phase. That happens to any
 * session, however it was started: a `SessionStart` maps to no phase, so a resume wipes the reading its own process
 * had written, and the row would fall back to the agent's word while the board's own observation sat in the store.
 *
 * `retainedPhase` for the same reason a saved session's row uses it: whatever was working when the reading was taken
 * is not working now, so a kept `running` would shimmer a row and ring a card for a turn that has stopped. Never for a
 * finished session either — `retaining` takes the reading away when the agent says one ended, and R6 claims no mark.
 */
function observed(session: Session, retained: ReadonlyMap<string, RetainedActivity>): Session {
  if (session.activity !== null || session.finished) {
    return session;
  }

  const held = retained.get(`${session.agent}:${session.sessionId}`);

  return held === undefined
    ? session
    : { ...session, activity: { phase: retainedPhase(held), since: held.at, at: held.at, event: held.event } };
}

/**
 * Every issue and every session on one board. Issue order is the order they were read; cards for issues the
 * developer is not assigned, then sessions with no issue, follow. Every session lands on exactly one card.
 *
 * `unassigned` is the issues a caller looked up for numbers the assigned read did not return. A number missing from
 * both is a guess off a branch name that named nothing, so the session keeps its checkout card instead (R4).
 *
 * `retained` is the last phase the board saw each session in, keyed `agent:sessionId`, which the saved session it
 * belongs to carries onto the card. Only that session's: a reading is about one session, not about the card (R6).
 * A live session with no current reading takes its own retained one, so what a row shows never turns on how the
 * session was launched — see `observed`.
 */
export function mergeBoard(
  issues: IssueCard[],
  sessions: Session[],
  history: readonly HistoricalSession[] = [],
  unassigned: ReadonlyMap<number, IssueCard> = new Map(),
  retained: ReadonlyMap<string, RetainedActivity> = new Map(),
): BoardCard[] {
  sessions = sessions.map((session) => observed(session, retained));

  const onBoard = new Set(issues.map((issue) => issue.number));
  const known = (session: Session): boolean =>
    session.issueNumber !== null && (onBoard.has(session.issueNumber) || unassigned.has(session.issueNumber));

  const linked = groupSessions(
    sessions.filter(known),
    (session) => session.issueNumber as number,
  );

  // A session naming no issue belongs to its checkout rather than to itself: that is what such work shares.
  const byCheckout = groupSessions(
    sessions.filter((session) => !known(session)),
    checkoutKey,
  );

  const cards: BoardCard[] = issues.map((issue) => ({
    key: `issue:${issue.number}`,
    issue,
    issueNumber: issue.number,
    sessions: linked.get(issue.number) ?? [],
  }));

  const liveIds = new Set(sessions.filter((s) => !s.finished).map((s) => `${s.agent}:${s.sessionId}`));
  const seenHistory = new Set<string>();
  const newest = [...history].filter((s) => !liveIds.has(`${s.agent}:${s.sessionId}`)).sort(
    (a, b) => b.updatedAt - a.updatedAt || `${a.agent}:${a.sessionId}`.localeCompare(`${b.agent}:${b.sessionId}`),
  ).filter((s) => {
    const key = `${s.agent}:${s.sessionId}`;
    if (seenHistory.has(key)) return false;
    seenHistory.add(key);
    return true;
  });
  for (const card of cards) {
    if (card.sessions.some((s) => !s.finished)) continue;
    const repo = repositoryKey(card.issue!.url);
    const last = newest.find((s) => s.issueNumber === card.issueNumber && s.repository !== null && s.repository === repo);
    if (last) {
      const held = retained.get(`${last.agent}:${last.sessionId}`);

      card.lastSession = held ? { ...last, retained: held } : last;
      card.sessions = [];
    }
  }

  for (const [issueNumber, group] of linked) {
    const issue = unassigned.get(issueNumber);

    if (!onBoard.has(issueNumber) && issue) {
      cards.push({ key: `issue:${issueNumber}`, issue, issueNumber, sessions: group, unassigned: true });
    }
  }

  for (const [checkout, group] of byCheckout) {
    cards.push({ key: `session:${checkout}`, issue: null, issueNumber: null, sessions: group });
  }

  return cards;
}
