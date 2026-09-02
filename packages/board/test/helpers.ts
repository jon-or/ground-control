import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
