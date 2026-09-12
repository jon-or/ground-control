import { describe, expect, it } from 'vitest';
import { GITHUB_SOURCE_ID, detectLogins, makeGithubSource, readGithubConfig } from '../src/source.js';
import type { GithubSettings, GithubSourceDeps } from '../src/source.js';
import type { AssignedIssues, GithubConfig } from '../src/types.js';

function accepted(raw: unknown): GithubSettings {
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
      linkedAccounts: {},
    });
  });

  it('refuses board policy keys in client settings, which the hub supplies', () => {
    expect(refusal({ repo: 'o/r', avatar: 'assignee' })).toContain('avatar');
  });

  it('takes the board policy from the hub, not from the client settings', () => {
    const { source: made, asked } = source();

    made.configure({ repo: 'example-org/example-repo', logins: ['dev-1'] }, { reviewStatuses: ['Awaiting Review'], avatar: { review: 'assignee', offReview: 'issue-author' } });

    return made.read().then(() => {
      expect(asked[0]).toMatchObject({ reviewStatuses: ['Awaiting Review'], avatar: { review: 'assignee', offReview: 'issue-author' } });
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
    expect(refusal({ repo: 'o/r', maxPages: 11 })).toContain('maxPages');
    expect(accepted({ repo: 'o/r', maxPages: 10 }).maxPages).toBe(10);
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

/** Linked accounts resolve through profiles the source reads before any of its entry points answer (R28). */
describe('the GitHub work source with linked accounts', () => {
  const NEVER = new AbortController().signal;
  const PROFILE = { login: 'dev-1', name: 'dev-1 Surname', avatarUrl: 'https://avatars.githubusercontent.com/dev-1?s=40' };

  function linked(over: Partial<GithubSourceDeps> = {}) {
    const reads: { targets: string[]; now: number }[] = [];
    // Every reader records the configuration it was handed, so the profiles it saw are assertable.
    const served: GithubConfig[] = [];
    let release: (() => void) | null = null;

    const { source: github, asked } = source({
      readProfiles: async (_config, targets, cache, now) => {
        reads.push({ targets: [...targets], now });
        await new Promise<void>((resolve) => {
          release = resolve;
        });

        for (const target of targets) {
          if (!['dev-1', 'dev-2'].includes(target)) {
            throw new Error(`profile read for ${target} was not expected`);
          }

          cache.set(target.toLowerCase(), { profile: { ...PROFILE, login: target }, at: now });
        }
      },
      readContext: async (config, card) => {
        served.push(config);

        return { context: { issueNumber: card.number, logins: config.logins, repository: '' } as never, failure: null };
      },
      readDetail: async (config) => {
        served.push(config);

        return { detail: null, failure: null };
      },
      readCustody: async (config) => {
        served.push(config);

        return { history: null, failure: null };
      },
      readCard: async (config) => {
        served.push(config);

        return { ok: true, value: { number: 1, assignees: config.logins } as never };
      },
      ...over,
    });

    github.configure({
      repo: 'example-org/example-repo',
      logins: ['dev-1-bot', 'dev-1'],
      linkedAccounts: { 'dev-1-bot': 'dev-1', 'dev-1-agent': 'Dev-1', 'other-bot': 'dev-2' },
    });

    return { github, asked, reads, served, release: () => release?.() };
  }

  it('reads the profile of every distinct link target once before any reader answers, and shares the read with everything asked meanwhile', async () => {
    const { github, asked, reads, served, release } = linked();
    const card = { number: 1, url: 'https://github.com/example-org/example-repo/issues/1', pullRequest: null } as never;

    const reading = github.read();
    const context = github.readContext!(card, NEVER);
    const detail = github.readDetail!(card, 'issue', NEVER);
    const custody = github.readCustody!(card, NEVER);
    const one = github.readCard!('github.com/example-org/example-repo', 1, NEVER);

    await Promise.resolve();
    expect(reads).toHaveLength(1);
    expect(reads[0]?.targets).toEqual(['dev-1', 'dev-2']);
    expect(asked).toHaveLength(0);
    expect(served).toHaveLength(0);

    release();

    // The board read passes the profiles it waited for on to the fetch, and reports the owners as they resolve and as written.
    expect((await reading).items?.owners).toEqual(['dev-1', 'dev-1-bot']);
    expect(asked[0]?.profiles.get('dev-1')?.profile).toEqual(PROFILE);
    expect(asked[0]?.linkedAccounts).toEqual({ 'dev-1-bot': 'dev-1', 'dev-1-agent': 'Dev-1', 'other-bot': 'dev-2' });
    await context;
    await detail;
    await custody;
    await one;
    expect(reads).toHaveLength(1);
    expect(served).toHaveLength(4);
    expect(served.map((config) => config.profiles.get('dev-1')?.profile)).toEqual([PROFILE, PROFILE, PROFILE, PROFILE]);
  });

  it('asks for accounts before it spends a profile read, since there is nothing to show them on', async () => {
    const { github, reads } = linked();

    github.configure({ repo: 'example-org/example-repo', linkedAccounts: { 'dev-1-bot': 'dev-1' } });

    expect((await github.read()).failure?.kind).toBe('no-logins');
    expect(reads).toHaveLength(0);
  });

  it('warns about the links it drops once per change of settings, not on every client that resends them', () => {
    const warnings: string[] = [];
    const log = { debug: () => undefined, info: () => undefined, warn: (message: string) => void warnings.push(message), error: () => undefined, setLevel: () => undefined, level: () => 'debug' as const, watch: () => () => undefined };
    const { source: github } = source({ log });
    const settings = { repo: 'example-org/example-repo', logins: ['dev-1'], linkedAccounts: { 'dev-1': 'dev-1' } };

    github.configure(settings);
    github.configure(settings);
    expect(warnings).toEqual(['Ignoring linked account "dev-1": it links to itself.']);

    github.configure({ ...settings, linkedAccounts: { 'dev-2': 'dev-2' } });
    expect(warnings).toHaveLength(2);
  });

  it('asks again on the next read, leaving the profile reader to decide what is stale', async () => {
    const { github, reads, release } = linked();

    const first = github.read();
    release();
    await first;

    const second = github.read();
    await Promise.resolve();
    expect(reads).toHaveLength(2);
    release();
    await second;
  });

  it('reports the configured logins as they resolve and as written, so a board filtered to the bot still passes the gate', async () => {
    const { github, release } = linked();

    github.configure({ repo: 'example-org/example-repo', logins: ['dev-1-bot'], linkedAccounts: { 'dev-1-bot': 'dev-1' } });

    const reading = github.read();
    release();

    expect((await reading).items?.owners).toEqual(['dev-1', 'dev-1-bot']);
  });

  it('drops the links it cannot use and keeps the rest, rather than refusing the settings', () => {
    const { github, asked, release } = linked();

    expect(github.configure({ repo: 'example-org/example-repo', logins: ['dev-1'], linkedAccounts: { 'dev-1': 'dev-1', 'a b': 'dev-2', 'dev-1-bot': 'dev-1' } })).toBeNull();

    const reading = github.read();
    release();

    return reading.then(() => {
      expect(asked[0]?.linkedAccounts).toEqual({ 'dev-1-bot': 'dev-1' });
    });
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
