import { describe, expect, it } from 'vitest';
import type { SessionSurface } from '@ground-control/core';
import { PLACEMENTS } from '../src/placements.js';
import { rootFrom, sidebarSession, surfacesFrom, tabSessions } from '../src/surface.js';
import type { WindowStore } from '../src/surface.js';
import { fixture } from './helpers.js';

const CLAUDE = PLACEMENTS['claude']!;
const KEY = CLAUDE.stateKey;

/**
 * Every field a recorded window store must carry, because a cast is not a check — a row missing one reads `undefined`
 * where the type promised `string | null`. `satisfies` fails the typecheck when `WindowStore` grows a field; the
 * assertion below fails the run until the fixture is re-recorded.
 */
const STORE_KEYS = {
  workspaceJson: true,
  editor: true,
  sidebar: true,
  updatedAt: true,
} satisfies Record<keyof WindowStore, true>;

const stores = (fixture('window-stores') as unknown[]).map((row, index) => {
  for (const key of Object.keys(STORE_KEYS)) {
    if (!Object.hasOwn(row as object, key)) {
      throw new Error(`window-stores.json row ${index} has no "${key}" — re-record it with record-window-stores.js`);
    }
  }

  return row as WindowStore;
});

function surfaceOf(sessionId: string, found: SessionSurface[]): SessionSurface | undefined {
  return found.find((surface) => surface.sessionId === sessionId);
}

/** The recorded window whose sidebar and one of whose tabs hold the same session — the case the rules are for. */
const BOTH = stores.find(
  (store) => sidebarSession(store.sidebar, KEY) !== null && tabSessions(store.editor, CLAUDE).includes(sidebarSession(store.sidebar, KEY)!),
)!;

describe('the recording these tests rest on', () => {
  it('carries windows with tabs, windows with only a sidebar, and a multi-root window', () => {
    expect(stores.length).toBeGreaterThan(4);
    expect(stores.some((store) => tabSessions(store.editor, CLAUDE).length > 1)).toBe(true);
    expect(stores.some((store) => tabSessions(store.editor, CLAUDE).length === 0)).toBe(true);
    expect(stores.some((store) => rootFrom(store.workspaceJson)?.endsWith('.code-workspace'))).toBe(true);
  });

  it('carries a session held by a window\u2019s sidebar and one of its tabs at once', () => {
    expect(BOTH).toBeDefined();
  });
});

describe('rootFrom', () => {
  it('reads the folder a window is rooted at, decoded', () => {
    expect(rootFrom('{"folder":"file:///d%3A/git/orez"}')).toBe('d:/git/orez');
  });

  it('reads a multi-root window\u2019s workspace file, which is what `code` is given for it', () => {
    expect(rootFrom('{"workspace":"file:///d%3A/git/team.code-workspace"}')).toBe('d:/git/team.code-workspace');
  });

  it('keeps a POSIX root, where the leading slash is the path rather than a drive prefix', () => {
    expect(rootFrom('{"folder":"file:///home/dev/repo"}')).toBe('/home/dev/repo');
  });

  it('reads nothing from a window with neither, which `code` has no argument for', () => {
    expect(rootFrom('{}')).toBeNull();
    expect(rootFrom('{"folder":"vscode-remote://ssh/repo"}')).toBeNull();
    expect(rootFrom('not json')).toBeNull();
    expect(rootFrom(null)).toBeNull();
  });

  it('reads nothing from a URI it cannot decode rather than a mangled path', () => {
    expect(rootFrom('{"folder":"file:///d%3A/git/%E0%A4%A"}')).toBeNull();
  });

  /** Both slashes belong to the path on a share: dropping one leaves `code` a relative path into the current drive. */
  it('keeps the authority of a network share, which is part of the path', () => {
    expect(rootFrom('{"folder":"file://server/share/proj"}')).toBe('//server/share/proj');
  });

  it('reads nothing from a URI with no path at all, rather than an empty root', () => {
    expect(rootFrom('{"folder":"file://"}')).toBeNull();
  });
});

describe('sidebarSession', () => {
  it('reads the session out of the webview state, which is JSON inside a JSON string', () => {
    const stored = '{"webviewState":"{\\"isFullEditor\\":false,\\"sessionID\\":\\"abc-123\\"}"}';

    expect(sidebarSession(stored, KEY)).toBe('abc-123');
  });

  it('reads nothing from a sidebar that has never shown a session', () => {
    expect(sidebarSession('{"webviewState":"{\\"isFullEditor\\":false}"}', KEY)).toBeNull();
    expect(sidebarSession('{}', KEY)).toBeNull();
    expect(sidebarSession('not json', KEY)).toBeNull();
    expect(sidebarSession(null, KEY)).toBeNull();
  });
});

describe('tabSessions', () => {
  /** Written out rather than selected by the same call: a predicate that picks the row cannot then check it. */
  it('finds every Claude tab in a recorded window, in the order the grid holds them', () => {
    expect(tabSessions(stores[3]!.editor, CLAUDE)).toEqual([
      '00000000-0000-4000-8000-000000000014',
      '00000000-0000-4000-8000-000000000015',
    ]);
  });

  /**
   * Counted, not merely non-empty: `[].every(...)` is `true`, so a reader that gave up at the first foreign editor
   * would satisfy the shape this test is named for.
   */
  it('steps over an editor that is not ours and keeps reading past it', () => {
    const withOthers = stores[5]!;

    expect(withOthers.editor).toContain('gettingStartedInput');
    expect(tabSessions(withOthers.editor, CLAUDE)).toEqual([
      '00000000-0000-4000-8000-000000000017',
      '00000000-0000-4000-8000-000000000018',
    ]);
  });

  /**
   * Another extension's webview may record a `sessionID` of its own, and taking it for a Claude tab would fire the
   * reveal command at an id the Claude extension has never heard of — which resumes a transcript as a second agent.
   */
  it('takes only a Claude webview’s session, never another extension’s of the same shape', () => {
    const webview = (providedId: string, id: string) =>
      `{"id":"webviewInput","value":"{\\"providedId\\":\\"${providedId}\\",\\"state\\":\\"{\\\\\\"sessionID\\\\\\":\\\\\\"${id}\\\\\\"}\\"}"}`;
    const mixed = `{"editors":[${webview('someOtherPanel', 'theirs')},${webview('claudeVSCodePanel', 'ours')}]}`;

    expect(tabSessions(mixed, CLAUDE)).toEqual(['ours']);
  });

  it('finds nothing in a Claude tab that has not bound a session yet', () => {
    const unbound =
      '{"editors":[{"id":"webviewInput","value":"{\\"providedId\\":\\"claudeVSCodePanel\\",\\"state\\":\\"{}\\"}"}]}';

    expect(tabSessions(unbound, CLAUDE)).toEqual([]);
  });

  it('walks a split grid rather than the first group only', () => {
    const tab = (id: string) =>
      `{"id":"webviewInput","value":"{\\"providedId\\":\\"claudeVSCodePanel\\",\\"state\\":\\"{\\\\\\"sessionID\\\\\\":\\\\\\"${id}\\\\\\"}\\"}"}`;
    const split = `{"root":{"type":"branch","data":[{"type":"leaf","data":{"editors":[${tab('one')}]}},{"type":"branch","data":[{"type":"leaf","data":{"editors":[${tab('two')}]}}]}]}}`;

    expect(tabSessions(split, CLAUDE)).toEqual(['one', 'two']);
  });

  it('finds nothing in a store it cannot parse', () => {
    expect(tabSessions('not json', CLAUDE)).toEqual([]);
    expect(tabSessions(null, CLAUDE)).toEqual([]);
  });
});

describe('surfacesFrom', () => {
  it('places every recorded session in the window that holds it', () => {
    const found = surfacesFrom(stores, PLACEMENTS);

    for (const store of stores) {
      const root = rootFrom(store.workspaceJson)!;

      for (const sessionId of tabSessions(store.editor, CLAUDE)) {
        expect(surfaceOf(sessionId, found)).toEqual({ agent: 'claude', sessionId, root, surface: 'tab' });
      }
    }
  });

  /** The rule that decides whether a fire is safe: a tab can be revealed by id, and the sidebar cannot. */
  it('calls a session in both a tab and the sidebar of one window a tab', () => {
    const shared = sidebarSession(BOTH.sidebar, KEY)!;

    expect(surfaceOf(shared, surfacesFrom([BOTH], PLACEMENTS))?.surface).toBe('tab');
  });

  it('calls it a tab whichever order that window is read in', () => {
    const shared = sidebarSession(BOTH.sidebar, KEY)!;

    expect(surfaceOf(shared, surfacesFrom([...stores].reverse(), PLACEMENTS))?.surface).toBe('tab');
  });

  it('believes the window that wrote most recently, not the one read last', () => {
    const [older, newer] = [
      { ...BOTH, workspaceJson: '{"folder":"file:///d%3A/old"}', updatedAt: 1 },
      { ...BOTH, editor: null, workspaceJson: '{"folder":"file:///d%3A/new"}', updatedAt: 2 },
    ];
    const shared = sidebarSession(BOTH.sidebar, KEY)!;

    expect(surfaceOf(shared, surfacesFrom([newer, older], PLACEMENTS))).toEqual({
      agent: 'claude',
      sessionId: shared,
      root: 'd:/new',
      surface: 'sidebar',
    });
  });

  /** Windows are flushed on a shared cycle, so two stores can carry one timestamp and the order they arrive in varies. */
  it('answers the same for two windows written at the same moment, whichever order they are read in', () => {
    const shared = sidebarSession(BOTH.sidebar, KEY)!;
    const pair = [
      { ...BOTH, editor: null, workspaceJson: '{"folder":"file:///d%3A/a"}', updatedAt: 5 },
      { ...BOTH, editor: null, workspaceJson: '{"folder":"file:///d%3A/b"}', updatedAt: 5 },
    ];

    const first = surfaceOf(shared, surfacesFrom(pair, PLACEMENTS))?.root;

    expect(first).toBe('d:/b');
    expect(surfaceOf(shared, surfacesFrom([...pair].reverse(), PLACEMENTS))?.root).toBe(first);
  });

  it('drops a window it has no root for rather than placing its sessions nowhere', () => {
    const rootless: WindowStore = { ...BOTH, workspaceJson: null };

    expect(surfacesFrom([rootless], PLACEMENTS)).toEqual([]);
  });

  it('drops one unreadable window without losing the rest', () => {
    const broken: WindowStore = { workspaceJson: 'not json', editor: 'not json', sidebar: 'not json', updatedAt: 0 };

    const kept = surfacesFrom(stores, PLACEMENTS);

    // Pinned, because two empty lists are equal: a reader that dropped every window would satisfy the comparison.
    expect(kept.length).toBeGreaterThan(0);
    expect(surfacesFrom([broken, ...stores], PLACEMENTS)).toEqual(kept);
  });
});
