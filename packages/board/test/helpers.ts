import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cwdKey } from '../src/merge.js';
import type { IssueCard, Session } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(here, 'fixtures', `${name}.json`), 'utf8'));
}

export const issues = fixture('issues') as IssueCard[];

/**
 * Every field a recorded session must carry, because a cast is not a check — a row missing one reads `undefined` where the type promised
 * `string | null`. `satisfies` fails the typecheck when `Session` grows a field; the assertion below fails the run until it is re-recorded.
 */
const SESSION_KEYS = {
  agent: true,
  sessionId: true,
  shortId: true,
  name: true,
  title: true,
  cwd: true,
  kind: true,
  startedAt: true,
  status: true,
  state: true,
  branch: true,
  issueNumber: true,
  transcriptWrittenAt: true,
  activity: true,
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

/** The directories the unlinked sessions run in — one card each, so the count the board produces is this set's size. */
export const unlinkedCwds = new Set(unlinked.map((s) => cwdKey(s.cwd)));
