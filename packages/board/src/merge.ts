import type { BoardCard, IssueCard, Session } from './types.js';

/**
 * Every issue and every session on one board. Issue order is the order they were read; cards for issues the
 * developer does not own, then sessions with no issue, follow. Every session lands on exactly one card.
 */
export function mergeBoard(issues: IssueCard[], sessions: Session[]): BoardCard[] {
  const linked = new Map<number, Session[]>();
  const unlinked: Session[] = [];

  for (const session of sessions) {
    if (session.issueNumber === null) {
      unlinked.push(session);
      continue;
    }

    const group = linked.get(session.issueNumber);

    if (group) {
      group.push(session);
    } else {
      linked.set(session.issueNumber, [session]);
    }
  }

  for (const group of linked.values()) {
    group.sort((a, b) => b.startedAt - a.startedAt);
  }

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

  // The agent is part of the key: two CLIs can mint the same session id, and they are then two cards, not one.
  for (const session of unlinked) {
    cards.push({
      key: `session:${session.agent}:${session.sessionId}`,
      issue: null,
      issueNumber: null,
      sessions: [session],
    });
  }

  return cards;
}
