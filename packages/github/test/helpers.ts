import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { GhOptions, GhRunner, GithubConfig, Result } from '../src/index.js';

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
    projectOwner: '',
    statusField: 'Status',
    cardSource: 'project',
    maxPages: 5,
    reviewStatuses: ['🔍 Dev Review'],
    avatar: { review: 'pull-request-author', offReview: 'assignee' },
    ...over,
  };
}

/** Return recorded pages in order and record arguments. Fail on excess requests instead of repeating the last page. */
export function runnerOf(...pages: unknown[]): GhRunner & { calls: string[][]; bounds: (GhOptions | undefined)[] } {
  const calls: string[][] = [];
  const bounds: (GhOptions | undefined)[] = [];
  let i = 0;

  const run = (async (args: string[], options?: GhOptions): Promise<Result<unknown>> => {
    calls.push(args);
    bounds.push(options);
    const page = pages[i];
    i++;

    if (page === undefined) {
      throw new Error(`runner asked for page ${i} but only ${pages.length} were recorded`);
    }

    return { ok: true, value: page };
  }) as GhRunner & { calls: string[][]; bounds: (GhOptions | undefined)[] };

  run.calls = calls;
  run.bounds = bounds;

  return run;
}
