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
export const sessions = fixture('sessions') as Session[];

export const onBoard = new Set(issues.map((issue) => issue.number));

export const linkedOnBoard = sessions.filter((s) => s.issueNumber !== null && onBoard.has(s.issueNumber));
export const linkedOffBoard = sessions.filter((s) => s.issueNumber !== null && !onBoard.has(s.issueNumber));
export const unlinked = sessions.filter((s) => s.issueNumber === null);

/** The directories the unlinked sessions run in — one card each, so the count the board produces is this set's size. */
export const unlinkedCwds = new Set(unlinked.map((s) => cwdKey(s.cwd)));
