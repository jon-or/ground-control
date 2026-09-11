import { describe, expect, it } from 'vitest';
import type { Logger } from '@ground-control/core';
import {
  PROFILE_FRESH_MS,
  PROFILE_QUERY,
  PROFILE_RETRY_MS,
  dedupeLogins,
  fetchProfiles,
  linkTargets,
  normalizeLinks,
  resolveActor,
  resolveLogin,
} from '../src/index.js';
import type { GhOptions, GhRunner, ProfileEntry, Result } from '../src/index.js';
import { fixture } from './helpers.js';

function logger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];

  return {
    warnings,
    debug: () => undefined,
    info: () => undefined,
    warn: (message) => {
      warnings.push(message);
    },
    error: () => undefined,
    setLevel: () => undefined,
    level: () => 'debug',
    watch: () => () => undefined,
  };
}

const NOW = Date.parse('2026-09-11T10:00:00Z');

/** Answer each login from a table and fail on one the test did not expect. */
function runnerFor(answers: Record<string, Result<unknown>>): GhRunner & { calls: string[][]; bounds: (GhOptions | undefined)[] } {
  const calls: string[][] = [];
  const bounds: (GhOptions | undefined)[] = [];
  const run = (async (args: string[], options?: GhOptions): Promise<Result<unknown>> => {
    calls.push(args);
    bounds.push(options);

    const login = args.find((arg) => arg.startsWith('login='))?.slice('login='.length) ?? '';
    const answer = answers[login];

    if (answer === undefined) {
      throw new Error(`profile read for ${login} was not expected`);
    }

    return answer;
  }) as GhRunner & { calls: string[][]; bounds: (GhOptions | undefined)[] };

  run.calls = calls;
  run.bounds = bounds;

  return run;
}

const DEV_1 = fixture('profile') as { data: { user: { login: string; name: string; avatarUrl: string } } };
// Derived from the recorded bot profile: GitHub's User.name is null for an account with no display name, which neither recording account is.
const NAMELESS = { data: { user: { ...(fixture('profile-bot') as typeof DEV_1).data.user, name: null } } };

describe('normalizeLinks', () => {
  it('keeps string pairs of logins under lowercase aliases, trimmed, and nothing else', () => {
    const log = logger();

    expect(normalizeLinks({ ' Dev-1-Bot ': ' dev-1 ', 'dev-2-bot': 7, '': 'dev-3', 'dev-4-bot': 'not a login', 'dependabot[bot]': 'dev-5' }, [], log)).toEqual({
      'dev-1-bot': 'dev-1',
      'dependabot[bot]': 'dev-5',
    });
    expect(log.warnings).toEqual([
      'Ignoring linked account "dev-2-bot": both sides must be GitHub logins.',
      'Ignoring linked account "": both sides must be GitHub logins.',
      'Ignoring linked account "dev-4-bot": both sides must be GitHub logins.',
    ]);
  });

  it('reads anything but an object as no links', () => {
    expect(normalizeLinks('dev-1-bot=dev-1', [])).toEqual({});
    expect(normalizeLinks(['dev-1-bot', 'dev-1'], [])).toEqual({});
    expect(normalizeLinks(null, [])).toEqual({});
  });

  it('keeps the first of two aliases that differ only in case, and says so', () => {
    const log = logger();

    expect(normalizeLinks({ 'Dev-1-Bot': 'dev-1', 'dev-1-bot': 'dev-2' }, [], log)).toEqual({ 'dev-1-bot': 'dev-1' });
    expect(log.warnings).toEqual(['Ignoring linked account "dev-1-bot": it repeats another entry in a different case.']);
  });

  it('drops a link to itself, however it is cased', () => {
    const log = logger();

    expect(normalizeLinks({ 'dev-1': 'DEV-1' }, [], log)).toEqual({});
    expect(log.warnings).toEqual(['Ignoring linked account "dev-1": it links to itself.']);
  });

  it('drops a link whose target is itself an alias, so nothing resolves twice, and both sides of a mutual pair', () => {
    const log = logger();

    expect(normalizeLinks({ 'dev-1-bot': 'dev-1', 'dev-1': 'dev-0', 'a': 'b', 'b': 'A' }, [], log)).toEqual({ 'dev-1': 'dev-0' });
    expect(log.warnings).toEqual([
      'Ignoring linked account "dev-1-bot": its target dev-1 is itself linked.',
      'Ignoring linked account "a": its target b is itself linked.',
      'Ignoring linked account "b": its target A is itself linked.',
    ]);
  });

  it('warns when an alias among the configured logins links outside them, because its target becomes the developer', () => {
    const log = logger();

    expect(normalizeLinks({ 'dev-1-bot': 'dev-2', 'other-bot': 'dev-3' }, ['DEV-1-BOT'], log)).toEqual({ 'dev-1-bot': 'dev-2', 'other-bot': 'dev-3' });
    expect(log.warnings).toEqual(['dev-2 becomes a developer identity: dev-1-bot is in github.logins and links to it.']);
    expect(normalizeLinks({ 'dev-1-bot': 'dev-1' }, ['dev-1-bot', 'dev-1'], log)).toEqual({ 'dev-1-bot': 'dev-1' });
    expect(log.warnings).toHaveLength(1);
  });

  it('lists each target once, as configured', () => {
    expect(linkTargets({ 'dev-1-bot': 'dev-1', 'dev-1-agent': 'Dev-1', 'other-bot': 'dev-2' })).toEqual(['dev-1', 'dev-2']);
  });
});

describe('fetchProfiles', () => {
  it('reads each target once through the profile query and caches what GitHub said', async () => {
    const run = runnerFor({ 'dev-1': { ok: true, value: DEV_1 }, 'dev-1-bot': { ok: true, value: NAMELESS } });
    const cache = new Map<string, ProfileEntry>();

    await fetchProfiles(run, ['dev-1', 'dev-1-bot'], cache, NOW);

    expect(run.calls).toEqual([
      ['api', 'graphql', '-f', `query=${PROFILE_QUERY}`, '-f', 'login=dev-1'],
      ['api', 'graphql', '-f', `query=${PROFILE_QUERY}`, '-f', 'login=dev-1-bot'],
    ]);
    expect(run.bounds[0]).toEqual({ timeoutMs: 20_000 });
    expect(cache.get('dev-1')).toEqual({ profile: { login: 'dev-1', name: 'dev-1 Surname', avatarUrl: 'https://avatars.githubusercontent.com/dev-1?s=40' }, at: NOW });
    expect(cache.get('dev-1-bot')).toEqual({ profile: { login: 'dev-1-bot', name: null, avatarUrl: 'https://avatars.githubusercontent.com/dev-1-bot?s=40' }, at: NOW });
  });

  it('keeps a profile for a day, then reads it again', async () => {
    // The query carries the target as configured; the cache key ignores its case.
    const run = runnerFor({ 'Dev-1': { ok: true, value: DEV_1 } });
    const cache = new Map<string, ProfileEntry>([['dev-1', { profile: { login: 'dev-1', name: 'Old', avatarUrl: 'old' }, at: NOW }]]);

    await fetchProfiles(run, ['Dev-1'], cache, NOW + PROFILE_FRESH_MS - 1);
    expect(run.calls).toHaveLength(0);
    expect(cache.get('dev-1')?.profile?.name).toBe('Old');

    await fetchProfiles(run, ['Dev-1'], cache, NOW + PROFILE_FRESH_MS);
    expect(run.calls).toHaveLength(1);
    expect(cache.get('dev-1')?.profile?.name).toBe('dev-1 Surname');
  });

  it('records a login GitHub does not know as a failure, says so once, and tries again after an hour', async () => {
    const log = logger();
    const run = runnerFor({ 'gone': { ok: false, error: { kind: 'query-failed', message: 'gh: Could not resolve to a User with the login of gone.', remedy: 'Check it.' } } });
    const cache = new Map<string, ProfileEntry>();

    await fetchProfiles(run, ['gone'], cache, NOW, log);
    expect(cache.get('gone')).toEqual({ profile: null, at: NOW, failedAt: NOW });
    expect(log.warnings).toEqual(['Could not read the profile of linked account gone: gh: Could not resolve to a User with the login of gone.']);

    await fetchProfiles(run, ['gone'], cache, NOW + PROFILE_RETRY_MS - 1, log);
    expect(run.calls).toHaveLength(1);

    await fetchProfiles(run, ['gone'], cache, NOW + PROFILE_RETRY_MS, log);
    expect(run.calls).toHaveLength(2);
    expect(cache.get('gone')).toEqual({ profile: null, at: NOW, failedAt: NOW + PROFILE_RETRY_MS });
    expect(log.warnings).toHaveLength(1);
  });

  it('keeps the last profile through a failed refresh, quietly, and tries again after an hour rather than a day', async () => {
    const log = logger();
    const kept = { login: 'dev-1', name: 'Kept', avatarUrl: 'kept' };
    const run = runnerFor({ 'dev-1': { ok: false, error: { kind: 'query-failed', message: 'GraphQL: Something went wrong', remedy: 'Retry.' } } });
    const cache = new Map<string, ProfileEntry>([['dev-1', { profile: kept, at: NOW }]]);

    await fetchProfiles(run, ['dev-1'], cache, NOW + PROFILE_FRESH_MS, log);

    expect(cache.get('dev-1')).toEqual({ profile: kept, at: NOW, failedAt: NOW + PROFILE_FRESH_MS });
    expect(log.warnings).toEqual([]);

    await fetchProfiles(run, ['dev-1'], cache, NOW + PROFILE_FRESH_MS + PROFILE_RETRY_MS - 1, log);
    expect(run.calls).toHaveLength(1);
    await fetchProfiles(run, ['dev-1'], cache, NOW + PROFILE_FRESH_MS + PROFILE_RETRY_MS, log);
    expect(run.calls).toHaveLength(2);
  });

  it('treats a null user and an unreadable response as the same failure', async () => {
    const log = logger();
    const run = runnerFor({ 'nobody': { ok: true, value: { data: { user: null } } }, 'odd': { ok: true, value: { data: { user: { login: 7 } } } } });
    const cache = new Map<string, ProfileEntry>();

    await fetchProfiles(run, ['nobody', 'odd'], cache, NOW, log);

    expect(cache.get('nobody')).toEqual({ profile: null, at: NOW, failedAt: NOW });
    expect(cache.get('odd')).toEqual({ profile: null, at: NOW, failedAt: NOW });
    expect(log.warnings).toEqual([
      'Could not read the profile of linked account nobody: GitHub returned no user',
      'Could not read the profile of linked account odd: GitHub returned no user',
    ]);
  });

  it('leaves the cache alone when the CLI, credentials, or network are the problem, which the board read reports', async () => {
    const log = logger();
    const cache = new Map<string, ProfileEntry>([['dev-1', { profile: { login: 'dev-1', name: 'Kept', avatarUrl: 'kept' }, at: 0 }]]);
    const failures = [
      { kind: 'not-authenticated' as const },
      { kind: 'gh-missing' as const },
      { kind: 'offline' as const, transient: true },
      { kind: 'timed-out' as const, transient: true },
    ];

    for (const failure of failures) {
      const error = { ...failure, message: 'no', remedy: 'fix' };
      const run = runnerFor({ 'dev-1': { ok: false, error }, 'dev-2': { ok: false, error } });

      await fetchProfiles(run, ['dev-1', 'dev-2'], cache, NOW, log);
    }

    expect(cache.get('dev-1')).toEqual({ profile: { login: 'dev-1', name: 'Kept', avatarUrl: 'kept' }, at: 0 });
    expect(cache.has('dev-2')).toBe(false);
    expect(log.warnings).toEqual([]);
  });
});

describe('resolving an account', () => {
  const links = { 'dev-1-bot': 'Dev-1', 'gone-bot': 'gone' };
  const profiles = new Map<string, ProfileEntry>([
    ['dev-1', { profile: { login: 'dev-1', name: 'dev-1 Surname', avatarUrl: 'https://example.test/dev-1' }, at: NOW }],
    ['gone', { profile: null, at: NOW }],
  ]);

  it('shows a linked alias as its target, with the target face and name and the alias as provenance', () => {
    expect(resolveActor(links, profiles, { login: 'DEV-1-BOT', avatarUrl: 'https://example.test/bot', name: null })).toEqual({
      login: 'dev-1',
      avatarUrl: 'https://example.test/dev-1',
      name: 'dev-1 Surname',
      aliasOf: 'DEV-1-BOT',
    });
    expect(resolveLogin(links, profiles, 'dev-1-bot')).toBe('dev-1');
  });

  it('keeps the alias face under the target login as configured when the profile could not be read', () => {
    expect(resolveActor(links, profiles, { login: 'gone-bot', avatarUrl: 'https://example.test/bot' })).toEqual({
      login: 'gone',
      avatarUrl: 'https://example.test/bot',
      name: null,
      aliasOf: 'gone-bot',
    });
    expect(resolveActor({ 'new-bot': 'unread' }, profiles, { login: 'new-bot' })).toEqual({ login: 'unread', avatarUrl: null, name: null, aliasOf: 'new-bot' });
    expect(resolveLogin(links, profiles, 'gone-bot')).toBe('gone');
  });

  it('passes an unlinked account through with no provenance', () => {
    expect(resolveActor(links, profiles, { login: 'dev-2', avatarUrl: 'https://example.test/dev-2', name: 'Two' })).toEqual({
      login: 'dev-2',
      avatarUrl: 'https://example.test/dev-2',
      name: 'Two',
    });
    expect(resolveActor(links, profiles, { login: 'dev-2' })).toEqual({ login: 'dev-2', avatarUrl: null, name: null });
    expect(resolveLogin(links, profiles, 'dev-2')).toBe('dev-2');
  });

  it('lists logins once, ignoring case, in first-seen order', () => {
    expect(dedupeLogins(['dev-1', 'DEV-1', 'dev-2', 'dev-1'])).toEqual(['dev-1', 'dev-2']);
  });
});
