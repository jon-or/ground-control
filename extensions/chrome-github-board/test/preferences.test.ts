import { describe, expect, it } from 'vitest';
import { allowsProject, filtersToMe, parseLogins, parsePreferences, presentationOf, projectPath, projectUrl, watchLogins, watchPreferences } from '../src/preferences.js';
import type { PreferenceState } from '../src/preferences.js';

describe('browser project preferences', () => {
  it.each(['/example/repo/issues/1', '/example/repo/pull/2', '/orgs/example/repositories', '/orgs/example/projects', '/', '/notifications'])('leaves non-project path %s unchanged', (path) => {
    expect(allowsProject({ enabled: true, projects: [], animations: true, replaceAvatars: true, filteredToMe: true, cardRows: true }, path)).toBe(false);
  });

  it('defaults an absent preference object to enabled on supported projects', () => {
    const state = parsePreferences(undefined);
    expect(state).toEqual({ value: { enabled: true, projects: [], animations: true, replaceAvatars: true, filteredToMe: true, cardRows: true }, error: null });
    expect(allowsProject(state.value, '/orgs/example/projects/3')).toBe(true);
    expect(allowsProject(state.value, '/example/repo/issues/3')).toBe(false);
  });

  it('normalizes owner case and view URLs without conflating owner kind or project number', () => {
    const state = parsePreferences({ enabled: true, projects: ['https://github.com/orgs/Example/projects/3/views/2?pane=issue#card', 'https://github.com/orgs/example/projects/3'] });
    expect(state.value?.projects).toEqual(['https://github.com/orgs/example/projects/3']);
    expect(allowsProject(state.value, '/orgs/EXAMPLE/projects/3/views/1')).toBe(true);
    expect(allowsProject(state.value, '/users/example/projects/3')).toBe(false);
    expect(allowsProject(state.value, '/orgs/example/projects/30')).toBe(false);
    expect(allowsProject(state.value, '/orgs/example-more/projects/3')).toBe(false);
  });

  it.each([
    null, false, [], {}, { enabled: true }, { enabled: 'true', projects: [] }, { enabled: true, projects: 'all' },
    { enabled: true, projects: [1] }, { enabled: true, projects: ['https://example.com/orgs/example/projects/3'] },
  ])('fails closed for malformed stored preferences %j', (raw) => {
    const state = parsePreferences(raw);
    expect(state.value).toBeNull();
    expect(state.error).toContain('invalid');
    expect(allowsProject(state.value, '/orgs/example/projects/3')).toBe(false);
  });

  it('keeps all projects ineligible when disabled despite a matching list', () => {
    const state = parsePreferences({ enabled: false, projects: ['https://github.com/users/example/projects/3'] });
    expect(allowsProject(state.value, '/users/example/projects/3')).toBe(false);
  });

  it.each([
    'http://github.com/orgs/example/projects/3', 'https://github.com.evil.test/orgs/example/projects/3',
    'https://user:secret@github.com/orgs/example/projects/3', 'https://github.com:444/orgs/example/projects/3',
    'https://github.com/orgs/example/projects/0', 'https://github.com/orgs/example/projects/03',
    'https://github.com/orgs/example/projects/3/settings', 'https://github.com/orgs/example/projects/3/views/0',
    'https://github.com/orgs/a/../example/projects/3', 'https://github.com/orgs/a/%2e%2e/example/projects/3',
    'https://github.com/orgs/example/projects/3\\views\\2', 'not a URL',
  ])('rejects unsupported project URL %s', (url) => {
    expect(projectUrl(url)).toBeNull();
  });

  it('accepts a personal project and canonicalizes a trailing slash', () => {
    expect(projectUrl(' https://github.com/users/Example/projects/42/ ')).toBe('https://github.com/users/example/projects/42');
    expect(projectPath('/orgs/example/projects/3-other')).toBeNull();
  });
});

function storageHarness() {
  let resolve!: (held: Record<string, unknown>) => void;
  let reject!: (error: Error) => void;
  const read = new Promise<Record<string, unknown>>((done, failed) => { resolve = done; reject = failed; });
  let listener: ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void) | null = null;
  let removed = false;
  const storage = {
    local: { get: () => read },
    onChanged: {
      addListener: (callback: NonNullable<typeof listener>) => { listener = callback; },
      removeListener: (callback: NonNullable<typeof listener>) => { removed = callback === listener; listener = null; },
    },
  } as unknown as typeof chrome.storage;
  const states: PreferenceState[] = [];
  const stop = watchPreferences(storage, (state) => states.push(state));
  return {
    resolve, reject, states, stop,
    get removed() { return removed; },
    change(changes: Record<string, chrome.storage.StorageChange>, area = 'local') { listener?.(changes, area); },
    async settle() { await read.catch(() => {}); await Promise.resolve(); await Promise.resolve(); },
  };
}

describe('preference loading', () => {
  it('does not allow access until the initial read completes', async () => {
    const h = storageHarness();
    expect(h.states).toEqual([]);
    h.resolve({ preferences: { enabled: false, projects: [] } });
    await h.settle();
    expect(h.states).toEqual([{ value: { enabled: false, projects: [], animations: true, replaceAvatars: true, filteredToMe: true, cardRows: true }, error: null }]);
  });

  it('retains newer storage changes when the initial read returns late', async () => {
    const h = storageHarness();
    h.change({ preferences: { newValue: { enabled: false, projects: [] } } });
    h.resolve({ preferences: { enabled: true, projects: [] } });
    await h.settle();
    expect(h.states).toEqual([{ value: { enabled: false, projects: [], animations: true, replaceAvatars: true, filteredToMe: true, cardRows: true }, error: null }]);
  });

  it('ignores unrelated keys and storage areas', async () => {
    const h = storageHarness();
    h.change({ last: { newValue: {} } });
    h.change({ preferences: { newValue: { enabled: false, projects: [] } } }, 'session');
    expect(h.states).toEqual([]);
    h.resolve({});
    await h.settle();
    expect(h.states[0]?.value?.enabled).toBe(true);
  });

  it('fails closed after an unreadable initial read', async () => {
    const h = storageHarness();
    h.reject(new Error('storage unavailable'));
    await h.settle();
    expect(h.states).toHaveLength(1);
    expect(h.states[0]?.value).toBeNull();
    expect(h.states[0]?.error).toContain('Could not read');
  });

  it('does not replace a newer valid choice with an older read failure', async () => {
    const h = storageHarness();
    h.change({ preferences: { newValue: { enabled: true, projects: [] } } });
    h.reject(new Error('old read failed'));
    await h.settle();
    expect(h.states).toEqual([{ value: { enabled: true, projects: [], animations: true, replaceAvatars: true, filteredToMe: true, cardRows: true }, error: null }]);
  });

  it('unsubscribes and ignores an initial read after disposal', async () => {
    const h = storageHarness();
    h.stop();
    h.resolve({});
    await h.settle();
    expect(h.removed).toBe(true);
    expect(h.states).toEqual([]);
  });

  it('restores defaults when preferences are explicitly removed', async () => {
    const h = storageHarness();
    h.resolve({ preferences: { enabled: false, projects: [] } });
    await h.settle();
    h.change({ preferences: { oldValue: { enabled: false, projects: [] } } });
    expect(h.states.at(-1)).toEqual({ value: { enabled: true, projects: [], animations: true, replaceAvatars: true, filteredToMe: true, cardRows: true }, error: null });
  });
});

describe('presentation preferences', () => {
  /** Preferences saved before these keys existed must keep working exactly as they did. */
  it('keeps the defaults for a stored object that predates the later keys', () => {
    expect(parsePreferences({ enabled: true, projects: [] }).value).toEqual({ enabled: true, projects: [], animations: true, replaceAvatars: true, filteredToMe: true, cardRows: true });
  });

  it('reads the toggles and refuses a value of the wrong type', () => {
    expect(parsePreferences({ enabled: true, projects: [], animations: false, replaceAvatars: false, cardRows: false }).value).toMatchObject({ animations: false, replaceAvatars: false, cardRows: false });
    expect(parsePreferences({ enabled: true, projects: [], animations: 'no' }).value).toBeNull();
    expect(parsePreferences({ enabled: true, projects: [], cardRows: 'no' }).value).toBeNull();
  });

  it('draws with the defaults when preferences are unreadable, leaving access to the eligibility check', () => {
    expect(presentationOf(null)).toEqual({ animations: true, replaceAvatars: true, cardRows: true });
    expect(presentationOf({ enabled: true, projects: [], animations: false, replaceAvatars: true, filteredToMe: true, cardRows: true })).toEqual({ animations: false, replaceAvatars: true, cardRows: true });
  });
});

describe('the board filter that names the developer', () => {
  const MINE = ['jon-or', 'jon-or-ai'];

  it.each([
    ['assignee:@me', []],
    ['assignee:jon-or', MINE],
    ['assignee:jon-or,jon-or-ai', MINE],
    ['assignee:"jon-or",jon-or-ai', MINE],
    ['label:bug assignee:@me is:open', []],
    ['ASSIGNEE:JON-OR', MINE],
    ['assignee:@me assignee:jon-or', MINE],
  ])('accepts %s', (filter, logins) => {
    expect(filtersToMe(filter, logins)).toBe(true);
  });

  it.each([
    ['assignee:teammate', MINE],
    ['assignee:jon-or,teammate', MINE],
    // The quoted value must not end the qualifier: everything after the comma is still assigned to someone else.
    ['assignee:"jon-or",teammate', MINE],
    ['assignee:@me assignee:teammate', MINE],
    ['label:bug', MINE],
    ['', MINE],
    ['no:assignee', MINE],
    ['assignee:jon-or', []],
  ])('refuses %s', (filter, logins) => {
    expect(filtersToMe(filter, logins)).toBe(false);
  });

  /** A negated qualifier can only remove cards from a board already restricted to the developer. */
  it('reads past a negated qualifier rather than refusing the board', () => {
    expect(filtersToMe('assignee:@me -assignee:jon-or-ai', MINE)).toBe(true);
    expect(filtersToMe('-assignee:teammate', MINE)).toBe(false);
  });

  it('has no filter to read when GitHub renders no filter box', () => {
    expect(filtersToMe(null, MINE)).toBe(false);
  });
});

describe('the cached hub logins', () => {
  it('keeps only usable logins, whatever else is stored under the key', () => {
    expect(parseLogins(['jon-or', '', 7, null, 'jon-or-ai'])).toEqual(['jon-or', 'jon-or-ai']);
    expect(parseLogins('jon-or')).toEqual([]);
    expect(parseLogins(undefined)).toEqual([]);
  });

  it('retains a newer change when the initial read returns late, as preferences do', async () => {
    let resolve!: (held: Record<string, unknown>) => void;
    const read = new Promise<Record<string, unknown>>((done) => { resolve = done; });
    let listener: ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void) | null = null;
    const storage = {
      local: { get: () => read },
      onChanged: { addListener: (c: NonNullable<typeof listener>) => { listener = c; }, removeListener: () => { listener = null; } },
    } as unknown as typeof chrome.storage;
    const seen: string[][] = [];

    watchLogins(storage, (logins) => seen.push(logins));
    listener!({ logins: { newValue: ['jon-or-ai'] } as chrome.storage.StorageChange }, 'local');
    resolve({ logins: [] });
    await read;
    await Promise.resolve();

    expect(seen).toEqual([['jon-or-ai']]);
  });
});
