import { mkdirSync } from 'node:fs';
import { EMPTY_KNOWN_ISSUES, readKnownIssues } from '@ground-control/board';
import type { KnownIssues } from '@ground-control/board';
import { read, writeIfChanged } from './fs.js';
import { issuesPathOf } from './paths.js';

/** Cache issue lookups so cards retain metadata after unassignment without another network request. */
export interface IssueStore {
  read(): KnownIssues;
  write(state: KnownIssues): boolean;
}

/** Sort keys before serialization so source/parser ordering differences do not trigger redundant writes. */
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(ordered);
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, held]) => held !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, held]) => [key, ordered(held)]),
  );
}

export function makeIssueStore(stateDir: string): IssueStore {
  const path = issuesPathOf(stateDir);

  return {
    read(): KnownIssues {
      const text = read(path);

      if (text === null) {
        return EMPTY_KNOWN_ISSUES;
      }

      try {
        return readKnownIssues(JSON.parse(text));
      } catch {
        // `readKnownIssues` already drops one bad entry at a time, so reaching here means the file is not JSON.
        return EMPTY_KNOWN_ISSUES;
      }
    },

    write(state: KnownIssues): boolean {
      try {
        mkdirSync(stateDir, { recursive: true });
        writeIfChanged(path, `${JSON.stringify(ordered(state), null, 2)}\n`);

        return true;
      } catch {
        // A failed write permits another lookup without failing rendering.
        return false;
      }
    },
  };
}
