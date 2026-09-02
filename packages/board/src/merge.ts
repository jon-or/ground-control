import type { BoardCard, IssueCard, Session } from './types.js';

/**
 * The directory a session runs in, as a comparable key. Case is folded because two CLIs can report the same Windows
 * path with a different drive-letter case. The cost lands only on a case-sensitive filesystem, where two directories
 * differing just in case become one card named after whichever session is newest.
 */
export function cwdKey(cwd: string): string {
  return cwd.split('\\').join('/').replace(/\/+$/, '').toLowerCase();
}

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
 * Every issue and every session on one board. Issue order is the order they were read; cards for issues the
 * developer does not own, then sessions with no issue, follow. Every session lands on exactly one card.
 */
export function mergeBoard(issues: IssueCard[], sessions: Session[]): BoardCard[] {
  const linked = groupSessions(
    sessions.filter((session) => session.issueNumber !== null),
    (session) => session.issueNumber as number,
  );

  // A session naming no issue belongs to its directory rather than to itself: the checkout is what such work shares.
  const byCwd = groupSessions(
    sessions.filter((session) => session.issueNumber === null),
    (session) => cwdKey(session.cwd),
  );

  const onBoard = new Set(issues.map((issue) => issue.number));

  const cards: BoardCard[] = issues.map((issue) => ({
    key: `issue:${issue.number}`,
    issue,
    issueNumber: issue.number,
    sessions: linked.get(issue.number) ?? [],
  }));

  for (const [issueNumber, group] of linked) {
    if (!onBoard.has(issueNumber)) {
      cards.push({ key: `issue:${issueNumber}`, issue: null, issueNumber, sessions: group });
    }
  }

  for (const [cwd, group] of byCwd) {
    cards.push({ key: `session:${cwd}`, issue: null, issueNumber: null, sessions: group });
  }

  return cards;
}
