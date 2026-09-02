import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { GhRunner, GithubConfig, Result } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(here, 'fixtures', `${name}.json`), 'utf8'));
}

export function config(over: Partial<GithubConfig> = {}): GithubConfig {
  return {
    ghPath: 'gh',
    repo: 'example-org/example-repo',
    logins: ['dev-1'],
    projectNumber: 3,
    cardSource: 'project',
    maxPages: 5,
    ...over,
  };
}

/**
 * Serves recorded responses in order and records the args it was called with. Asking for a page that was not
 * recorded is a failure, not a repeat — repeating the last page hides an over-paging bug from every test.
 */
export function runnerOf(...pages: unknown[]): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;

  const run = (async (args: string[]): Promise<Result<unknown>> => {
    calls.push(args);
    const page = pages[i];
    i++;

    if (page === undefined) {
      throw new Error(`runner asked for page ${i} but only ${pages.length} were recorded`);
    }

    return { ok: true, value: page };
  }) as GhRunner & { calls: string[][] };

  run.calls = calls;

  return run;
}
