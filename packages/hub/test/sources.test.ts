import { describe, expect, it } from 'vitest';
import { readGithubConfig } from '../src/sources.js';
import type { GithubConfig } from '@ground-control/github';

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
  /** A hub the browser started alone has only these, so what they are is what it reads with. */
  it('fills in everything but the repository', () => {
    expect(accepted({ repo: 'example-org/example-repo' })).toEqual({
      ghPath: 'gh',
      repo: 'example-org/example-repo',
      logins: [],
      projectNumber: 0,
      cardSource: 'project',
      maxPages: 5,
    });
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
    expect(refusal({})).toContain('repo');
    expect(refusal({ repo: '' })).toContain('repo');
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

  /** Strict: a key nothing reads is a setting the developer believes is doing something. */
  it('refuses a key it does not know', () => {
    expect(refusal({ repo: 'o/r', ghToken: 'secret' })).toContain('ghToken');
  });

  it('refuses something that is not an entry at all, rather than reading past it', () => {
    expect(refusal(42)).toContain('could not be read');
    expect(refusal('{"repo":"o/r"}')).toContain('could not be read');
  });
});
