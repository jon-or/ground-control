import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ReadText } from '../src/machine.js';

const here = dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(here, 'fixtures', `${name}.json`), 'utf8'));
}

/**
 * Deliberately not the machine's own home: a reader ignoring its injected home would land on the real directory
 * and pass. Nothing exists here, so only a reader using what it was handed finds anything.
 */
export const HOME = '/nowhere/home';

/** The recorded git reads, keyed by forward-slash path. An unrecorded path reads as absent, which is the truth. */
export function gitReads(): ReadText {
  const reads = fixture('git-reads') as Record<string, string | null>;

  return (path) => reads[path] ?? null;
}
