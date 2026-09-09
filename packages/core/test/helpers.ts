import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ReadText } from '../src/machine.js';

const here = dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(here, 'fixtures', `${name}.json`), 'utf8'));
}

/** Use a nonexistent home so tests cannot pass by reading the real filesystem. */
export const HOME = '/nowhere/home';

/** The recorded git reads, keyed by forward-slash path. An unrecorded path reads as absent, which is the truth. */
export function gitReads(): ReadText {
  const reads = fixture('git-reads') as Record<string, string | null>;

  return (path) => reads[path] ?? null;
}
