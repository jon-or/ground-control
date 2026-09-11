import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LANE_ORDER, LANE_TITLES, boardStatuses, statusLanes } from '@ground-control/board';
import type { Attention, Lane, LaneId, LanedCard } from '@ground-control/board';
import type { HistoricalSession, Session } from '@ground-control/core';
import type { BoardMessage, DetailNote, DetailPost, DetailThread, ItemDetail, SnapshotMessage } from '@ground-control/core';

const api = {
  postMessage: vi.fn(),
  setState: vi.fn(),
  getState: vi.fn(() => undefined),
};

const session: Session = {
  agent: 'claude',
  sessionId: 'session-1',
  pid: 4242,
  title: null,
  cwd: 'c:/work/18953-cache-remediation',
  checkoutRoot: 'c:/work/18953-cache-remediation',
  startedAt: 1,
  branch: '18953-cache-remediation',
  repository: 'github.com/example-org/example-repo',
  issueNumber: 18953,
  transcriptWrittenAt: null,
  activity: null,
  finished: false,
  attachId: null,
  details: { kind: 'interactive', name: 'cache-remediation', status: 'working', state: 'editing tests' },
};

/** Test both sides of each duration threshold with the same literal table as the other client. */
const AGO_ROWS: [string, number, string][] = [
  ['the moment it happened', 0, '0s'],
  ['a time in the future', -5_000, '0s'],
  ['seconds, to the last one below a minute', 59_999, '59s'],
  ['a minute, the moment it is one', 60_000, '1m'],
  ['minutes, to the last one below an hour', 3_599_999, '59m'],
  ['an hour, the moment it is one', 3_600_000, '1h'],
  ['hours, to the last one below a day', 86_399_999, '23h'],
  ['a day, the moment it is one', 86_400_000, '1d'],
  ['days, to the last one below a week', 604_799_999, '6d'],
  ['a week, the moment it is one', 604_800_000, '1w'],
  ['weeks, however many', 31_536_000_000, '52w'],
];

/** The bag is a whole field, so an override that names one key would otherwise drop the rest of it. */
function withDetails(over: Record<string, string>): Record<string, string> {
  return { ...session.details, ...over };
}

/** Every key the session's own words are read from, cleared, for a row that must fall back past all of them. */
const NO_WORDS = { kind: 'interactive' };

/** One checkout of ad-hoc work: what the sessions on a card with no issue share, and what the card is named for. */
const checkout = {
  cwd: 'd:/git/ground-control',
  checkoutRoot: 'd:/git/ground-control',
  branch: 'master',
  repository: 'github.com/example-org/example-repo',
  issueNumber: null,
} satisfies Partial<Session>;

/** Every lane, always, so a payload here has the shape `assignLanes` produces rather than a hand-picked subset. */
function lanes(cards: Partial<Record<LaneId, LanedCard[]>>): Lane[] {
  return LANE_ORDER.map((id) => ({ id, title: LANE_TITLES[id], cards: cards[id] ?? [] }));
}

/** Openable by default: most tests are not about which sessions this window can open, and none may be. */
function message(overrides: Partial<SnapshotMessage> = {}): SnapshotMessage {
  const shown = overrides.lanes ?? lanes({});

  return {
    type: 'board',
    lanes: shown,
    openable: shown.flatMap((lane) => lane.cards).flatMap((card) => card.sessions).map((s) => s.sessionId),
    // Startable by nothing by default: a start item is drawn only where a test says which agents this host offers.
    startable: [],
    issues: {
      count: 0,
      matched: 0,
      totalAssigned: 0,
      notOnProject: 0,
      fieldProblem: null,
      truncated: false,
      fetchedAt: '2026-09-01T20:00:00Z',
    },
    sessions: { count: 0, patternError: null, fetchedAt: '2026-09-01T20:00:01Z' },
    hooks: null,
    needs: null,
    // A current hub always reports triage capability; controls are drawn only when it says they can run.
    triage: { mode: 'manual', message: null, canRequest: true },
    fetchedAt: '2026-09-01T20:00:01Z',
    failures: [],
    stale: false,
    ...overrides,
  };
}

function send(data: BoardMessage): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

/** What the board sent because someone clicked. Every render also reports what it drew, which is not that. */
function sent(): unknown[] {
  return api.postMessage.mock.calls.map(([message]) => message).filter((m) => (m as { type: string }).type !== 'drew');
}

/** What an element says on hover. Not `title` — the board draws its own tooltip, in GitHub's shape. */
function tipOf(el: Element | null | undefined): string {
  return el?.getAttribute('data-gc-tip') ?? '';
}

function laneEl(id: LaneId): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.lane-${id}`);
}

const liveCard: LanedCard = {
  key: 'issue:18953',
  issueNumber: 18953,
  lane: 'unstarted',
  returned: false,
  attention: null,
  reason: '⚒️ Dev',
  issue: {
    number: 18953,
    title: 'Cached counts do not update',
    repository: 'example-org/example-repo',
    type: 'Bug',
    url: 'https://github.com/example-org/example-repo/issues/18953',
    typeColor: 'RED',
    status: '🔍 Dev Review',
    statusColor: 'GRAY',
    statusChangedAt: null,
    assignees: ['dev-1'],
    pullRequest: {
      number: 19403,
      url: 'https://github.com/example-org/example-repo/pull/19403',
      state: 'OPEN',
      author: 'dev-1',
      isDraft: false,
      reviewDecision: null,
      updatedAt: null,
      headOid: null,
      checksRed: null,
    },
    avatar: {
      login: 'dev-2',
      url: 'https://avatars.githubusercontent.com/dev-2?s=40',
      source: 'pull-request',
    },
    updatedAt: '2026-09-01T19:00:00Z',
  },
  sessions: [session],
  checkout: { root: 'c:/work/18953-test', source: 'session', only: true },
};

/** What the script posted while it was loading. Read by the readiness test, which cannot re-run the module. */
let onLoad: unknown[] = [];

/** The board's own duration clock, captured rather than started: a test drives it, and no interval outlives the run. */
let tick: (() => void) | null = null;
let tickMs = 0;

beforeAll(async () => {
  vi.stubGlobal('acquireVsCodeApi', () => api);
  vi.stubGlobal('setInterval', (fn: () => void, ms: number) => {
    tick = fn;
    tickMs = ms;

    return 0;
  });
  document.head.innerHTML = `<style>${readFileSync(resolve('media/board.css'), 'utf8')}</style>`;
  document.body.innerHTML = `
    <header>
      <div id="meta"></div>
      <button id="board-menu" type="button"></button>
    </header>
    <div id="notices"></div><main id="lanes" tabindex="-1"></main>
  `;

  const boardScript = '../media/board.js';
  await import(boardScript);

  // Captured before any test clears the spy: the script runs once per module load, and what it says on the way up
  // cannot be observed again from inside a test.
  onLoad = api.postMessage.mock.calls.map(([sent]) => sent);
});

beforeEach(() => {
  api.postMessage.mockClear();
  api.setState.mockClear();
  document.getElementById('meta')!.textContent = '';
  document.getElementById('meta')!.className = '';
  document.getElementById('notices')!.replaceChildren();
  // The renderer keeps its lane and card elements across renders, so a test starts from a board that carries none.
  send(message());
  document.getElementById('lanes')!.replaceChildren();
  document.getElementById('detail')?.remove();
  document.getElementById('detail-scrim')?.remove();
  document.getElementById('lanes')!.className = '';
});

/** Read the archive toggle through the board menu, excluding the checkmark from its label. */
const archiveItem = (): { label: string; checked: boolean } | null => {
  document.getElementById('board-menu')!.click();

  const el = Array.from(document.querySelectorAll<HTMLButtonElement>('.card-popover button')).find((item) =>
    item.lastChild?.nodeValue?.startsWith('Show archived'),
  );
  const read =
    el === undefined
      ? null
      : { label: el.lastChild!.nodeValue!, checked: el.getAttribute('aria-checked') === 'true' };

  document.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  return read;
};

/** Flips it. An absent item is a failure rather than a no-op: a test that meant to show the archive would pass. */
const toggleArchived = () => {
  document.getElementById('board-menu')!.click();

  const el = Array.from(document.querySelectorAll<HTMLButtonElement>('.card-popover button')).find((item) =>
    item.lastChild?.nodeValue?.startsWith('Show archived'),
  );

  if (el === undefined) {
    throw new Error('the board is offering no archive toggle');
  }

  el.click();
};

describe('board webview', () => {
  it('renders an accessible avatar, retains fallback initials until load, and lays sessions out below the header', () => {
    const payload = message({ lanes: lanes({ unstarted: [liveCard] }) });

    send(payload);

    const card = document.querySelector<HTMLElement>('.card')!;
    const open = card.querySelector<HTMLButtonElement>('.card-open')!;
    const avatar = card.querySelector<HTMLElement>('.avatar')!;
    const image = avatar.querySelector<HTMLImageElement>('img')!;
    const renderedSession = card.querySelector<HTMLElement>('.session')!;

    expect(api.setState).toHaveBeenCalledWith({ payload, showArchived: false, animations: true });
    expect(card.querySelector('.status')?.textContent).toBe('Dev Review');
    expect(card.querySelector('.type')?.textContent).toBe('Bug');
    // Nothing on hover: a chip that is its own whole fact has nothing left to say when it is pointed at.
    expect(tipOf(card.querySelector('.status'))).toBe('');
    expect(tipOf(card.querySelector('.type'))).toBe('');
    expect(avatar.getAttribute('role')).toBe('img');
    expect(avatar.getAttribute('aria-label')).toBe('dev-2, pull request author');
    expect(avatar.textContent).toContain('DE');
    expect(avatar.classList).not.toContain('has-image');
    expect(card.querySelector('.card-meta')?.contains(card.querySelector('.avatar'))).toBe(true);
    expect(getComputedStyle(card.querySelector('.title')!).overflowWrap).toBe('anywhere');
    // Group issue type, project status, and PR under the title.
    expect(card.querySelector('.badges.github')?.contains(card.querySelector('.status'))).toBe(true);
    expect(renderedSession.textContent).toContain('editing tests');

    image.dispatchEvent(new Event('load'));
    expect(avatar.classList).toContain('has-image');

    image.dispatchEvent(new Event('error'));
    expect(avatar.classList).not.toContain('has-image');
    expect(avatar.querySelector('img')).toBeNull();

    open.click();
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'readDetail', key: 'issue:18953', subject: 'issue' });
  });

  it('labels the issue author when the hub picked one', () => {
    const issue = { ...liveCard.issue!, status: '⚒️ Dev', avatar: { ...liveCard.issue!.avatar!, login: 'dev-4', source: 'issue-author' as const } };

    send(message({ lanes: lanes({ unstarted: [{ ...liveCard, issue }] }) }));

    const avatar = document.querySelector<HTMLElement>('.card .avatar')!;

    expect(avatar.getAttribute('aria-label')).toBe('dev-4, issue author');
    expect(avatar.textContent).toContain('DE');
  });

  it('names the issue on a card the developer is not assigned, and titles the unlinked one from its bar', () => {
    send(
      message({
        lanes: lanes({
          unstarted: [
            {
              ...liveCard,
              key: 'issue:42',
              issueNumber: 42,
              unassigned: true,
              reason: '🚦 QA — not assigned to you, but an agent is still running.',
              issue: { ...liveCard.issue!, number: 42, title: 'Guest portal drops rows past the first page' },
              sessions: [{ ...session, details: { ...NO_WORDS, shortId: 'short-1' } }],
            },
            {
              key: 'session:c:/work/18953-cache-remediation',
              issue: null,
              issueNumber: null,
              lane: 'unstarted',
              returned: false,
              attention: null,
              reason: 'Ad-hoc work with no issue.',
              sessions: [
                // No `state`, so the row falls through to the agent's own `status` — the pair the ladder is for.
                { ...session, sessionId: 'session-2', issueNumber: null, details: { ...NO_WORDS, status: 'working' } },
              ],
            },
          ],
        }),
      }),
    );

    const cards = Array.from(document.querySelectorAll<HTMLElement>('.card'));

    expect(cards).toHaveLength(2);
    expect(cards[0]?.querySelector('.card-open')).not.toBeNull();
    expect(cards[0]?.textContent).toContain('Guest portal drops rows past the first page');
    expect(cards[1]?.querySelector('.card-open')).toBeNull();
    expect(cards[1]?.querySelector('.verdict')?.textContent).toContain('18953-cache-remediation');
    expect(cards[1]?.querySelector('.state')?.textContent).toBe('working');
  });

  it('badges the pull request before the type, then the status, in GitHub own colours', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));

    const badges = Array.from(document.querySelectorAll<HTMLElement>('.badges.github .badge'));

    expect(badges.map((b) => b.className.replace('badge ', ''))).toEqual([
      'pull-request link',
      'type',
      'status',
    ]);
    expect(badges[0]?.textContent).toBe('#19403');
    expect(badges[0]?.style.getPropertyValue('--gc-badge')).toBe('var(--vscode-charts-green)');
    expect(badges[0]?.querySelector('.pr-mark')).not.toBeNull();
    expect(badges[1]?.style.getPropertyValue('--gc-badge')).toBe('var(--vscode-charts-red)');
    expect(badges[2]?.style.getPropertyValue('--gc-badge')).toBe('var(--vscode-charts-foreground)');
  });

  it('opens the issue from its number and the pull request from its badge', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));

    const number = document.querySelector<HTMLButtonElement>('.card-meta .number')!;
    const pr = document.querySelector<HTMLButtonElement>('.badges.github .badge.pull-request')!;

    expect(number.tagName).toBe('BUTTON');
    // The number and its repository are the chip's whole fact, so it says nothing further on hover.
    expect(tipOf(number)).toBe('');
    // The button's own text is a bare number, so without this a screen reader announces only "18953, button".
    expect(number.getAttribute('aria-label')).toBe('Read issue example-repo #18953');
    expect(number.getAttribute('draggable')).toBe('false');
    expect(pr.tagName).toBe('BUTTON');
    // The accessible name includes PR state; no redundant hover text is needed.
    expect(tipOf(pr)).toBe('');
    expect(pr.getAttribute('aria-label')).toBe('Read pull request #19403, open');
    expect(pr.getAttribute('draggable')).toBe('false');
    expect(getComputedStyle(pr).cursor).toBe('pointer');

    number.click();
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'readDetail', key: 'issue:18953', subject: 'issue' });

    pr.click();
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'readDetail', key: 'issue:18953', subject: 'pull-request' });
  });

  it('sends the issue and pull request to the browser when the click asks for it', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));

    const number = document.querySelector<HTMLButtonElement>('.card-meta .number')!;
    const title = document.querySelector<HTMLButtonElement>('.card-open')!;
    const pr = document.querySelector<HTMLButtonElement>('.badges.github .badge.pull-request')!;

    number.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'openIssue', number: 18953 });

    // The same modifier on macOS, where Ctrl-click is the context menu.
    title.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'openIssue', number: 18953 });

    pr.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'openPullRequest', number: 18953 });

    // A modified click goes to the browser instead of the panel, never to both.
    expect(sent().some((m) => (m as { type: string }).type === 'readDetail')).toBe(false);
    expect(document.getElementById('detail')).toBeNull();
  });

  it('opens a session from its own row, naming the session and never its directory', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));

    const row = document.querySelector<HTMLButtonElement>('.session')!;
    const label = row.querySelector<HTMLElement>('.session-label')!;

    // The whole row is the control, as the overlay makes it: a hover then paints the row rather than the words.
    expect(row.tagName).toBe('BUTTON');
    expect(label.tagName).toBe('SPAN');
    // The accessible name describes opening the session; the visible label needs no duplicate tooltip.
    expect(tipOf(row)).toBe('');
    expect(row.getAttribute('aria-label')).toBe('cache-remediation, Claude, editing tests, live - open this session');
    expect(getComputedStyle(row).cursor).toBe('pointer');
    // Override native button colors to match session text contrast across clients (mechanics M38).
    expect(getComputedStyle(label).color).toBe('var(--vscode-foreground)');
    expect(getComputedStyle(row).color).toBe('var(--vscode-descriptionForeground)');
    // Assert the draggable attribute: the property default alone would not prove explicit drag suppression.
    expect(row.getAttribute('draggable')).toBe('false');

    label.click();

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'openSession', sessionId: 'session-1' });
  });

  /**
   * Detached runs attach through a terminal even when the agent editor extension is unavailable. Resuming them
   * as tabs would create a second process that exits 1 (mechanics M33).
   */
  it('attaches to a detached run instead of opening it, and offers it even where nothing is openable', () => {
    const detached = { ...session, attachId: 'c5d0c58f', details: { kind: 'background', name: 'merge-upstream' } };

    send(message({ lanes: lanes({ build: [{ ...liveCard, sessions: [detached] }] }), openable: [] }));

    const row = document.querySelector<HTMLElement>('.session')!;

    expect(row.tagName).toBe('BUTTON');
    expect(row.getAttribute('aria-label')).toBe('merge-upstream, Claude, no state reported, live - attach to this run in a terminal');

    row.click();

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'attachSession', sessionId: 'session-1' });
    expect(api.postMessage).not.toHaveBeenCalledWith({ type: 'openSession', sessionId: 'session-1' });
  });

  /** Render terminal and editor destinations, plus noninteractive rows. */
  it('marks where each row click lands, and marks nothing on a row that cannot be clicked', () => {
    const detached = { ...session, attachId: 'c5d0c58f', details: { kind: 'background', name: 'merge-upstream' } };

    send(message({ lanes: lanes({ build: [{ ...liveCard, sessions: [detached] }] }), openable: [] }));

    expect(document.querySelector('.session .destination')?.getAttribute('data-destination')).toBe('terminal');
    expect(document.querySelector<HTMLElement>('.session')?.dataset.detached).toBe('true');

    send(message({ lanes: lanes({ build: [liveCard] }), openable: ['session-1'] }));

    expect(document.querySelector('.session .destination')?.getAttribute('data-destination')).toBe('editor');
    expect(document.querySelector('.session .destination svg > *')?.tagName).toBe('path');
    expect(document.querySelector<HTMLElement>('.session')?.dataset.detached).toBeUndefined();

    send(message({ lanes: lanes({ build: [liveCard] }), openable: [] }));

    expect(document.querySelector('.session .destination')).toBeNull();
  });

  it('offers no control for a session no command can open, such as another agent’s', () => {
    send(message({ lanes: lanes({ build: [liveCard] }), openable: [] }));

    const row = document.querySelector<HTMLElement>('.session')!;

    expect(row.tagName).toBe('SPAN');
    // Nothing to open and nothing to say: the name is its own text, so it is neither named again nor described.
    expect(tipOf(row)).toBe('');
    expect(row.hasAttribute('aria-label')).toBe(false);
    expect(getComputedStyle(row).cursor).not.toBe('pointer');

    row.click();

    expect(sent()).toEqual([]);
  });

  it('marks only the openable rows on a card whose sessions run in different places', () => {
    const mixed: LanedCard = {
      ...liveCard,
      sessions: [
        { ...session, sessionId: 'here', details: withDetails({ name: 'in this window' }) },
        { ...session, sessionId: 'elsewhere', details: withDetails({ name: 'in another worktree' }) },
      ],
    };

    send(message({ lanes: lanes({ build: [mixed] }), openable: ['here'] }));

    const rows = Array.from(document.querySelectorAll<HTMLElement>('.session'));

    expect(rows.map((el) => el.tagName)).toEqual(['BUTTON', 'SPAN']);

    rows[0]!.click();

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'openSession', sessionId: 'here' });
  });

  it('rebuilds a card when a session stops being openable, rather than leaving a dead button', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));
    expect(document.querySelector('.session')!.tagName).toBe('BUTTON');

    send(message({ lanes: lanes({ build: [liveCard] }), openable: [] }));
    expect(document.querySelector('.session')!.tagName).toBe('SPAN');
  });

  it('opens the session whose row was clicked, not the first on the card', () => {
    const two: LanedCard = {
      ...liveCard,
      sessions: [
        { ...session, sessionId: 'newest', details: withDetails({ name: 'reading logs' }) },
        { ...session, sessionId: 'older', details: withDetails({ name: 'drafting notes' }) },
      ],
    };

    send(message({ lanes: lanes({ build: [two] }) }));

    const labels = document.querySelectorAll<HTMLButtonElement>('.session');

    labels[1]!.click();

    expect(sent()).toHaveLength(1);
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'openSession', sessionId: 'older' });
  });

  it('keeps the name clipped to the card rather than widening it, even though the label is a button', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));

    const style = getComputedStyle(document.querySelector<HTMLElement>('.session .session-label')!);

    expect(style.textOverflow).toBe('ellipsis');
    expect(style.overflow).toBe('hidden');
    expect(style.whiteSpace).toBe('nowrap');
    // The declaration that actually lets it clip: a flex item defaults to min-width auto and refuses to shrink.
    expect(style.minWidth).toBe('0');
    // The row owns the height, so a card mixing an openable label with a plain one does not step between the two.
    expect(getComputedStyle(document.querySelector<HTMLElement>('.session')!).minHeight).toBe('1.5rem');
  });

  it('labels a session with its own title, falling back to the name Claude derived from the directory', () => {
    const titled: LanedCard = {
      key: 'session:c:/work/scratch',
      issue: null,
      issueNumber: null,
      lane: 'build',
      returned: false,
      attention: null,
      reason: 'Ad-hoc work with no issue.',
      sessions: [
        { ...session, sessionId: 'a', title: 'Grouping orphan sessions', cwd: 'c:/work/scratch', issueNumber: null },
        { ...session, sessionId: 'b', title: null, cwd: 'c:/work/scratch', issueNumber: null, details: withDetails({ name: 'scratch-7b' }) },
      ],
    };

    send(message({ lanes: lanes({ build: [titled] }) }));

    const labels = Array.from(document.querySelectorAll<HTMLElement>('.session-label')).map((el) => el.textContent);

    expect(labels).toEqual(['Grouping orphan sessions', 'scratch-7b']);
  });

  it('names a card with no issue for its repository and branch, and lists every session in the checkout', () => {
    const grouped: LanedCard = {
      key: 'session:github.com/example-org/example-repo#master',
      issue: null,
      issueNumber: null,
      lane: 'build',
      returned: false,
      attention: null,
      reason: 'Ad-hoc work with no issue.',
      sessions: [
        { ...session, sessionId: 'a', ...checkout, details: withDetails({ name: 'reading logs' }) },
        { ...session, sessionId: 'b', ...checkout, details: withDetails({ name: 'drafting notes' }) },
      ],
    };

    send(message({ lanes: lanes({ build: [grouped] }) }));

    const card = document.querySelector<HTMLElement>('.card')!;
    const number = card.querySelector<HTMLElement>('.card-meta .number')!;
    const labels = Array.from(card.querySelectorAll<HTMLElement>('.session-label')).map((el) => el.textContent);

    expect(document.querySelectorAll('.card')).toHaveLength(1);
    expect(number.tagName).toBe('SPAN');
    expect(number.classList).not.toContain('link');
    expect(number.textContent).toBe('example-repo');
    // Display repository owner without the host prefix used for identity.
    expect(tipOf(number)).toBe('example-org/example-repo');
    expect(card.querySelector('.verdict')?.textContent).toBe('master');
    expect(labels).toEqual(['reading logs', 'drafting notes']);
  });

  it('stands the checkout directory in for the repository where git reports none, past a Windows path', () => {
    const win = 'd:\\git\\ground-control';
    const grouped: LanedCard = {
      key: 'session:d:/git/ground-control',
      issue: null,
      issueNumber: null,
      lane: 'build',
      returned: false,
      attention: null,
      reason: 'Ad-hoc work with no issue.',
      sessions: [
        { ...session, sessionId: 'a', ...checkout, cwd: win, checkoutRoot: win, repository: null, details: NO_WORDS },
      ],
    };

    send(message({ lanes: lanes({ build: [grouped] }) }));

    const card = document.querySelector<HTMLElement>('.card')!;
    const number = card.querySelector<HTMLElement>('.card-meta .number')!;

    expect(number.textContent).toBe('ground-control');
    expect(tipOf(number)).toBe('ground-control');
    expect(card.querySelector('.verdict')?.textContent).toBe('master');
  });

  it('counts the sessions on a card whose work is under no checkout at all', () => {
    const loose = { ...session, cwd: 'c:/work/scratch', checkoutRoot: null, branch: null, repository: null, issueNumber: null };

    send(
      message({
        lanes: lanes({
          unstarted: [
            {
              key: 'session:c:/work/scratch',
              issue: null,
              issueNumber: null,
              lane: 'unstarted',
              returned: false,
              attention: null,
              reason: 'Ad-hoc work with no issue.',
              sessions: [loose],
            },
          ],
        }),
      }),
    );

    const card = document.querySelector<HTMLElement>('.card')!;
    const number = card.querySelector<HTMLElement>('.card-meta .number')!;

    expect(number.tagName).toBe('SPAN');
    expect(number.textContent).toBe('session');
    expect(tipOf(number)).toBe('');
    expect(card.querySelector('.verdict')?.textContent).toBe('scratch');
  });

  /** Display repository beside issue number, matching GitHub and distinguishing cards across repositories. */
  it('writes the repository beside the issue number, without its owner', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));

    const number = document.querySelector<HTMLElement>('.number')!;

    expect(number.textContent).toBe('example-repo #18953');
    expect(number.getAttribute('aria-label')).toBe('Read issue example-repo #18953');
  });

  // A snapshot an older hub cached carries no repository, and the card must read as it did rather than as a blank.
  it('carries the number alone where the snapshot has no repository on it', () => {
    const issue = { ...liveCard.issue! };

    // Absent, not undefined: `exactOptionalPropertyTypes` separates the two, and a snapshot without the field is the
    // first of them.
    delete issue.repository;

    send(message({ lanes: lanes({ build: [{ ...liveCard, issue }] }) }));

    const number = document.querySelector<HTMLElement>('.number')!;

    expect(number.textContent).toBe('#18953');
    expect(number.getAttribute('aria-label')).toBe('Read issue #18953');
  });

  it('leaves out a badge the issue has nothing for', () => {
    const bare = { ...liveCard, issue: { ...liveCard.issue!, type: null, status: null, pullRequest: null } };

    send(message({ lanes: lanes({ build: [bare] }) }));

    expect(document.querySelectorAll('.badges.github .badge')).toHaveLength(0);
    // No row rather than an empty one, so the card's own gap does not leave a blank line where GitHub said nothing.
    expect(getComputedStyle(document.querySelector<HTMLElement>('.badges.github')!).display).toBe('none');
  });

  it('marks a Claude session with its own icon — R2', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));

    const mark = document.querySelector<SVGElement>('.session .agent-mark')!;

    expect(mark).not.toBeNull();
    expect(mark.getAttribute('data-agent')).toBe('claude');
    // An openable row replaces the mark with its own name, so both state the agent and only one is read.
    expect(mark.getAttribute('aria-label')).toBe('claude');
    expect(mark.querySelector('title')).toBeNull();
    expect(document.querySelector('.session')!.getAttribute('aria-label')).toBe(
      'cache-remediation, Claude, editing tests, live - open this session',
    );
  });

  it("marks a Codex session with OpenAI's icon rather than the word — R2", () => {
    send(
      message({
        lanes: lanes({ build: [{ ...liveCard, sessions: [{ ...session, agent: 'codex' }] }] }),
      }),
    );

    const mark = document.querySelector<SVGElement>('.session .agent-mark')!;

    expect(mark).not.toBeNull();
    expect(mark.getAttribute('aria-label')).toBe('codex');
    expect(document.querySelector('.session .agent')?.textContent).toBe('');
    expect(document.querySelector('.session')!.getAttribute('aria-label')).toBe(
      'cache-remediation, Codex, editing tests, live - open this session',
    );
  });

  /** Key logo fill by agent so the monochrome OpenAI logo does not inherit Claude brand orange. */
  it('gives the brand colour to the mark that has one, and the row tone to the one that does not', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));

    expect(getComputedStyle(document.querySelector<SVGElement>('.session .agent-mark')!).fill).toBe('#d97757');

    send(
      message({
        lanes: lanes({ build: [{ ...liveCard, sessions: [{ ...session, agent: 'codex' }] }] }),
      }),
    );

    expect(getComputedStyle(document.querySelector<SVGElement>('.session .agent-mark')!).fill).toBe('currentColor');
  });

  it('names an agent it has no mark for, so an unmarked row never reads as one that has one — R2', () => {
    send(
      message({
        lanes: lanes({ build: [{ ...liveCard, sessions: [{ ...session, agent: 'gemini' }] }] }),
      }),
    );

    expect(document.querySelector('.session .agent-mark')).toBeNull();
    expect(document.querySelector('.session .agent')?.textContent).toBe('gemini');
    expect(document.querySelector('.session')!.getAttribute('aria-label')).toBe(
      'cache-remediation, Gemini, editing tests, live - open this session',
    );
  });

  it('shows stale-source, pattern, project-filter, and truncation notices together', () => {
    send(
      message({
        issues: {
          count: 3,
          matched: 8,
          totalAssigned: 10,
          notOnProject: 2,
          fieldProblem: null,
          truncated: true,
          fetchedAt: '2026-09-01T20:00:00Z',
        },
        sessions: { count: 0, patternError: 'Pattern is invalid.', fetchedAt: '2026-09-01T20:00:01Z' },
        failures: [{ subject: 'github', kind: 'query-failed', message: 'GitHub failed.', remedy: 'Refresh.' }],
        stale: true,
      }),
    );

    expect(document.querySelectorAll('.notice')).toHaveLength(4);
    expect(document.querySelectorAll('.notice.error')).toHaveLength(2);
    expect(document.getElementById('lanes')?.classList).toContain('stale');
    expect(document.getElementById('meta')?.textContent).toContain('could not refresh');
    expect(document.querySelector('.empty')?.textContent).toBe('None of your assigned issues match the current card source.');
  });

  it('names a status field the project cannot supply, with the setting that fixes it', () => {
    send(
      message({
        issues: {
          count: 1,
          matched: 1,
          totalAssigned: 1,
          notOnProject: 0,
          fieldProblem: 'Project example-org/3 has no field named "Stage".',
          truncated: false,
          fetchedAt: '2026-09-01T20:00:00Z',
        },
      }),
    );

    const notice = Array.from(document.querySelectorAll('.notice')).find((held) => held.textContent?.includes('has no field named "Stage"'));

    expect(notice?.classList).toContain('error');
    expect(notice?.textContent).toContain('groundControl.github.statusField');
  });

  /** Assert the completed DOM report so a mid-render report cannot pass with old metadata and empty notices. */
  it('reports what it drew after the screen is finished, not during', () => {
    api.postMessage.mockClear();
    send(
      message({
        lanes: lanes({ build: [liveCard] }),
        failures: [{ subject: 'github', kind: 'query-failed', message: 'GitHub failed.', remedy: 'Refresh.' }],
        stale: true,
      }),
    );

    const drew = api.postMessage.mock.calls.map(([m]) => m).filter((m) => (m as { type: string }).type === 'drew');

    expect(drew).toHaveLength(1);
    expect(drew[0]).toEqual({
      type: 'drew',
      lanes: document.querySelectorAll('.lane').length,
      cards: document.querySelectorAll('.card').length,
      notices: document.querySelectorAll('.notice').length,
      meta: document.getElementById('meta')?.textContent,
    });
    expect((drew[0] as { cards: number }).cards).toBeGreaterThan(0);
    expect((drew[0] as { notices: number }).notices).toBeGreaterThan(0);
    expect((drew[0] as { meta: string }).meta).toContain('could not refresh');
  });

  it('states a settings failure without claiming the read failed', () => {
    send(
      message({
        failures: [
          {
            subject: 'userDir',
            kind: 'unknown-host',
            message: 'The board does not know how to reach into "userDir".',
            remedy: 'Remove it from groundControl.hosts, or check the spelling.',
          },
        ],
      }),
    );

    expect(document.querySelector('.notice.error')?.textContent).toContain('does not know how to reach');
    expect(document.getElementById('meta')?.textContent).not.toContain('could not refresh');
    expect(document.getElementById('lanes')?.classList).not.toContain('stale');
  });

  it('reports each empty state honestly and handles loading and refresh', () => {
    send(message({ issues: null, sessions: null }));
    expect(document.querySelector('.empty')?.textContent).toBe('Nothing to show yet.');
    expect(document.getElementById('meta')?.textContent).toBe('0 cards');

    send(message({ issues: { ...message().issues!, totalAssigned: 0 } }));
    expect(document.querySelector('.empty')?.textContent).toBe('No open issues are assigned to you.');

    send(message({ issues: { ...message().issues!, totalAssigned: 1 } }));
    expect(document.querySelector('.empty')?.textContent).toBe('None of your assigned issues match the current card source.');

    send({ type: 'loading' });
    expect(document.getElementById('meta')?.textContent).toBe('Reading GitHub…');

    document.getElementById('board-menu')!.click();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.card-popover button'))
      .find((item) => item.textContent === 'Refresh')!
      .click();
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'refresh' });
  });
});

describe('reported activity', () => {
  const withPhase = (phase: 'running' | 'waiting' | 'idle' | 'failed', since = Date.now(), over: Partial<Session> = {}) => ({
    ...session,
    ...over,
    activity: { phase, since, at: since, event: 'PostToolBatch' },
  });

  const cardWith = (sessions: Session[], attention: Attention | null = null): LanedCard => ({
    ...liveCard,
    sessions,
    attention,
  });

  // The mark is the board's decision, not the webview's, so a test states it the way `assignLanes` would have.
  const sendCard = (sessions: Session[], attention: Attention | null = null): HTMLElement => {
    send(message({ lanes: lanes({ unstarted: [cardWith(sessions, attention)] }) }));

    return document.querySelector<HTMLElement>('.card')!;
  };

  it('shimmers the running session and only the running session', () => {
    const card = sendCard([
      withPhase('running', Date.now(), { sessionId: 's-run' }),
      withPhase('waiting', Date.now(), { sessionId: 's-wait' }),
      withPhase('idle', Date.now(), { sessionId: 's-idle' }),
    ]);

    const rows = Array.from(card.querySelectorAll<HTMLElement>('.session'));

    expect(rows.map((row) => row.dataset.phase)).toEqual(['running', 'waiting', 'idle']);

    const names = rows.map((row) => getComputedStyle(row.querySelector('.session-label')!));

    // jsdom leaves an unanimated element's animation-name empty rather than at its 'none' initial value.
    expect(names.map((style) => style.animationName)).toEqual(['gc-shimmer', '', '']);
  });

  it('says that setup is unfinished, names the command, and drops the notice once it is done', () => {
    send(message());
    send({ type: 'setup', pending: true });

    const pending = Array.from(document.querySelectorAll('.notice')).find((held) => held.textContent?.includes('setup is not finished'));

    expect(pending?.textContent).toContain('Run Setup');
    expect(pending?.classList).not.toContain('error');

    send({ type: 'setup', pending: false });
    expect(Array.from(document.querySelectorAll('.notice')).some((held) => held.textContent?.includes('setup is not finished'))).toBe(false);
  });

  /** With animation off the running row keeps its phase and name; only the shimmer goes (R6). */
  it('stops the shimmer when the developer turns animations off, and keeps the running row readable', () => {
    send({ type: 'presentation', animations: false });

    const card = sendCard([withPhase('running', Date.now(), { sessionId: 's-run' })]);
    const row = card.querySelector<HTMLElement>('.session')!;

    expect(document.body.dataset.motion).toBe('reduced');
    expect(row.dataset.phase).toBe('running');
    expect(getComputedStyle(row.querySelector('.session-label')!).animationName).toBe('none');
    expect(row.querySelector('.session-label')?.textContent?.trim()).not.toBe('');

    send({ type: 'presentation', animations: true });
    expect(document.body.dataset.motion).toBeUndefined();
  });

  /** Show attention on the card border and relevant session dot, without a duplicate attention chip (R6). */
  it('marks the card, not only the row, when an agent is blocked on the developer', () => {
    const card = sendCard([withPhase('idle'), withPhase('waiting', Date.now(), { sessionId: 's-2' })], 'blocked');

    expect(card.dataset.attention).toBe('blocked');
    expect(card.querySelector('.badge.blocked')).toBeNull();
    expect(card.textContent).not.toContain('Needs you');
  });

  it('marks the card when an agent ended its turn and nothing has replied', () => {
    const card = sendCard([withPhase('running'), withPhase('idle', Date.now(), { sessionId: 's-2' })], 'your-turn');

    expect(card.dataset.attention).toBe('your-turn');
    expect(card.querySelector('.badge.your-turn')).toBeNull();
    expect(card.textContent).not.toContain('Your turn');
  });

  /** Require an accessible phase name on each session dot. */
  it('leaves the phase on the mark a reader can hear, now that no words carry it', () => {
    const card = sendCard(
      [
        withPhase('waiting', Date.now(), { sessionId: 's-1', details: withDetails({ name: 'still asking' }) }),
        withPhase('running', Date.now(), { sessionId: 's-2', details: withDetails({ name: 'drafting notes' }) }),
      ],
      'blocked',
    );

    expect(Array.from(card.querySelectorAll('.dot')).map((el) => el.getAttribute('aria-label'))).toEqual([
      'waiting for input, live',
      'running, live',
    ]);
  });

  /** A failed turn outranks the other marks on the card; the row says which error, in the agent's own words (R6). */
  it('marks the card red when a turn ended on an error, and says the error on the mark', () => {
    const failed = {
      ...withPhase('failed', Date.now(), { sessionId: 's-2' }),
      activity: {
        phase: 'failed' as const,
        since: 1,
        at: 1,
        event: 'StopFailure',
        error: { kind: 'rate_limit', message: "You've hit your session limit · resets 12:10pm (America/New_York)" },
      },
    };
    const card = sendCard([withPhase('waiting'), failed], 'failed');
    const row = card.querySelector<HTMLElement>('[data-session-id="s-2"]')!;

    expect(card.dataset.attention).toBe('failed');
    expect(row.dataset.phase).toBe('failed');
    expect(row.querySelector<HTMLElement>('.dot')?.dataset['phase']).toBe('failed');
    expect(row.querySelector('.dot')?.getAttribute('aria-label')).toBe('failed, live');
    expect(tipOf(row.querySelector('.dot'))).toBe(
      "The turn ended on an error: rate limit. You've hit your session limit · resets 12:10pm (America/New_York)",
    );
  });

  it('says the error is unclassified when the agent gave no kind, and that the session ended when it has', () => {
    const bare = sendCard([{ ...withPhase('failed'), finished: true }]);

    expect(tipOf(bare.querySelector('.dot'))).toBe('The turn ended on an error: unknown. The session has since ended.');
  });

  it('marks nothing when the board asked nothing of the developer', () => {
    const card = sendCard([{ ...session, activity: null }]);

    expect(card.dataset.attention).toBeUndefined();
    expect(card.querySelector('.badge.blocked')).toBeNull();
    expect(card.querySelector('.badge.your-turn')).toBeNull();
  });

  /** Expose phase and liveness through the dot accessible name as well as color and fill. */
  it.each([
    ['running', false, 'running, live'],
    ['waiting', false, 'waiting for input, live'],
    ['idle', false, 'idle, live'],
    ['idle', true, 'idle, ended'],
  ] as const)('names a %s session, finished %s, on the mark a reader can hear', (phase, finished, named) => {
    const row = sendCard([{ ...withPhase(phase), finished }]).querySelector<HTMLElement>('.session')!;
    const dot = row.querySelector<HTMLElement>('.dot')!;

    // Ahead of the agent's own mark: the row is read left to right, and its state is the first thing wanted from it.
    expect(row.firstElementChild).toBe(dot);
    expect(dot.dataset['phase']).toBe(phase);
    expect(dot.dataset['live']).toBe(String(!finished));
    expect(dot.getAttribute('aria-label')).toBe(named);
    expect(dot.getAttribute('role')).toBe('img');

    // The dot's own name is never read on a reachable row: an aria-label there replaces everything inside
    // it, so the row states the same words itself (R2).
    expect(row.getAttribute('aria-label')).toBe(`cache-remediation, Claude, ${named} - open this session`);
  });

  /**
   * A row name replaces everything inside it, including the word the agent reported, so the name has to
   * follow the same precedence the row renders (R24).
   */
  it('names the word the agent reported where no hook observed a phase', () => {
    const row = sendCard([{ ...session, activity: null }]).querySelector('.session')!;

    expect(row.querySelector('.state')!.textContent).toBe('editing tests');
    expect(row.getAttribute('aria-label')).toBe('cache-remediation, Claude, editing tests, live - open this session');
  });

  it('prefers the observed phase over the word the agent reported', () => {
    const row = sendCard([withPhase('running')]).querySelector('.session')!;

    expect(row.getAttribute('aria-label')).toBe('cache-remediation, Claude, running, live - open this session');
  });

  it('reports no state only where the row shows none either', () => {
    const row = sendCard([{ ...session, activity: null, details: {} }]).querySelector('.session')!;

    expect(row.querySelector('.state')).toBeNull();
    // Emptying details also drops the CLI's name for the session, so the label falls back to the branch.
    expect(row.getAttribute('aria-label')).toBe('18953-cache-remediation, Claude, no state reported, live - open this session');
  });

  // A row the board has no phase for still gets a mark: an absent one would read as a row with nothing to report.
  it('marks a session no hook has reported on as having no state, rather than leaving the row unmarked', () => {
    const dot = sendCard([{ ...session, activity: null }]).querySelector<HTMLElement>('.dot')!;

    expect(dot.dataset['phase']).toBe('none');
    expect(dot.getAttribute('aria-label')).toBe('no state reported, live');
  });

  it('offers the title as a control only where there is an issue to open', () => {
    send(message({ lanes: lanes({ build: [liveCard, { ...liveCard, key: 'session:x', issueNumber: null, issue: null }] }) }));

    const [withIssue, without] = Array.from(document.querySelectorAll<HTMLElement>('.card'));

    expect(withIssue!.querySelector('.card-open')).not.toBeNull();
    expect(without!.querySelector('.card-open')).toBeNull();
  });

  /** The card uses the highest-priority attention state; only the corresponding session row uses that color. */
  it('paints only the row the mark is about, and leaves the others on their own state', () => {
    const card = sendCard(
      [withPhase('idle', Date.now(), { sessionId: 's-idle' }), withPhase('waiting', Date.now(), { sessionId: 's-wait' })],
      'blocked',
    );
    const [idle, waiting] = Array.from(card.querySelectorAll<HTMLElement>('.session'));

    expect(card.dataset['attention']).toBe('blocked');
    expect(getComputedStyle(waiting!.querySelector<HTMLElement>('.dot')!).getPropertyValue('--gc-dot')).toBe(
      'var(--vscode-charts-yellow)',
    );
    // The idle row is a different session in a different state, and the card's mark is not a claim about it.
    expect(getComputedStyle(idle!.querySelector<HTMLElement>('.dot')!).getPropertyValue('--gc-dot')).toBe(
      'var(--vscode-descriptionForeground)',
    );
    expect(getComputedStyle(idle!.querySelector<HTMLElement>('.session-label')!).color).toBe('var(--vscode-foreground)');
  });

  it('shows one state per row, and it is the board own observation', () => {
    const row = sendCard([withPhase('running', Date.now(), { details: withDetails({ status: 'idle', state: 'editing tests' }) })])
      .querySelector<HTMLElement>('.session')!;

    expect(row.querySelectorAll('.state')).toHaveLength(1);
    // The board's own phase is the mark; the CLI's own words are neither on the row nor behind the mark.
    expect(row.querySelector<HTMLElement>('.dot')?.dataset['phase']).toBe('running');
    expect(row.textContent).not.toContain('editing tests');
    expect(row.textContent).not.toContain('idle');
  });

  it('falls back to the CLI own word when no hook has reported', () => {
    const row = sendCard([{ ...session, activity: null }]).querySelector<HTMLElement>('.session')!;

    expect(row.dataset.phase).toBeUndefined();
    expect(row.querySelector('.state')?.textContent).toBe('editing tests');
    expect(getComputedStyle(row.querySelector('.session-label')!).animationName).toBeFalsy();
  });

  it('rebuilds the card when a phase changes', () => {
    const before = sendCard([withPhase('idle', 1)]);
    const after = sendCard([withPhase('running', 1)]);

    expect(after).not.toBe(before);
    expect(after.querySelector<HTMLElement>('.session')?.dataset.phase).toBe('running');
  });

  // Without this the test above passes on a renderer that rebuilds everything, which is not what it claims to prove.
  it('leaves the card alone when nothing about it changed', () => {
    const before = sendCard([withPhase('running', 1)]);

    expect(sendCard([withPhase('running', 1)])).toBe(before);
  });

  it('advances the duration in place, without rebuilding the card', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T12:00:00Z'));

    try {
      const since = Date.now() - 90_000;
      const card = sendCard([withPhase('running', since)]);

      expect(card.querySelector('.state')?.textContent).toBe('1m');

      vi.advanceTimersByTime(10 * 60 * 1000);
      sendCard([withPhase('running', since)]);

      expect(document.querySelector('.card')).toBe(card);
      expect(card.querySelector('.state')?.textContent).toBe('11m');

      // A render inside the same turn keeps the count where it is; the next turn starts it again, on the same element.
      sendCard([withPhase('running', Date.now())]);

      expect(document.querySelector('.card')).toBe(card);
      expect(card.querySelector('.state')?.textContent).toBe('0s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('says what the duration counts, and what it last saw, on hover', () => {
    const state = sendCard([withPhase('running')]).querySelector<HTMLElement>('.state')!;

    // Not the phase: that is the mark's at the other end of the row, and saying it twice is two hovers to ignore.
    expect(tipOf(state)).toBe(
      'Time in this turn, from its prompt when recorded. Last event: PostToolBatch.',
    );
    expect(tipOf(state)).not.toContain('working');

    // The other variant, which the overlay pins and this suite did not, so neither string can drift alone.
    const idle = sendCard([withPhase('idle')]).querySelector<HTMLElement>('.state')!;

    expect(tipOf(idle)).toBe('Time since the phase was reported. Last event: PostToolBatch.');
  });

  /** Describe phase and liveness in dot tooltips, with matching literal expectations in both clients. */
  it.each([
    ['running', false, 'Turn in progress.'],
    ['waiting', false, 'Waiting for your input.'],
    ['idle', false, 'Last reported state: turn complete.'],
    ['idle', true, 'Last reported state: turn complete. The session has since ended.'],
  ] as const)('says what the mark means for a %s session, finished %s', (phase, finished, said) => {
    const card = sendCard([{ ...withPhase(phase, Date.now()), finished }]);

    expect(tipOf(card.querySelector('.dot'))).toBe(said);
  });

  it('says the mark means nothing has reported, where nothing has', () => {
    const card = sendCard([{ ...session, activity: null }]);

    expect(tipOf(card.querySelector('.dot'))).toBe('No activity reported.');
  });

  /** Duration must advance from the clock without another host message or machine read. */
  it('advances the duration on its own clock, with nothing arriving from the host', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T12:00:00Z'));

    try {
      const card = sendCard([withPhase('running', Date.now())]);

      expect(card.querySelector('.state')?.textContent).toBe('0s');

      api.postMessage.mockClear();
      vi.setSystemTime(new Date('2026-09-02T12:00:07Z'));
      tick?.();

      expect(document.querySelector('.card')).toBe(card);
      expect(card.querySelector('.state')?.textContent).toBe('7s');
      expect(sent()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Seconds are what the text is written to below a minute, so a slower clock leaves a card reading 0s for that long.
  it('runs that clock at the resolution the text is written to', () => {
    expect(tickMs).toBe(1_000);
  });

  /** Verify identical literal duration formatting in both clients, which cannot share runtime imports. */
  it.each(AGO_ROWS)('reads a duration of %s', (_rung, ms, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T12:00:00Z'));

    try {
      const card = sendCard([withPhase('idle', Date.now() - ms, { sessionId: 's-ago' })]);

      expect(card.querySelector('.state')?.textContent).toBe(expected);
    } finally {
      vi.useRealTimers();
    }
  });

  // The rows above each pin one unit, so only this pins that a duration is ever only one of them.
  it('reads a duration as a single number, with no second unit behind it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T12:00:00Z'));

    try {
      const card = sendCard([
        withPhase('idle', Date.now() - (90 * 60_000 + 30_000), { sessionId: 's-h' }),
        withPhase('idle', Date.now() - (3 * 86_400_000 + 4 * 3_600_000), { sessionId: 's-d' }),
        withPhase('idle', Date.now() - (16 * 86_400_000 + 5 * 3_600_000), { sessionId: 's-w' }),
      ]);

      expect(Array.from(card.querySelectorAll('.state')).map((el) => el.textContent)).toEqual(['1h', '3d', '2w']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('states once above the lanes what it did about the hooks', () => {
    send(message({ hooks: { notice: 'Session activity hooks installed. Restart 3 sessions to enable activity reporting.' } }));

    const notices = Array.from(document.querySelectorAll('#notices .notice'));

    expect(notices).toHaveLength(1);
    expect(notices[0]?.classList).not.toContain('error');
    expect(notices[0]?.textContent).toContain('Restart 3 sessions');
  });

  it('reports a failed install as an error, and says nothing when there is nothing to say', () => {
    send(
      message({
        failures: [{ subject: 'hooks', kind: 'hooks-failed', message: 'could not be installed', remedy: 'Fix it.' }],
      }),
    );

    expect(document.querySelector('#notices .notice.error')?.textContent).toContain('could not be installed');

    send(message());
    expect(document.querySelectorAll('#notices .notice')).toHaveLength(0);
  });
});

/**
 * Update existing text nodes. childList mutations would trigger overlay scans; both clients preserve rows and
 * running animations.
 */
describe('what a second costs', () => {
  const AGE = '[data-gc-since]';

  function watch(run: () => void): MutationRecord[] {
    const seen: MutationRecord[] = [];
    const observer = new MutationObserver((records) => seen.push(...records));

    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    run();

    const records = observer.takeRecords();

    observer.disconnect();

    return [...seen, ...records];
  }

  /** Every kind of duration at once: a live row, a saved row, the age of a card's status, and the header read time. */
  function everyAge(): void {
    send(
      message({
        lanes: lanes({
          unstarted: [
            {
              ...liveCard,
              sessions: [{ ...session, activity: { phase: 'running', since: Date.now() - 600_000, at: Date.now() - 600_000, event: 'PostToolBatch' } }],
              triage: { state: 'done', action: 'develop', qualifier: null, detail: 'Pick it up.', at: Date.now() - 7_200_000, stale: false },
              issue: { ...liveCard.issue!, statusChangedAt: '2026-09-06T12:00:00Z' },
            },
            {
              ...liveCard,
              key: 'issue:19001',
              issueNumber: 19001,
              sessions: [],
              lastSession: { agent: 'claude', sessionId: 'past', title: 'Past attempt', cwd: '/work/19001', branch: '19001', issueNumber: 19001, repository: 'github.com/org/repo', updatedAt: Date.now() - 10_800_000 },
            },
          ],
        }),
      }),
    );
  }

  it('writes nothing at all when no duration has moved', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T12:00:00Z'));

    try {
      everyAge();

      // Every value here is minutes or hours old, so a second later each one reads exactly the same.
      expect(document.querySelectorAll(AGE)).toHaveLength(4);

      vi.setSystemTime(new Date('2026-09-07T12:00:01Z'));

      expect(watch(() => tick?.())).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('edits the text node rather than replacing it when one has', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T12:00:00Z'));

    try {
      const card = sendRunning(Date.now() - 59_000);

      expect(card.querySelector('.state')?.textContent).toBe('59s');

      vi.setSystemTime(new Date('2026-09-07T12:00:01Z'));

      const records = watch(() => tick?.());

      expect(records.map((record) => record.type)).toEqual(['characterData']);
      expect(card.querySelector('.state')?.textContent).toBe('1m');
    } finally {
      vi.useRealTimers();
    }
  });

  /** Assert the updated duration count so an obsolete attribute cannot silently exclude a duration type. */
  it('carries one age attribute and none of the three it replaced', () => {
    everyAge();

    expect(document.querySelectorAll('[data-activity-since], [data-history-updated], [data-status-since]')).toHaveLength(0);
    expect(document.querySelectorAll(AGE)).toHaveLength(4);
  });

  it('stamps the header read time as an age and advances it on the tick', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T20:00:31Z'));

    try {
      send(message());

      expect(document.getElementById('meta')?.textContent).toBe('0 cards · updated 30s ago');

      vi.setSystemTime(new Date('2026-09-01T20:01:31Z'));
      tick?.();

      expect(document.getElementById('meta')?.textContent).toBe('0 cards · updated 1m ago');
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves an age it cannot read alone rather than writing NaN into it', () => {
    const card = sendRunning(Date.now());
    const state = card.querySelector<HTMLElement>('.state')!;

    state.setAttribute('data-gc-since', 'whenever');
    state.firstChild!.nodeValue = 'held';

    tick?.();

    expect(state.textContent).toBe('held');
  });

  /** The reserved column: the rule has to reach the node, not merely sit in the stylesheet. */
  it('reserves the width of the value so a digit does not relay the row out', () => {
    const drawn = getComputedStyle(sendRunning(Date.now()).querySelector('.state')!);

    expect(drawn.minWidth).toBe('3ch');
    expect(drawn.textAlign).toBe('right');
    expect(drawn.fontVariantNumeric).toBe('tabular-nums');
  });

  function sendRunning(since: number): HTMLElement {
    send(
      message({
        lanes: lanes({
          unstarted: [{ ...liveCard, sessions: [{ ...session, activity: { phase: 'running', since, at: since, event: 'PostToolBatch' } }] }],
        }),
      }),
    );

    return document.querySelector<HTMLElement>('.card')!;
  }
});

describe('the manifest and the code agree on every default', () => {
  const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { default: unknown }> }[] };
  };
  const properties = Object.assign({}, ...manifest.contributes.configuration.map(group => group.properties)) as Record<string, { default: unknown }>;
  const declared = (name: string) => properties[`groundControl.${name}`]?.default;

  // Two copies of a default is what VS Code's settings UI costs; a test is what keeps them from drifting apart.
  it('ships the board statuses the package computes', () => {
    expect(declared('boardStatuses')).toEqual(boardStatuses(undefined));
  });

  it('ships the status-to-lane map the package computes', () => {
    expect(declared('statusLanes')).toEqual(statusLanes(undefined));
  });

  it('ships the intervals the extension falls back to', () => {
    expect(declared('sessionRefreshSeconds')).toBe(30);
    expect(declared('refreshIntervalSeconds')).toBe(300);
  });

  it('ships the hook install default the extension falls back to', () => {
    expect(declared('installSessionHooks')).toBe(true);
  });
});

describe('lanes', () => {
  const planCard: LanedCard = { ...liveCard, lane: 'plan', reason: '🎁 Assigned' };
  const archivedCard: LanedCard = {
    ...liveCard,
    key: 'issue:18900',
    issueNumber: 18900,
    lane: 'archived',
    reason: '🏃 Testing — outside active board statuses.',
    sessions: [],
  };

  /**
   * The literal titles, in order. Both clients duplicate this map because neither can import core at
   * runtime, so an expectation computed from the constant would agree with any drift (`docs/testing.md`).
   */
  const LANE_NAMES = ['Unstarted', 'Plan', 'Build', 'Review', 'Icebox'] as const;

  /**
   * The literal lane pictograms, matching the table in the other client's suite. Both clients duplicate the map
   * because neither can import the other at runtime, so an expectation computed from the constant would agree
   * with any drift (`docs/testing.md`).
   */
  const LANE_MARKS: Record<string, [string, Record<string, string>][]> = {
    unstarted: [['circle', { cx: '8', cy: '8', r: '6', 'stroke-dasharray': '2.6 2.6' }]],
    plan: [['path', { d: 'M3 4h10M3 8h10M3 12h6' }]],
    build: [['path', { d: 'M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4', 'stroke-width': '1.7' }]],
    review: [
      ['circle', { cx: '7', cy: '7', r: '4.2' }],
      ['path', { d: 'M10.2 10.2 14 14' }],
    ],
    icebox: [['path', { d: 'M8 2v12M2.8 5 13.2 11M13.2 5 2.8 11' }]],
    archived: [
      ['rect', { x: '2.2', y: '4.6', width: '11.6', height: '8', rx: '1.2' }],
      ['path', { d: 'M2.2 7.2h11.6M6.4 9.8h3.2' }],
    ],
  };

  /** Read one drawn pictogram back as the table that produced it. */
  function drawnMark(svg: Element | null): [string, Record<string, string>][] {
    return Array.from(svg?.children ?? []).map((shape) => [
      shape.tagName,
      Object.fromEntries(Array.from(shape.attributes).map((entry) => [entry.name, entry.value])),
    ]);
  }

  it('renders every lane the payload carries, with its count — R10', () => {
    send(message({ lanes: lanes({ plan: [planCard] }) }));

    const rendered = Array.from(document.querySelectorAll<HTMLElement>('.lane h2 .lane-name')).map((h) => h.textContent);

    expect(rendered).toEqual([...LANE_NAMES]);
    expect(laneEl('plan')?.querySelector('.lane-count')?.textContent).toBe('1');
    expect(laneEl('unstarted')?.querySelector('.lane-count')?.textContent).toBe('0');
    expect(laneEl('plan')?.querySelectorAll('.card')).toHaveLength(1);
  });

  /** The heading keeps its name here, so the pictogram reinforces it; the overlay's chip has only the mark. */
  it('marks every lane heading with the pictogram the overlay draws', () => {
    // Archived draws only behind its toggle, and its pictogram is the one no visible lane would cover.
    send(message({ lanes: lanes({ plan: [planCard], archived: [{ ...planCard, key: 'issue:1', lane: 'archived' }] }) }));

    toggleArchived();

    const drawn = Array.from(document.querySelectorAll<HTMLElement>('.lane h2 .lane-mark'));

    expect(drawn.map((el) => el.dataset.lane)).toEqual([
      'unstarted', 'plan', 'build', 'review', 'icebox', 'archived',
    ]);
    expect(drawn.map((el) => drawnMark(el))).toEqual(drawn.map((el) => LANE_MARKS[el.dataset.lane ?? '']));
    // Before the name, which the heading still carries.
    expect(drawn[1]!.nextElementSibling?.className).toBe('lane-name');
  });

  it('says a lane is empty rather than leaving a blank column', () => {
    send(message({ lanes: lanes({ plan: [planCard] }) }));

    expect(laneEl('unstarted')?.querySelector('.lane-empty')?.textContent).toBe('Nothing here');
    expect(laneEl('plan')?.querySelector('.lane-empty')).toBeNull();
  });

  it('hides archived work until the toggle asks for it — R9', () => {
    send(message({ lanes: lanes({ plan: [planCard], archived: [archivedCard] }) }));

    expect(laneEl('archived')).toBeNull();
    expect(archiveItem()).toEqual({ label: 'Show archived (1)', checked: false });
    expect(document.getElementById('meta')?.textContent).toContain('1 card');

    toggleArchived();

    expect(laneEl('archived')?.querySelectorAll('.card')).toHaveLength(1);
    expect(archiveItem()?.checked).toBe(true);
    expect(document.getElementById('meta')?.textContent).toContain('2 cards');
  });

  it('posts the archive choice for the extension to keep, and draws the lane when it is handed back — R9', () => {
    send(message({ lanes: lanes({ plan: [planCard], archived: [archivedCard] }) }));

    toggleArchived();

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'setShowArchived', shown: true });

    toggleArchived();

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'setShowArchived', shown: false });
    expect(laneEl('archived')).toBeNull();

    send({ type: 'showArchived', shown: true });

    expect(laneEl('archived')?.querySelectorAll('.card')).toHaveLength(1);
    expect(archiveItem()?.checked).toBe(true);
  });

  it('says so when the configured statuses archive the whole board — R25', () => {
    send(message({ lanes: lanes({ archived: [archivedCard] }) }));

    expect(document.querySelector('.notice')?.textContent).toContain('Every issue the board read is archived');
  });

  it('says nothing of the sort while any lane holds a card', () => {
    send(message({ lanes: lanes({ plan: [planCard], archived: [archivedCard] }) }));

    expect(document.querySelectorAll('.notice')).toHaveLength(0);
  });

  it('drops the emoji off a status but keeps the board own word', () => {
    const statuses = ['🎁 Assigned', '⚒️ Dev', '👟 Ready For Testing', '🧊 On Ice'];

    for (const status of statuses) {
      send(message({ lanes: lanes({ plan: [{ ...planCard, issue: { ...planCard.issue!, status } }] }) }));

      expect(document.querySelector('.status')?.textContent).toBe(status.replace(/^\S+\s+/u, ''));
    }
  });

  // Absent rather than disabled: an item that could only ever draw an empty column is worse than no item at all.
  it('offers no archive toggle when nothing is archived', () => {
    send(message({ lanes: lanes({ plan: [planCard] }) }));

    expect(archiveItem()).toBeNull();
  });

  it('marks a returned card, and leaves the card itself without a tooltip — R6', () => {
    send(message({ lanes: lanes({ unstarted: [{ ...liveCard, returned: true }] }) }));

    const card = document.querySelector<HTMLElement>('.card')!;

    expect(card.querySelector('.badges.github .returned')?.textContent).toBe('Returned');
    expect(tipOf(card.querySelector('.card-open'))).toBe('');
    expect(tipOf(card)).toBe('');
  });

  it('moves a focused card one lane with alt and an arrow', () => {
    send(message({ lanes: lanes({ plan: [planCard] }) }));

    const open = document.querySelector<HTMLElement>('.card-open')!;

    open.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true }));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'moveCard', key: 'issue:18953', lane: 'build' });

    open.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true }));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'moveCard', key: 'issue:18953', lane: 'unstarted' });
  });

  it('does not move a card on an arrow without alt, nor past either end', () => {
    // Distinct keys: one card is one element, so the same key in two lanes would be one card, not two.
    const parked: LanedCard = { ...planCard, key: 'issue:18900', issueNumber: 18900, lane: 'icebox' };

    send(message({ lanes: lanes({ unstarted: [liveCard], icebox: [parked] }) }));

    const [first, last] = Array.from(document.querySelectorAll<HTMLElement>('.card-open'));

    first!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    first!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true }));
    last!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true }));

    expect(sent()).toEqual([]);
  });

  it('moves a card dropped onto another lane', () => {
    send(message({ lanes: lanes({ plan: [planCard] }) }));

    const card = document.querySelector<HTMLElement>('.card')!;
    const target = laneEl('build')!;

    // jsdom has no DataTransfer, which is the case the drop's own fallback to the dragged key exists for.
    card.dispatchEvent(new Event('dragstart', { bubbles: true }));
    expect(card.classList).toContain('dragging');

    target.dispatchEvent(new Event('drop', { bubbles: true }));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'moveCard', key: 'issue:18953', lane: 'build' });

    card.dispatchEvent(new Event('dragend', { bubbles: true }));
    expect(card.classList).not.toContain('dragging');
  });

  it('hides an empty Icebox, and brings it back as a drop target while a card is dragged', () => {
    send(message({ lanes: lanes({ plan: [planCard], icebox: [{ ...planCard, key: 'issue:1', lane: 'icebox' }] }) }));

    expect(laneEl('icebox')?.classList).not.toContain('lane-idle');

    send(message({ lanes: lanes({ plan: [planCard] }) }));

    expect(laneEl('icebox')?.classList).toContain('lane-idle');
    expect(document.getElementById('lanes')?.classList).not.toContain('dragging');

    const card = document.querySelector<HTMLElement>('.card')!;

    expect(getComputedStyle(laneEl('icebox')!).display).toBe('none');

    card.dispatchEvent(new Event('dragstart', { bubbles: true }));
    expect(document.getElementById('lanes')?.classList).toContain('dragging');
    expect(getComputedStyle(laneEl('icebox')!).display).toBe('flex');

    card.dispatchEvent(new Event('dragend', { bubbles: true }));
    expect(document.getElementById('lanes')?.classList).not.toContain('dragging');
  });

  it('clears the archive toggle when the last archived card leaves, so no empty column is stranded', () => {
    send(message({ lanes: lanes({ plan: [planCard], archived: [archivedCard] }) }));
    toggleArchived();

    expect(laneEl('archived')).not.toBeNull();

    send(message({ lanes: lanes({ plan: [planCard] }) }));

    expect(laneEl('archived')).toBeNull();
    expect(archiveItem()).toBeNull();

    // Cleared rather than remembered: the archive filling again must not bring back a column nobody asked for.
    send(message({ lanes: lanes({ plan: [planCard], archived: [archivedCard] }) }));

    expect(laneEl('archived')).toBeNull();
    expect(archiveItem()?.checked).toBe(false);
  });

  it('keeps the element of a card a refresh did not change, so its lane stays scrolled where it was', () => {
    const other: LanedCard = { ...planCard, key: 'issue:18900', issueNumber: 18900 };

    send(message({ lanes: lanes({ plan: [planCard, other] }) }));

    const before = Array.from(document.querySelectorAll<HTMLElement>('.card'));
    const list = laneEl('plan')!.querySelector('.lane-cards')!;

    send(message({ lanes: lanes({ plan: [planCard, other] }) }));

    expect(laneEl('plan')!.querySelector('.lane-cards')).toBe(list);
    expect(Array.from(document.querySelectorAll<HTMLElement>('.card'))).toEqual(before);
  });

  it('rebuilds a card whose session was retitled, so the new title is on it', () => {
    send(message({ lanes: lanes({ plan: [planCard] }) }));

    const before = document.querySelector<HTMLElement>('.card')!;
    const retitled = { ...planCard, sessions: [{ ...session, title: 'Now checking the migration' }] };

    send(message({ lanes: lanes({ plan: [retitled] }) }));

    const after = document.querySelector<HTMLElement>('.card')!;

    expect(after).not.toBe(before);
    expect(after.querySelector('.session-label')?.textContent).toBe('Now checking the migration');
  });

  it('rebuilds only the card whose content changed, and reorders the rest in place', () => {
    const other: LanedCard = { ...planCard, key: 'issue:18900', issueNumber: 18900 };

    send(message({ lanes: lanes({ plan: [planCard, other] }) }));

    const [first, second] = Array.from(document.querySelectorAll<HTMLElement>('.card'));

    send(message({ lanes: lanes({ plan: [other, { ...planCard, returned: true }] }) }));

    const after = Array.from(document.querySelectorAll<HTMLElement>('.card'));

    expect(after[0]).toBe(second);
    expect(after[1]).not.toBe(first);
    expect(after[1]?.querySelector('.returned')).not.toBeNull();
  });

  it('drops the element of a card the board no longer carries', () => {
    send(message({ lanes: lanes({ plan: [planCard] }) }));
    send(message({ lanes: lanes({}) }));

    expect(document.querySelectorAll('.card')).toHaveLength(0);
    expect(document.querySelector('.empty')?.textContent).toBe('No open issues are assigned to you.');
  });

  it('holds a refresh that arrives mid-drag until the drag ends', () => {
    send(message({ lanes: lanes({ plan: [planCard] }) }));

    const card = document.querySelector<HTMLElement>('.card')!;
    card.dispatchEvent(new Event('dragstart', { bubbles: true }));

    send(message({ lanes: lanes({ build: [{ ...planCard, lane: 'build' }] }) }));

    expect(laneEl('plan')?.querySelectorAll('.card')).toHaveLength(1);
    expect(laneEl('build')?.querySelectorAll('.card')).toHaveLength(0);

    card.dispatchEvent(new Event('dragend', { bubbles: true }));

    expect(laneEl('plan')?.querySelectorAll('.card')).toHaveLength(0);
    expect(laneEl('build')?.querySelectorAll('.card')).toHaveLength(1);
  });

  it('renders a refresh straight away when nothing is being dragged', () => {
    send(message({ lanes: lanes({ plan: [planCard] }) }));
    send(message({ lanes: lanes({ build: [{ ...planCard, lane: 'build' }] }) }));

    expect(laneEl('build')?.querySelectorAll('.card')).toHaveLength(1);
  });

  it('ignores a drop carrying something that is not a card on the board', () => {
    send(message({ lanes: lanes({ plan: [planCard] }) }));

    // A file or a text selection dropped on a column arrives exactly like this, with a key the board never issued.
    const drop = new Event('drop', { bubbles: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { getData: () => 'issue:99999' } });

    laneEl('build')!.dispatchEvent(drop);
    expect(sent()).toEqual([]);
  });

  it('keeps a card with no issue reachable from a keyboard, since it has no open button', () => {
    const adHoc: LanedCard = {
      key: 'session:c:/work/18953-cache-remediation',
      issue: null,
      issueNumber: null,
      lane: 'plan',
      returned: false,
      attention: null,
      reason: 'Ad-hoc work with no issue.',
      sessions: [{ ...session, issueNumber: null }],
    };

    send(message({ lanes: lanes({ plan: [adHoc] }) }));

    const card = document.querySelector<HTMLElement>('.card')!;

    expect(card.querySelector('.card-open')).toBeNull();
    expect(card.tabIndex).toBe(0);

    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true }));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'moveCard', key: adHoc.key, lane: 'build' });
  });

  it('offers no way to move an archived card — only a status takes a card off the board', () => {
    send(message({ lanes: lanes({ archived: [archivedCard] }) }));
    toggleArchived();
    // The toggle posts the choice itself, and this is about what the card sends.
    api.postMessage.mockClear();

    const card = laneEl('archived')!.querySelector<HTMLElement>('.card')!;

    expect(card.draggable).toBe(false);

    card.querySelector<HTMLElement>('.card-open')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true }),
    );
    expect(sent()).toEqual([]);
  });
});

/**
 * Both clients duplicate the agent display name because neither can import workspace packages at runtime. The
 * board has no export to call, so read it back off a rendered row.
 */
describe('the agent display name', () => {
  it.each([
    ['claude', 'Claude'],
    ['codex', 'Codex'],
    ['gemini', 'Gemini'],
  ])('titles %s as %s on the row', (agent, titled) => {
    send(message({ lanes: lanes({ build: [{ ...liveCard, sessions: [{ ...session, agent }] }] }) }));

    expect(document.querySelector('.session')!.getAttribute('aria-label')).toBe(
      `cache-remediation, ${titled}, editing tests, live - open this session`,
    );
  });
});

/**
 * Verify the same literal session-label precedence in core and both clients, which cannot import core at
 * runtime.
 */
describe('the session label ladder', () => {
  const rows: [string, Partial<Session>, string][] = [
    ['the title derived from the first prompt', { title: 'Fix the lane divider' }, 'Fix the lane divider'],
    ['what the CLI called it', { title: null, details: { name: 'plucky-otter' } }, 'plucky-otter'],
    ['the short id', { title: null, details: { shortId: 'a1b2c3d4' } }, 'a1b2c3d4'],
    ['the directory it is working in', { title: null, details: {}, cwd: 'd:/git/orez' }, 'orez'],
    ['the directory, past a trailing separator', { title: null, details: {}, cwd: 'd:/git/orez/' }, 'orez'],
    ['the directory a Windows CLI reported', { title: null, details: {}, cwd: 'D:\\git\\orez' }, 'orez'],
    ['the directory, past a trailing Windows separator', { title: null, details: {}, cwd: 'D:\\git\\orez\\' }, 'orez'],
  ];

  it.each(rows)('names a session by %s', (_rung, over, expected) => {
    send(message({ lanes: lanes({ build: [{ ...liveCard, sessions: [{ ...session, ...over }] }] }) }));

    expect(document.querySelector('.session .session-label')!.textContent).toBe(expected);
  });

  // The rows above each set one rung, so only this pins the order: a ladder that read the bag first would pass them.
  it('prefers each rung over the one below it', () => {
    const rungs: Partial<Session>[] = [
      { title: 'Fix the lane divider', cwd: 'd:/git/orez', details: { name: 'plucky-otter', shortId: 'a1b2c3d4' } },
      { title: null, cwd: 'd:/git/orez', details: { name: 'plucky-otter', shortId: 'a1b2c3d4' } },
      { title: null, cwd: 'd:/git/orez', details: { shortId: 'a1b2c3d4' } },
    ];

    send(message({ lanes: lanes({ build: [{ ...liveCard, sessions: rungs.map((over, i) => ({ ...session, ...over, sessionId: `s${i}` })) }] }) }));

    expect(Array.from(document.querySelectorAll('.session .session-label')).map((el) => el.textContent)).toEqual([
      'Fix the lane divider',
      'plucky-otter',
      'a1b2c3d4',
    ]);
  });
});


describe('historical rows', () => {
  const lastSession = { agent: 'claude', sessionId: 'past', title: 'Past attempt', cwd: '/work/18953-test', branch: '18953-test', issueNumber: 18953, repository: 'github.com/org/repo', updatedAt: Date.now() - 60000 };
  it('renders a neutral non-clickable row, updates it, and replaces it when a session resumes', () => {
    const pastCard = { ...liveCard, sessions: [], lastSession };
    send(message({ lanes: lanes({ build: [pastCard] }), openable: [] }));
    const row = document.querySelector<HTMLElement>('.historical')!;
    expect(row.textContent).toContain('Past attempt');
    // One line: the value alone floats to the right, and what it is a value of is said by the hollow mark.
    expect(row.querySelector('.state')?.textContent).toBe('1m');
    expect(row.textContent).not.toContain('Last session');
    expect(row.querySelector<HTMLElement>('.dot')?.dataset['live']).toBe('false');
    // On the age, as a live row's is: the row itself says nothing on hover, and the exact moment is what `1m` drops.
    expect(tipOf(row)).toBe('');
    expect(tipOf(row.querySelector('.state'))).toContain('Last saved');
    expect(row.tagName).toBe('SPAN');
    expect(row.querySelector('button, a')).toBeNull();
    // Assert phase absence on the row and dot; the age attribute alone does not establish it.
    expect(row.dataset.phase).toBeUndefined();
    expect(row.querySelector<HTMLElement>('.dot')?.dataset['phase']).toBe('none');
    row.click(); expect(sent()).toEqual([]);
    send(message({ lanes: lanes({ build: [{ ...pastCard, lastSession: { ...lastSession, title: 'Renamed' } }] }) }));
    expect(document.querySelector('.historical')?.textContent).toContain('Renamed');
    send(message({ lanes: lanes({ build: [{ ...liveCard, lastSession }] }) }));
    expect(document.querySelector('.historical')).toBeNull();
    send(message({ lanes: lanes({ build: [pastCard] }) }));
    expect(document.querySelector('.historical')).not.toBeNull();
  });
  /**
   * Set retained phase on the row and unfilled dot. Map ended running sessions to idle (R6).
   */
  it.each([
    ['waiting', 'waiting', 'waiting for your input'],
    ['idle', 'idle', 'completed its turn'],
    ['running', 'idle', 'before completing its turn'],
    ['failed', 'failed', 'ended on an error: overloaded. API Error: 529 Overloaded. The session has since ended.'],
  ] as const)('outlines a %s reading kept past the process as %s, and says which on hover', (phase, drawn, said) => {
    const at = Date.now() - 300_000;
    const error = { kind: 'overloaded', message: 'API Error: 529 Overloaded.' };
    const retained = { ...lastSession, retained: { phase, event: 'PreToolUse', at, ...(phase === 'failed' ? { error } : {}) } };

    send(message({ lanes: lanes({ build: [{ ...liveCard, sessions: [], lastSession: retained }] }) }));

    const row = document.querySelector<HTMLElement>('.historical')!;

    expect(row.dataset.phase).toBe(drawn);
    expect(row.querySelector<HTMLElement>('.dot')?.dataset['phase']).toBe(drawn);
    // The fill is what says the process is gone, and it stays off whatever the phase.
    expect(row.querySelector<HTMLElement>('.dot')?.dataset['live']).toBe('false');
    expect(tipOf(row.querySelector('.dot'))).toContain(said);
    expect(tipOf(row.querySelector('.dot'))).toContain('PreToolUse');
    // Use retained event time for both duration and tooltip instead of transcript modification time (R24).
    expect(row.querySelector('.state')?.textContent).toBe('5m');
    expect(tipOf(row.querySelector('.state'))).toContain('Last seen');
    expect(tipOf(row.querySelector('.state'))).toContain(new Date(at).toLocaleString());

    // A resumable row states the retained phase itself; its dot's name would be replaced by the row's (R2).
    send(message({ lanes: lanes({ build: [{ ...liveCard, sessions: [], lastSession: retained }] }), openable: [lastSession.sessionId] }));

    expect(document.querySelector('button.historical')!.getAttribute('aria-label')).toBe(
      `Past attempt, Claude, ${drawn === 'waiting' ? 'waiting for input' : drawn}, ended - resume this session`,
    );
  });

  /** A snapshot an older hub cached, or one whose fields were redefined: the cast is what lets a shape the current type forbids be rendered. */
  it('draws the plain hollow mark for a saved session carrying a reading it cannot read', () => {
    const readings: unknown[] = [undefined, { phase: 'waiting', event: 'PreToolUse' }, { phase: 'napping', event: 'PreToolUse', at: 1 }];

    for (const retained of readings) {
      const saved = { ...lastSession, ...(retained ? { retained } : {}) } as HistoricalSession;

      send(message({ lanes: lanes({ build: [{ ...liveCard, sessions: [], lastSession: saved }] }) }));

      const row = document.querySelector<HTMLElement>('.historical')!;

      expect(row.querySelector<HTMLElement>('.dot')?.dataset['phase']).toBe('none');
      expect(row.querySelector('.state')?.textContent).toBe('1m');
      expect(tipOf(row.querySelector('.state'))).toContain('Last saved');
    }
  });

  it('tolerates absent and malformed history in cached payloads', () => {
    for (const history of [undefined, { ...lastSession, updatedAt: NaN }]) {
      send(message({ lanes: lanes({ build: [{ ...liveCard, sessions: [], ...(history ? { lastSession: history } : {}) }] }) }));
      expect(document.querySelector('.historical')).toBeNull();
    }
    send(message({ lanes: lanes({ build: [{ ...liveCard, sessions: [], lastSession: { ...lastSession, title: null, agent: 'other' } }] }) }));
    expect(document.querySelector('.historical')?.textContent).toContain('18953-test');
  });
});


it('makes a historical title openable when the host offers it, including after a cached render', () => {
  const lastSession = { agent: 'claude', sessionId: 'past', title: 'Past attempt', cwd: '/work/18953-test', branch: '18953-test', issueNumber: 18953, repository: 'github.com/org/repo', updatedAt: Date.now() - 60000 };
  const pastCard = { ...liveCard, sessions: [], lastSession };
  send(message({ lanes: lanes({ build: [pastCard] }), openable: [] }));
  expect(document.querySelector('button.historical')).toBeNull();
  send(message({ lanes: lanes({ build: [pastCard] }), openable: ['past'] }));
  const button = document.querySelector<HTMLButtonElement>('button.historical')!;
  expect(button.querySelector('.session-label')?.textContent).toBe('Past attempt'); expect(button.draggable).toBe(false);
  // Saved sessions must resume in the editor; there is no process to attach to.
  expect(button.querySelector('.destination')?.getAttribute('data-destination')).toBe('editor');
  button.click(); expect(sent()).toEqual([{ type: 'openSession', sessionId: 'past' }]);
  expect(tipOf(button)).toBe('');
  expect(button.getAttribute('aria-label')).toBe('Past attempt, Claude, no state reported, ended - resume this session');
  expect(tipOf(button.querySelector('.state'))).toContain('Resume this session');
  send(message({ lanes: lanes({ build: [pastCard] }), openable: [] }));
  expect(document.querySelector('button.historical')).toBeNull();
});

/** Keep GitHub issue details separate from the Ground Control footer, matching the overlay. */
describe('what GitHub says, and what the board adds', () => {
  const triage: NonNullable<LanedCard['triage']> = { state: 'done', action: 'address-review', qualifier: 'followup', detail: 'Answer the naming notes.', at: Date.now(), stale: false };
  const waiting: Session = { ...session, activity: { phase: 'waiting', since: Date.now(), at: Date.now(), event: 'Notification' } };

  const rows: [string, string][] = [
    ['type', '.badges.github'],
    ['status', '.badges.github'],
    ['pull-request', '.badges.github'],
    ['returned', '.badges.github'],
    ['verdict', '.card-foot .cmdbar'],
  ];

  function full(): void {
    send(
      message({
        lanes: lanes({
          build: [
            {
              ...liveCard,
              returned: true,
              attention: 'blocked',
              triage,
              sessions: [waiting],
            },
          ],
        }),
      }),
    );
  }

  // The pull request's own state reaches the chip through `--gc-badge`, which is the one part of it that carries it.
  it('hands a reference chip the colour of the state it is reporting', () => {
    full();

    expect(document.querySelector<HTMLElement>('.badge.pull-request')!.style.getPropertyValue('--gc-badge')).toBe(
      'var(--vscode-charts-green)',
    );
  });

  it('reads down: the header, the title, GitHub own labels, then everything this board adds', () => {
    full();

    const card = document.querySelector<HTMLElement>('.card')!;

    expect(Array.from(card.children).map((el) => el.className)).toEqual([
      'card-meta',
      'card-open',
      'badges github',
      'card-foot',
    ]);
  });

  it.each(rows)('draws the %s chip in %s', (kind, where) => {
    full();

    expect(document.querySelector(`${where} .${kind}`)).not.toBeNull();
  });

  /** The band under the bar carries the footer tint, so a card with no session must not draw an empty one. */
  it('leaves the session block empty on a card nobody has worked on, for the stylesheet to drop', () => {
    const { lastSession: _saved, ...bare } = liveCard;

    send(message({ lanes: lanes({ build: [{ ...bare, sessions: [] }] }) }));

    expect(document.querySelector('.card-foot .card-sessions')!.childElementCount).toBe(0);
  });

  it('carries the reading sentence and every session row inside the footer, never above it', () => {
    full();

    const foot = document.querySelector<HTMLElement>('.card-foot')!;

    expect(tipOf(foot.querySelector('.verdict'))).toContain('Answer the naming notes.');
    expect(foot.querySelectorAll('.session')).toHaveLength(1);
    expect(document.querySelectorAll('.card > .session')).toHaveLength(0);
  });

  /** Include triage and action state in the card signature so their changes rebuild the footer. */
  it('fills in when a reading lands on a card already on the board', () => {
    const bare = { ...liveCard, sessions: [] };

    send(message({ lanes: lanes({ build: [bare] }) }));
    // An eligible unread card says so and carries the reading control (R38).
    expect(document.querySelector('.card-foot .verdict')?.textContent).toBe('Not read');
    expect(document.querySelector('.card-foot .tool[aria-label^="Read this card"]')).not.toBeNull();

    send(message({ lanes: lanes({ build: [{ ...bare, triage: { state: 'running' } }] }) }));
    expect(document.querySelector<HTMLElement>('.card-foot .verdict')?.dataset.state).toBe('triaging');

    send(message({ lanes: lanes({ build: [{ ...bare, triage }] }) }));
    expect(document.querySelector('.card-foot .verdict')?.textContent).toBe('Answer review · followup');
    expect(tipOf(document.querySelector('.card-foot .verdict'))).toContain('Answer the naming notes.');

    send(message({ lanes: lanes({ build: [{ ...bare, triage, action: { state: 'available', action: 'merge-upstream' } }] }) }));
    expect(document.querySelector('.card-foot .tool[aria-label="Run merge upstream"]')).not.toBeNull();
  });

  // Settled: the footer is where this board's controls go, so it is drawn on a card that has nothing in it yet.
  it('is drawn on a card the board has read nothing about and nobody has worked on', () => {
    send(message({ lanes: lanes({ unstarted: [{ ...liveCard, sessions: [] }] }) }));

    const foot = document.querySelector<HTMLElement>('.card-foot')!;

    expect(foot).not.toBeNull();
    expect(foot.querySelector('.verdict')?.textContent).toBe('Not read');
    expect(foot.querySelector('.tool[aria-label^="Read this card"]')).not.toBeNull();
  });

  it('draws an empty footer where the hub reports no classifier to read with', () => {
    send(
      message({
        lanes: lanes({ unstarted: [{ ...liveCard, sessions: [] }] }),
        triage: { mode: 'manual', message: null, canRequest: false },
      }),
    );

    expect(document.querySelector('.card-foot .verdict')?.textContent).toBe('Not read');
    expect(document.querySelector('.tool[aria-label^="Read this card"]')).toBeNull();
  });

});

describe("the card's own menu", () => {
  const control = () => document.querySelector<HTMLButtonElement>('.card-menu');
  const menu = () => document.querySelector<HTMLElement>('.card-popover');
  const items = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.card-popover button'));

  // Close through closeMenu to remove document handlers between tests.
  afterEach(() => document.dispatchEvent(new MouseEvent('click', { bubbles: true })));

  it('hangs from a control on the card header, named for the card it acts on', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));

    const el = control()!;

    expect(el.closest('.card-meta')).not.toBeNull();
    expect(el.getAttribute('aria-haspopup')).toBe('menu');
    expect(el.getAttribute('aria-expanded')).toBe('false');
    expect(el.getAttribute('aria-label')).toBe('More actions for Cached counts do not update');
    // Without this a few pixels of drift on the way to a click starts a drag of the card instead.
    expect(el.getAttribute('draggable')).toBe('false');
    expect(menu()).toBeNull();
  });

  // Between the number it acts on and the face at the card's edge, which is where GitHub keeps its own.
  it('sits beside the issue number rather than past the avatar', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));

    const meta = document.querySelector<HTMLElement>('.card-meta')!;

    expect(Array.from(meta.children).map((el) => el.className)).toEqual([
      'number link',
      'card-menu',
      'avatar-slot',
    ]);
  });

  it('names the repository beside the branch on a card with no issue, which a branch alone would not', () => {
    const adHoc: LanedCard = {
      key: 'session:github.com/example-org/example-repo#master',
      issue: null,
      issueNumber: null,
      lane: 'build',
      returned: false,
      attention: null,
      reason: 'Ad-hoc work with no issue.',
      sessions: [{ ...session, ...checkout }],
      checkout: { root: 'c:/work/example-repo', source: 'session', only: true },
    };

    send(message({ lanes: lanes({ build: [adHoc] }) }));
    control()!.click();

    expect(control()!.getAttribute('aria-label')).toBe('More actions for example-repo master');
    expect(menu()!.getAttribute('aria-label')).toBe('Actions for example-repo master');
  });

  /** A checkout card has nothing to read, so the bar's verdict names its branch and the title line is not drawn. */
  it('titles a card with no issue from its command bar, with the controls where every card has them', () => {
    const adHoc: LanedCard = {
      key: 'session:github.com/example-org/example-repo#master',
      issue: null,
      issueNumber: null,
      lane: 'build',
      returned: false,
      attention: null,
      reason: 'Ad-hoc work with no issue.',
      sessions: [{ ...session, ...checkout }],
      checkout: { root: 'c:/work/example-repo', source: 'session', only: true },
      action: { state: 'available', action: 'merge-upstream' },
    };

    send(message({ lanes: lanes({ build: [adHoc] }), triage: { mode: 'manual', message: null, canRequest: true } }));

    const card = document.querySelector<HTMLElement>('.card')!;

    expect(card.querySelector('.card-open')).toBeNull();
    expect(card.querySelector('.cmdbar .verdict')?.textContent).toBe('master');
    expect(tipOf(card.querySelector('.verdict'))).toBe('');
    expect(card.querySelector('.card-age')).toBeNull();
    // No issue to read, so no read control, whatever the mode; the checkout and the action still have theirs.
    expect(Array.from(card.querySelectorAll('.cmdbar .tail .tool')).map((el) => el.getAttribute('aria-label'))).toEqual([
      'Open in VS Code',
      'Run merge upstream',
    ]);
  });

  it('opens on a click and offers the changes the card has, closing again on a second one', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));
    control()!.click();

    expect(control()!.getAttribute('aria-expanded')).toBe('true');
    expect(menu()!.getAttribute('role')).toBe('menu');
    expect(menu()!.getAttribute('aria-label')).toBe('Actions for Cached counts do not update');
    expect(items().map((item) => item.textContent)).toEqual(['View changes']);
    expect(tipOf(items()[0])).toBe("Open this card's commits and uncommitted changes in one editor");
    // The first item takes the focus, so the menu can be driven from where the control left the keyboard.
    expect(document.activeElement).toBe(items()[0]);

    control()!.click();
    expect(menu()).toBeNull();
    expect(control()!.getAttribute('aria-expanded')).toBe('false');
  });

  it('names the card, never its directory, and closes as it acts', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));
    control()!.click();
    items()[0]!.click();

    expect(sent()).toEqual([{ type: 'openChanges', key: 'issue:18953' }]);
    expect(menu()).toBeNull();
  });

  it('closes on a click anywhere else, and on Escape with the focus put back', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));

    control()!.click();
    document.getElementById('meta')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(menu()).toBeNull();

    control()!.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(control());
  });

  it('walks its items with the arrow keys, wrapping at either end', () => {
    send(message({ lanes: lanes({ build: [liveCard] }), startable: [{ agent: 'claude', takesPrompt: true }] }));
    control()!.click();

    menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items()[1]);
    menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items()[0]);
    menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(items()[items().length - 1]);

    // Anything else is the item's own to handle, so the menu neither swallows it nor moves the focus for it.
    const typed = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });

    menu()!.dispatchEvent(typed);
    expect(typed.defaultPrevented).toBe(false);
  });

  // The menu is the last thing in the document, so a Tab it did not handle would land at the far end of the board.
  it('closes on Tab and continues navigation from the control', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));
    control()!.click();

    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });

    items()[0]!.dispatchEvent(tab);

    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(control());
    // Never prevented: the browser's own Tab is what moves on from the control this just focused.
    expect(tab.defaultPrevented).toBe(false);
  });

  it('opens at the first or last item with arrow keys', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));

    control()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items()[0]);

    control()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(items()[items().length - 1]);

    // One menu, not two: opening from the control again must take the first one off the document.
    expect(document.querySelectorAll('.card-popover')).toHaveLength(1);
  });

  it('jumps to either end on Home and End', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));
    control()!.click();

    menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(items()[items().length - 1]);

    menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(items()[0]);
  });

  // An action the host refuses would otherwise leave the keyboard at the top of the document with nothing said.
  it('puts the focus back on the control when an item is chosen', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));
    control()!.click();
    items()[0]!.click();

    expect(document.activeElement).toBe(control());
  });

  // A drag emits no click, so without this the menu rides along and is re-placed over the card's new lane.
  it('closes when the card it belongs to starts being dragged', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));
    control()!.click();

    const card = document.querySelector('.card')!;

    card.dispatchEvent(new Event('dragstart'));

    expect(menu()).toBeNull();

    // The board defers every render while a drag is live, so a drag left open stops the next test drawing anything.
    card.dispatchEvent(new Event('dragend'));
  });

  // `cardEls` keeps the element of a card the archive toggle is hiding, so being on the board is not being on screen.
  it('closes menus when their archive card is hidden', () => {
    const archived = { ...liveCard, key: 'issue:404', lane: 'archived' as const };

    send(message({ lanes: lanes({ archived: [archived] }) }));
    toggleArchived();

    control()!.click();
    expect(menu()).not.toBeNull();

    toggleArchived();
    send(message({ lanes: lanes({ archived: [{ ...archived, returned: true }] }) }));

    expect(menu()).toBeNull();
  });

  it('preserves the menu accessible name after card rebuild', () => {
    const running: Session = { ...session, activity: { phase: 'running', since: Date.now(), at: Date.now(), event: 'UserPromptSubmit' } };

    send(message({ lanes: lanes({ build: [{ ...liveCard, sessions: [running] }] }) }));
    control()!.click();

    const stopped: Session = { ...running, activity: { phase: 'waiting', since: Date.now(), at: Date.now(), event: 'Notification' } };

    send(message({ lanes: lanes({ build: [{ ...liveCard, sessions: [stopped] }] }) }));

    expect(control()!.getAttribute('aria-controls')).toBe(menu()!.id);
  });

  it('closes when the lane it is anchored in scrolls under it', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));
    control()!.click();

    document.querySelector('.lane-cards')!.dispatchEvent(new Event('scroll'));

    expect(menu()).toBeNull();
  });

  it('updates aria-controls to the current menu', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));
    control()!.click();

    expect(control()!.getAttribute('aria-controls')).toBe(menu()!.id);

    control()!.click();
    expect(control()!.getAttribute('aria-controls')).toBeNull();
  });

  it('is drawn on a card whose sessions have all ended, from the session it saved', () => {
    const lastSession = { agent: 'claude', sessionId: 'past', title: 'Past attempt', cwd: '/work/18953-test', branch: '18953-test', issueNumber: 18953, repository: 'github.com/org/repo', updatedAt: Date.now() - 60000 };

    send(message({ lanes: lanes({ build: [{ ...liveCard, sessions: [], lastSession }] }) }));

    expect(control()).not.toBeNull();
  });

  /** A card the hub found no checkout for carries no such field at all, which is not the same as carrying undefined. */
  const { checkout: _resolved, ...noCheckout } = liveCard;

  // Omit menus without available actions, including ad-hoc cards whose checkout no longer exists.
  it('omits menus with no available actions', () => {
    send(message({ lanes: lanes({ unstarted: [{ ...noCheckout, issue: null, issueNumber: null }] }) }));

    expect(control()).toBeNull();
  });

  it('offers checkout selection for issues without a checkout', () => {
    send(message({ lanes: lanes({ unstarted: [{ ...noCheckout, sessions: [] }] }) }));
    control()!.click();

    expect(items().map((item) => item.textContent)).toEqual(['Choose folder…']);
  });

  /** One item per agent the host has a way into. Which of them this window can start is settled on the click. */
  it('offers a start for each agent the host named, on a card with a checkout', () => {
    send(message({
      lanes: lanes({ build: [liveCard] }),
      startable: [{ agent: 'claude', takesPrompt: true }, { agent: 'codex', takesPrompt: false }],
    }));
    control()!.click();

    expect(items().map((item) => item.textContent)).toEqual(['View changes', 'Start Claude session', 'Start Codex session']);
  });

  // Codex new-panel commands accept no prompt; the menu must disclose this when a prompt is configured (M51).
  it('labels agents that cannot accept a start prompt', () => {
    send(message({
      lanes: lanes({ build: [liveCard] }),
      startable: [{ agent: 'claude', takesPrompt: true }, { agent: 'codex', takesPrompt: false }],
    }));
    control()!.click();

    // Pinned, not contained: the overlay pins the same two sentences (`docs/testing.md` parity tables).
    expect(tipOf(items()[1])).toBe('Open a new Claude session in c:/work/18953-test, prefilled and unsent');
    expect(tipOf(items()[2])).toBe(
      'Open a new Codex session in c:/work/18953-test. Codex offers no way in that takes a prompt, so it starts empty',
    );
  });

  /** Archived is wider than unassigned: a closed issue is archived while still assigned (R9). */
  it('offers no start on an archived card', () => {
    send(message({
      lanes: lanes({ archived: [{ ...liveCard, lane: 'archived' }] }),
      startable: [{ agent: 'claude', takesPrompt: true }],
    }));
    send({ type: 'showArchived', shown: true });
    control()!.click();

    // Named against an open menu: a menu that never opened has no start item either.
    expect(items().length).toBeGreaterThan(0);
    expect(items().map((item) => item.textContent ?? '').filter((label) => label.includes('Start'))).toEqual([]);
  });

  /** The other half of the same guard, which the archived case cannot stand in for (R9). */
  it('offers no start on a card the developer is no longer assigned', () => {
    send(message({
      lanes: lanes({ build: [{ ...liveCard, unassigned: true }] }),
      startable: [{ agent: 'claude', takesPrompt: true }],
    }));
    control()!.click();

    expect(items().length).toBeGreaterThan(0);
    expect(items().map((item) => item.textContent ?? '').filter((label) => label.includes('Start'))).toEqual([]);
  });

  it('sends only the selected card and agent', () => {
    send(message({ lanes: lanes({ build: [liveCard] }), startable: [{ agent: 'claude', takesPrompt: true }] }));
    control()!.click();
    items()[1]!.click();

    expect(sent()).toEqual([{ type: 'startSession', key: liveCard.key, agent: 'claude' }]);
  });

  // A card with no checkout has nowhere to start, so the item is left out rather than drawn to refuse.
  it('offers no start on a card with no checkout, whatever the host can start', () => {
    send(message({
      lanes: lanes({ unstarted: [{ ...noCheckout, sessions: [] }] }),
      startable: [{ agent: 'claude', takesPrompt: true }],
    }));
    control()!.click();

    expect(items().map((item) => item.textContent)).toEqual(['Choose folder…']);
  });

  // A browser board is resident in nothing, and a hub sends it an empty list — so the same card draws no start.
  it('omits start actions without host capabilities', () => {
    send(message({ lanes: lanes({ build: [liveCard] }), startable: [] }));
    control()!.click();

    expect(items().map((item) => item.textContent)).toEqual(['View changes']);
  });

  it('reanchors menus on rebuild and closes them on card removal', () => {
    const running: Session = { ...session, activity: { phase: 'running', since: Date.now(), at: Date.now(), event: 'UserPromptSubmit' } };
    const working: LanedCard = { ...liveCard, sessions: [running] };

    send(message({ lanes: lanes({ build: [working] }) }));
    control()!.click();

    const first = control()!;

    // A phase change rebuilds the card, so the menu would otherwise be left hanging off a detached control.
    const stopped: Session = { ...running, activity: { phase: 'waiting', since: Date.now(), at: Date.now(), event: 'Notification' } };

    send(message({ lanes: lanes({ build: [{ ...working, sessions: [stopped] }] }) }));
    expect(menu()).not.toBeNull();
    expect(control()).not.toBe(first);
    expect(control()!.getAttribute('aria-expanded')).toBe('true');

    send(message({ lanes: lanes({}) }));
    expect(menu()).toBeNull();
  });
});

describe('card triage (R38)', () => {
  const at = Date.UTC(2026, 8, 1, 19, 0, 0);

  /** The status moved at `moved`, which is a different time from `at` — a test must not pass on the wrong one. */
  function triaged(triage: NonNullable<LanedCard['triage']>, moved: string | null = null): LanedCard {
    return { ...liveCard, sessions: [], triage, issue: { ...liveCard.issue!, statusChangedAt: moved } };
  }

  function chip(): HTMLElement | null {
    return document.querySelector<HTMLElement>('.verdict');
  }

  /** The reread control, which stands where the age does until the bar is pointed at. */
  function again(): HTMLButtonElement | null {
    return document.querySelector<HTMLButtonElement>('.tool[aria-label^="Read this card"]');
  }

  it('shows triage progress without attention styling', () => {
    send(message({ lanes: lanes({ unstarted: [triaged({ state: 'running' })] }) }));

    expect(chip()?.textContent).toBe('Reading…');
    // R6's channels are for the two things that want the developer. Being read is not one of them.
    expect(document.querySelector<HTMLElement>('.card')?.dataset['attention']).toBeUndefined();
    expect(chip()?.dataset['state']).toBe('triaging');
  });

  /** Display status age on the chip and classification time in its tooltip. */
  it('shows action and status age with classification details on hover', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-06T19:00:00Z'));

    try {
      send(
        message({
          lanes: lanes({
            unstarted: [
              triaged(
                {
                  state: 'done',
                  action: 'address-review',
                  qualifier: 'followup',
                  detail: 'Answer the naming notes on the paging fix.',
                  at: Date.now() - 3_600_000,
                  stale: false,
                },
                '2026-09-04T19:00:00Z',
              ),
            ],
          }),
        }),
      );

      // 2d is the status move; the reading itself was an hour ago, and saying that here would be the wrong number.
      expect(chip()?.textContent).toBe('Answer review · followup');
      expect(document.querySelector('.tail .card-age')?.textContent).toBe('2d');
      expect(tipOf(chip())).toBe('Answer the naming notes on the paging fix. Read 1h ago.');
      expect(chip()?.dataset['stale']).toBe('false');
    } finally {
      vi.useRealTimers();
    }
  });

  // A card the project board records no move for — one off the board — carries the action and nothing after it.
  it('writes no age where GitHub records no status move', () => {
    send(
      message({
        lanes: lanes({ unstarted: [triaged({ state: 'done', action: 'develop', qualifier: null, detail: 'Pick it up.', at, stale: false })] }),
      }),
    );

    expect(chip()?.textContent).toBe('Develop');
    expect(document.querySelector('.card-age')).toBeNull();
  });

  it('advances the status age where it stands, on the clock the durations run on', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-06T19:00:00Z'));

    try {
      send(
        message({
          lanes: lanes({
            unstarted: [
              triaged(
                { state: 'done', action: 'develop', qualifier: null, detail: 'Pick it up.', at: Date.now(), stale: false },
                '2026-09-06T18:00:00Z',
              ),
            ],
          }),
        }),
      );

      const age = document.querySelector<HTMLElement>('.card-age')!;

      vi.setSystemTime(new Date('2026-09-06T21:00:00Z'));
      tick?.();

      expect(document.querySelector('.card-age')).toBe(age);
      expect(age.textContent).toBe('3h');
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes no qualifier where there is none', () => {
    send(
      message({
        lanes: lanes({ unstarted: [triaged({ state: 'done', action: 'merge-upstream', qualifier: null, detail: 'Merge it.', at, stale: false })] }),
      }),
    );

    expect(chip()?.textContent).toBe('Merge upstream');
  });

  it('marks stale classifications', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-06T19:00:00Z'));

    try {
      send(
        message({
          lanes: lanes({ unstarted: [triaged({ state: 'done', action: 'develop', qualifier: null, detail: 'Pick it up.', at, stale: true })] }),
        }),
      );

      expect(chip()?.dataset['stale']).toBe('true');
      // The sentence, when it was read, and the caveat — the caveat is about the sentence, so they read together.
      expect(tipOf(chip())).toBe('Pick it up. Read 5d ago; card details have changed.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('says so for unclassified cards', () => {
    send(message({ lanes: lanes({ unstarted: [{ ...liveCard, sessions: [] }] }) }));

    expect(chip()?.textContent).toBe('Not read');
    expect(tipOf(chip())).toBe('This card has not been read.');
  });

  it('requests an initial reading in manual mode', () => {
    send(message({
      triage: { mode: 'manual', message: 'Triage is manual.', canRequest: true },
      lanes: lanes({ unstarted: [{ ...liveCard, sessions: [] }] }),
    }));

    const read = again()!;

    expect(chip()?.textContent).toBe('Not read');
    expect(tipOf(read)).toContain('model usage');
    expect(sent()).toEqual([]);
    read.click();
    expect(sent()).toEqual([{ type: 'retriage', key: 'issue:18953' }]);
  });

  it.each([
    ['ad-hoc', { issue: null, issueNumber: null, sessions: [{ ...session, ...checkout }] }],
    ['unassigned', { unassigned: true }],
    ['archived', { lane: 'archived' }],
  ] satisfies [string, Partial<LanedCard>][])('offers no initial reading for %s cards', (_name, over) => {
    const entry = { ...liveCard, sessions: [], ...over };

    send(message({
      triage: { mode: 'manual', message: null, canRequest: true },
      lanes: lanes({ [entry.lane]: [entry] }),
    }));

    if (entry.lane === 'archived') {
      toggleArchived();
    }

    expect(document.querySelectorAll('.card')).toHaveLength(1);
    expect(again()).toBeNull();
  });

  it('redraws initial request controls when triage is turned off and on', () => {
    const shown = lanes({ unstarted: [{ ...liveCard, sessions: [] }] });

    send(message({ lanes: shown, triage: { mode: 'manual', message: null, canRequest: true } }));
    expect(again()).not.toBeNull();
    send(message({ lanes: shown, triage: { mode: 'off', message: null, canRequest: false } }));
    expect(again()).toBeNull();
    send(message({ lanes: shown, triage: { mode: 'automatic', message: null, canRequest: true } }));
    again()!.click();
    expect(sent()).toEqual([{ type: 'retriage', key: 'issue:18953' }]);
  });

  it.each([
    { state: 'done', action: 'develop', qualifier: null, detail: 'Saved result.', at, stale: false },
    { state: 'failed', attempts: 1, exhausted: false },
  ] satisfies NonNullable<LanedCard['triage']>[])('retains archived $state state without classification controls', (triage) => {
    const entry = { ...triaged(triage, '2026-09-01T19:00:00Z'), lane: 'archived' as const };
    send(message({ lanes: lanes({ archived: [entry] }), triage: { mode: 'manual', message: null, canRequest: true } }));
    toggleArchived();
    expect(chip()).not.toBeNull();
    expect(chip()?.textContent).toContain(triage.state === 'done' ? 'Develop' : 'Not read');
    expect(again()).toBeNull();
    api.postMessage.mockClear();
    chip()?.click();
    expect(sent()).toEqual([]);
  });

  it.each([
    { state: 'failed', attempts: 5, exhausted: true },
    { state: 'failed', attempts: 1, exhausted: false },
    { state: 'done', action: 'develop', qualifier: null, detail: 'Pick it up.', at, stale: false },
  ] satisfies NonNullable<LanedCard['triage']>[])('preserves $state results with no request control while off', (triage) => {
    const shown = lanes({ unstarted: [triaged(triage)] });

    send(message({ lanes: shown, triage: { mode: 'manual', message: null, canRequest: true } }));
    expect(again()).not.toBeNull();
    send(message({ lanes: shown, triage: { mode: 'off', message: null, canRequest: false } }));
    expect(chip()?.textContent).toBe(triage.state === 'done' ? 'Develop' : 'Not read');
    expect(again()).toBeNull();
    chip()?.click();
    expect(sent()).toEqual([]);
  });

  it.each([
    ['off', 'Triage is off.', false],
    ['manual', 'Triage is manual.', true],
    ['manual', 'No enabled agent supports card classification.', false],
    ['automatic', 'No configured source can provide card conversations.', false],
    ['automatic', 'Automatic triage reached its daily limit.', true],
  ] as const)('shows the %s diagnostic as a neutral notice', (mode, text, canRequest) => {
    send(message({ triage: { mode, message: text, canRequest } }));

    const notes = document.querySelectorAll('#notices .notice');

    expect(notes).toHaveLength(1);
    expect(notes[0]?.textContent).toBe(text);
    expect(notes[0]?.classList.contains('error')).toBe(false);
    send(message({ triage: { mode, message: null, canRequest } }));
    expect(document.querySelector('#notices .notice')).toBeNull();
  });

  it('offers retry for failed triage', () => {
    send(message({ lanes: lanes({ unstarted: [triaged({ state: 'failed', attempts: 2, exhausted: false })] }) }));

    expect(chip()?.textContent).toBe('Not read');
    expect(tipOf(chip())).toBe('Triage failed.');

    again()!.click();

    expect(sent()).toContainEqual({ type: 'retriage', key: 'issue:18953' });
  });

  it('reports when automatic triage retries stop', () => {
    send(message({ lanes: lanes({ unstarted: [triaged({ state: 'failed', attempts: 5, exhausted: true })] }) }));

    // Literal because the overlay pins the same sentence.
    expect(tipOf(chip())).toBe('Triage failed after 5 attempts. Automatic retries stopped.');
  });

  it('keeps triage separate from attention colors', () => {
    send(
      message({
        lanes: lanes({ unstarted: [triaged({ state: 'done', action: 'merge-upstream', qualifier: null, detail: 'Merge it.', at, stale: false })] }),
      }),
    );

    // `your-turn` is BLUE and `blocked` is YELLOW; a reading must read as neither at a glance.
    expect(chip()?.dataset['outcome']).toBeUndefined();
    expect(document.querySelector<HTMLElement>('.card')?.dataset['attention']).toBeUndefined();
  });

  /** The age is what the bar carries at rest, and the controls stand in its place: one slot, one width. */
  it('stacks the age and the controls in one right-edge slot', () => {
    send(
      message({
        lanes: lanes({
          unstarted: [
            triaged({ state: 'done', action: 'develop', qualifier: null, detail: 'Pick it up.', at, stale: false }, '2026-09-04T19:00:00Z'),
          ],
        }),
      }),
    );

    const tail = document.querySelector('.cmdbar > .tail')!;

    expect(Array.from(tail.children).map((el) => el.className)).toEqual(['card-age', 'tools']);
    expect(Array.from(tail.querySelectorAll('.tool')).map((el) => el.getAttribute('aria-label'))).toEqual([
      'Read this card again',
      'Open in VS Code',
    ]);
  });

  /** Keep the paid retriage action separate from opening the classification explanation. */
  it('requests retriage only from its dedicated control', () => {
    send(
      message({
        lanes: lanes({ unstarted: [triaged({ state: 'done', action: 'other', qualifier: null, detail: 'Unclear.', at, stale: false })] }),
      }),
    );

    chip()?.click();
    document.querySelector<HTMLElement>('.card-age')?.click();

    expect(sent()).toEqual([]);
    // Hovering to reach the control is what hides the age, so the control states it.
    expect(tipOf(again())).toMatch(/^Read this card again\. Last read .+ ago\. Uses model usage\.$/);
    again()!.click();

    expect(sent()).toEqual([{ type: 'retriage', key: 'issue:18953' }]);
  });

  it('is not a drag handle, through the attribute the platform reflects rather than the property', () => {
    send(
      message({
        lanes: lanes({ unstarted: [triaged({ state: 'done', action: 'other', qualifier: null, detail: 'Unclear.', at, stale: false })] }),
      }),
    );

    expect(again()?.getAttribute('draggable')).toBe('false');
  });
});

describe('card actions (R39)', () => {
  const at = Date.UTC(2026, 8, 1, 19, 0, 0);

  function acting(action: NonNullable<LanedCard['action']>): LanedCard {
    return { ...liveCard, sessions: [], action };
  }

  /** The run control, which the bar reveals in the age's place. */
  function chip(): HTMLButtonElement | null {
    return document.querySelector<HTMLButtonElement>('.tool.run');
  }

  /** What the bar says while an action is dispatched: the state displaces the triage qualifier. */
  function said(): string | undefined {
    return document.querySelector<HTMLElement>('.verdict .note')?.textContent ?? undefined;
  }

  it('offers to run an action the board could take, and sends the card key when pressed', () => {
    send(message({ lanes: lanes({ unstarted: [acting({ state: 'available', action: 'merge-upstream' })] }) }));

    expect(chip()?.getAttribute('aria-label')).toBe('Run merge upstream');
    expect(tipOf(chip())).toBe('Start Merge upstream in this card’s worktree.');
    chip()?.click();

    expect(sent()).toContainEqual({ type: 'runAction', key: 'issue:18953' });
  });

  it('offers stop for a running action', () => {
    send(message({ lanes: lanes({ unstarted: [acting({ state: 'running', action: 'merge-upstream', since: at })] }) }));

    expect(said()).toBe('Working…');
    expect(chip()?.getAttribute('aria-label')).toBe('Stop merge upstream');
    chip()?.click();

    expect(sent()).toContainEqual({ type: 'stopAction', key: 'issue:18953' });
    // Keep dispatched work out of R6's channels; it does not imply session attention.
    expect(document.querySelector<HTMLElement>('.card')?.dataset['attention']).toBeUndefined();
  });

  it('removes scoped-out session details while keeping the running action stoppable', () => {
    const action = { state: 'running', action: 'merge-upstream', since: at } as const;
    send(message({ lanes: lanes({ build: [{ ...liveCard, action }] }) }));
    expect(document.querySelectorAll('.session')).toHaveLength(1);
    document.querySelector<HTMLElement>('.card-menu')!.click();
    expect(document.body.innerHTML).toContain(liveCard.checkout!.root);
    expect(document.body.textContent).toContain('cache-remediation');

    const { checkout: _checkout, ...projected } = liveCard;
    send(message({ lanes: lanes({ build: [{ ...projected, sessions: [], action }] }) }));

    expect(document.querySelectorAll('.session')).toHaveLength(0);
    expect(document.body.innerHTML).not.toContain(session.cwd);
    expect(document.body.innerHTML).not.toContain(liveCard.checkout!.root);
    expect(document.body.innerHTML).not.toContain('cache-remediation');
    expect(document.body.textContent).toContain(liveCard.issue!.title);
    expect(said()).toBe('Working…');
    chip()?.click();
    expect(sent()).toContainEqual({ type: 'stopAction', key: liveCard.key });
  });

  it('renders a stop-only action without issue or session details', () => {
    const card: LanedCard = {
      key: 'issue:18953', issue: null, issueNumber: null, sessions: [], lane: 'build', returned: false,
      attention: null, reason: 'Ground Control action is running.',
      action: { state: 'running', action: 'merge-upstream', since: at },
    };
    send(message({ lanes: lanes({ build: [card] }) }));
    expect(document.body.textContent).toContain('Ground Control action');
    expect(document.querySelectorAll('.session, .card-menu')).toHaveLength(0);
    chip()?.click();
    expect(sent()).toContainEqual({ type: 'stopAction', key: card.key });
  });

  const outcomes: [NonNullable<LanedCard['action']> & { state: 'done' }, string][] = [
    [{ state: 'done', action: 'merge-upstream', outcome: 'landed', detail: 'Merged master.', at }, 'Merged'],
    [{ state: 'done', action: 'merge-upstream', outcome: 'halted', detail: 'Conflicts in Booking.cs.', at }, 'Stopped short'],
    [{ state: 'done', action: 'merge-upstream', outcome: 'failed', detail: 'Claude Code was not found.', at }, 'Did not run'],
    [{ state: 'done', action: 'merge-upstream', outcome: 'stopped', detail: 'Stopped by you.', at }, 'Stopped'],
  ];

  for (const [action, text] of outcomes) {
    it(`reads a ${action.outcome} run as "${text}", carrying what it said about itself`, () => {
      send(message({ lanes: lanes({ unstarted: [acting(action)] }) }));

      expect(said()).toBe(text);
      expect(document.querySelector<HTMLElement>('.verdict')?.dataset['outcome']).toBe(action.outcome);
      // Pinned, not contained: the overlay pins the same sentence, and a drift caught on one side only is
      // how the two clients stop matching (`docs/testing.md` parity tables).
      expect(tipOf(chip())).toBe(`${action.detail} Click to run Merge upstream again.`);
    });
  }

  it('offers retry for finished actions', () => {
    send(message({ lanes: lanes({ unstarted: [acting(outcomes[1]![0])] }) }));

    chip()?.click();

    expect(sent()).toContainEqual({ type: 'runAction', key: 'issue:18953' });
  });

  /** The remedy for a refusal is a setting or the card itself, so pressing again would only refuse again. */
  it('shows action refusals without a control', () => {
    send(
      message({
        lanes: lanes({
          unstarted: [acting({ state: 'refused', action: 'merge-upstream', reason: 'It merges into a feature branch.' })],
        }),
      }),
    );

    expect(said()).toBe('Not run');
    expect(tipOf(chip())).toBe('It merges into a feature branch.');
    expect(chip()?.getAttribute('aria-disabled')).toBe('true');
    // Reachable, or the reason it refuses could not be read.
    expect(chip()?.getAttribute('aria-description')).toBe('It merges into a feature branch.');
  });

  it('omits absent card actions', () => {
    send(message({ lanes: lanes({ unstarted: [{ ...liveCard, sessions: [] }] }) }));

    expect(chip()).toBeNull();
  });

  it('is not a drag handle, through the attribute the platform reflects rather than the property', () => {
    send(message({ lanes: lanes({ unstarted: [acting({ state: 'available', action: 'merge-upstream' })] }) }));

    expect(chip()?.getAttribute('draggable')).toBe('false');
  });
});

/** Verify literal triage labels against packages/board and both clients, which cannot share runtime imports. */
describe('triage labels read the same on every board', () => {
  const rows: [string, string | null, string][] = [
    ['develop', null, 'Develop'],
    ['dev-question', null, 'Dev question'],
    ['qa-question', null, 'QA question'],
    ['qa-failure', null, 'QA failure'],
    ['review-others', 'initial', 'Review their PR · initial'],
    ['review-others', 'followup', 'Review their PR · followup'],
    ['address-review', 'initial', 'Answer review · initial'],
    ['address-review', 'followup', 'Answer review · followup'],
    ['fix-checks', null, 'Fix failing checks'],
    ['merge-upstream', null, 'Merge upstream'],
    ['other', null, 'Other'],
  ];

  it.each(rows)('draws %s/%s as "%s"', (action, qualifier, expected) => {
    send(
      message({
        lanes: lanes({
          unstarted: [
            {
              ...liveCard,
              sessions: [],
              triage: {
                state: 'done',
                action: action as never,
                qualifier: qualifier as never,
                detail: 'x',
                at: Date.now(),
                stale: false,
              },
            },
          ],
        }),
      }),
    );

    expect(document.querySelector('.verdict')?.textContent).toBe(expected);
  });
});

describe("the board's own menu", () => {
  const control = () => document.getElementById('board-menu')!;
  const items = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.card-popover button'));
  const item = (label: string) => items().find((el) => el.textContent?.endsWith(label))!;

  beforeEach(() => {
    send({ type: 'logs', streaming: false });
  });

  // Close through closeMenu to remove document handlers between tests.
  afterEach(() => document.dispatchEvent(new MouseEvent('click', { bubbles: true })));

  it('lists board actions and the archive toggle when available', () => {
    control().click();

    expect(items().map((el) => el.textContent)).toEqual([
      'Stream hub log',
      'Show board log',
      'Refresh',
      'Settings',
    ]);
    expect(control().getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.card-popover')?.getAttribute('aria-label')).toBe('Board actions');

    document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    send(message({ lanes: lanes({ archived: [{ ...liveCard, lane: 'archived' as const }] }) }));
    control().click();

    // First, because what is on the board is read before what the board is doing about it.
    expect(items().map((el) => el.textContent)).toEqual([
      'Show archived (1)',
      'Stream hub log',
      'Show board log',
      'Refresh',
      'Settings',
    ]);
  });

  it('shows the board log, refreshes, and opens settings on the items that say so', () => {
    control().click();
    item('Show board log').click();
    expect(sent()).toEqual([{ type: 'showBoardLog' }]);

    control().click();
    item('Refresh').click();
    expect(sent()).toEqual([{ type: 'showBoardLog' }, { type: 'refresh' }]);

    control().click();
    item('Settings').click();
    expect(sent()).toEqual([{ type: 'showBoardLog' }, { type: 'refresh' }, { type: 'openSettings' }]);
  });

  it('asks the extension to toggle the hub log rather than deciding for itself', () => {
    control().click();
    item('Stream hub log').click();

    expect(sent()).toEqual([{ type: 'toggleLogs' }]);
    // Still off: the board paints what the extension says, so a click the extension refused leaves no mark.
    expect(control().classList).not.toContain('on');

    control().click();
    expect(item('Stream hub log').getAttribute('aria-checked')).toBe('false');
  });

  it('checks the hub log item and marks the control while the log is streaming', () => {
    send({ type: 'logs', streaming: true });

    expect(control().classList).toContain('on');
    expect(tipOf(control())).toContain('streaming into Output');

    control().click();

    const toggle = item('Stream hub log');

    // A state the menu will change, not an action, so it is a checkbox item rather than a plain one.
    expect(toggle.getAttribute('role')).toBe('menuitemcheckbox');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.querySelector('.menu-check')?.textContent).toBe('\u2713');
    expect(tipOf(toggle)).toContain('Stop streaming');

    document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    send({ type: 'logs', streaming: false });

    expect(control().classList).not.toContain('on');
    expect(tipOf(control())).toBe('Board actions');
  });

  // Three items deep, a tooltip under the first one covers the two below it, and the menu opens with focus on it.
  it('suppresses tooltips on menu focus', () => {
    vi.useFakeTimers();

    try {
      control().click();
      item('Stream hub log').dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      vi.advanceTimersByTime(2000);

      // Undefined where nothing has opened one yet: the panel is built on the first tooltip the board draws.
      expect(document.getElementById('tip')?.getAttribute('data-open') ?? null).toBeNull();

      // Still the pointer's to read, where nothing is covered by it opening.
      item('Stream hub log').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      vi.advanceTimersByTime(2000);

      expect(document.getElementById('tip')?.getAttribute('data-open')).toBe('true');
    } finally {
      vi.useRealTimers();
    }
  });

  // Nothing on a plain item is checked, so its mark column is empty rather than absent - the labels have to line up.
  it('leaves the mark column empty on an item that is not a state', () => {
    control().click();

    expect(item('Refresh').getAttribute('role')).toBe('menuitem');
    expect(item('Refresh').hasAttribute('aria-checked')).toBe(false);
    expect(item('Refresh').querySelector('.menu-check')?.textContent).toBe('');
  });

  /** The ready message must restore controls after webview reloads, even without a visibility change. */
  it('reports ready to restore extension-owned control state', () => {
    expect(onLoad).toContainEqual({ type: 'ready' });
  });
});

/** Verify shared tooltip geometry and timing measured from GitHub (mechanics M35). */
describe('the tooltip', () => {
  const tip = () => document.getElementById('tip');
  const open = () => tip()?.getAttribute('data-open') ?? null;

  const hover = (el: Element) => el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  const unhover = (el: Element) => el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));

  beforeEach(() => {
    vi.useFakeTimers();
    send(message({ lanes: lanes({ build: [liveCard] }) }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for the tooltip hover delay', () => {
    const avatarEl = document.querySelector('.avatar')!;

    hover(avatarEl);

    expect(open()).toBeNull();

    vi.advanceTimersByTime(120);

    expect(open()).toBe('true');
    expect(tip()?.textContent).toBe('dev-2 · pull request author');
  });

  /** One node for the whole board: a render replaces every card, and a node per anchor would be built by the hundred. */
  it('reuses one tooltip element', () => {
    for (const el of Array.from(document.querySelectorAll('[data-gc-tip]'))) {
      hover(el);
      vi.advanceTimersByTime(120);
    }

    expect(document.querySelectorAll('#tip')).toHaveLength(1);
  });

  /** A child would be part of `textContent`, and every label that reads its own would gain the tooltip's words. */
  it('preserves anchor text', () => {
    const avatarEl = document.querySelector('.avatar')!;

    hover(avatarEl);
    vi.advanceTimersByTime(120);

    expect(avatarEl.textContent).toBe('DE');
  });

  it('closes when the pointer leaves, and on Escape', () => {
    const avatarEl = document.querySelector('.avatar')!;

    hover(avatarEl);
    vi.advanceTimersByTime(120);
    unhover(avatarEl);

    expect(open()).toBeNull();

    hover(avatarEl);
    vi.advanceTimersByTime(120);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(open()).toBeNull();
  });

  /** Placed once in viewport coordinates, so a lane scrolling under it would otherwise leave it behind. */
  it('closes when a lane scrolls under it', () => {
    hover(document.querySelector('.avatar')!);
    vi.advanceTimersByTime(120);
    document.querySelector('.lane-cards')!.dispatchEvent(new Event('scroll', { bubbles: true }));

    expect(open()).toBeNull();
  });

  it('never opens for a pointer that left before it was due', () => {
    const avatarEl = document.querySelector('.avatar')!;

    hover(avatarEl);
    vi.advanceTimersByTime(60);
    unhover(avatarEl);
    vi.advanceTimersByTime(600);

    expect(open()).toBeNull();
  });

  /**
   * Set accessible descriptions before focus; adding them after the tooltip delay misses the focus
   * announcement.
   */
  it('sets accessible descriptions before hover', () => {
    expect(document.querySelector('.number')!.getAttribute('aria-label')).toBe('Read issue example-repo #18953');
    expect(document.querySelector('.session')!.getAttribute('aria-label')).toContain('open this session');
    // The state is the row's described half: what the board saw is the part not written on the row.
    send(message({ lanes: lanes({ build: [{ ...liveCard, sessions: [{ ...session, activity: { phase: 'running', since: Date.now(), at: Date.now(), event: 'PostToolBatch' } }] }] }) }));
    // The mark is named rather than described, so the described half of the row is the duration beside it.
    expect(document.querySelector('.state')!.getAttribute('aria-description')).toContain('Time in this turn');
    expect(document.querySelector('.dot')!.hasAttribute('aria-description')).toBe(false);
    expect(document.querySelector('[aria-describedby]')).toBeNull();
  });

  /**
   * A reader says the name, then the description. The same words in both is the board saying it twice, so an
   * element carries a description only where it says something the name does not: a glyph control names the
   * action and describes what pressing it costs (R45).
   */
  it('never repeats a name in a description', () => {
    const both = Array.from(document.querySelectorAll('[aria-description]')).filter((el) =>
      el.hasAttribute('aria-label'),
    );

    expect(both.map((el) => el.getAttribute('aria-label'))).toEqual(['Read this card', 'Open in VS Code']);
    expect(both.every((el) => el.getAttribute('aria-description') !== el.getAttribute('aria-label'))).toBe(true);
    // The avatar is the one that would repeat itself: named for a reader, and its tooltip says the same thing.
    expect(document.querySelector('.avatar')!.getAttribute('aria-label')).toBe('dev-2, pull request author');
    expect(document.querySelector('.avatar')!.hasAttribute('aria-description')).toBe(false);
  });

  it('opens tooltips on keyboard focus', () => {
    document.querySelector('.avatar')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    vi.advanceTimersByTime(120);

    expect(open()).toBe('true');
  });

  /** Keep tooltips open when moving between children of their anchor. */
  it('keeps tooltips open across anchor children', () => {
    // The verdict carries a tooltip and holds a child of its own: the qualifier.
    send(
      message({
        lanes: lanes({
          build: [
            {
              ...liveCard,
              sessions: [],
              triage: { state: 'done', action: 'develop', qualifier: 'followup', detail: 'Pick it up.', at: Date.now(), stale: false },
            },
          ],
        }),
      }),
    );

    const chip = document.querySelector('.verdict')!;

    hover(chip);
    vi.advanceTimersByTime(120);
    chip.querySelector('.note')!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: chip }));

    expect(open()).toBe('true');
  });

  /** Ignore anchors removed during the delay; their zero-sized bounds would place the tooltip in a corner. */
  it('ignores removed tooltip anchors', () => {
    const avatarEl = document.querySelector('.avatar')!;

    hover(avatarEl);
    avatarEl.remove();
    vi.advanceTimersByTime(120);

    expect(open()).toBeNull();
  });

  it('closes one left over a card the render replaced', () => {
    hover(document.querySelector('.avatar')!);
    vi.advanceTimersByTime(120);

    expect(open()).toBe('true');

    send(message({ lanes: lanes({ build: [{ ...liveCard, key: 'issue-99', issueNumber: 99 }] }) }));

    expect(open()).toBeNull();
  });

  /** Opening one must add and remove no nodes: the overlay's twin is watched by a MutationObserver that repaints. */
  it('adds and removes no nodes when it opens', () => {
    const seen: MutationRecord[] = [];
    const observer = new MutationObserver((records) => seen.push(...records));

    observer.observe(document.documentElement, { childList: true, subtree: true });
    hover(document.querySelector('.avatar')!);
    vi.advanceTimersByTime(120);
    hover(document.querySelector('.dot')!);
    vi.advanceTimersByTime(120);

    const records = observer.takeRecords();

    observer.disconnect();

    expect(open()).toBe('true');
    expect([...seen, ...records]).toEqual([]);
  });

  /** The rule the parity table names, applied — a stylesheet that stopped reaching the node would pass that table. */
  it('matches shared tooltip geometry', () => {
    hover(document.querySelector('.avatar')!);
    vi.advanceTimersByTime(120);

    const drawn = getComputedStyle(tip()!);

    expect(drawn.display).toBe('block');
    expect(drawn.position).toBe('fixed');
    expect(drawn.fontSize).toBe('12px');
    expect(drawn.padding).toBe('4px 8px');
    expect(drawn.maxWidth).toBe('250px');
    expect(drawn.textAlign).toBe('center');
    // Deaf to the pointer, or the tooltip takes the hover it is explaining and flickers against its own anchor.
    expect(drawn.pointerEvents).toBe('none');
  });

  it('keeps the tooltip hidden before hover', () => {
    expect(getComputedStyle(tipElementForTest()).display).toBe('none');
  });

  function tipElementForTest(): HTMLElement {
    hover(document.querySelector('.avatar')!);
    vi.advanceTimersByTime(120);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    return tip()!;
  }

  /**
   * Exercise all tooltip branches and assert that neither title attributes nor SVG title nodes add duplicate
   * native tooltips.
   */
  it('sets no native tooltip anywhere on the board', () => {
    send(
      message({
        lanes: lanes({
          build: [
            {
              ...liveCard,
              returned: true,
              attention: 'blocked' as Attention,
              triage: { state: 'done', action: 'qa-failure', qualifier: null, detail: 'It came back.', at: Date.now(), stale: false },
              lastSession: { agent: 'claude', sessionId: 'past', title: 'Past attempt', cwd: '/work/18953-test', branch: '18953-test', issueNumber: 18953, repository: 'github.com/org/repo', updatedAt: Date.now() - 60000 },
            },
          ],
        }),
      }),
    );

    expect(document.querySelectorAll('[title], title')).toHaveLength(0);
    expect(document.querySelectorAll('[data-gc-tip]').length).toBeGreaterThan(0);
    // The agent glyph most of all: an SVG `<title>` child on a row that already carries one draws two at once.
    expect(document.querySelector('.agent-mark')).not.toBeNull();
  });
});

/** Verify each duration element, timestamp attribute, and literal timer output in both clients. */
describe('the age attribute both boards share', () => {
  const held = Date.UTC(2026, 8, 7, 12, 0, 0);

  const rows: [string, string, number, string][] = [
    ['a session state', '.state', 125_000, '2m'],
    ['a saved session', '.historical .state', 60_000, '1m'],
    ['the age of a status', '.card-age', 10_800_000, '3h'],
  ];

  it.each(rows)('marks %s and reads it %s', (kind, selector, ms, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(held));

    try {
      const at = held - ms;
      const drawn: LanedCard =
        kind === 'a saved session'
          ? { ...liveCard, sessions: [], lastSession: { agent: 'claude', sessionId: 'past', title: 'Past attempt', cwd: '/work/18953', branch: '18953', issueNumber: 18953, repository: 'github.com/org/repo', updatedAt: at } }
          : {
              ...liveCard,
              sessions: [{ ...session, activity: { phase: 'running', since: at, at, event: 'PreToolUse' } }],
              triage: { state: 'done', action: 'develop', qualifier: null, detail: 'Pick it up.', at: held - 60_000, stale: false },
              issue: { ...liveCard.issue!, statusChangedAt: new Date(at).toISOString() },
            };

      send(message({ lanes: lanes({ unstarted: [drawn] }) }));

      const element = document.querySelector(selector)!;

      expect(element.getAttribute('data-gc-since')).toBe(String(at));
      expect(element.textContent).toBe(expected);
    } finally {
      vi.useRealTimers();
    }
  });

});

/**
 * Assert identical tooltip geometry and timing in both client suites (mechanics M35).
 */
describe('the tooltip shape both boards share', () => {
  const rows: [string, number][] = [
    ['delay', 120],
    ['gap', 4],
    ['margin', 8],
  ];

  it.each(rows)('pins %s at %s', (name, expected) => {
    const script = readFileSync(resolve(__dirname, '..', 'media', 'board.js'), 'utf8');
    const constants: Record<string, RegExp> = {
      delay: /const TIP_DELAY = (\d+);/,
      gap: /const TIP_GAP = (\d+);/,
      margin: /const TIP_MARGIN = (\d+);/,
    };

    expect(Number(constants[name]!.exec(script)?.[1])).toBe(expected);
  });
});

describe('the conversation panel', () => {
  const detailFixture = JSON.parse(
    readFileSync(resolve('../../packages/github/test/fixtures/detail-issue.json'), 'utf8'),
  ) as { data: { repository: { issue: { bodyHTML: string } } } };

  const recordedBody = detailFixture.data.repository.issue.bodyHTML;

  function detail(over: Partial<ItemDetail> = {}): ItemDetail {
    return {
      subject: 'issue',
      number: 18953,
      repository: 'example-org/example-repo',
      title: 'Cache remediation',
      url: 'https://github.com/example-org/example-repo/issues/18953',
      state: 'OPEN',
      bodyHtml: '<p dir="auto">A body the source rendered.</p>',
      author: 'dev-1',
      authorAvatarUrl: 'https://avatars.githubusercontent.com/u/1?s=40',
      createdAt: '2026-08-19T20:16:30Z',
      editedAt: null,
      reactions: [],
      labels: [{ name: 'area-1', color: 'e3e3e3' }],
      assignees: [],
      milestone: null,
      branches: null,
      draft: false,
      reviewDecision: null,
      checks: null,
      events: [],
      moreEvents: false,
      moreThreads: false,
      threads: [],
      ...over,
    };
  }

  function post(over: Partial<DetailPost> = {}): DetailPost {
    return {
      kind: 'comment',
      author: 'dev-2',
      avatarUrl: null,
      bodyHtml: '<p>said</p>',
      createdAt: '2026-08-19T20:16:30Z',
      editedAt: null,
      reactions: [],
      hidden: null,
      state: null,
      threads: [],
      ...over,
    };
  }

  function note(over: Partial<DetailNote> = {}): DetailNote {
    return { kind: 'note', icon: 'closed', actor: 'dev-2', avatarUrl: null, createdAt: '2026-08-19T20:16:30Z', summary: 'closed this', url: null, ...over };
  }

  function thread(over: Partial<DetailThread> = {}): DetailThread {
    return { path: 'src/one.cs', line: 86, resolved: false, outdated: false, comments: [post()], moreComments: false, ...over };
  }

  function answer(over: Partial<ItemDetail> | null = {}, failure: string | null = null): void {
    send({
      type: 'detail',
      key: 'issue:18953',
      subject: 'issue',
      detail: over === null ? null : detail(over),
      failure,
    } as BoardMessage);
  }

  function openPanel(): void {
    send(message({ lanes: lanes({ build: [liveCard] }) }));
    document.querySelector<HTMLButtonElement>('.card-meta .number')!.click();
  }

  function panel(): HTMLElement | null {
    return document.getElementById('detail');
  }

  function closePanel(): void {
    document.getElementById('detail')!.querySelector<HTMLButtonElement>('.detail-close')!.click();
  }

  afterEach(() => {
    document.getElementById('detail')?.remove();
    document.getElementById('detail-scrim')?.remove();
  });

  it('says it is reading before the hub has answered, rather than showing an empty conversation', () => {
    openPanel();

    expect(panel()).not.toBeNull();
    expect(panel()!.textContent).toContain('Reading');
  });

  it('renders the body the source returned without parsing markdown', () => {
    openPanel();
    answer({ bodyHtml: recordedBody });

    const body = panel()!.querySelector('.markdown-body')!;

    // The recorded body carries GitHub's own table and task-list markup.
    expect(body.querySelector('table')).not.toBeNull();
    expect(body.querySelector('.task-list-item-checkbox')).not.toBeNull();
  });

  it('leaves task-list checkboxes disabled, because the panel reads a conversation and never writes one', () => {
    openPanel();
    answer({ bodyHtml: recordedBody });

    const boxes = Array.from(panel()!.querySelectorAll<HTMLInputElement>('input'));

    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.every((box) => box.disabled)).toBe(true);
  });

  it('drops scripts, frames, and event handlers the source did not sanitize', () => {
    openPanel();
    answer({
      bodyHtml:
        '<p onclick="steal()">text</p><script>steal()</script><iframe src="https://example.com"></iframe><img src="javascript:steal()">',
    });

    const body = panel()!.querySelector('.markdown-body')!;

    expect(body.querySelector('script')).toBeNull();
    expect(body.querySelector('iframe')).toBeNull();
    expect(body.querySelector('p')!.hasAttribute('onclick')).toBe(false);
    expect(body.querySelector('img')?.hasAttribute('src')).toBe(false);
    // Source text is not conversation prose: a dropped script's code must not be printed as body copy.
    expect(body.textContent).toBe('text');
  });

  it('keeps the words of an element it does not know, because losing prose is worse than losing a tag', () => {
    openPanel();
    answer({ bodyHtml: '<p>before <picture><span>kept</span></picture> after</p>' });

    const body = panel()!.querySelector('.markdown-body')!;

    expect(body.querySelector('picture')).toBeNull();
    expect(body.textContent).toContain('kept');
    // The unknown element's children are filtered too, not trusted.
    expect(body.querySelector('span')).not.toBeNull();
  });

  it('drops the content of elements whose children are source text rather than markup', () => {
    openPanel();
    answer({ bodyHtml: '<style>body{background:url(https://tracker.example/x)}</style><template><p>hidden</p></template><p>shown</p>' });

    expect(panel()!.querySelector('.markdown-body')!.textContent).toBe('shown');
  });

  it('refuses class names the conversation does not own, so a comment cannot wear the board’s chrome', () => {
    openPanel();
    answer({ bodyHtml: '<div class="card-popover highlight notranslate"><p class="lane">x</p></div>' });

    const wrapper = panel()!.querySelector('.markdown-body div')!;

    // A fixed-position board class inside the panel would render as a menu over the board.
    expect(wrapper.classList.contains('card-popover')).toBe(false);
    expect(wrapper.classList.contains('highlight')).toBe(true);
    expect(panel()!.querySelector('.markdown-body p')!.hasAttribute('class')).toBe(false);
  });

  it('refuses an image the webview policy could never load, rather than drawing a broken one', () => {
    openPanel();
    answer({ bodyHtml: '<p><img src="http://example.com/a.png" alt="a"><img src="https://x.githubusercontent.com/b.png" alt="b"></p>' });

    const images = Array.from(panel()!.querySelectorAll('.markdown-body img'));

    expect(images.filter((image) => image.hasAttribute('src')).map((image) => image.getAttribute('alt'))).toEqual(['b']);
  });

  it('drops the cross-reference data attributes GitHub attaches to links', () => {
    openPanel();
    answer({ bodyHtml: recordedBody });

    expect(panel()!.querySelector('[data-hovercard-url]')).toBeNull();
    expect(recordedBody).toContain('data-hovercard-url');
  });

  it('keeps only addresses the editor can open', () => {
    openPanel();
    answer({ bodyHtml: '<p><a href="https://github.com/a/b/issues/1">ok</a><a href="vbscript:bad()">bad</a></p>' });

    const links = Array.from(panel()!.querySelectorAll('a'));

    expect(links.filter((link) => link.hasAttribute('href'))).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('https://github.com/a/b/issues/1');
  });


  it('shows what people wrote, in the order the source reported it', () => {
    openPanel();
    answer({
      events: [
        post({ author: 'dev-2', bodyHtml: '<p>first</p>' }),
        post({ author: 'dev-3', bodyHtml: '<p>second</p>', createdAt: '2026-08-20T20:16:30Z' }),
      ],
    });

    // The opening body is drawn as a post too, so the reader sees who opened the conversation and when.
    const written = Array.from(panel()!.querySelectorAll('.detail-comment'));

    expect(written).toHaveLength(3);
    expect(written[0]!.textContent).toContain('dev-1');
    expect(written[0]!.textContent).toContain('opened this');
    expect(written[1]!.textContent).toContain('dev-2');
    expect(written[2]!.textContent).toContain('dev-3');
  });

  it('says a conversation is clipped without inventing a number the source cannot give', () => {
    openPanel();
    answer({ moreEvents: true });

    expect(panel()!.textContent).toContain('Earlier updates are not shown');
    // GitHub overcounts a timeline, so the panel must not print a count derived from that total.
    expect(panel()!.textContent).not.toMatch(/\d+ earlier update/);
  });

  it('draws a review with the state it left and the threads it opened', () => {
    openPanel();
    answer({ events: [post({ kind: 'review', state: 'CHANGES_REQUESTED', author: 'dev-3', threads: [thread()] })] });

    const review = panel()!.querySelector('.detail-comment[data-kind="review"]')!;

    expect(review.textContent).toContain('requested changes');
    expect(review.querySelector('.detail-review-state')!.getAttribute('data-state')).toBe('changes_requested');
    expect(review.querySelector('.detail-thread code')!.textContent).toBe('src/one.cs:86');
  });

  it('draws a state change as one line naming who did what', () => {
    openPanel();
    answer({ events: [note({ actor: 'dev-4', summary: 'added the bug label' })] });

    const row = panel()!.querySelector('.detail-activity')!;

    expect(row.querySelector('.detail-activity-who')!.textContent).toBe('dev-4');
    expect(row.textContent).toContain('added the bug label');
    expect(panel()!.querySelectorAll('.detail-comment')).toHaveLength(1);
  });

  it('folds a long run of state changes so it does not bury the conversation, while still holding them', () => {
    openPanel();
    answer({
      events: [
        note({ summary: 'one' }),
        note({ summary: 'two' }),
        note({ summary: 'three' }),
        note({ summary: 'four' }),
        post({ bodyHtml: '<p>after</p>' }),
        note({ summary: 'five' }),
        note({ summary: 'six' }),
      ],
    });

    const run = panel()!.querySelector('.detail-activity-run')!;

    expect(run.querySelector('summary')!.textContent).toBe('4 updates');
    expect(run.querySelectorAll('.detail-activity')).toHaveLength(4);
    // A run shorter than three stays inline rather than hiding two lines behind a disclosure.
    expect(panel()!.querySelectorAll('.detail-activity-run')).toHaveLength(1);
    expect(panel()!.querySelectorAll('.detail-activity')).toHaveLength(6);
  });

  it('shows reactions people left, and nothing when nobody reacted', () => {
    openPanel();
    answer({ events: [post({ reactions: [{ content: 'THUMBS_UP', count: 2 }] }), post({ bodyHtml: '<p>quiet</p>' })] });

    const reacted = Array.from(panel()!.querySelectorAll('.detail-reaction'));

    expect(reacted).toHaveLength(1);
    expect(reacted[0]!.firstChild!.textContent).toBe('👍 2');
    // A bare span takes no accessible name, so the emoji is named in text only a screen reader reads.
    expect(reacted[0]!.querySelector('.sr-only')!.textContent).toBe(' thumbs up');
  });

  it('collapses a hidden comment behind the reason the source hid it, rather than dropping it', () => {
    openPanel();
    answer({ events: [post({ hidden: 'OFF_TOPIC', bodyHtml: '<p>off topic</p>' })] });

    const fold = panel()!.querySelector('.detail-hidden') as HTMLDetailsElement;

    expect(fold.open).toBe(false);
    expect(fold.querySelector('summary')!.textContent).toBe('Hidden as off topic');
    expect(fold.textContent).toContain('off topic');
  });

  it('marks an edited comment without claiming to know what changed', () => {
    openPanel();
    answer({ events: [post({ editedAt: '2026-08-21T20:16:30Z' })] });

    expect(panel()!.textContent).toContain('edited');
  });

  it('shows the facts that sit beside a pull-request conversation', () => {
    openPanel();
    answer({
      subject: 'pull-request',
      assignees: ['dev-1'],
      milestone: 'Patch 1',
      branches: { base: 'main', head: 'topic' },
      reviewDecision: 'CHANGES_REQUESTED',
      checks: 'FAILURE',
    });

    const facets = Array.from(panel()!.querySelectorAll('.detail-facet')).map((facet) => [
      facet.querySelector('h3')!.textContent,
      facet.querySelector('.detail-facet-value')!.textContent,
    ]);

    expect(facets).toEqual([
      ['Reviewers', 'Changes requested'],
      ['Assignees', 'dev-1'],
      ['Labels', 'area-1'],
      ['Milestone', 'Patch 1'],
      ['Checks', 'Some checks failed'],
    ]);
    // A facet that holds something is not drawn in the muted empty colour.
    expect(panel()!.querySelectorAll('.detail-facet-value[data-empty]')).toHaveLength(0);
    // The branches sit under the state pill, as GitHub draws them, with the head first.
    expect(Array.from(panel()!.querySelectorAll('.detail-branch')).map((chip) => chip.textContent)).toEqual(['topic', 'main']);
    expect(panel()!.querySelector('.detail-summary')!.textContent).toBe('dev-1 wants to merge topic into main');
    expect(panel()!.querySelector('.detail-state')!.textContent).toBe('Open');
  });

  it('draws the state pill the way GitHub colours it, and says Draft for a draft pull request', () => {
    openPanel();
    answer({ subject: 'pull-request', state: 'MERGED', branches: { base: 'main', head: 'topic' } });

    const state = panel()!.querySelector<HTMLElement>('.detail-state')!;

    expect(state.textContent).toBe('Merged');
    expect(state.dataset.tone).toBe('done');
    expect(panel()!.querySelector('.detail-summary')!.textContent).toBe('dev-1 merged topic into main');

    answer({ subject: 'pull-request', state: 'OPEN', draft: true });

    expect(panel()!.querySelector<HTMLElement>('.detail-state')!.textContent).toBe('Draft');
    expect(panel()!.querySelector<HTMLElement>('.detail-state')!.dataset.tone).toBe('muted');

    answer({ subject: 'pull-request', state: 'CLOSED' });

    expect(panel()!.querySelector<HTMLElement>('.detail-state')!.dataset.tone).toBe('closed');

    answer({ state: 'CLOSED' });

    // A closed issue is purple on GitHub, unlike a closed pull request, which is red.
    expect(panel()!.querySelector<HTMLElement>('.detail-state')!.dataset.tone).toBe('done');
  });

  it('gives each state change the badge GitHub draws for it, coloured where GitHub colours it', () => {
    openPanel();
    answer({
      subject: 'pull-request',
      events: [note({ icon: 'label', summary: 'added the bug label' }), note({ icon: 'closed', summary: 'closed this' }), note({ icon: 'merged', summary: 'merged this into main' })],
    });

    const badges = Array.from(panel()!.querySelectorAll<HTMLElement>('.detail-activity .detail-badge'));

    expect(badges.map((badge) => badge.dataset.tone)).toEqual(['muted', 'closed', 'done']);
    // Each event draws its own octicon, not one shared glyph.
    expect(new Set(badges.map((badge) => badge.innerHTML)).size).toBe(3);

    // The same closing is purple on an issue, as GitHub draws a completed issue.
    answer({ events: [note({ icon: 'closed', summary: 'closed this as completed' })] });

    expect(panel()!.querySelector<HTMLElement>('.detail-activity .detail-badge')!.dataset.tone).toBe('done');
  });

  it('shows the empty sidebar words GitHub uses when nothing is assigned, labelled, or milestoned', () => {
    openPanel();
    answer({ labels: [] });

    const values = Array.from(panel()!.querySelectorAll('.detail-facet-value')).map((value) => value.textContent);

    expect(values).toEqual(['No one', 'None yet', 'No milestone']);
    expect(panel()!.querySelectorAll('.detail-facet-value[data-empty]')).toHaveLength(3);
    expect(panel()!.querySelector('.detail-facet h3')!.textContent).toBe('Assignees');
  });

  it('shows inline review threads with their file, line, and state', () => {
    openPanel();
    answer({
      subject: 'pull-request',
      threads: [
        thread({ resolved: true, comments: [post({ bodyHtml: '<p>naming</p>' })] }),
        thread({
          path: 'src/two.cs',
          line: null,
          outdated: true,
          comments: [post({ author: 'dev-3', bodyHtml: '<p>moved</p>' })],
          moreComments: true,
        }),
      ],
      moreThreads: true,
    });

    const threads = Array.from(panel()!.querySelectorAll('.detail-thread'));

    expect(threads).toHaveLength(2);
    expect(threads[0]!.querySelector('code')!.textContent).toBe('src/one.cs:86');
    expect(Array.from(threads[0]!.querySelectorAll('.detail-thread-mark')).map((mark) => mark.textContent)).toEqual(['Resolved']);
    // A thread whose diff moved past it has no current line, so the panel names the file alone.
    expect(threads[1]!.querySelector('code')!.textContent).toBe('src/two.cs');
    expect(Array.from(threads[1]!.querySelectorAll('.detail-thread-mark')).map((mark) => mark.textContent)).toEqual(['Outdated']);
    expect(threads[1]!.textContent).toContain('Earlier replies are not shown');
    // A resolved thread is settled, so it opens closed; an unresolved one stays open to be read.
    expect((threads[0] as HTMLDetailsElement).open).toBe(false);
    expect((threads[1] as HTMLDetailsElement).open).toBe(true);
    expect(threads[0]!.querySelector('.detail-thread-count')!.textContent).toBe('1 comment');
    // A clipped thread marks its count, rather than stating a number the source cannot give.
    expect(threads[1]!.querySelector('.detail-thread-count')!.textContent).toBe('1+ comments');
    expect(panel()!.querySelector('.detail-threads h3')!.textContent).toBe('Review comments (2)');
    expect(panel()!.textContent).toContain('Some review threads are not shown');
  });

  it('leaves out the review section when every thread belongs to a review above it', () => {
    openPanel();
    answer({ threads: [], events: [post({ kind: 'review', state: 'COMMENTED', threads: [thread()] })] });

    expect(panel()!.querySelector('.detail-threads')).toBeNull();
    expect(panel()!.querySelectorAll('.detail-thread')).toHaveLength(1);
  });

  it('renders a review comment body through the same sanitizer as the conversation', () => {
    openPanel();
    answer({ threads: [thread({ comments: [post({ bodyHtml: '<p onclick="steal()">kept</p><script>steal()</script>' })] })] });

    const body = panel()!.querySelector('.detail-thread .markdown-body')!;

    expect(body.textContent).toContain('kept');
    expect(body.querySelector('script')).toBeNull();
    expect(body.querySelector('p')!.getAttribute('onclick')).toBeNull();
  });

  it('reports a failure with the hub’s own words rather than an empty body', () => {
    openPanel();
    answer(null, 'GitHub could not be reached. Check your connection.');

    expect(panel()!.querySelector('.detail-note.error')!.textContent).toBe('GitHub could not be reached. Check your connection.');
    expect(panel()!.querySelector('.markdown-body')).toBeNull();
  });

  it('says a conversation with no description has none, rather than drawing nothing', () => {
    openPanel();
    answer({ bodyHtml: '' });

    expect(panel()!.textContent).toContain('No description');
  });

  it('ignores an answer for a card or subject it is no longer showing', () => {
    openPanel();

    for (const stale of [
      { key: 'issue:99999', subject: 'issue' },
      { key: 'issue:18953', subject: 'pull-request' },
    ]) {
      send({ ...stale, type: 'detail', detail: detail({ title: 'Another conversation' }), failure: null } as BoardMessage);
    }

    expect(panel()!.textContent).not.toContain('Another conversation');
    expect(panel()!.textContent).toContain('Reading');
  });

  it('keeps focus where the reader put it when the answer arrives', () => {
    openPanel();

    const close = panel()!.querySelector<HTMLButtonElement>('.detail-close')!;

    expect(document.activeElement).toBe(close);

    // The reader moves on while the read is in flight. Open on GitHub is disabled until the answer lands.
    panel()!.querySelector<HTMLButtonElement>('.detail-grip')!.focus();
    answer();

    // Every paint replaces the panel's children, so focus must land back on the same control, not on the document.
    expect(document.activeElement).toBe(panel()!.querySelector('.detail-grip'));
    expect(document.activeElement).not.toBe(document.body);
  });

  it('holds the board out of pointer and keyboard reach while a conversation is open', () => {
    openPanel();

    expect(panel()!.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById('lanes')!.hasAttribute('inert')).toBe(true);

    closePanel();

    expect(document.getElementById('lanes')!.hasAttribute('inert')).toBe(false);
  });

  it('returns focus to the board when the control that opened it has been redrawn away', () => {
    openPanel();
    answer();

    // A rebuild replaces the card, so the opener is no longer in the document.
    document.getElementById('lanes')!.replaceChildren();
    closePanel();

    expect(document.activeElement).toBe(document.getElementById('lanes'));
  });

  it('opens the conversation in the browser from the panel itself', () => {
    openPanel();
    answer();

    panel()!.querySelector<HTMLButtonElement>('.detail-action')!.click();

    expect(api.postMessage).toHaveBeenCalledWith({
      type: 'openLink',
      url: 'https://github.com/example-org/example-repo/issues/18953',
    });
  });

  it('closes on Escape, on the close control, and on a click outside it', () => {
    for (const close of [
      () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      () => panel()!.querySelector<HTMLButtonElement>('.detail-close')!.click(),
      () => document.getElementById('detail-scrim')!.click(),
    ]) {
      openPanel();
      answer();
      expect(panel()).not.toBeNull();

      close();

      expect(panel()).toBeNull();
      expect(document.getElementById('detail-scrim')).toBeNull();
    }
  });

  it('survives a board redraw, because a snapshot arriving must not close what is being read', () => {
    openPanel();
    answer();

    send(message({ lanes: lanes({ build: [liveCard] }) }));

    expect(panel()).not.toBeNull();
    expect(panel()!.textContent).toContain('Cache remediation');
  });
  it('sizes the panel from its own edge and reports the width for the next one', () => {
    openPanel();
    answer();

    const grip = panel()!.querySelector<HTMLElement>('.detail-grip')!;

    expect(grip.getAttribute('role')).toBe('separator');

    // jsdom reports no layout, so the drag is measured from the width the panel reports.
    panel()!.getBoundingClientRect = () => ({ width: 600 }) as DOMRect;
    grip.setPointerCapture = () => {};
    grip.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 900 }));
    grip.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 800 }));
    grip.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 800 }));

    // Dragging left widens a panel anchored to the right edge.
    expect(panel()!.style.width).toBe('700px');
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'setDetailWidth', width: 700 });
  });

  it('refuses to be dragged narrower than it can be read', () => {
    openPanel();
    answer();

    const grip = panel()!.querySelector<HTMLElement>('.detail-grip')!;

    panel()!.getBoundingClientRect = () => ({ width: 600 }) as DOMRect;
    grip.setPointerCapture = () => {};
    grip.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100 }));
    grip.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 9000 }));

    expect(Number.parseInt(panel()!.style.width, 10)).toBe(360);
  });

  it('sizes it from the keyboard, because a pointer is not the only way to resize a panel', () => {
    openPanel();
    answer();

    const grip = panel()!.querySelector<HTMLElement>('.detail-grip')!;
    panel()!.getBoundingClientRect = () => ({ width: 600 }) as DOMRect;

    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));

    expect(panel()!.style.width).toBe('640px');
    // Sizing is reported as it happens; the width is saved once the reader lets the key go, not on every repeat.
    expect(grip.getAttribute('aria-valuenow')).toBe('600');
    expect(api.postMessage).not.toHaveBeenCalledWith({ type: 'setDetailWidth', width: 640 });

    grip.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'setDetailWidth', width: 640 });
  });

  it('opens the width the developer last dragged to', () => {
    send({ type: 'reading', enabled: true, width: 720 } as BoardMessage);
    openPanel();

    expect(panel()!.style.width).toBe('720px');
  });

  it('leaves links to the host, which opens an anchor once on its own', () => {
    openPanel();
    answer({ bodyHtml: '<p><a href="https://github.com/a/b/issues/1">ok</a></p>' });

    const link = panel()!.querySelector('a')!;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);

    // Opening it from here as well opened every link twice.
    expect(sent().some((m) => (m as { type: string }).type === 'openLink')).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('reading conversations turned off', () => {
  afterEach(() => {
    send({ type: 'reading', enabled: true, width: null } as BoardMessage);
    document.getElementById('detail')?.remove();
    document.getElementById('detail-scrim')?.remove();
  });

  it('sends a card’s controls to the browser, as they went before the panel existed', () => {
    send({ type: 'reading', enabled: false, width: null } as BoardMessage);
    send(message({ lanes: lanes({ build: [liveCard] }) }));

    document.querySelector<HTMLButtonElement>('.card-meta .number')!.click();
    document.querySelector<HTMLButtonElement>('.badges.github .badge.pull-request')!.click();

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'openIssue', number: 18953 });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'openPullRequest', number: 18953 });
    expect(sent().some((m) => (m as { type: string }).type === 'readDetail')).toBe(false);
    expect(document.getElementById('detail')).toBeNull();
  });

  it('says what its controls do, so the name matches the click', () => {
    send({ type: 'reading', enabled: false, width: null } as BoardMessage);
    send(message({ lanes: lanes({ build: [liveCard] }) }));

    expect(document.querySelector('.card-meta .number')!.getAttribute('aria-label')).toBe(
      'Open issue example-repo #18953 on GitHub',
    );
    expect(document.querySelector('.badge.pull-request')!.getAttribute('aria-label')).toBe(
      'Open pull request #19403, open, on GitHub',
    );
  });

  it('closes a conversation left open when the setting is turned off', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));
    document.querySelector<HTMLButtonElement>('.card-meta .number')!.click();
    expect(document.getElementById('detail')).not.toBeNull();

    send({ type: 'reading', enabled: false, width: null } as BoardMessage);

    expect(document.getElementById('detail')).toBeNull();
    expect(document.getElementById('lanes')!.hasAttribute('inert')).toBe(false);
  });
});

/**
 * R46: the open control says when the checkout is the issue's worktree, and one further control, offered where
 * the hub says the card has none, makes one. The overlay builds the same sentences, so both are pinned here and there.
 */
describe('the worktree in the bar', () => {
  // Branch and directory differ, so an implementation that used either one alone fails a test below.
  const WORKTREE = { root: 'd:/work/wt/18941-badge', branch: '18941-inbox-badge', only: true };
  const AS_CHECKOUT = { root: WORKTREE.root, source: 'worktree' as const, only: true };
  const at = Date.UTC(2026, 8, 1, 19, 0, 0);

  const open = () => document.querySelector<HTMLButtonElement>('.tools .tool[aria-label="Open in VS Code"]');
  const create = () => document.querySelector<HTMLButtonElement>('.tools .tool[aria-label="Create a worktree for this issue"]');
  const run = () => document.querySelector<HTMLButtonElement>('.tool.run');
  const said = () => document.querySelector<HTMLElement>('.verdict .note')?.textContent ?? undefined;

  function show(over: Partial<LanedCard>): void {
    send(message({ lanes: lanes({ unstarted: [{ ...liveCard, ...over }] }) }));
  }

  it('says the checkout it opens is the worktree, naming the branch', () => {
    show({ worktree: WORKTREE, checkout: AS_CHECKOUT });

    expect(tipOf(open())).toBe('Open the worktree on 18941-inbox-badge at d:/work/wt/18941-badge in VS Code');
    expect(create()).toBeNull();
  });

  it('names the directory where HEAD is detached and there is no branch', () => {
    show({ worktree: { ...WORKTREE, branch: null }, checkout: AS_CHECKOUT });

    expect(tipOf(open())).toBe('Open the worktree on 18941-badge at d:/work/wt/18941-badge in VS Code');
  });

  it('reads the two spellings of one directory as the same one', () => {
    show({ worktree: WORKTREE, checkout: { ...AS_CHECKOUT, root: 'D:\\work\\wt\\18941-badge' } });

    expect(tipOf(open())).toContain('the worktree on 18941-inbox-badge');
  });

  // The checkout is somewhere else, so the tooltip must not claim it is the worktree.
  it('says nothing of the worktree when the checkout is another directory', () => {
    show({ worktree: WORKTREE });

    expect(tipOf(open())).toBe(`Open ${liveCard.checkout!.root} in VS Code`);
  });

  // The hub decides where the offer is made: a card it sends without `creation` has no control, whatever else it carries.
  it('offers to create one only where the hub offers it, and asks the hub on press', () => {
    show({});

    expect(create()).toBeNull();

    show({ creation: { state: 'available' } });

    expect(tipOf(create())).toBe('No worktree for this issue. Run the worktree prompt to create one.');
    expect(create()!.closest('.cmdbar .tail')).not.toBeNull();

    create()!.click();

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'createWorktree', key: liveCard.key });
  });

  it('states why none can be made, and takes no press', () => {
    show({ creation: { state: 'refused', reason: 'No worktree for this issue. Set groundControl.worktree.prompt so one can be created.' } });

    const refused = document.querySelector<HTMLButtonElement>('.tools .tool[aria-label="Cannot create a worktree"]')!;

    expect(tipOf(refused)).toBe('No worktree for this issue. Set groundControl.worktree.prompt so one can be created.');
    expect(refused.getAttribute('aria-disabled')).toBe('true');

    // The press must neither ask nor reach the card behind the control.
    const reached = vi.fn();

    document.body.addEventListener('click', reached);
    refused.click();

    expect(api.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'createWorktree' }));
    expect(reached).not.toHaveBeenCalled();
  });

  // A worktree run takes a while; the same control says so meanwhile, and a press stops it rather than asking again.
  it('says the worktree is being made while the run is on, and stops it on press', () => {
    show({ creation: { state: 'running', since: at } });

    const busy = document.querySelector<HTMLButtonElement>('.tools .tool[aria-label="Stop creating the worktree"]')!;

    expect(tipOf(busy)).toBe('A session is creating a worktree for this issue. Click to stop it. What it made so far stays.');
    expect(busy.dataset.state).toBe('running');
    expect(create()).toBeNull();

    busy.click();

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'stopAction', key: liveCard.key });
    expect(api.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'createWorktree' }));
  });

  it('says how the last run ended, and offers to try again', () => {
    show({ creation: { state: 'done', outcome: 'halted', detail: 'The run ended without reporting a worktree.', at } });

    expect(tipOf(create())).toBe('Stopped short: The run ended without reporting a worktree. Click to try again.');
    expect(create()!.dataset.outcome).toBe('halted');

    create()!.click();

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'createWorktree', key: liveCard.key });
  });

  // The action before its worktree exists is one press: the run control says it will make the worktree first.
  it('says the run control will make the worktree first where the card has none', () => {
    show({ creation: { state: 'available' }, action: { state: 'available', action: 'merge-upstream' } });

    expect(tipOf(run())).toBe('Create a worktree for this card, then start Merge upstream in it.');

    show({ worktree: WORKTREE, checkout: AS_CHECKOUT, action: { state: 'available', action: 'merge-upstream' } });

    expect(tipOf(run())).toBe('Start Merge upstream in this card’s worktree.');
    expect(create()).toBeNull();
  });

  it('says the action is at its worktree stage, and stops from either control', () => {
    show({ creation: { state: 'running', since: at }, action: { state: 'running', action: 'merge-upstream', since: at, stage: 'worktree' } });

    expect(said()).toBe('Creating worktree…');
    expect(run()?.getAttribute('aria-label')).toBe('Stop merge upstream');
    expect(tipOf(run())).toBe('Merge upstream is waiting for its worktree, which a session is creating. Click to stop.');

    run()!.click();

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'stopAction', key: liveCard.key });
  });

  // The card is rebuilt only when its signature changes, so each worktree state has to be in the signature.
  it('rebuilds the card as the worktree is offered, made, and gone', () => {
    const cardOf = () => document.querySelector<HTMLElement>('.card')!;

    show({ creation: { state: 'available' } });
    const offered = cardOf();

    show({ creation: { state: 'running', since: at } });
    const pending = cardOf();

    expect(pending).not.toBe(offered);
    expect(create()).toBeNull();

    show({ worktree: WORKTREE, checkout: AS_CHECKOUT });
    const made = cardOf();

    expect(made).not.toBe(pending);
    expect(tipOf(open())).toContain('the worktree on 18941-inbox-badge');

    show({ worktree: { ...WORKTREE, branch: '18941-renamed' }, checkout: AS_CHECKOUT });

    expect(tipOf(open())).toContain('the worktree on 18941-renamed');

    show({ creation: { state: 'available' } });

    expect(create()).not.toBeNull();
  });

  // A pick outranks a discovered worktree (R46), so the card that resolved to one must still be able to take a pick.
  it('still offers checkout selection on a card whose checkout came from a worktree', () => {
    show({ sessions: [], worktree: WORKTREE, checkout: AS_CHECKOUT });
    document.querySelector<HTMLButtonElement>('.card-menu')!.click();

    expect(Array.from(document.querySelectorAll<HTMLButtonElement>('.card-popover button')).map((item) => item.textContent)).toContain('Change folder…');
  });
});
