import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { dirKey } from '@ground-control/core';
import type { CardPullRequest } from '@ground-control/github';
import type { IssueCard, Session } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(here, 'fixtures', `${name}.json`), 'utf8'));
}

/** What `fetchAssignedIssues` returned when the recording was made, which predates six of the pull request's fields. */
type RecordedCard = Omit<IssueCard, 'pullRequest'> & {
  pullRequest:
    | (Omit<CardPullRequest, 'author' | 'isDraft' | 'reviewDecision' | 'updatedAt' | 'headOid' | 'checksRed'> &
        Partial<CardPullRequest>)
    | null;
};

/**
 * A cast is not a check: it would hand every test `undefined` where the type promised a value, and a lane and the card's
 * evidence now read these. So each is filled where the recording holds nothing, and a pull request is nobody's until a test says whose it is.
 */
function completed(cards: RecordedCard[]): IssueCard[] {
  return cards.map((card) => ({
    ...card,
    pullRequest:
      card.pullRequest && {
        ...card.pullRequest,
        author: card.pullRequest.author ?? null,
        isDraft: card.pullRequest.isDraft ?? false,
        reviewDecision: card.pullRequest.reviewDecision ?? null,
        updatedAt: card.pullRequest.updatedAt ?? null,
        headOid: card.pullRequest.headOid ?? null,
        checksRed: card.pullRequest.checksRed ?? null,
      },
  }));
}

export const issues = completed(fixture('issues') as RecordedCard[]);

/**
 * Every field a recorded session must carry, because a cast is not a check — a row missing one reads `undefined` where the type promised
 * `string | null`. `satisfies` fails the typecheck when `Session` grows a field; the assertion below fails the run until it is re-recorded.
 */
const SESSION_KEYS = {
  agent: true,
  sessionId: true,
  pid: true,
  title: true,
  cwd: true,
  checkoutRoot: true,
  startedAt: true,
  branch: true,
  repository: true,
  issueNumber: true,
  transcriptWrittenAt: true,
  activity: true,
  finished: true,
  details: true,
} satisfies Record<keyof Session, true>;

function checked(rows: unknown[]): Session[] {
  rows.forEach((row, index) => {
    for (const key of Object.keys(SESSION_KEYS)) {
      if (!Object.hasOwn(row as object, key)) {
        throw new Error(`sessions.json row ${index} has no "${key}" — re-record it with test/fixtures/record.js`);
      }
    }
  });

  return rows as Session[];
}

export const sessions = checked(fixture('sessions') as unknown[]);

export const onBoard = new Set(issues.map((issue) => issue.number));

export const linkedOnBoard = sessions.filter((s) => s.issueNumber !== null && onBoard.has(s.issueNumber));
export const linkedOffBoard = sessions.filter((s) => s.issueNumber !== null && !onBoard.has(s.issueNumber));
export const unlinked = sessions.filter((s) => s.issueNumber === null);

/**
 * The issues behind the recorded off-board sessions, as the hub's lookup would hand them to `mergeBoard`. Built here
 * rather than recorded: the issue fixture is the assigned search, which by definition never returns one of these.
 */
export const offBoardIssues = new Map<number, IssueCard>(
  linkedOffBoard.map((session) => [
    session.issueNumber!,
    {
      number: session.issueNumber!,
      title: `Issue ${session.issueNumber} somebody else now owns`,
      repository: 'example-org/example-repo',
      state: 'OPEN',
      type: null,
      typeColor: null,
      url: `https://github.com/example-org/example-repo/issues/${session.issueNumber}`,
      status: '🚦 QA',
      statusColor: null,
      statusChangedAt: null,
      assignees: ['dev-2'],
      avatar: null,
      pullRequest: null,
      updatedAt: '2026-09-01T00:00:00Z',
    },
  ]),
);

/** The key `mergeBoard` gives a card with no issue: the repository and branch its sessions share, else the checkout. */
export function checkoutKeyOf(session: Session): string {
  return session.repository !== null && session.branch !== null
    ? `${session.repository}#${session.branch}`
    : dirKey(session.checkoutRoot ?? session.cwd);
}

/** The checkouts the unlinked sessions run in — one card each, so the count the board produces is this set's size. */
export const unlinkedCheckouts = new Set(unlinked.map(checkoutKeyOf));
