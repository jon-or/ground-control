import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LANE_ORDER, LANE_TITLES, boardStatuses, statusLanes } from '@ground-control/board';
import type { Attention, Lane, LaneId, LanedCard } from '@ground-control/board';
import type { HistoricalSession, Session } from '@ground-control/core';
import type { BoardMessage, SnapshotMessage } from '@ground-control/core';

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

/**
 * How long ago, one rung per unit and both sides of every threshold, as literal strings. `extensions/chrome-github-board/test/overlay.test.ts`
 * asserts this table verbatim: `ago` exists in both clients because neither can import `core` at runtime.
 */
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
      truncated: false,
      fetchedAt: '2026-09-01T20:00:00Z',
    },
    sessions: { count: 0, patternError: null, fetchedAt: '2026-09-01T20:00:01Z' },
    hooks: null,
    needs: null,
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
    <div id="notices"></div><main id="lanes"></main>
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
  document.getElementById('lanes')!.className = '';
});

/**
 * The archive toggle is an item in the board's own menu, so a test reaches it the way a developer does. Its label
 * carries the count, read off the trailing text node because the mark column ahead of it is part of `textContent`.
 */
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

    expect(api.setState).toHaveBeenCalledWith({ payload, showArchived: false });
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
    // What GitHub says the card is reads under the title; what the board says about it is set apart below.
    expect(card.querySelector('.badges.github')?.contains(card.querySelector('.status'))).toBe(true);
    expect(renderedSession.textContent).toContain('editing tests');

    image.dispatchEvent(new Event('load'));
    expect(avatar.classList).toContain('has-image');

    image.dispatchEvent(new Event('error'));
    expect(avatar.classList).not.toContain('has-image');
    expect(avatar.querySelector('img')).toBeNull();

    open.click();
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'openIssue', number: 18953 });
  });

  it('names the issue on a card the developer is not assigned, and disables only the unlinked one', () => {
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
    const opens = Array.from(document.querySelectorAll<HTMLButtonElement>('.card-open'));

    expect(cards).toHaveLength(2);
    expect(opens[0]?.disabled).toBe(false);
    expect(cards[0]?.textContent).toContain('Guest portal drops rows past the first page');
    expect(opens[1]?.disabled).toBe(true);
    expect(cards[1]?.textContent).toContain('18953-cache-remediation');
    expect(cards[1]?.querySelector('.state')?.textContent).toBe('working');
  });

  it('badges the type before the status, then the pull request, in GitHub own colours', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));

    const badges = Array.from(document.querySelectorAll<HTMLElement>('.badges.github .badge'));

    expect(badges.map((b) => b.className.replace('badge ', ''))).toEqual([
      'type',
      'status',
      'pull-request link',
    ]);
    expect(badges[0]?.style.getPropertyValue('--gc-badge')).toBe('var(--vscode-charts-red)');
    expect(badges[1]?.style.getPropertyValue('--gc-badge')).toBe('var(--vscode-charts-foreground)');
    expect(badges[2]?.textContent).toBe('#19403');
    expect(badges[2]?.style.getPropertyValue('--gc-badge')).toBe('var(--vscode-charts-green)');
    expect(badges[2]?.querySelector('.pr-mark')).not.toBeNull();
  });

  it('opens the issue from its number and the pull request from its badge', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));

    const number = document.querySelector<HTMLButtonElement>('.card-meta .number')!;
    const pr = document.querySelector<HTMLButtonElement>('.badges.github .badge.pull-request')!;

    expect(number.tagName).toBe('BUTTON');
    // The number and its repository are the chip's whole fact, so it says nothing further on hover.
    expect(tipOf(number)).toBe('');
    // The button's own text is a bare number, so without this a screen reader announces only "18953, button".
    expect(number.getAttribute('aria-label')).toBe('Open issue example-repo #18953 on GitHub');
    expect(number.getAttribute('draggable')).toBe('false');
    expect(pr.tagName).toBe('BUTTON');
    // The number and its glyph are the chip's whole fact, so it says nothing further on hover. The state is not
    // lost with it: the accessible name carries the word, which is what a reader gets in place of the colour.
    expect(tipOf(pr)).toBe('');
    expect(pr.getAttribute('aria-label')).toBe('Open pull request #19403, open, on GitHub');
    expect(pr.getAttribute('draggable')).toBe('false');
    expect(getComputedStyle(pr).cursor).toBe('pointer');

    number.click();
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'openIssue', number: 18953 });

    pr.click();
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'openPullRequest', number: 18953 });
  });

  it('opens a session from its own row, naming the session and never its directory', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));

    const row = document.querySelector<HTMLButtonElement>('.session')!;
    const label = row.querySelector<HTMLElement>('.session-label')!;

    // The whole row is the control, as the overlay makes it: a hover then paints the row rather than the words.
    expect(row.tagName).toBe('BUTTON');
    expect(label.tagName).toBe('SPAN');
    // Nothing on hover: the name is on the row already. What a reader needs beyond it — that this one opens — is
    // the accessible name instead, since a hover repeating a row's own words is a hover to learn to ignore.
    expect(tipOf(row)).toBe('');
    expect(row.getAttribute('aria-label')).toBe('cache-remediation - go to this session');
    expect(getComputedStyle(row).cursor).toBe('pointer');
    // A button brings its own colour, and on a dark card the UA default is the wrong one. The name is a step above
    // the marks around it, which stay at the description colour - the tone the overlay mixes to (`mechanics.md` §38).
    expect(getComputedStyle(label).color).toBe('var(--vscode-foreground)');
    expect(getComputedStyle(row).color).toBe('var(--vscode-descriptionForeground)');
    // Without this, a few pixels of drift on the way to a click drags the card and the click never fires. The
    // attribute, not the property: a button reads false either way, so only the attribute proves the line is there.
    expect(row.getAttribute('draggable')).toBe('false');

    label.click();

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'openSession', sessionId: 'session-1' });
  });

  /**
   * The only way into a run the board started: opening one as a tab resumes it, which the CLI refuses while the
   * background process still holds the conversation (`mechanics.md` §33). So a detached run is reachable whether or
   * not the agent's editor extension is, because a terminal is all `attach` needs.
   */
  it('attaches to a detached run instead of opening it, and offers it even where nothing is openable', () => {
    const detached = { ...session, attachId: 'c5d0c58f', details: { kind: 'background', name: 'merge-upstream' } };

    send(message({ lanes: lanes({ build: [{ ...liveCard, sessions: [detached] }] }), openable: [] }));

    const row = document.querySelector<HTMLElement>('.session')!;

    expect(row.tagName).toBe('BUTTON');
    expect(row.getAttribute('aria-label')).toBe('merge-upstream - attach to this run in a terminal');

    row.click();

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'attachSession', sessionId: 'session-1' });
    expect(api.postMessage).not.toHaveBeenCalledWith({ type: 'openSession', sessionId: 'session-1' });
  });

  /**
   * Two destinations and a row that has neither. Which one a click lands in is decided at the render, so it can be
   * drawn: an attachable run goes to a terminal, and everything else to the editor.
   */
  it('marks where each row click lands, and marks nothing on a row that cannot be clicked', () => {
    const detached = { ...session, attachId: 'c5d0c58f', details: { kind: 'background', name: 'merge-upstream' } };

    send(message({ lanes: lanes({ build: [{ ...liveCard, sessions: [detached] }] }), openable: [] }));

    expect(document.querySelector('.session .destination')?.getAttribute('data-destination')).toBe('terminal');
    expect(document.querySelector<HTMLElement>('.session')?.dataset.detached).toBe('true');

    send(message({ lanes: lanes({ build: [liveCard] }), openable: ['session-1'] }));

    expect(document.querySelector('.session .destination')?.getAttribute('data-destination')).toBe('editor');
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
    // The owner, not the whole key: the host is in it so two hosts' copies of one name compare unequal, and it
    // tells the developer nothing about which checkout they are looking at.
    expect(tipOf(number)).toBe('example-org/example-repo');
    expect(card.querySelector('.title')?.textContent).toBe('master');
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
    expect(card.querySelector('.title')?.textContent).toBe('master');
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
    expect(card.querySelector('.title')?.textContent).toBe('scratch');
  });

  /**
   * The repository beside the number, the way GitHub writes it on a card of its own — a board spanning repositories
   * says which one each card came from. Named without its owner, as `checkoutName` names a session's.
   */
  it('writes the repository beside the issue number, without its owner', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));

    const number = document.querySelector<HTMLElement>('.number')!;

    expect(number.textContent).toBe('example-repo #18953');
    expect(number.getAttribute('aria-label')).toBe('Open issue example-repo #18953 on GitHub');
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
    expect(number.getAttribute('aria-label')).toBe('Open issue #18953 on GitHub');
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
    expect(mark.getAttribute('aria-label')).toBe('claude');
    expect(mark.getAttribute('data-agent')).toBe('claude');
    // No `<title>` child: the browser draws its own tooltip from one, beside the row's (`docs/mechanics.md` §35).
    expect(mark.querySelector('title')).toBeNull();
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
  });

  /** The two marks are drawn differently by their owners, and a monochrome one at Claude's orange would be wrong. */
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
  });

  it('shows stale-source, pattern, project-filter, and truncation notices together', () => {
    send(
      message({
        issues: {
          count: 3,
          matched: 8,
          totalAssigned: 10,
          notOnProject: 2,
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

  /**
   * The report the extension host reads to know the script ran at all. Asserted here rather than only in a real
   * window, because it has to describe the finished screen: posted mid-render it reported an emptied notice list
   * and the previous render's meta line, and passed in both places.
   */
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
  const withPhase = (phase: 'running' | 'waiting' | 'idle', since = Date.now(), over: Partial<Session> = {}) => ({
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

  /**
   * The card's edge carries R6, and so does the mark on the row it is about. No chip: a pill reading `Needs you`
   * beside a card already edged yellow was the same claim twice.
   */
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

  /**
   * A colour is not a fact that reaches everyone, and with the words gone the mark's own name is what carries it:
   * a reader gets the phase per row, which is more than a card-level pill ever said about which session it meant.
   */
  it('leaves the phase on the mark a reader can hear, now that no words carry it', () => {
    const card = sendCard(
      [
        withPhase('waiting', Date.now(), { sessionId: 's-1', details: withDetails({ name: 'still asking' }) }),
        withPhase('running', Date.now(), { sessionId: 's-2', details: withDetails({ name: 'drafting notes' }) }),
      ],
      'blocked',
    );

    expect(Array.from(card.querySelectorAll('.dot')).map((el) => el.getAttribute('aria-label'))).toEqual([
      'needs you, open',
      'running, open',
    ]);
  });

  it('marks nothing when the board asked nothing of the developer', () => {
    const card = sendCard([{ ...session, activity: null }]);

    expect(card.dataset.attention).toBeUndefined();
    expect(card.querySelector('.badge.blocked')).toBeNull();
    expect(card.querySelector('.badge.your-turn')).toBeNull();
  });

  /**
   * The phase and whether the agent still has the session open are what the row used to spend a word on. The word is
   * not lost: it is the mark's own name, because a hue reaches only some readers.
   */
  it.each([
    ['running', false, 'running, open'],
    ['waiting', false, 'needs you, open'],
    ['idle', false, 'idle, open'],
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
  });

  // A row the board has no phase for still gets a mark: an absent one would read as a row with nothing to report.
  it('marks a session no hook has reported on as having no state, rather than leaving the row unmarked', () => {
    const dot = sendCard([{ ...session, activity: null }]).querySelector<HTMLElement>('.dot')!;

    expect(dot.dataset['phase']).toBe('none');
    expect(dot.getAttribute('aria-label')).toBe('no state reported, open');
  });

  it('offers the title as a control only where there is an issue to open', () => {
    send(message({ lanes: lanes({ build: [liveCard, { ...liveCard, key: 'session:x', issueNumber: null, issue: null }] }) }));

    const [withIssue, without] = Array.from(document.querySelectorAll<HTMLButtonElement>('.card-open'));

    expect(withIssue!.disabled).toBe(false);
    expect(without!.disabled).toBe(true);
  });

  /**
   * A card holds several sessions, and the loudest of them is what the card is: `attentionOf` returns `blocked` where
   * any live session waits, so the border is the most urgent. Only the row it is about is painted with it.
   */
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
      'Counts the turn it is in, from the prompt that began it where the board saw one. Last seen at the PostToolBatch hook.',
    );
    expect(tipOf(state)).not.toContain('working');
  });

  /**
   * A colour is the one thing on a row that cannot be read, so the mark is the one thing on it that earns a hover.
   * The fill is the second half of what it means, and a saved row says what its own hollow mark is about.
   */
  it.each([
    ['running', false, 'This session is working.'],
    ['waiting', false, 'This session is waiting on you.'],
    ['idle', false, 'The board last saw this session finish.'],
    ['idle', true, 'The board last saw this session finish. The agent has since ended it.'],
  ] as const)('says what the mark means for a %s session, finished %s', (phase, finished, said) => {
    const card = sendCard([{ ...withPhase(phase, Date.now()), finished }]);

    expect(tipOf(card.querySelector('.dot'))).toBe(said);
  });

  it('says the mark means nothing has reported, where nothing has', () => {
    const card = sendCard([{ ...session, activity: null }]);

    expect(tipOf(card.querySelector('.dot'))).toBe('No hook has reported on this session.');
  });

  /**
   * The anchor does not move, so its age is a function of the clock: the text has to advance with no message from the
   * extension host and no read of the machine behind it.
   */
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

  /**
   * The same table the overlay's suite asserts, against literal strings: `ago` exists in both clients because neither
   * can import `core` at runtime, and a copy that drifts reads a duration in a unit the other board never shows.
   */
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
    send(message({ hooks: { notice: 'Session activity hooks installed. 3 sessions started before that and will not report until restarted.' } }));

    const notices = Array.from(document.querySelectorAll('#notices .notice'));

    expect(notices).toHaveLength(1);
    expect(notices[0]?.classList).not.toContain('error');
    expect(notices[0]?.textContent).toContain('3 sessions started before that');
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
 * What the tick is allowed to cost. The overlay's twin runs under a `MutationObserver` that answers a `childList`
 * record with a repaint of the whole board, so a duration advancing must write through the text node it already
 * has. This board has no such observer, but the same write is what stops a row relaying out once a second under a
 * label carrying a running animation — and the two copies are held to one rule.
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

  /** A card carrying every kind of duration at once: a live row, a saved row, and the age of a card's status. */
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
      expect(document.querySelectorAll(AGE)).toHaveLength(3);

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

  /**
   * One attribute for every duration, so one pass advances them all. A writer left on an old name would tick
   * nothing and no other assertion here would notice — the count is what says every age is reached.
   */
  it('carries one age attribute and none of the three it replaced', () => {
    everyAge();

    expect(document.querySelectorAll('[data-activity-since], [data-history-updated], [data-status-since]')).toHaveLength(0);
    expect(document.querySelectorAll(AGE)).toHaveLength(3);
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
    contributes: { configuration: { properties: Record<string, { default: unknown }> } };
  };
  const declared = (name: string) => manifest.contributes.configuration.properties[`groundControl.${name}`]?.default;

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
    reason: '🏃 Testing — not yours to act on right now.',
    sessions: [],
  };

  it('renders every lane the payload carries, with its count — R10', () => {
    send(message({ lanes: lanes({ plan: [planCard] }) }));

    const rendered = Array.from(document.querySelectorAll<HTMLElement>('.lane h2 .lane-name')).map((h) => h.textContent);

    expect(rendered).toEqual(LANE_ORDER.filter((id) => id !== 'archived').map((id) => LANE_TITLES[id]));
    expect(laneEl('plan')?.querySelector('.lane-count')?.textContent).toBe('1');
    expect(laneEl('unstarted')?.querySelector('.lane-count')?.textContent).toBe('0');
    expect(laneEl('plan')?.querySelectorAll('.card')).toHaveLength(1);
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

    expect(card.querySelector('.card-foot .badges.marks .returned')?.textContent).toBe('Returned');
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

  it('hides an empty Done and Icebox, and brings them back as drop targets while a card is dragged', () => {
    send(message({ lanes: lanes({ plan: [planCard], done: [{ ...planCard, key: 'issue:1', lane: 'done' }] }) }));

    expect(laneEl('done')?.classList).not.toContain('lane-idle');
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

  it('keeps a card with no issue reachable from a keyboard, since its open button is disabled', () => {
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

    expect(card.querySelector<HTMLButtonElement>('.card-open')!.disabled).toBe(true);
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
 * The ladder is duplicated into every board: `media/board.js` is a classic script and the Chrome overlay is plain
 * JavaScript, so neither can import `core`'s `sessionLabel`. This table is the same one asserted in
 * `packages/core/test/roster.test.ts` and in the overlay's suite, against literal strings rather than a computed
 * expectation — a copy that drifts fails here rather than quietly naming a session something else.
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
    // Not the age attribute, which every duration on the board now carries: what says this row reports no phase is
    // the row carrying none and its mark saying so.
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
   * R6 past the session's own process: a filled mark says the process is running, so a reading kept past it is drawn as an outline in the
   * phase's own colour. The row carries the rendered phase rather than the recorded one, because `data-phase` also drives the running
   * shimmer and the your-turn tone, and both are claims about a session that still has a process.
   */
  it.each([
    ['waiting', 'waiting', 'waiting on you'],
    ['idle', 'idle', 'finished its turn'],
    ['running', 'idle', 'stopped short'],
  ] as const)('outlines a %s reading kept past the process as %s, and says which on hover', (phase, drawn, said) => {
    const at = Date.now() - 300_000;
    const retained = { ...lastSession, retained: { phase, event: 'PreToolUse', at } };

    send(message({ lanes: lanes({ build: [{ ...liveCard, sessions: [], lastSession: retained }] }) }));

    const row = document.querySelector<HTMLElement>('.historical')!;

    expect(row.dataset.phase).toBe(drawn);
    expect(row.querySelector<HTMLElement>('.dot')?.dataset['phase']).toBe(drawn);
    // The fill is what says the process is gone, and it stays off whatever the phase.
    expect(row.querySelector<HTMLElement>('.dot')?.dataset['live']).toBe('false');
    expect(tipOf(row.querySelector('.dot'))).toContain(said);
    expect(tipOf(row.querySelector('.dot'))).toContain('PreToolUse');
    // The reading's own event, so the duration is the age of what the mark claims rather than of the last transcript write — and the hover
    // names that same moment, since a value and a tooltip disagreeing about one row is two of the board's claims about it (R24).
    expect(row.querySelector('.state')?.textContent).toBe('5m');
    expect(tipOf(row.querySelector('.state'))).toContain('Last seen');
    expect(tipOf(row.querySelector('.state'))).toContain(new Date(at).toLocaleString());
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
  // A saved session has no process to attach to, so the editor is the only destination it has.
  expect(button.querySelector('.destination')?.getAttribute('data-destination')).toBe('editor');
  button.click(); expect(sent()).toEqual([{ type: 'openSession', sessionId: 'past' }]);
  expect(tipOf(button)).toBe('');
  expect(button.getAttribute('aria-label')).toBe('Past attempt - resume this session');
  expect(tipOf(button.querySelector('.state'))).toContain('Resume this session');
  send(message({ lanes: lanes({ build: [pastCard] }), openable: [] }));
  expect(document.querySelector('button.historical')).toBeNull();
});

/**
 * The card reads in two halves, the way the browser overlay's does: what GitHub says about the issue, and then what
 * this board adds on top of it. A chip that drifts from one half to the other puts the board's own reading among
 * GitHub's facts, which is the confusion the split exists to end.
 */
describe('what GitHub says, and what the board adds', () => {
  const triage: NonNullable<LanedCard['triage']> = { state: 'done', action: 'address-review', qualifier: 'followup', detail: 'Answer the naming notes.', at: Date.now(), stale: false };
  const waiting: Session = { ...session, activity: { phase: 'waiting', since: Date.now(), at: Date.now(), event: 'Notification' } };

  const rows: [string, string][] = [
    ['type', '.badges.github'],
    ['status', '.badges.github'],
    ['pull-request', '.badges.github'],
    ['returned', '.card-foot .badges.marks'],
    ['triage', '.card-foot .badges.marks'],
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

  it('carries the reading sentence and every session row inside the footer, never above it', () => {
    full();

    const foot = document.querySelector<HTMLElement>('.card-foot')!;

    expect(tipOf(foot.querySelector('.badge.triage'))).toContain('Answer the naming notes.');
    expect(foot.querySelectorAll('.session')).toHaveLength(1);
    expect(document.querySelectorAll('.card > .session')).toHaveLength(0);
  });

  /**
   * A reading and a run change nothing else about a card, so a card already on the board is only redrawn for them if
   * the signature says so. Without that the footer stays empty for the whole time a card sits on a live board.
   */
  it('fills in when a reading lands on a card already on the board', () => {
    const bare = { ...liveCard, sessions: [] };

    send(message({ lanes: lanes({ build: [bare] }) }));
    expect(document.querySelector('.card-foot .badge')).toBeNull();

    send(message({ lanes: lanes({ build: [{ ...bare, triage: { state: 'running' } }] }) }));
    expect(document.querySelector('.card-foot .badge.triage-running')).not.toBeNull();

    send(message({ lanes: lanes({ build: [{ ...bare, triage }] }) }));
    expect(document.querySelector('.card-foot .badge.triage')?.textContent).toBe('Answer review · followup');
    expect(tipOf(document.querySelector('.card-foot .badge.triage'))).toContain('Answer the naming notes.');

    send(message({ lanes: lanes({ build: [{ ...bare, triage, action: { state: 'available', action: 'merge-upstream' } }] }) }));
    expect(document.querySelector('.card-foot .badge.action')?.textContent).toBe('Run merge upstream');
  });

  // Settled: the footer is where this board's controls go, so it is drawn on a card that has nothing in it yet.
  it('is drawn on a card the board has read nothing about and nobody has worked on', () => {
    send(message({ lanes: lanes({ unstarted: [{ ...liveCard, sessions: [] }] }) }));

    const foot = document.querySelector<HTMLElement>('.card-foot')!;

    expect(foot).not.toBeNull();
    expect(foot.querySelector('.badge')).toBeNull();
  });

});

describe("the card's own menu", () => {
  const control = () => document.querySelector<HTMLButtonElement>('.card-menu');
  const menu = () => document.querySelector<HTMLElement>('.card-popover');
  const items = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.card-popover button'));

  // Closed the way the board closes it, not by yanking the node: the document handlers a menu installs are
  // released by `closeMenu`, and a test that left them installed would leak one pair per test.
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

  it('opens on a click and offers the changes the card has, closing again on a second one', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));
    control()!.click();

    expect(control()!.getAttribute('aria-expanded')).toBe('true');
    expect(menu()!.getAttribute('role')).toBe('menu');
    expect(menu()!.getAttribute('aria-label')).toBe('Actions for Cached counts do not update');
    expect(items().map((item) => item.textContent)).toEqual(['View changes', 'Open in VS Code']);
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
    send(message({ lanes: lanes({ build: [liveCard] }) }));
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
  it('closes on Tab, leaving the focus on the control the browser then tabs on from', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));
    control()!.click();

    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });

    items()[0]!.dispatchEvent(tab);

    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(control());
    // Never prevented: the browser's own Tab is what moves on from the control this just focused.
    expect(tab.defaultPrevented).toBe(false);
  });

  it('opens from the keyboard on either arrow, taking the end the arrow points at', () => {
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
  it('closes rather than re-anchoring to a card the archive toggle has taken off screen', () => {
    const archived = { ...liveCard, key: 'issue:404', lane: 'archived' as const };

    send(message({ lanes: lanes({ archived: [archived] }) }));
    toggleArchived();

    control()!.click();
    expect(menu()).not.toBeNull();

    toggleArchived();
    send(message({ lanes: lanes({ archived: [{ ...archived, returned: true }] }) }));

    expect(menu()).toBeNull();
  });

  it('keeps naming its menu after a refresh has rebuilt the card under it', () => {
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

  it('names the menu it opened, so the control points at the one on the document', () => {
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

  // A menu whose every item could only refuse is worse than no menu — the rule the session rows already follow.
  // Ad-hoc work whose directory has gone is the card that reaches it: no checkout to open, and no issue to name a
  // repository a picked folder could be checked against.
  it('is absent on a card with nothing to offer — no checkout, and no issue to choose one for', () => {
    send(message({ lanes: lanes({ unstarted: [{ ...noCheckout, issue: null, issueNumber: null }] }) }));

    expect(control()).toBeNull();
  });

  it('offers a folder to an issue card with no checkout, which is the one thing that would give it one', () => {
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

    expect(items().map((item) => item.textContent)).toEqual([
      'View changes',
      'Open in VS Code',
      'Start Claude session',
      'Start Codex session',
    ]);
  });

  // §51: `chatgpt.newCodexPanel` takes no arguments, so the prompt is dropped — and the item says so rather than
  // letting a developer with a configured prompt believe it reached the session.
  it('says on the item itself which agent’s start cannot carry the prompt', () => {
    send(message({
      lanes: lanes({ build: [liveCard] }),
      startable: [{ agent: 'claude', takesPrompt: true }, { agent: 'codex', takesPrompt: false }],
    }));
    control()!.click();

    expect(tipOf(items()[2])).toContain('prefilled and unsent');
    expect(tipOf(items()[3])).toContain('no way in that takes a prompt');
  });

  it('sends the card and the agent the item was drawn for, and nothing about where it runs', () => {
    send(message({ lanes: lanes({ build: [liveCard] }), startable: [{ agent: 'claude', takesPrompt: true }] }));
    control()!.click();
    items()[2]!.click();

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
  it('offers no start where the host named no agent, rather than guessing one', () => {
    send(message({ lanes: lanes({ build: [liveCard] }), startable: [] }));
    control()!.click();

    expect(items().map((item) => item.textContent)).toEqual(['View changes', 'Open in VS Code']);
  });

  it('follows the card it belongs to when a refresh rebuilds it, and goes when the card does', () => {
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

describe('what a card was read to be waiting on (R38)', () => {
  const at = Date.UTC(2026, 8, 1, 19, 0, 0);

  /** The status moved at `moved`, which is a different time from `at` — a test must not pass on the wrong one. */
  function triaged(triage: NonNullable<LanedCard['triage']>, moved: string | null = null): LanedCard {
    return { ...liveCard, sessions: [], triage, issue: { ...liveCard.issue!, statusChangedAt: moved } };
  }

  function chip(): HTMLElement | null {
    return document.querySelector<HTMLElement>('.badge.triage, .badge.triage-running, .badge.triage-failed');
  }

  it('says a card is being read, and asks nothing of the developer while it does', () => {
    send(message({ lanes: lanes({ unstarted: [triaged({ state: 'running' })] }) }));

    expect(chip()?.textContent).toBe('Reading…');
    // R6's channels are for the two things that want the developer. Being read is not one of them.
    expect(document.querySelector<HTMLElement>('.card')?.dataset['attention']).toBeUndefined();
    expect(document.querySelector('.triage-again')).toBeNull();
  });

  /**
   * Two ages are in play and only one is on the chip: how long the card has held its status, which is what says
   * whether a reading is still the card to pick up. When the board decided is in the tooltip with the sentence.
   */
  it('names the action, ages the status on the chip, and holds the sentence and the reading age on hover', () => {
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
      expect(chip()?.textContent).toBe('Answer review · followup · 2d');
      expect(chip()?.querySelector('.triage-age')?.textContent).toBe('2d');
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
    expect(chip()?.querySelector('.triage-age')).toBeNull();
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

      const age = document.querySelector<HTMLElement>('.triage-age')!;

      vi.setSystemTime(new Date('2026-09-06T21:00:00Z'));
      tick?.();

      expect(document.querySelector('.triage-age')).toBe(age);
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

  it('marks a reading the card has moved under, rather than presenting it as current', () => {
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
      expect(tipOf(chip())).toBe('Pick it up. Read 5d ago; the card has moved since.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries nothing at all on a card that has not been read', () => {
    send(message({ lanes: lanes({ unstarted: [{ ...liveCard, sessions: [] }] }) }));

    expect(chip()).toBeNull();
    expect(document.querySelector('.triage-again')).toBeNull();
  });

  it('gives a card it could not read somewhere to press, with no words about why', () => {
    send(message({ lanes: lanes({ unstarted: [triaged({ state: 'failed', attempts: 2, exhausted: false })] }) }));

    expect(chip()?.textContent).toBe('Not read');

    chip()?.click();

    expect(sent()).toContainEqual({ type: 'retriage', key: 'issue:18953' });
  });

  it('says when the board has stopped trying on its own', () => {
    send(message({ lanes: lanes({ unstarted: [triaged({ state: 'failed', attempts: 5, exhausted: true })] }) }));

    expect(tipOf(chip())).toContain('has stopped trying');
  });

  it('never paints a reading in a colour R6 keeps for the two things that want the developer', () => {
    send(
      message({
        lanes: lanes({ unstarted: [triaged({ state: 'done', action: 'merge-upstream', qualifier: null, detail: 'Merge it.', at, stale: false })] }),
      }),
    );

    // `your-turn` is BLUE and `blocked` is YELLOW; a reading must read as neither at a glance.
    expect(chip()?.style.getPropertyValue('--gc-badge')).toBe('var(--vscode-charts-foreground)');
  });

  /** The age is what a card at rest carries, and the control stands in its place: one cell, so the chip is one width. */
  it('draws the control and the age into one cell of the chip', () => {
    send(
      message({
        lanes: lanes({
          unstarted: [
            triaged({ state: 'done', action: 'develop', qualifier: null, detail: 'Pick it up.', at, stale: false }, '2026-09-04T19:00:00Z'),
          ],
        }),
      }),
    );

    const end = chip()!.querySelector('.triage-end')!;

    expect(Array.from(end.children).map((el) => el.className)).toEqual(['triage-age', 'triage-again']);
  });

  /**
   * Reading a card again spends the developer's usage, so it takes a press of its own: the chip carries a sentence
   * worth clicking to see in full, and that click must not have been the one that started a read.
   */
  it('asks for the card to be read again from its own control, and from nowhere else on the chip', () => {
    send(
      message({
        lanes: lanes({ unstarted: [triaged({ state: 'done', action: 'other', qualifier: null, detail: 'Unclear.', at, stale: false })] }),
      }),
    );

    chip()?.click();
    chip()?.querySelector<HTMLElement>('.triage-age')?.click();

    expect(sent()).toEqual([]);
    expect(chip()?.tagName).toBe('SPAN');

    const again = chip()!.querySelector<HTMLButtonElement>('button.triage-again')!;

    expect(again.getAttribute('aria-label')).toBe('Read this card again');
    expect(tipOf(again)).toBe('Read this card again.');
    again.click();

    expect(sent()).toEqual([{ type: 'retriage', key: 'issue:18953' }]);
  });

  it('is not a drag handle, through the attribute the platform reflects rather than the property', () => {
    send(
      message({
        lanes: lanes({ unstarted: [triaged({ state: 'done', action: 'other', qualifier: null, detail: 'Unclear.', at, stale: false })] }),
      }),
    );

    expect(chip()?.querySelector('.triage-again')?.getAttribute('draggable')).toBe('false');
  });
});

describe('what the board can do about a card reading (R39)', () => {
  const at = Date.UTC(2026, 8, 1, 19, 0, 0);

  function acting(action: NonNullable<LanedCard['action']>): LanedCard {
    return { ...liveCard, sessions: [], action };
  }

  function chip(): HTMLElement | null {
    return document.querySelector<HTMLElement>(
      '.badge.action, .badge.action-running, .badge.action-done, .badge.action-refused',
    );
  }

  it('offers to run an action the board could take, and sends the card key when pressed', () => {
    send(message({ lanes: lanes({ unstarted: [acting({ state: 'available', action: 'merge-upstream' })] }) }));

    expect(chip()?.textContent).toBe('Run merge upstream');
    chip()?.click();

    expect(sent()).toContainEqual({ type: 'runAction', key: 'issue:18953' });
  });

  it('says a run is working and offers to take it back, rather than starting a second one', () => {
    send(message({ lanes: lanes({ unstarted: [acting({ state: 'running', action: 'merge-upstream', since: at })] }) }));

    expect(chip()?.textContent).toBe('Working…');
    chip()?.click();

    expect(sent()).toContainEqual({ type: 'stopAction', key: 'issue:18953' });
    // Work the board started is work in progress, which is the one thing a card is not asking the developer for —
    // so the chip is none of R6's three channels. Asserted through the badge's own colour, which is what would
    // change if it ever became one; the card's attention attribute is absent on this card either way.
    expect(chip()?.style.getPropertyValue('--gc-badge')).toBe('var(--vscode-charts-foreground)');
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

      expect(chip()?.textContent).toBe(text);
      expect(tipOf(chip())).toContain(action.detail);
    });
  }

  it('offers a finished run again, so a card the board stopped short on is one press from another try', () => {
    send(message({ lanes: lanes({ unstarted: [acting(outcomes[1]![0])] }) }));

    chip()?.click();

    expect(sent()).toContainEqual({ type: 'runAction', key: 'issue:18953' });
  });

  /** The remedy for a refusal is a setting or the card itself, so pressing again would only refuse again. */
  it('says why the board will not act, and gives nothing to press', () => {
    send(
      message({
        lanes: lanes({
          unstarted: [acting({ state: 'refused', action: 'merge-upstream', reason: 'It merges into a feature branch.' })],
        }),
      }),
    );

    expect(chip()?.textContent).toBe('Not run');
    expect(tipOf(chip())).toBe('It merges into a feature branch.');
    expect(chip()?.tagName).toBe('SPAN');
  });

  it('draws nothing at all on a card the board has no action for', () => {
    send(message({ lanes: lanes({ unstarted: [{ ...liveCard, sessions: [] }] }) }));

    expect(chip()).toBeNull();
  });

  it('is not a drag handle, through the attribute the platform reflects rather than the property', () => {
    send(message({ lanes: lanes({ unstarted: [acting({ state: 'available', action: 'merge-upstream' })] }) }));

    expect(chip()?.getAttribute('draggable')).toBe('false');
  });
});

/**
 * The parity table. `media/board.js` is a classic script and imports nothing from `packages/board`, so its copy of
 * the labels is pinned by asserting the same literals here that `packages/board`'s own suite asserts. A copy that
 * drifts labels a card one way in the editor and another in the browser (`docs/testing.md`).
 */
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

    expect(document.querySelector('.badge.triage')?.firstChild?.textContent).toBe(expected);
  });
});

describe("the board's own menu", () => {
  const control = () => document.getElementById('board-menu')!;
  const items = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.card-popover button'));
  const item = (label: string) => items().find((el) => el.textContent?.endsWith(label))!;

  beforeEach(() => {
    send({ type: 'logs', streaming: false });
  });

  // Closed the way the board closes it, so the document handlers a menu installs are released with it.
  afterEach(() => document.dispatchEvent(new MouseEvent('click', { bubbles: true })));

  it('holds what the board itself can be asked to do, the archive among them where there is one', () => {
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
    expect(tipOf(toggle)).toContain('Choose this to stop');

    document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    send({ type: 'logs', streaming: false });

    expect(control().classList).not.toContain('on');
    expect(tipOf(control())).toBe('Board actions');
  });

  // Three items deep, a tooltip under the first one covers the two below it, and the menu opens with focus on it.
  it('leaves the tooltip shut when a menu hands its first item the keyboard', () => {
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

  /**
   * The one signal that this script has run. A webview reloads on its own — a tab returning from the background, a
   * renderer restored — and the panel is not told; without this the button would sit reading off while the window
   * was streaming, and the developer's first click would stop the stream instead of starting it.
   */
  it('says it is ready, so the extension can tell it the state of the controls it owns', () => {
    expect(onLoad).toContainEqual({ type: 'ready' });
  });
});

/**
 * The board draws its own tooltip rather than leaving `title` to the browser: the native one opens after about a
 * second, in the operating system's shape, and cannot be made to match the editor. GitHub's own geometry and
 * timing (`docs/mechanics.md` §35), so the two boards read the same — the parity table below is what pins that.
 */
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

  it('draws nothing until a pointer has rested on something that says something', () => {
    const avatarEl = document.querySelector('.avatar')!;

    hover(avatarEl);

    expect(open()).toBeNull();

    vi.advanceTimersByTime(120);

    expect(open()).toBe('true');
    expect(tip()?.textContent).toBe('dev-2 · pull request author');
  });

  /** One node for the whole board: a render replaces every card, and a node per anchor would be built by the hundred. */
  it('reuses one element however many things are hovered', () => {
    for (const el of Array.from(document.querySelectorAll('[data-gc-tip]'))) {
      hover(el);
      vi.advanceTimersByTime(120);
    }

    expect(document.querySelectorAll('#tip')).toHaveLength(1);
  });

  /** A child would be part of `textContent`, and every label that reads its own would gain the tooltip's words. */
  it('leaves the text of what it names alone', () => {
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
   * The description is on the anchor and always there, not written as the tooltip opens: one written on `focusin`
   * lands 120ms after focus was announced, and a reader never hears it. `title` had this for free.
   */
  it('describes what it names before anything is hovered at all', () => {
    expect(document.querySelector('.number')!.getAttribute('aria-label')).toBe('Open issue example-repo #18953 on GitHub');
    expect(document.querySelector('.session')!.getAttribute('aria-label')).toContain('go to this session');
    // The state is the row's described half: what the board saw is the part not written on the row.
    send(message({ lanes: lanes({ build: [{ ...liveCard, sessions: [{ ...session, activity: { phase: 'running', since: Date.now(), at: Date.now(), event: 'PostToolBatch' } }] }] }) }));
    // The mark is named rather than described, so the described half of the row is the duration beside it.
    expect(document.querySelector('.state')!.getAttribute('aria-description')).toContain('Counts the turn it is in');
    expect(document.querySelector('.dot')!.hasAttribute('aria-description')).toBe(false);
    expect(document.querySelector('[aria-describedby]')).toBeNull();
  });

  /** A reader says the name, then the description. The same words in both is the board saying it twice. */
  it('never gives one element both a name and a description', () => {
    const both = Array.from(document.querySelectorAll('[aria-description]')).filter((el) =>
      el.hasAttribute('aria-label'),
    );

    expect(both.map((el) => el.getAttribute('aria-label'))).toEqual([]);
    // The avatar is the one that would: it is named for a reader and its tooltip says the same thing.
    expect(document.querySelector('.avatar')!.getAttribute('aria-label')).toBe('dev-2, pull request author');
    expect(document.querySelector('.avatar')!.hasAttribute('aria-description')).toBe(false);
  });

  it('opens on focus, for a developer who never touches the pointer', () => {
    document.querySelector('.avatar')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    vi.advanceTimersByTime(120);

    expect(open()).toBe('true');
  });

  /** `mouseout` fires as the pointer crosses an anchor's own children; closing there shuts and reopens it. */
  it('stays open as the pointer crosses its anchor own children', () => {
    // The reading is the chip that carries a tooltip and holds children of its own: an age, and a control.
    send(
      message({
        lanes: lanes({
          build: [
            {
              ...liveCard,
              sessions: [],
              triage: { state: 'done', action: 'develop', qualifier: null, detail: 'Pick it up.', at: Date.now(), stale: false },
            },
          ],
        }),
      }),
    );

    const chip = document.querySelector('.badge.triage')!;

    hover(chip);
    vi.advanceTimersByTime(120);
    chip
      .querySelector('.triage-again')!
      .dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: chip.firstChild }));

    expect(open()).toBe('true');
  });

  /** A render inside the delay replaces what the pointer was over; a detached anchor measures zero at the origin. */
  it('never opens against an anchor the board has replaced', () => {
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
  it('draws it in the shape the parity table pins', () => {
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

  it('is drawn nowhere until something is hovered', () => {
    expect(getComputedStyle(tipElementForTest()).display).toBe('none');
  });

  function tipElementForTest(): HTMLElement {
    hover(document.querySelector('.avatar')!);
    vi.advanceTimersByTime(120);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    return tip()!;
  }

  /**
   * Nothing may set `title`, in the attribute or as an SVG `<title>` child — the browser draws its own from either,
   * beside ours. The card carries every branch that draws one, or the count holds for a board that drew none of them.
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

/**
 * The parity table for the durations. Both boards write the same attribute and tick it the same way, and neither
 * can import the other, so each suite asserts the same rows: the element a kind of age is drawn on, the attribute
 * that marks it, and the literal the tick puts in it. A board that renamed the attribute on its own would leave
 * the other's tick selecting nothing, which is a board whose durations quietly stop.
 */
describe('the age attribute both boards share', () => {
  const held = Date.UTC(2026, 8, 7, 12, 0, 0);

  const rows: [string, string, number, string][] = [
    ['a session state', '.state', 125_000, '2m'],
    ['a saved session', '.historical .state', 60_000, '1m'],
    ['the age of a status', '.triage-age', 10_800_000, '3h'],
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
 * The parity table. Neither board imports the other's tooltip — both are classic scripts — so the shape they share
 * is pinned by asserting the same numbers in both suites (`docs/testing.md`). Measured off GitHub's own tooltip,
 * `docs/mechanics.md` §35.
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
