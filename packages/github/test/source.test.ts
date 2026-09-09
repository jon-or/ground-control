import { describe, expect, it } from 'vitest';
import { GITHUB_SOURCE_ID, detectLogins, makeGithubSource, readGithubConfig } from '../src/source.js';
import type { GithubSourceDeps } from '../src/source.js';
import type { AssignedIssues, GithubConfig } from '../src/types.js';

function accepted(raw: unknown): GithubConfig {
  const parsed = readGithubConfig(raw);

  if ('failure' in parsed) {
    throw new Error(`expected this to be accepted: ${parsed.failure.message}`);
  }

  return parsed.config;
}

function refusal(raw: unknown): string {
  const parsed = readGithubConfig(raw);

  if (!('failure' in parsed)) {
    throw new Error('expected this to be refused');
  }

  expect(parsed.failure).toMatchObject({ subject: 'github', kind: 'bad-config' });

  return parsed.failure.message;
}

describe('the GitHub entry in a pushed configuration', () => {
  /** Default settings used before a browser-started hub receives client configuration. */
  it('fills in everything but the repository', () => {
    expect(accepted({ repo: 'example-org/example-repo' })).toEqual({
      ghPath: 'gh',
      repo: 'example-org/example-repo',
      logins: [],
      projectNumber: 0,
      projectOwner: '',
      statusField: 'Status',
      cardSource: 'project',
      maxPages: 5,
    });
  });

  it('trims the project owner and field name, and refuses a field name with nothing in it', () => {
    const read = accepted({ repo: 'o/r', projectOwner: ' someone ', statusField: ' Stage ' });

    expect(read.projectOwner).toBe('someone');
    expect(read.statusField).toBe('Stage');
    expect(accepted({ repo: 'o/r', projectOwner: '   ' }).projectOwner).toBe('');
    expect(refusal({ repo: 'o/r', statusField: '   ' })).toContain('statusField');
  });

  it('takes what the developer set', () => {
    const read = accepted({
      repo: 'example-org/example-repo',
      ghPath: 'gh',
      logins: ['dev-1', 'dev-2'],
      projectNumber: 3,
      cardSource: 'issueSearch',
      maxPages: 2,
    });

    expect(read.logins).toEqual(['dev-1', 'dev-2']);
    expect(read.cardSource).toBe('issueSearch');
    expect(read.maxPages).toBe(2);
  });

  it('refuses a configuration naming no repository, which every query needs', () => {
    expect(refusal({ repo: '' })).toContain('repo');
    expect(refusal({ ghPath: 'gh' })).toContain('repo');
  });

  /** Treat absent browser-startup configuration as missing settings. */
  it('reports missing configuration', () => {
    expect(refusal({})).toBe('No GitHub repository is configured.');
    expect(refusal(undefined)).toBe('No GitHub repository is configured.');
  });

  /** How much of someone's GitHub one client may ask the hub for, which is why it is a bound and not a default. */
  it('refuses a page count outside the bound', () => {
    expect(refusal({ repo: 'o/r', maxPages: 0 })).toContain('maxPages');
    expect(refusal({ repo: 'o/r', maxPages: 21 })).toContain('maxPages');
    expect(accepted({ repo: 'o/r', maxPages: 20 }).maxPages).toBe(20);
  });

  it('refuses a CLI path that is neither a command name nor a file, as the agent paths are refused', () => {
    expect(refusal({ repo: 'o/r', ghPath: '' })).toContain('ghPath');
    expect(refusal({ repo: 'o/r', ghPath: 'd:/nope/gh.exe' })).toContain('ghPath');
  });

  it('refuses a negative project and a card source it has no query for', () => {
    expect(refusal({ repo: 'o/r', projectNumber: -1 })).toContain('projectNumber');
    expect(refusal({ repo: 'o/r', cardSource: 'everything' })).toContain('cardSource');
  });

  /** Reject unknown keys rather than accepting ineffective settings. */
  it('refuses a key it does not know', () => {
    expect(refusal({ repo: 'o/r', ghToken: 'secret' })).toContain('ghToken');
  });

  it('refuses something that is not an entry at all, rather than reading past it', () => {
    expect(refusal(42)).toContain('could not be read');
    expect(refusal('{"repo":"o/r"}')).toContain('could not be read');
  });
});


const ISSUES: AssignedIssues = {
  cards: [],
  matched: 4,
  totalAssigned: 6,
  notOnProject: 2,
  fieldProblem: null,
  truncated: false,
  fetchedAt: '2026-09-04T09:00:00Z',
  sourceQuery: 'assignee:dev-1',
};

function source(over: Partial<GithubSourceDeps> = {}) {
  const asked: GithubConfig[] = [];

  const made = makeGithubSource({
    fetch: async (given) => {
      asked.push(given);

      return { ok: true, value: ISSUES };
    },
    detectLogins: async () => ['detected-dev'],
    ...over,
  });

  return { source: made, asked };
}

describe('the GitHub work source', () => {
  it('is registered under the id its configuration key carries', () => {
    expect(source().source.id).toBe(GITHUB_SOURCE_ID);
    expect(GITHUB_SOURCE_ID).toBe('github');
  });

  it('reads with the configuration it was given, and reports who it read for', async () => {
    const { source: github, asked } = source();

    expect(github.configure({ repo: 'example-org/example-repo', logins: ['dev-1'] })).toBeNull();

    const reading = await github.read();

    expect(asked[0]?.repo).toBe('example-org/example-repo');
    expect(reading.items).toMatchObject({ owners: ['dev-1'], matched: 4, totalAssigned: 6, notOnProject: 2 });
    expect(reading.failure).toBeNull();
    expect(reading.needs).toBeNull();
  });

  /** Reading with the settings from before the refused ones is reading with settings nobody set. */
  it('disables reads after rejected configuration', async () => {
    const { source: github, asked } = source();

    github.configure({ repo: 'example-org/example-repo', logins: ['dev-1'] });
    expect(github.configure({ repo: '' })?.kind).toBe('bad-config');

    const reading = await github.read();

    expect(asked).toHaveLength(0);
    expect(reading).toEqual({ items: null, failure: null, needs: null });
  });

  it('returns no data before configuration', async () => {
    const { source: github, asked } = source();

    expect(await github.read()).toEqual({ items: null, failure: null, needs: null });
    expect(asked).toHaveLength(0);
  });

  /** The hub has no screen: what it detected is offered to a client to put to the developer (R26, R28). */
  it('asks for the accounts it has none of rather than reading a whole repository', async () => {
    const { source: github, asked } = source();

    github.configure({ repo: 'example-org/example-repo' });

    const reading = await github.read();

    expect(asked).toHaveLength(0);
    expect(reading.failure?.kind).toBe('no-logins');
    expect(reading.needs).toEqual({ detected: ['detected-dev'] });
  });

  it('names itself on a failed read, and keeps no items to go with it', async () => {
    const { source: github } = source({
      fetch: async () => ({
        ok: false,
        error: { kind: 'query-failed', message: 'GitHub failed.', remedy: 'Try again.' },
      }),
    });

    github.configure({ repo: 'example-org/example-repo', logins: ['dev-1'] });

    const reading = await github.read();

    expect(reading.items).toBeNull();
    expect(reading.failure).toMatchObject({ subject: GITHUB_SOURCE_ID, kind: 'query-failed' });
  });
});

/** Exercise default dependencies with a nonexistent CLI name to prevent real gh or network access. */
describe('the GitHub work source as it ships', () => {
  const ABSENT_CLI = 'gh-not-on-any-path';

  it('reads through the GitHub CLI', async () => {
    const github = makeGithubSource();

    github.configure({ repo: 'example-org/example-repo', ghPath: ABSENT_CLI, logins: ['dev-1'] });

    expect((await github.read()).failure).toMatchObject({ subject: GITHUB_SOURCE_ID, kind: 'gh-missing' });
  });

  /** The whole of what an absent CLI can prove: the hub asks for accounts and is told none, rather than thrown at. */
  it('reports no accounts, rather than failing, when the CLI cannot be asked', async () => {
    expect(await detectLogins(ABSENT_CLI)).toEqual([]);
  });
});

describe('a board nobody has named a repository for', () => {
  it('reports the missing setting', () => {
    // Report blank default repository settings directly; removing an already absent value cannot fix it.
    const outcome = readGithubConfig({ ghPath: 'gh', repo: '', logins: [], projectNumber: 3, cardSource: 'project', maxPages: 5 });

    expect('failure' in outcome && outcome.failure).toMatchObject({ kind: 'bad-config' });
    expect('failure' in outcome && outcome.failure.message).toContain('No GitHub repository is configured');
    expect('failure' in outcome && outcome.failure.remedy).toContain('groundControl.github.repo');
  });

  it('reads whitespace as no repository at all', () => {
    expect('failure' in readGithubConfig({ repo: '   ' })).toBe(true);
  });
});

describe('one issue read by number', () => {
  const NEVER = new AbortController().signal;

  function sourceWith(read: GithubSourceDeps['readCard'], raw: unknown = { repo: 'example-org/example-repo' }) {
    const source = makeGithubSource({ readCard: read });
    source.configure(raw);

    return source;
  }

  it('matches the configured repository case-insensitively', async () => {
    const asked: string[] = [];
    const source = sourceWith(async (_config, owner, name, number) => {
      asked.push(`${owner}/${name}#${number}`);

      return { ok: true, value: { number, title: 'A card' } as never };
    });

    expect(await source.readCard!('github.com/Example-Org/Example-Repo'.toLowerCase(), 42, NEVER)).toMatchObject({
      card: { number: 42 },
      failure: null,
    });
    expect(asked).toEqual(['example-org/example-repo#42']);
  });

  /** Do not resolve issue numbers against another checkout's repository. */
  it('refuses a repository that is not the one it is configured for, without spending a read', async () => {
    const asked: string[] = [];
    const source = sourceWith(async (_config, owner, name, number) => {
      asked.push(`${owner}/${name}#${number}`);

      return { ok: true, value: null };
    });

    // Return null for unserved repositories so the caller cannot cache the issue as missing.
    expect(await source.readCard!('github.com/other-org/other-repo', 42, NEVER)).toBeNull();
    expect(await source.readCard!('example.ghe.com/example-org/example-repo', 42, NEVER)).toBeNull();
    expect(asked).toEqual([]);
  });

  it('skips card lookups with rejected settings', async () => {
    const source = sourceWith(async () => ({ ok: true, value: { number: 1 } as never }), { repo: '' });

    expect(await source.readCard!('github.com/example-org/example-repo', 42, NEVER)).toBeNull();
  });

  it('returns a successful null result for a missing issue', async () => {
    const source = sourceWith(async () => ({ ok: true, value: null }));

    expect(await source.readCard!('github.com/example-org/example-repo', 99999, NEVER)).toEqual({ card: null, failure: null });
  });

  it('identifies the source in lookup failures', async () => {
    const source = sourceWith(async () => ({ ok: false, error: { kind: 'offline', message: 'no network', remedy: 'try later' } }));

    expect(await source.readCard!('github.com/example-org/example-repo', 42, NEVER)).toEqual({
      card: null,
      failure: { subject: GITHUB_SOURCE_ID, kind: 'offline', message: 'no network', remedy: 'try later' },
    });
  });
});
