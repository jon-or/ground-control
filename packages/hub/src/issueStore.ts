import { mkdirSync } from 'node:fs';
import { groundControlDirOf } from '@ground-control/core';
import { EMPTY_KNOWN_ISSUES, readKnownIssues } from '@ground-control/board';
import type { KnownIssues } from '@ground-control/board';
import { read, writeIfChanged } from './fs.js';
import { issuesPathOf } from './paths.js';

/**
 * The issues the board has looked up by number, as a file rather than as one hub's memory. This is what makes the
 * common case free: an issue read while it was assigned is still named on the card once it is not, with no round
 * trip and nothing for an offline board to be missing.
 */
export interface IssueStore {
  read(): KnownIssues;
  write(state: KnownIssues): boolean;
}

/**
 * Key order, fixed. A card reaches this file either straight from a source or back out of the parser, in two
 * different orders, and `writeIfChanged` compares text — so without this the file churns on alternating polls.
 */
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

export function makeIssueStore(home: string): IssueStore {
  const path = issuesPathOf(home);

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
        mkdirSync(groundControlDirOf(home), { recursive: true });
        writeIfChanged(path, `${JSON.stringify(ordered(state), null, 2)}\n`);

        return true;
      } catch {
        // A lookup that could not be stored is one the board takes again. Failing the render is worse.
        return false;
      }
    },
  };
}
