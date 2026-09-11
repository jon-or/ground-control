import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueCard, Lane, LaneId, LanedCard, Session, Snapshot } from '@ground-control/core';
import { LANE_SHAPES, LANE_TITLES, LOG_LIMIT, ago, agentIcon, agentTitle, appendLog, assigneeStackOf, cardsByIssue, clear, filterBox, filterText, foldedRows, issueRefOf, paint, sessionLabel, setLogOpen, tickDurations, viewerLogin } from '../src/overlay.js';

/**
 * The literal lane titles, matching the table in the editor board's suite. Both clients duplicate the map
 * because neither can import core at runtime (`docs/testing.md` parity tables).
 */
const LANE_NAMES: Record<string, string> = {
  unstarted: 'Unstarted',
  plan: 'Plan',
  build: 'Build',
  review: 'Review',
  done: 'Done',
  icebox: 'Icebox',
  archived: 'Archived',
};

/** The board GitHub actually serves, recorded and scrubbed. Its three cards are issues 4501, 4502 and 4503. */
const BOARD = readFileSync(join(__dirname, 'fixtures', 'project-board.html'), 'utf8');

const REPO = 'example-org/example-repo';
const NOW = Date.parse('2026-09-04T12:00:00Z');
/** A real id: the link the chip writes is only taken for one, so a fixture id of another shape proves nothing. */
const SESSION_ID = 'a1b2c3d4-0000-4000-8000-000000000000';
const OTHER_ID = 'b2c3d4e5-0000-4000-8000-000000000000';

function session(over: Partial<Session> = {}): Session {
  return {
    agent: 'claude',
    sessionId: SESSION_ID,
    pid: 4242,
    title: 'Working on it',
    cwd: 'd:/checkouts/4501-quote-email',
    checkoutRoot: 'd:/checkouts/4501-quote-email',
    startedAt: NOW - 600_000,
    branch: '4501-quote-email',
    repository: `github.com/${REPO}`,
    issueNumber: 4501,
    transcriptWrittenAt: NOW - 30_000,
    activity: { phase: 'waiting', since: NOW - 125_000, at: NOW - 125_000, event: 'PermissionRequest' },
    finished: false,
    attachId: null,
    details: {},
    ...over,
  };
}

/** A card the hub knows the repository of, which is how it is told from another repository's issue of that number. */
function card(issueNumber: number, over: Partial<LanedCard> = {}, repo = REPO): LanedCard {
  return {
    key: `issue-${issueNumber}`,
    issue: {
      number: issueNumber,
      title: `Issue ${issueNumber}`,
      type: null,
      typeColor: null,
      url: `https://github.com/${repo}/issues/${issueNumber}`,
      status: null,
      statusColor: null,
      statusChangedAt: null,
      assignees: [],
      avatar: null,
      pullRequest: null,
      updatedAt: '2026-09-04T08:00:00Z',
    },
    issueNumber,
    sessions: [session({ issueNumber })],
    lane: 'build',
    returned: false,
    attention: null,
    reason: '',
    ...over,
  };
}

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  const shown: Lane[] = [{ id: 'build', title: 'Build', cards: [card(4501)] }];

  return {
    lanes: shown,
    issues: { count: 1, matched: 1, totalAssigned: 1, notOnProject: 0, fieldProblem: null, truncated: false, fetchedAt: '' },
    sessions: { count: 1, patternError: null, fetchedAt: '' },
    // What the hub sends a browser board: every session of an agent the host is placed for, which is Claude's (R14).
    openable: (over.lanes ?? shown)
      .flatMap((lane) => lane.cards)
      .flatMap((entry) => entry.sessions)
      .filter((entry) => entry.agent === 'claude')
      .map((entry) => entry.sessionId),
    // What a connected editor can start for this board; none while no editor is connected (R36, R42).
    startable: [],
    hooks: null,
    failures: [],
    stale: false,
    needs: null,
    fetchedAt: new Date(NOW - 90_000).toISOString(),
    ...over,
  };
}

const actions = { refresh: vi.fn(), move: vi.fn(), repaint: vi.fn(), watchLog: vi.fn(), openCheckout: vi.fn(), retriage: vi.fn(), runAction: vi.fn(), stopAction: vi.fn(), startSession: vi.fn(), showCardRows: vi.fn() };

interface State {
  snapshot: Snapshot | null;
  trouble: string | null;
  notice: string | null;
}

function state(over: Partial<State> = {}): State {
  return { snapshot: snapshot(), trouble: null, notice: null, ...over };
}

beforeEach(() => {
  document.documentElement.innerHTML = BOARD;
  actions.refresh.mockReset();
  actions.move.mockReset();
  actions.repaint.mockReset();
  actions.watchLog.mockReset();
  actions.openCheckout.mockReset();
  actions.retriage.mockReset();
  actions.showCardRows.mockReset();
  actions.runAction.mockReset();
  actions.stopAction.mockReset();
  // The open lane list is module state, so a test that left one open would leak into the next.
  clear(document);
  // And the collapse outlives a tab on purpose, which means it outlives a test unless the storage goes with it.
  localStorage.clear();
});

function badges(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.gc-badge')];
}

/** What an element says on hover. Not `title` — the board draws its own tooltip, in GitHub's shape. */
function tipOf(el: Element | null | undefined): string {
  return el?.getAttribute('data-gc-tip') ?? '';
}

/** The card element the fixture carries for an issue, which is what the swap reads GitHub's own assignees off. */
function cardElement(issueNumber: number): Element {
  const element = [...document.querySelectorAll('[data-board-card-id]')].find((held) =>
    held.querySelector(`a[href$="/issues/${issueNumber}"]`),
  );

  if (element === undefined) {
    throw new Error(`The fixture has no card for issue ${issueNumber}.`);
  }

  return element;
}

const AUTHOR = { login: 'colleague', url: 'https://avatars.example.test/colleague.png', source: 'pull-request' } as const;
const ASSIGNEE = { login: 'example-dev', url: 'https://avatars.example.test/example-dev.png', source: 'issue' } as const;
const REPORTER = { login: 'reporter', url: 'https://avatars.example.test/reporter.png', source: 'issue-author' } as const;

/** A card whose issue carries the actor the hub picked, which is the only input the swap has. */
function actorCard(issueNumber: number, avatar: IssueCard['avatar']): LanedCard {
  const base = card(issueNumber);

  return { ...base, issue: { ...base.issue!, avatar } };
}

function laneOf(...cards: LanedCard[]): Snapshot {
  return snapshot({ lanes: [{ id: 'build', title: 'Build', cards }] });
}

describe('reading GitHub board markup', () => {
  it('finds the repository and issue every card links to', () => {
    const cards = [...document.querySelectorAll('[data-board-card-id]')];

    expect(cards).toHaveLength(3);
    expect(cards.map((element) => issueRefOf(element))).toEqual([
      { repo: REPO, number: 4501 },
      { repo: REPO, number: 4502 },
      { repo: REPO, number: 4503 },
    ]);
  });

  it('reports no issue for a card that links to none', () => {
    const draft = document.querySelector('[data-board-card-id]')!;

    draft.querySelector('a[href*="/issues/"]')!.remove();

    expect(issueRefOf(draft)).toBeNull();
  });

  it('gathers the cards from every lane, not only the first', () => {
    const { byRef } = cardsByIssue(
      snapshot({
        lanes: [
          { id: 'build', title: 'Build', cards: [card(4501), card(4502)] },
          { id: 'review', title: 'Review', cards: [card(4503, { lane: 'review' })] },
        ],
      }),
    );

    expect([...byRef.keys()]).toEqual([`${REPO}#4501`, `${REPO}#4502`, `${REPO}#4503`]);
    expect(byRef.get(`${REPO}#4503`)?.lane).toBe('review');
  });

  it('leaves out a card with no issue of its own, which no GitHub board carries', () => {
    const sessionOnly = card(4501, { issueNumber: null, issue: null, key: 'dir-checkout' });
    const index = cardsByIssue(snapshot({ lanes: [{ id: 'build', title: 'Build', cards: [sessionOnly] }] }));

    expect([...index.byRef.keys()]).toEqual([]);
    expect([...index.byNumber.keys()]).toEqual([]);
  });

  /** An issue URL this pattern does not read leaves the number, which still matches the page it is painted on. */
  it('indexes a card the hub knows the number of but not the repository', () => {
    const base = card(4501);
    const unknown = { ...base, issue: { ...base.issue!, url: 'https://example.invalid/whatever' } };
    const index = cardsByIssue(snapshot({ lanes: [{ id: 'build', title: 'Build', cards: [unknown] }] }));

    expect([...index.byRef.keys()]).toEqual([]);
    expect([...index.byNumber.keys()]).toEqual([4501]);
  });
});

/** Use the avatar selected by @ground-control/github; the overlay must not repeat the selection decision. */
describe('swapping the assignee for the pull request author', () => {
  it('finds the assignee figure GitHub draws, and reports none where it draws none', () => {
    expect(assigneeStackOf(cardElement(4501))).not.toBeNull();
    expect(assigneeStackOf(cardElement(4503))).toBeNull();
  });

  /** Bound assignee ancestor lookup to the card so changed GitHub markup cannot hide unrelated board content. */
  it("refuses a figure that is not the card's own", () => {
    const element = cardElement(4501);
    const figure = assigneeStackOf(element)!;
    const stack = figure.querySelector('[data-component="AvatarStack"]')!;

    // GitHub's own figure gone and the stack kept, with a figure still standing above the card.
    figure.replaceWith(stack);

    const outer = document.createElement('figure');

    element.parentElement!.insertBefore(outer, element);
    outer.appendChild(element);

    expect(element.querySelector('[data-component="AvatarStack"]')).not.toBeNull();
    expect(element.closest('figure')).toBe(outer);
    expect(assigneeStackOf(element)).toBeNull();
  });

  it('hides the assignees and draws the author the hub picked', () => {
    paint(document, state({ snapshot: laneOf(actorCard(4501, AUTHOR)) }), NOW, actions);

    const stack = assigneeStackOf(cardElement(4501))!;
    const actor = stack.querySelector<HTMLElement>('.gc-actor')!;

    expect(stack.getAttribute('data-gc-actor')).toBe('colleague');
    expect(actor.querySelector('img')!.getAttribute('src')).toBe(AUTHOR.url);
    expect(tipOf(actor)).toBe('colleague · pull request author');
    expect(actor.getAttribute('aria-label')).toBe('colleague, pull request author');
    // GitHub's own avatar is still in the tree — the swap hides it rather than destroying it, so it comes back.
    expect(stack.querySelector('img[data-testid="github-avatar"]')).not.toBeNull();
  });

  /** The hub applies the avatar policy; the overlay draws whichever person it picked. */
  it('hides the assignees and draws the issue author the hub picked', () => {
    paint(document, state({ snapshot: laneOf(actorCard(4501, REPORTER)) }), NOW, actions);

    const stack = assigneeStackOf(cardElement(4501))!;
    const actor = stack.querySelector<HTMLElement>('.gc-actor')!;

    expect(stack.getAttribute('data-gc-actor')).toBe('reporter');
    expect(stack.getAttribute('role')).toBe('presentation');
    expect(actor.querySelector('img')!.getAttribute('src')).toBe(REPORTER.url);
    expect(tipOf(actor)).toBe('reporter · issue author');
    expect(actor.getAttribute('aria-label')).toBe('reporter, issue author');
  });

  it('redraws the slot when the hub switches from the pull request author to the issue author', () => {
    paint(document, state({ snapshot: laneOf(actorCard(4501, AUTHOR)) }), NOW, actions);
    paint(document, state({ snapshot: laneOf(actorCard(4501, REPORTER)) }), NOW, actions);

    const actors = document.querySelectorAll<HTMLElement>('.gc-actor');

    expect(actors).toHaveLength(1);
    expect(actors[0]!.getAttribute('aria-label')).toBe('reporter, issue author');
    expect(assigneeStackOf(cardElement(4501))!.getAttribute('data-gc-actor')).toBe('reporter');
  });

  /** The caption is the one thing a reader would still hear: it names the assignee the avatar no longer shows. */
  it('takes the whole stack over, its caption included', () => {
    paint(document, state({ snapshot: laneOf(actorCard(4501, AUTHOR)) }), NOW, actions);

    const stack = assigneeStackOf(cardElement(4501))!;

    expect(getComputedStyle(stack.querySelector<HTMLElement>('figcaption')!).display).toBe('none');
    expect(getComputedStyle(stack.querySelector<HTMLElement>('[data-component="AvatarStack"]')!).display).toBe('none');
    expect(getComputedStyle(stack.querySelector<HTMLElement>('.gc-actor')!).display).toBe('grid');
    // And the figure itself, left with no caption, is a boundary with no name — so it is taken out of the reading.
    expect(stack.getAttribute('role')).toBe('presentation');
  });

  /** The browser preference is the developer's; GitHub's own figure, role and caption come back when it is off. */
  it('restores the assignee figure when replacement is turned off, and never replaces while it stays off', () => {
    const presentation = { animations: true, replaceAvatars: false, cardRows: true };

    paint(document, state({ snapshot: laneOf(actorCard(4501, AUTHOR)) }), NOW, actions);
    expect(document.querySelector('.gc-actor')).not.toBeNull();

    paint(document, state({ snapshot: laneOf(actorCard(4501, AUTHOR)) }), NOW, actions, presentation);

    const stack = assigneeStackOf(cardElement(4501))!;

    expect(document.querySelector('.gc-actor')).toBeNull();
    expect(stack.hasAttribute('data-gc-actor')).toBe(false);
    expect(stack.getAttribute('role')).not.toBe('presentation');
    expect(getComputedStyle(stack.querySelector<HTMLElement>('[data-component="AvatarStack"]')!).display).not.toBe('none');

    paint(document, state({ snapshot: laneOf(actorCard(4501, AUTHOR)) }), NOW, actions, presentation);
    expect(document.querySelector('.gc-actor')).toBeNull();
  });

  /** R36: what the overlay put inside GitHub's cards goes; GitHub's own markup and every overlay panel stay. */
  it('takes its rows out of the cards while they are turned off, and restores what it took', () => {
    const shown = state({ snapshot: laneOf(actorCard(4501, AUTHOR)) });

    paint(document, shown, NOW, actions);
    expect(document.querySelector('.gc-badge')).not.toBeNull();

    const off = paint(document, shown, NOW, actions, { animations: true, replaceAvatars: true, cardRows: false });
    const stack = assigneeStackOf(cardElement(4501))!;

    expect(document.querySelector('.gc-badge')).toBeNull();
    expect(document.querySelector('.gc-actor')).toBeNull();
    expect(cardElement(4501).hasAttribute('data-gc-issue')).toBe(false);
    expect(stack.hasAttribute('data-gc-actor')).toBe(false);
    // GitHub's figure carries its own role and its avatars again, which the replacement had taken.
    expect(stack.getAttribute('role')).not.toBe('presentation');
    expect(getComputedStyle(stack.querySelector<HTMLElement>('[data-component="AvatarStack"]')!).display).not.toBe('none');
    expect(off).toEqual({ scanned: 3, badges: 0, menu: true });
  });

  /** The rows are the only thing the choice reaches: the menu, its log, and the collapsed header are separate. */
  it('leaves its own menu, log, and collapsed header standing while the rows are off', () => {
    const shown = state({ snapshot: laneOf(actorCard(4501, AUTHOR)) });

    paint(document, shown, NOW, actions);
    setLogOpen(document, true, actions);
    document.getElementById('gc-collapse')!.click();
    paint(document, shown, NOW, actions);

    const hidden = document.querySelectorAll('[data-gc-hidden]').length;

    expect(hidden).toBeGreaterThan(0);

    paint(document, shown, NOW, actions, { animations: true, replaceAvatars: true, cardRows: false });

    expect(document.getElementById('gc-menu')).not.toBeNull();
    expect(document.getElementById('gc-log')).not.toBeNull();
    expect(document.querySelectorAll('[data-gc-hidden]')).toHaveLength(hidden);
  });

  it('draws the rows again when they are turned back on', () => {
    const shown = state({ snapshot: laneOf(actorCard(4501, AUTHOR)) });

    paint(document, shown, NOW, actions, { animations: true, replaceAvatars: true, cardRows: false });

    expect(paint(document, shown, NOW, actions)).toEqual({ scanned: 3, badges: 1, menu: true });
    expect(document.querySelector('.gc-badge')).not.toBeNull();
  });

  it('marks the page for reduced motion while the preference is off and clears it when it returns', () => {
    paint(document, state(), NOW, actions, { animations: false, replaceAvatars: true, cardRows: true });
    expect(document.documentElement.getAttribute('data-gc-motion')).toBe('reduced');

    paint(document, state(), NOW, actions, { animations: true, replaceAvatars: true, cardRows: true });
    expect(document.documentElement.hasAttribute('data-gc-motion')).toBe(false);
  });

  it("leaves the assignees alone where the hub picked the issue's own assignee", () => {
    paint(document, state({ snapshot: laneOf(actorCard(4501, ASSIGNEE)) }), NOW, actions);

    expect(assigneeStackOf(cardElement(4501))!.hasAttribute('data-gc-actor')).toBe(false);
    expect(document.querySelector('.gc-actor')).toBeNull();
  });

  it('leaves the assignees alone on a card the hub does not know', () => {
    paint(document, state({ snapshot: laneOf(actorCard(4501, AUTHOR)) }), NOW, actions);

    expect(assigneeStackOf(cardElement(4502))!.hasAttribute('data-gc-actor')).toBe(false);
  });

  /** A pull request that closed, or a card that left review: the hub stops naming an author and the board goes back. */
  it('hands the stack back when the author goes away', () => {
    paint(document, state({ snapshot: laneOf(actorCard(4501, AUTHOR)) }), NOW, actions);
    paint(document, state({ snapshot: laneOf(actorCard(4501, ASSIGNEE)) }), NOW, actions);

    expect(assigneeStackOf(cardElement(4501))!.hasAttribute('data-gc-actor')).toBe(false);
    expect(assigneeStackOf(cardElement(4501))!.hasAttribute('role')).toBe(false);
    expect(document.querySelector('.gc-actor')).toBeNull();
  });

  /**
   * Repeated paints must not duplicate the replacement avatar, whether a card is retained or rebuilt
   * (mechanics M27).
   */
  it('draws one author however many times the board is painted', () => {
    paint(document, state({ snapshot: laneOf(actorCard(4501, AUTHOR)) }), NOW, actions);
    paint(document, state({ snapshot: laneOf(actorCard(4501, AUTHOR)) }), NOW, actions);

    expect(document.querySelectorAll('.gc-actor')).toHaveLength(1);
  });

  it('draws no author on a card GitHub gave no assignee stack', () => {
    paint(document, state({ snapshot: laneOf(actorCard(4503, AUTHOR)) }), NOW, actions);

    expect(cardElement(4503).querySelector('.gc-actor')).toBeNull();
    expect(badges()).toHaveLength(1);
  });

  /**
   * Hide failed avatars instead of removing them; removal caused a measured loop of 182 paints in three
   * seconds.
   */
  it('hides an avatar that fails rather than taking it out of the card', () => {
    paint(document, state({ snapshot: laneOf(actorCard(4501, AUTHOR)) }), NOW, actions);

    const slot = document.querySelector<HTMLElement>('.gc-actor')!;
    const image = slot.querySelector('img')!;

    image.dispatchEvent(new Event('error'));

    expect(image.parentElement).toBe(slot);
    expect(image.hidden).toBe(true);
    // The attribute alone is a user-agent rule GitHub's own stylesheet outranks; the overlay's own rule is what holds.
    expect(getComputedStyle(image).display).toBe('none');
    // And the initials behind it are what the developer is left looking at.
    expect(slot.textContent).toBe('CO');
    expect(getComputedStyle(slot).color).not.toBe('rgba(0, 0, 0, 0)');
  });

  /**
   * Keep initials behind cached avatars so repeated scans cannot flash the fallback while awaiting load
   * events.
   */
  it('draws the avatar with no frame of initials before it', () => {
    paint(document, state({ snapshot: laneOf(actorCard(4501, AUTHOR)) }), NOW, actions);

    const slot = document.querySelector<HTMLElement>('.gc-actor')!;

    expect(slot.dataset.avatar).toBeUndefined();
    expect(getComputedStyle(slot).color).toBe('rgba(0, 0, 0, 0)');
  });

  it('gives the stack back when the overlay leaves the board', () => {
    paint(document, state({ snapshot: laneOf(actorCard(4501, AUTHOR)) }), NOW, actions);
    clear(document);

    expect(document.querySelector('.gc-actor')).toBeNull();
    expect(document.querySelector('[data-gc-actor]')).toBeNull();
    expect(document.querySelector('figure[role]')).toBeNull();
  });

  it.each(['clear', 'repaint'])('restores an existing assignee role after %s', (operation) => {
    const figure = assigneeStackOf(document.querySelector('[data-board-card-id]')!)!;
    figure.setAttribute('role', 'group');
    paint(document, state({ snapshot: laneOf(actorCard(4501, AUTHOR)) }), NOW, actions);
    expect(figure.getAttribute('role')).toBe('presentation');
    if (operation === 'clear') clear(document);
    else paint(document, state({ snapshot: snapshot({ lanes: [] }) }), NOW, actions);
    expect(figure.getAttribute('role')).toBe('group');
    expect(document.querySelector('.gc-actor')).toBeNull();
  });
});

/** Verify shared tooltip geometry and timing measured from GitHub (mechanics M35). */
describe('the tooltip', () => {
  const tip = () => document.getElementById('gc-tip');
  const open = () => tip()?.getAttribute('data-open') ?? null;

  function hover(el: Element): void {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  }

  function unhover(el: Element): void {
    el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    paint(document, state({ snapshot: laneOf(actorCard(4501, AUTHOR)) }), NOW, actions);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for the tooltip hover delay', () => {
    const avatar = document.querySelector('.gc-actor')!;

    hover(avatar);

    expect(open()).toBeNull();

    vi.advanceTimersByTime(120);

    expect(open()).toBe('true');
    expect(tip()?.textContent).toBe('colleague · pull request author');
  });

  /** One node for the whole document: a scan replaces every card, and a node per anchor would be built by the hundred. */
  it('reuses one tooltip element', () => {
    const avatar = document.querySelector('.gc-actor')!;
    const lane = document.querySelector('.gc-lane')!;

    hover(avatar);
    vi.advanceTimersByTime(120);
    hover(document.querySelector('.gc-session')!);
    vi.advanceTimersByTime(120);
    hover(lane);
    vi.advanceTimersByTime(120);

    expect(document.querySelectorAll('#gc-tip')).toHaveLength(1);
  });

  /** A child would be part of `textContent`, and every label that reads its own would gain the tooltip's words. */
  it('preserves anchor text', () => {
    const avatar = document.querySelector('.gc-actor')!;
    const lane = document.querySelector('.gc-lane')!;

    hover(avatar);
    vi.advanceTimersByTime(120);

    expect(avatar.textContent).toBe('CO');
    expect(lane.querySelector<HTMLElement>('.gc-lane-mark')!.dataset.lane).toBe('build');
  });

  it('closes when the pointer leaves, and on Escape', () => {
    const avatar = document.querySelector('.gc-actor')!;

    hover(avatar);
    vi.advanceTimersByTime(120);
    unhover(avatar);

    expect(open()).toBeNull();

    hover(avatar);
    vi.advanceTimersByTime(120);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(open()).toBeNull();
  });

  /** Placed once in viewport coordinates, so a column scrolling under it would otherwise leave it behind. */
  it('closes when the board scrolls under it', () => {
    hover(document.querySelector('.gc-actor')!);
    vi.advanceTimersByTime(120);
    document.querySelector('[data-board-column]')!.dispatchEvent(new Event('scroll', { bubbles: true }));

    expect(open()).toBeNull();
  });

  it('never opens for a pointer that left before it was due', () => {
    const avatar = document.querySelector('.gc-actor')!;

    hover(avatar);
    vi.advanceTimersByTime(60);
    unhover(avatar);
    vi.advanceTimersByTime(600);

    expect(open()).toBeNull();
  });

  /**
   * Set accessible descriptions before focus; adding them after the tooltip delay misses the focus
   * announcement.
   */
  it('sets accessible descriptions before hover', () => {
    const row = document.querySelector('.gc-session')!;

    // Name the session action; put observed activity on the state description without repeating the visible
    // label.
    expect(row.getAttribute('aria-label')).toContain('open this session in VS Code');
    expect(row.hasAttribute('aria-description')).toBe(false);
    // The mark is named rather than described, so the described half of the row is the duration beside it.
    expect(row.querySelector('.gc-state')!.getAttribute('aria-description')).toContain('Time since the phase was reported');
    expect(row.querySelector('.gc-dot')!.hasAttribute('aria-description')).toBe(false);
    // And nothing is wired up as the tooltip opens: GitHub's own cards carry `aria-describedby`, the overlay's do not.
    expect(document.querySelector(`[data-gc-tip][aria-describedby]`)).toBeNull();
  });

  /** A reader says the name, then the description. The same words in both is the board saying it twice. */
  /**
   * A reader says the name, then the description. The same words in both is the board saying it twice, so an
   * element carries a description only where it says something the name does not: a glyph control names the
   * action and describes what pressing it costs (R45).
   */
  it('never repeats a name in a description', () => {
    const both = [...document.querySelectorAll('[aria-description]')].filter((el) => el.hasAttribute('aria-label'));

    expect(both.every((el) => el.getAttribute('aria-description') !== el.getAttribute('aria-label'))).toBe(true);
    expect(both.every((el) => el.classList.contains('gc-tool'))).toBe(true);
    // The avatar is the one that would repeat itself: named for a reader, and its tooltip says the same thing.
    expect(document.querySelector('.gc-actor')!.getAttribute('aria-label')).toBe('colleague, pull request author');
    expect(document.querySelector('.gc-actor')!.hasAttribute('aria-description')).toBe(false);
  });

  it('opens tooltips on keyboard focus', () => {
    document.querySelector('.gc-actor')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    vi.advanceTimersByTime(120);

    expect(open()).toBe('true');
    expect(tip()?.textContent).toContain('pull request author');
  });

  /** Keep tooltips open when moving between children of their anchor. */
  it('keeps tooltips open across anchor children', () => {
    // The reading is the mark that carries a tooltip and holds children of its own: an age, and the words before it.
    paint(
      document,
      state({
        snapshot: laneOf({
          ...actorCard(4501, AUTHOR),
          issue: { ...actorCard(4501, AUTHOR).issue!, statusChangedAt: new Date(NOW - 86_400_000).toISOString() },
          triage: { state: 'done', action: 'develop', qualifier: null, detail: 'Pick it up.', at: NOW, stale: false },
        }),
      }),
      NOW,
      actions,
    );

    const mark = document.querySelector('.gc-lane')!;

    hover(mark);
    vi.advanceTimersByTime(120);

    mark
      .querySelector('.gc-lane-mark')!
      .dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: mark }));

    expect(open()).toBe('true');
  });

  /** Ignore anchors removed during the delay; their zero-sized bounds would place the tooltip in a corner. */
  it('ignores removed tooltip anchors', () => {
    const avatar = document.querySelector('.gc-actor')!;

    hover(avatar);
    avatar.remove();
    vi.advanceTimersByTime(120);

    expect(open()).toBeNull();
  });

  /** And one already open when the scan lands is closed by it, rather than left over a node that is gone. */
  it('closes one left over a card the scan replaced', () => {
    hover(document.querySelector('.gc-actor')!);
    vi.advanceTimersByTime(120);

    expect(open()).toBe('true');

    // A card the scan draws differently, or the footer and the figure with it are kept and the anchor never goes.
    paint(document, state({ snapshot: laneOf({ ...actorCard(4501, AUTHOR), lane: 'review' }) }), NOW, actions);

    expect(open()).toBeNull();
  });

  /** The other half: an anchor a scan did not touch keeps what it is saying, rather than blinking once a scan. */
  it('leaves one open over an anchor the scan kept', () => {
    hover(document.querySelector('.gc-actor')!);
    vi.advanceTimersByTime(120);

    const anchor = document.querySelector('.gc-actor');

    paint(document, state({ snapshot: laneOf(actorCard(4501, AUTHOR)) }), NOW, actions);

    expect(document.querySelector('.gc-actor')).toBe(anchor);
    expect(open()).toBe('true');
  });

  /** Opening one is the board's own DOM change, and the scan's observer watches for exactly those (`mechanics.md` M27). */
  it('adds and removes no nodes when it opens', () => {
    const seen: MutationRecord[] = [];
    const observer = new MutationObserver((records) => seen.push(...records));

    observer.observe(document.documentElement, { childList: true, subtree: true });
    hover(document.querySelector('.gc-actor')!);
    vi.advanceTimersByTime(120);
    hover(document.querySelector('.gc-state')!);
    vi.advanceTimersByTime(120);

    const records = observer.takeRecords();

    observer.disconnect();

    expect(open()).toBe('true');
    expect([...seen, ...records]).toEqual([]);
  });

  /** Supply rectangles explicitly and verify tooltip centering, flipping, and viewport bounds. */
  describe('where it is drawn', () => {
    function placedAt(anchorBox: Partial<DOMRect>, tipBox: Partial<DOMRect>): { top: string; left: string } {
      const el = document.querySelector<HTMLElement>('.gc-actor')!;
      const box = (over: Partial<DOMRect>) => () =>
        ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, ...over }) as DOMRect;

      el.getBoundingClientRect = box(anchorBox);
      tip()!.getBoundingClientRect = box(tipBox);

      // Closed first, or a second placement on the same anchor is the re-entrancy guard returning early.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      hover(el);
      vi.advanceTimersByTime(120);

      return { top: tip()!.style.top, left: tip()!.style.left };
    }

    // jsdom's window is 1024 x 768.
    const TALL = { width: 120, height: 28 };

    it('sits centred, one gap above the anchor', () => {
      expect(placedAt({ top: 300, bottom: 320, left: 500, right: 520, width: 20, height: 20 }, TALL)).toEqual({
        top: '268px',
        left: '450px',
      });
    });

    it('flips below an anchor with nothing above it', () => {
      expect(placedAt({ top: 2, bottom: 22, left: 500, right: 520, width: 20, height: 20 }, TALL)).toEqual({
        top: '26px',
        left: '450px',
      });
    });

    /** The flip is not a rescue on its own: below the fold is as unreadable as above it. */
    it('is held inside the window when neither side has room', () => {
      expect(
        placedAt({ top: 10, bottom: 710, left: 500, right: 520, width: 20, height: 700 }, { width: 120, height: 100 }),
      ).toEqual({ top: '660px', left: '450px' });
    });

    it('is pulled back from the edge it would run off', () => {
      expect(placedAt({ top: 300, bottom: 320, left: 1010, right: 1024, width: 14, height: 20 }, TALL).left).toBe(
        '896px',
      );
      expect(placedAt({ top: 300, bottom: 320, left: 0, right: 14, width: 14, height: 20 }, TALL).left).toBe('8px');
    });
  });

  it('takes itself off the page when the overlay leaves the board', () => {
    hover(document.querySelector('.gc-actor')!);
    vi.advanceTimersByTime(120);
    clear(document);

    expect(tip()).toBeNull();
  });

  /**
   * Assert rendering adds no native title attributes or SVG title nodes, while preserving those in GitHub
   * markup.
   */
  it('adds no native tooltip anywhere on the page', () => {
    const native = () => document.querySelectorAll('[title], title').length;

    clear(document);

    const before = native();

    paint(document, state({ snapshot: laneOf(actorCard(4501, AUTHOR)) }), NOW, actions);

    expect(native()).toBe(before);
    // And it drew something, so the count above is not holding for a board that painted nothing.
    expect(document.querySelectorAll('[data-gc-tip]').length).toBeGreaterThan(0);
  });
});

describe('painting the board', () => {
  it('badges the cards the snapshot knows and leaves the rest alone', () => {
    const drew = paint(document, state(), NOW, actions);

    expect(drew).toMatchObject({ scanned: 3, badges: 1, menu: true });
    expect(badges()).toHaveLength(1);
    expect(badges()[0]!.closest('[data-gc-issue]')?.getAttribute('data-gc-issue')).toBe(`${REPO}#4501`);
  });

  /**
   * Match repository and issue number so equal numbers from different repositories cannot select the wrong
   * card.
   */
  it('does not badge another repository issue of the same number', () => {
    const elsewhere = snapshot({
      lanes: [{ id: 'build', title: 'Build', cards: [card(4501, {}, 'other-org/other-repo')] }],
    });

    expect(paint(document, state({ snapshot: elsewhere }), NOW, actions)).toMatchObject({ scanned: 3, badges: 0 });
  });

  it('falls back to the number where the hub knows no repository', () => {
    const unknown = snapshot({ lanes: [{ id: 'build', title: 'Build', cards: [card(4502, { issue: null })] }] });

    paint(document, state({ snapshot: unknown }), NOW, actions);

    expect(badges()).toHaveLength(1);
    expect(badges()[0]!.closest('[data-gc-issue]')?.getAttribute('data-gc-issue')).toBe(`${REPO}#4502`);
  });

  it('marks every card it scanned with its issue, badge or no badge', () => {
    paint(document, state(), NOW, actions);

    expect([...document.querySelectorAll('[data-gc-issue]')].map((el) => el.getAttribute('data-gc-issue'))).toEqual([
      `${REPO}#4501`,
      `${REPO}#4502`,
      `${REPO}#4503`,
    ]);
  });

  /** A draft item has no issue, so it can never match a card. Marking it would leave a mark that never clears. */
  it('marks no issue on a card that links to none', () => {
    document.querySelector('[data-board-card-id] a[href*="/issues/"]')!.remove();

    const drew = paint(document, state(), NOW, actions);

    expect(drew).toMatchObject({ scanned: 3, badges: 0 });
    expect([...document.querySelectorAll('[data-gc-issue]')].map((el) => el.getAttribute('data-gc-issue'))).toEqual([
      `${REPO}#4502`,
      `${REPO}#4503`,
    ]);
  });

  it('says the phase it is in', () => {
    paint(document, state(), NOW, actions);

    expect(badges()[0]!.querySelector<HTMLElement>('.gc-session')!.dataset.phase).toBe('waiting');
  });

  it('falls back to the CLI’s own word for a session no signal has reported on', () => {
    const only = snapshot({
      lanes: [
        {
          id: 'build',
          title: 'Build',
          cards: [card(4501, { sessions: [session({ activity: null, details: { state: 'editing tests' } })] })],
        },
      ],
    });

    paint(document, state({ snapshot: only }), NOW, actions);

    const chip = badges()[0]!.querySelector<HTMLElement>('.gc-session')!;

    expect(chip.querySelector('.gc-state')!.textContent).toBe('editing tests');
    expect(chip.dataset.phase).toBe('none');
  });

  /** One state per session and never two (R24): the board's own observation, then the CLI's word, then nothing. */
  it('reads a session’s status where it reports no state, and claims nothing where it reports neither', () => {
    const rows: [Record<string, string>, string | null][] = [
      [{ status: 'working' }, 'working'],
      [{ state: 'editing tests', status: 'working' }, 'editing tests'],
      [{}, null],
    ];

    for (const [details, expected] of rows) {
      const only = snapshot({
        lanes: [{ id: 'build', title: 'Build', cards: [card(4501, { sessions: [session({ activity: null, details })] })] }],
      });

      paint(document, state({ snapshot: only }), NOW, actions);

      expect(badges()[0]!.querySelector('.gc-session .gc-state')?.textContent ?? null).toBe(expected);
    }
  });

  /**
   * A view switch replaces card nodes and removes their footers (mechanics M27). Rebuild replacements without
   * duplicating footers on surviving nodes.
   */
  it('leaves one badge per card however many times it paints', () => {
    paint(document, state(), NOW, actions);
    paint(document, state(), NOW, actions);
    paint(document, state(), NOW, actions);

    expect(badges()).toHaveLength(1);
    expect(document.querySelectorAll('#gc-menu')).toHaveLength(1);
    expect(document.querySelectorAll('#gc-style')).toHaveLength(1);
  });

  it('takes a badge away when the snapshot stops naming the issue', () => {
    paint(document, state(), NOW, actions);

    expect(badges()).toHaveLength(1);

    paint(document, state({ snapshot: snapshot({ lanes: [] }) }), NOW, actions);

    expect(badges()).toHaveLength(0);
  });

  it('paints nothing where the page is not a board', () => {
    document.documentElement.innerHTML = '<body><p>Not a project board</p></body>';

    expect(paint(document, state(), NOW, actions)).toEqual({ scanned: 0, badges: 0, menu: false });
  });

  /** Navigating off a board is something the overlay handles: the content script is injected across github.com. */
  it('takes everything it drew back off the page', () => {
    paint(document, state(), NOW, actions);
    clear(document);

    expect(badges()).toHaveLength(0);
    expect(document.getElementById('gc-menu')).toBeNull();
    expect(document.getElementById('gc-toasts')).toBeNull();
    expect(document.getElementById('gc-style')).toBeNull();
    expect(document.querySelectorAll('[data-gc-issue]')).toHaveLength(0);
  });
});

describe('the footer on a card', () => {
  function box(): Element {
    return document.querySelector(`[data-gc-issue="${REPO}#4501"]`)!.firstElementChild!;
  }

  /** Insert the footer inside the bordered card box, not the outer drag handle (mechanics M27). */
  it('goes inside the card\u2019s own box, as its last line', () => {
    paint(document, state(), NOW, actions);

    expect(badges()[0]!.parentElement).toBe(box());
    expect(box().lastElementChild).toBe(badges()[0]);
  });

  it('names the lane the board has the card in, as a pictogram the chip states in words', () => {
    const only = snapshot({ lanes: [{ id: 'review', title: 'Review', cards: [card(4501, { lane: 'review' })] }] });

    paint(document, state({ snapshot: only }), NOW, actions);

    const lane = badges()[0]!.querySelector<HTMLElement>('.gc-lane')!;

    expect(lane.getAttribute('aria-label')).toBe('Lane: Review');
    expect(tipOf(lane)).toBe('Review — change lane');
    expect(lane.querySelector<HTMLElement>('.gc-lane-mark')!.dataset.lane).toBe('review');
  });

  /** Put each session on a separate line to prevent inline chips from clipping names. */
  it('gives each session a line of its own, the width of the card', () => {
    const two = snapshot({
      lanes: [
        { id: 'build', title: 'Build', cards: [card(4501, { sessions: [session(), session({ sessionId: OTHER_ID })] })] },
      ],
    });

    paint(document, state({ snapshot: two }), NOW, actions);

    const badge = badges()[0]!;

    expect(badge.querySelector('.gc-lane')!.parentElement!.className).toBe('gc-cmdbar');
    expect([...badge.children].map((el) => el.className)).toEqual(['gc-cmdbar', 'gc-sessions']);
    expect([...badge.querySelector('.gc-sessions')!.children].map((el) => el.className)).toEqual([
      'gc-session',
      'gc-session',
    ]);
  });

  /** The band under the bar carries the footer tint, so a card with no session must not draw an empty one. */
  it('leaves the session block empty on a card nobody has worked on, for the stylesheet to drop', () => {
    paint(document, state({ snapshot: snapshot({ lanes: [{ id: 'build', title: 'Build', cards: [card(4501, { sessions: [] })] }] }) }), NOW, actions);

    expect(badges()[0]!.querySelector('.gc-sessions')!.childElementCount).toBe(0);
  });

  it('marks a Claude session with Claude’s own mark, names it, and marks the phase ahead of it', () => {
    paint(document, state(), NOW, actions);

    const chip = badges()[0]!.querySelector<HTMLElement>('.gc-session')!;

    expect(chip.querySelector('svg.gc-agent-icon')).not.toBeNull();
    expect(chip.querySelector('.gc-name')!.textContent).toBe('Working on it');
    // The phase is the mark at the head of the row, so the words beside the name are the duration and nothing else.
    expect(chip.querySelector('.gc-state')!.textContent).toBe('2m');
    expect(chip.firstElementChild!.className).toBe('gc-dot');
    // Put activity details on the state tooltip; the row label already identifies the session.
    expect(tipOf(chip)).toBe('');
    expect(chip.getAttribute('aria-label')).toBe('Working on it, Claude, waiting for input, live — open this session in VS Code.');
    // The phase is the mark's; the duration says only what it counts, or the row would say the same thing twice.
    expect(tipOf(chip.querySelector('.gc-dot'))).toBe('Waiting for your input.');
    expect(tipOf(chip.querySelector('.gc-state'))).toBe(
      'Time since the phase was reported. Last event: PermissionRequest.',
    );
    // 13, matching the mark the editor board draws at 13.6px - the two boards are read side by side.
    expect(chip.querySelector('svg.gc-agent-icon')!.getAttribute('width')).toBe('13');
  });

  /** Expose phase and liveness through the dot accessible name as well as color and fill. */
  it.each([
    ['running', false, 'var(--fgColor-success, #1a7f37)', 'running, live'],
    ['waiting', false, 'var(--fgColor-attention, #9a6700)', 'waiting for input, live'],
    ['idle', false, '', 'idle, live'],
    ['idle', true, '', 'idle, ended'],
  ] as const)('marks a %s session, finished %s, in its own colour and fill', (phase, finished, colour, named) => {
    paint(
      document,
      state({
        snapshot: snapshot({
          lanes: [
            {
              id: 'build',
              title: 'Build',
              cards: [
                card(4501, {
                  sessions: [
                    session({ activity: { phase, since: NOW - 120_000, at: NOW - 120_000, event: 'Stop' }, finished }),
                  ],
                }),
              ],
            },
          ],
        }),
      }),
      NOW,
      actions,
    );

    const dot = document.querySelector<HTMLElement>('.gc-dot')!;

    expect(dot.dataset.phase).toBe(phase);
    expect(dot.dataset.live).toBe(String(!finished));
    expect(dot.getAttribute('aria-label')).toBe(named);
    expect(dot.getAttribute('role')).toBe('img');

    // The dot's own name is never read on a reachable row: an aria-label there replaces everything inside
    // it, so the row states the same words itself (R2).
    expect(document.querySelector('.gc-session')!.getAttribute('aria-label')).toBe(
      `Working on it, Claude, ${named} — open this session in VS Code.`,
    );
  });

  /**
   * A row name replaces everything inside it, including the word the agent reported, so the name has to
   * follow the same precedence the row renders (R24).
   */
  it.each([
    [{ activity: null, details: { state: 'editing tests' } }, 'editing tests, live'],
    [{ details: { state: 'editing tests' } }, 'waiting for input, live'],
    [{ activity: null }, 'no state reported, live'],
  ] as const)('states what the row shows, not the phase alone', (over, said) => {
    paint(document, state({ snapshot: laneOf(card(4501, { sessions: [session(over)] })) }), NOW, actions);

    expect(document.querySelector('.gc-session')!.getAttribute('aria-label')).toBe(
      `Working on it, Claude, ${said} — open this session in VS Code.`,
    );
  });

  /** Describe phase and liveness in dot tooltips, with matching literal expectations in both clients. */
  it.each([
    ['running', false, 'Turn in progress.'],
    ['waiting', false, 'Waiting for your input.'],
    ['idle', false, 'Last reported state: turn complete.'],
    ['idle', true, 'Last reported state: turn complete. The session has since ended.'],
  ] as const)('says what the mark means for a %s session, finished %s', (phase, finished, said) => {
    paint(
      document,
      state({
        snapshot: laneOf(
          card(4501, { sessions: [session({ activity: { phase, since: NOW - 120_000, at: NOW - 120_000, event: 'Stop' }, finished })] }),
        ),
      }),
      NOW,
      actions,
    );

    expect(tipOf(document.querySelector('.gc-dot'))).toBe(said);
  });

  /** A failed turn outranks the other marks on the card; the row says which error, in the agent's own words (R6). */
  it('marks the card red when a turn ended on an error, and says the error on the mark', () => {
    const waiting = session({ sessionId: 's-1', activity: { phase: 'waiting', since: NOW - 1_000, at: NOW - 1_000, event: 'PermissionRequest' } });
    const failed = session({
      sessionId: 's-2',
      activity: {
        phase: 'failed',
        since: NOW - 2_000,
        at: NOW - 2_000,
        event: 'StopFailure',
        error: { kind: 'rate_limit', message: "You've hit your session limit · resets 12:10pm (America/New_York)" },
      },
    });

    paint(document, state({ snapshot: laneOf(card(4501, { sessions: [waiting, failed], attention: 'failed' })) }), NOW, actions);

    // Rows keep snapshot order, so the failed session is the second row.
    const row = document.querySelectorAll<HTMLElement>('.gc-session')[1]!;

    expect(document.querySelector(`[data-gc-issue="${REPO}#4501"]`)!.getAttribute('data-gc-attention')).toBe('failed');
    expect(row.dataset.phase).toBe('failed');
    expect(row.querySelector('.gc-dot')?.getAttribute('data-phase')).toBe('failed');
    expect(row.querySelector('.gc-dot')?.getAttribute('aria-label')).toBe('failed, live');
    expect(tipOf(row.querySelector('.gc-dot'))).toBe(
      "The turn ended on an error: rate limit. You've hit your session limit · resets 12:10pm (America/New_York)",
    );
  });

  it('says the error is unclassified when the agent gave no kind, and that the session ended when it has', () => {
    const bare = session({ activity: { phase: 'failed', since: NOW - 2_000, at: NOW - 2_000, event: 'StopFailure' }, finished: true });

    paint(document, state({ snapshot: laneOf(card(4501, { sessions: [bare] })) }), NOW, actions);

    expect(tipOf(document.querySelector('.gc-dot'))).toBe('The turn ended on an error: unknown. The session has since ended.');
  });

  it('says the mark means nothing has reported, where nothing has', () => {
    paint(document, state({ snapshot: laneOf(card(4501, { sessions: [session({ activity: null })] })) }), NOW, actions);

    expect(tipOf(document.querySelector('.gc-dot'))).toBe('No activity reported.');
  });

  it("marks a Codex session with OpenAI's own icon rather than the word — R2", () => {
    const codex = snapshot({
      lanes: [{ id: 'build', title: 'Build', cards: [card(4501, { sessions: [session({ agent: 'codex' })] })] }],
    });

    paint(document, state({ snapshot: codex }), NOW, actions);

    const chip = badges()[0]!.querySelector('.gc-session')!;

    expect(chip.querySelector('svg')).not.toBeNull();
    expect(chip.querySelector('.gc-agent')).toBeNull();
    expect(agentIcon(document, 'codex')?.getAttribute('data-agent')).toBe('codex');
    // Unreachable, so the row has no name of its own and the mark's is the one read (R2).
    expect(chip.hasAttribute('aria-label')).toBe(false);
    expect(chip.querySelector('svg')!.getAttribute('aria-label')).toBe('codex');
  });

  /** Key logo fill by agent so the monochrome OpenAI logo does not inherit Claude brand orange. */
  it('keys each mark by its agent, and draws no fill of its own', () => {
    for (const agent of ['claude', 'codex']) {
      const icon = agentIcon(document, agent)!;

      expect(icon.getAttribute('data-agent')).toBe(agent);
      expect(icon.getAttribute('fill')).toBeNull();
    }
  });

  /** One mark per agent that has one. A third CLI showing either of theirs would be worse than showing none. */
  it('names an agent it has no mark for, rather than leaving the chip unattributed — R2', () => {
    const gemini = snapshot({
      lanes: [{ id: 'build', title: 'Build', cards: [card(4501, { sessions: [session({ agent: 'gemini' })] })] }],
    });

    paint(document, state({ snapshot: gemini }), NOW, actions);

    const chip = badges()[0]!.querySelector('.gc-session')!;

    expect(chip.querySelector('svg')).toBeNull();
    expect(chip.querySelector('.gc-agent')!.textContent).toBe('gemini');
    expect(agentIcon(document, 'gemini')).toBeNull();
    // No mark to name, so the written agent name is what the unnamed row reads (R2).
    expect(chip.hasAttribute('aria-label')).toBe(false);
  });

  /**
   * A row with an `aria-label` replaces everything inside it, so an openable row states the agent itself. The
   * mark keeps its own name for the rows that have none (R2).
   */
  it('names the agent on the row and on the mark, because only one of them is ever read', () => {
    paint(document, state(), NOW, actions);

    const chip = badges()[0]!.querySelector('.gc-session')!;
    const mark = chip.querySelector('svg.gc-agent-icon')!;

    expect(mark.getAttribute('role')).toBe('img');
    expect(mark.getAttribute('aria-label')).toBe('claude');
    expect(chip.getAttribute('aria-label')).toBe('Working on it, Claude, waiting for input, live — open this session in VS Code.');
  });
});

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
  done: [
    ['circle', { cx: '8', cy: '8', r: '6' }],
    ['path', { d: 'M5.2 8.2 7.2 10.4 10.9 5.9', 'stroke-width': '1.7' }],
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

it('titles every lane the way the editor board titles it', () => {
  expect(LANE_TITLES).toEqual(LANE_NAMES);
});

/** The pictogram is the lane on this client, so its geometry is product wording rather than decoration. */
it('draws every lane the way the editor board draws it', () => {
  expect(LANE_SHAPES).toEqual(LANE_MARKS);
});

it('puts each lane pictogram on the card the board has in that lane', () => {
  // The recorded page carries three cards, so three lanes are what a paint can put a pictogram on.
  const shown = ['unstarted', 'review', 'icebox'] as const;
  const board = snapshot({
    lanes: shown.map((id, at) => ({ id, title: LANE_TITLES[id]!, cards: [card(4501 + at, { lane: id, sessions: [] })] })),
  });

  paint(document, state({ snapshot: board }), NOW, actions);

  const drawn = [...document.querySelectorAll<HTMLElement>('.gc-lane-mark')];

  expect(drawn.map((el) => el.dataset.lane)).toEqual([...shown]);
  expect(drawnMark(drawn[1]!)).toEqual(LANE_MARKS['review']);
});

describe('the menu in the board’s own filter bar', () => {
  function open(over: { openOptions?: () => void } = {}): void {
    document.querySelector<HTMLElement>('#gc-menu button')!.click();
    paint(document, state(), NOW, { ...actions, ...over });
  }

  function items(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>('#gc-menu .gc-popover button[role]')];
  }

  function panelText(): string {
    return document.querySelector('#gc-menu .gc-popover')?.textContent ?? '';
  }

  /** GitHub's own buttons are the only source of the classes that make one look like GitHub's: they are hashed. */
  it('sits after the View button, wearing its classes', () => {
    paint(document, state(), NOW, actions);

    const bar = document.querySelector('[role="region"][aria-label="View filters"]')!;
    const button = document.querySelector<HTMLElement>('#gc-menu button')!;

    expect(bar.lastElementChild?.id).toBe('gc-menu');
    expect(button.textContent).toBe('Ground Control');
    expect(button.className).toBe(bar.querySelector('button[data-component="Button"]')!.className);
    expect(button.className).not.toBe('');
  });

  /** Losing the age of the reading and the refresh without a word is what R25 rules out, bar or no bar. */
  it('hangs itself above the columns when the filter bar is not there', () => {
    document.querySelector('[role="region"][aria-label="View filters"]')!.remove();

    expect(paint(document, state(), NOW, actions)).toMatchObject({ menu: true });
    expect(document.getElementById('gc-perch')?.contains(document.getElementById('gc-menu'))).toBe(true);
    expect(document.getElementById('gc-perch')!.nextElementSibling?.id).toBe('project-items-region');
  });

  it('says nothing until it is opened', () => {
    paint(document, state(), NOW, actions);

    expect(document.querySelectorAll('.gc-popover')).toHaveLength(0);
    expect(document.querySelector('#gc-menu button')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('states how old the reading is', () => {
    paint(document, state(), NOW, actions);
    open();

    expect(panelText()).toContain('Board updated 1m ago');
    expect(document.querySelector<HTMLElement>('#gc-menu button')!.dataset.stale).toBe('false');
  });

  it('states the hook notice once, in the menu rather than on every card', () => {
    const installed = snapshot({ hooks: { notice: '2 sessions are not reporting yet.' } });

    paint(document, state({ snapshot: installed }), NOW, actions);
    document.querySelector<HTMLElement>('#gc-menu button')!.click();
    paint(document, state({ snapshot: installed }), NOW, actions);

    expect(panelText()).toContain('2 sessions are not reporting yet.');
  });

  it('says so before the first snapshot has arrived', () => {
    paint(document, state({ snapshot: null }), NOW, actions);
    document.querySelector<HTMLElement>('#gc-menu button')!.click();
    paint(document, state({ snapshot: null }), NOW, actions);

    expect(panelText()).toContain('No session or issue data received yet');
    expect(badges()).toHaveLength(0);
  });

  /** The button carries the one thing worth seeing without opening it: that what is on the board may be old. */
  it('marks itself when the reading is stale', () => {
    paint(document, state({ trouble: 'Disconnected from Ground Control.' }), NOW, actions);

    expect(document.querySelector<HTMLElement>('#gc-menu button')!.dataset.stale).toBe('true');
  });

  /**
   * Log, refresh and settings in the editor board's order, behind the overlay-only row control R36 settles.
   * The button already names the overlay, so the panel opens on its snapshot age rather than a heading.
   */
  it('lists the shared choices in the order the editor board lists them, behind its own', () => {
    paint(document, state(), NOW, actions);
    open({ openOptions: vi.fn() });

    expect(items().map((entry) => entry.textContent)).toEqual(['✓Enable overlay', 'Show log', 'Refresh', 'Settings']);
    expect(document.querySelector('#gc-menu .gc-popover')?.firstElementChild?.className).toBe('gc-note');
  });

  /** A page with no options to open still lists the rest, and Settings is the item that goes. */
  it('drops Settings alone when the client cannot open options', () => {
    paint(document, state(), NOW, actions);
    open();

    expect(items().map((entry) => entry.textContent)).toEqual(['✓Enable overlay', 'Show log', 'Refresh']);
  });

  /** One name, marked while it holds. The mark is decorative, so `aria-checked` is what carries the state. */
  it('keeps its name and moves only its mark as the rows go off and on', () => {
    paint(document, state(), NOW, actions);
    open();

    const shown = items()[0]!;

    expect(shown.textContent).toBe('✓Enable overlay');
    expect(shown.getAttribute('role')).toBe('menuitemcheckbox');
    expect(shown.getAttribute('aria-checked')).toBe('true');
    shown.click();
    expect(actions.showCardRows).toHaveBeenCalledWith(false);

    paint(document, state(), NOW, actions, { animations: true, replaceAvatars: true, cardRows: false });

    const hidden = items()[0]!;

    expect(hidden.textContent).toBe('Enable overlay');
    expect(hidden.getAttribute('aria-checked')).toBe('false');
    hidden.click();
    expect(actions.showCardRows).toHaveBeenLastCalledWith(true);
  });

  /** The log item is checked the same way. Opening the log shuts the panel, so its mark is read on reopening. */
  it('marks the log item while the log is open', () => {
    paint(document, state(), NOW, actions);
    open();

    const log = items()[1]!;

    expect(log.textContent).toBe('Show log');
    expect(log.getAttribute('aria-checked')).toBe('false');
    log.click();
    open();

    const opened = items()[1]!;

    expect(opened.textContent).toBe('✓Show log');
    expect(opened.getAttribute('aria-checked')).toBe('true');
  });

  /** Its own lane menu and the editor's name their panels; a panel with no heading needs the name spoken. */
  it('names the panel for assistive technology, which no longer reads a heading', () => {
    paint(document, state(), NOW, actions);
    open();

    const panel = document.querySelector('#gc-menu .gc-popover')!;

    expect(panel.getAttribute('role')).toBe('menu');
    expect(panel.getAttribute('aria-label')).toBe('Ground Control');
  });

  it('asks the hub to read again, and closes', () => {
    paint(document, state(), NOW, actions);
    open();

    items().find((entry) => entry.textContent === 'Refresh')!.click();
    paint(document, state(), NOW, actions);

    expect(actions.refresh).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('.gc-popover')).toHaveLength(0);
  });

  it('closes when the next click lands anywhere else', () => {
    paint(document, state(), NOW, actions);
    open();

    expect(document.querySelectorAll('.gc-popover')).toHaveLength(1);

    document.body.click();
    paint(document, state(), NOW, actions);

    expect(document.querySelectorAll('.gc-popover')).toHaveLength(0);
  });
});

describe('the gap between the lanes', () => {
  /** Override GitHub column margins with !important and stable attributes; its classes are hashed per build. */
  it('finds every column by the attribute rather than the hashed class it wears', () => {
    paint(document, state(), NOW, actions);

    const columns = [...document.querySelectorAll<HTMLElement>('[data-board-column]')];

    expect(columns).toHaveLength(2);

    for (const column of columns) {
      expect(column.className).toMatch(/column-frame-module__Box__\w+/);
    }
  });

});

describe('folding the project header away', () => {
  function collapse(): void {
    document.querySelector<HTMLElement>('#gc-collapse')!.click();
    paint(document, state(), NOW, actions);
  }

  /** What is folded, named by something a reader recognises rather than by the hashed class it wears. */
  function hidden(): string[] {
    return [...document.querySelectorAll('[data-gc-hidden]')].map(
      (row) => row.getAttribute('aria-label') ?? (row.querySelector('[role="tablist"]') ? 'view tabs' : (row.textContent ?? '').trim()),
    );
  }

  /** Both wrappers are hashed per build, so what is found is the row rather than the attribute that located it. */
  it('finds the title bar and the whole tab row, not the tab list inside it', () => {
    const rows = foldedRows(document);

    expect(rows).toHaveLength(3);
    expect(rows[0]!.getAttribute('aria-label')).toBe('Project');
    expect(rows[1]!.contains(document.querySelector('nav[aria-label="Select view"]'))).toBe(true);
    expect(rows[1]!.querySelector('[role="tablist"]')).not.toBe(rows[1]);
    expect(rows[1]!.parentElement?.id).toBe('memex-project-view-root');
    expect(rows[2]!.textContent).toBe('Discard');
  });

  it('sits to the right of the Ground Control button, and hides nothing until it is clicked', () => {
    paint(document, state(), NOW, actions);

    const holder = document.getElementById('gc-menu')!;

    expect(holder.children[0]!.textContent).toBe('Ground Control');
    expect(holder.children[1]!.id).toBe('gc-collapse');
    expect(holder.children[1]!.getAttribute('aria-pressed')).toBe('false');
    expect(hidden()).toEqual([]);
  });

  it('folds both rows away when it is clicked, and puts them back on the next', () => {
    paint(document, state(), NOW, actions);
    collapse();

    expect(hidden()).toEqual(['Project', 'view tabs', 'Discard']);
    expect(document.querySelector('#gc-collapse')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('#gc-collapse')?.getAttribute('aria-label')).toBe('Show the project header');

    collapse();

    expect(hidden()).toEqual([]);
    expect(document.querySelector('#gc-collapse')?.getAttribute('aria-pressed')).toBe('false');
  });

  /**
   * The anonymous fixture has Discard; Save requires write access. Either label must locate the collapse
   * container.
   */
  it('folds the actions away when the filter is unsaved and only Save is showing', () => {
    const discard = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Discard')!;

    discard.textContent = 'Save';
    paint(document, state(), NOW, actions);
    collapse();

    expect(hidden()).toEqual(['Project', 'view tabs', 'Save']);
  });

  it('leaves the bar alone when the filter has nothing to save', () => {
    document.querySelector('.filter-input-actions-module__Box__oDpBc')!.remove();
    paint(document, state(), NOW, actions);
    collapse();

    expect(hidden()).toEqual(['Project', 'view tabs']);
    expect(document.querySelector('#gc-menu')?.closest('[data-gc-hidden]')).toBeNull();
  });

  /** The point of storing it: a reload is a fresh module and a fresh page, and the board comes back as it was left. */
  it('is still folded after the tab is reloaded', () => {
    paint(document, state(), NOW, actions);
    collapse();

    document.documentElement.innerHTML = BOARD;
    clear(document);
    paint(document, state(), NOW, actions);

    expect(hidden()).toEqual(['Project', 'view tabs', 'Discard']);
    expect(localStorage.getItem('ground-control:header-collapsed')).toBe('true');
  });

  /** A view switch replaces those rows along with the cards (`mechanics.md` M27), and the replacement arrives shown. */
  it('folds the rows a re-render replaced', () => {
    paint(document, state(), NOW, actions);
    collapse();

    document.documentElement.innerHTML = BOARD;
    paint(document, state(), NOW, actions);

    expect(hidden()).toEqual(['Project', 'view tabs', 'Discard']);
  });

  /** A climb with nothing to stop it runs to the page's own root, and folding the site away is the one bad outcome. */
  it('hides nothing on a page with no board on it yet', () => {
    document.getElementById('project-items-region')!.remove();

    expect(foldedRows(document)).toEqual([]);

    localStorage.setItem('ground-control:header-collapsed', 'true');
    paint(document, state(), NOW, actions);

    expect(hidden()).toEqual([]);
  });

  it('puts the header back when the overlay leaves the board', () => {
    paint(document, state(), NOW, actions);
    collapse();
    clear(document);

    expect(hidden()).toEqual([]);
    expect(document.getElementById('gc-collapse')).toBeNull();
  });

  it('starts expanded when the browser refuses to be read', () => {
    const refused = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('site data is blocked');
    });

    paint(document, state(), NOW, actions);

    expect(hidden()).toEqual([]);
    expect(document.querySelector('#gc-collapse')?.getAttribute('aria-pressed')).toBe('false');

    refused.mockRestore();
  });

  it('still folds for this tab when the browser refuses to be written to', () => {
    const refused = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage is full');
    });

    paint(document, state(), NOW, actions);
    collapse();

    expect(hidden()).toEqual(['Project', 'view tabs', 'Discard']);

    refused.mockRestore();
  });
});

describe('where a panel hangs', () => {
  /** Supply anchor and panel rectangles because jsdom does not perform layout. */
  function measured(anchor: Partial<DOMRect>, panel: Partial<DOMRect>): void {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const of = this.classList.contains('gc-popover') ? panel : anchor;

      return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}), ...of };
    });
  }

  function panel(): HTMLElement {
    return document.querySelector<HTMLElement>('.gc-popover')!;
  }

  function open(): void {
    paint(document, state(), NOW, actions);
    document.querySelector<HTMLElement>('#gc-menu button')!.click();
    paint(document, state(), NOW, actions);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The board menu sits at the end of the filter bar, so its panel grows back across the bar, not past it. */
  it('hangs under what opened it, right edges aligned', () => {
    measured({ left: 300, right: 420, bottom: 120, top: 90 }, { width: 260, height: 140 });
    open();

    expect(panel().style.top).toBe('124px');
    expect(panel().style.left).toBe('160px');
  });

  /** Verify right-edge overflow correction uses measured panel width. */
  it('shifts back from the window edge by no more than it has to', () => {
    measured({ left: 900, right: 1020, bottom: 120, top: 90 }, { width: 260, height: 140 });
    open();

    expect(window.innerWidth).toBe(1024);
    expect(panel().style.left).toBe('756px');
  });

  it('flips above the anchor rather than off the bottom of the window', () => {
    measured({ left: 300, right: 420, top: 700, bottom: 740 }, { width: 260, height: 200 });
    open();

    expect(panel().style.top).toBe('496px');
  });

  /** A lane menu hangs off a control inside a card, where the space to grow into is to the right. */
  it('hangs a lane menu from the left edge of the control that opened it', () => {
    measured({ left: 300, right: 420, bottom: 120, top: 90 }, { width: 260, height: 140 });
    paint(document, state(), NOW, actions);
    document.querySelector<HTMLElement>('.gc-lane')!.click();
    paint(document, state(), NOW, actions);

    expect(document.querySelector<HTMLElement>('.gc-lanes')!.style.left).toBe('300px');
  });
});

describe('what went wrong, as a toast', () => {
  function toasts(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>('#gc-toasts .gc-toast')];
  }

  const failing = snapshot({
    stale: true,
    failures: [
      { subject: 'github', kind: 'gh-missing', message: 'The GitHub CLI is not installed.', remedy: 'Install gh.' },
    ],
  });

  it('states each failure with what to do about it', () => {
    paint(document, state({ snapshot: failing }), NOW, actions);

    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]!.textContent).toContain('The GitHub CLI is not installed.');
    expect(toasts()[0]!.textContent).toContain('Install gh.');
    expect(toasts()[0]!.dataset.tone).toBe('danger');
  });

  it('names a status field the project cannot supply, and where to fix it', () => {
    const unsupported = snapshot({
      issues: { count: 1, matched: 1, totalAssigned: 1, notOnProject: 0, fieldProblem: 'Project example-org/3 has no field named "Stage".', truncated: false, fetchedAt: '' },
    });

    paint(document, state({ snapshot: unsupported }), NOW, actions);

    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]!.textContent).toContain('has no field named "Stage"');
    expect(toasts()[0]!.textContent).toContain('groundControl.github.statusField');
    expect(toasts()[0]!.dataset.tone).toBe('danger');
  });

  it('reports an incomplete read the way the editor board does, naming the setting that widens it', () => {
    const cut = snapshot({
      issues: { count: 100, matched: 240, totalAssigned: 260, notOnProject: 20, fieldProblem: null, truncated: true, fetchedAt: '' },
    });

    paint(document, state({ snapshot: cut }), NOW, actions);

    const texts = toasts().map((toast) => toast.textContent ?? '');

    expect(texts.some((text) => text.includes('Showing 100 of 240') && text.includes('groundControl.github.maxPages'))).toBe(true);
    expect(texts.some((text) => text.includes('20 assigned issues are not on the configured project board'))).toBe(true);
    expect(toasts().every((toast) => toast.dataset.tone === 'default')).toBe(true);

    // A later refresh with other counts must redraw the toast, not leave the first numbers standing.
    paint(document, state({ snapshot: snapshot({ issues: { ...cut.issues!, count: 200, matched: 240 } }) }), NOW, actions);

    const later = toasts().map((toast) => toast.textContent ?? '');

    expect(later.some((text) => text.includes('Showing 200 of 240'))).toBe(true);
    expect(later.some((text) => text.includes('Showing 100 of 240'))).toBe(false);
  });

  /** A bridge that lost its hub must not leave badges that look current. */
  it('says when it cannot reach the board at all', () => {
    paint(document, state({ trouble: 'Disconnected from Ground Control.' }), NOW, actions);

    expect(toasts()[0]!.textContent).toContain('Disconnected from Ground Control.');
    expect(toasts()[0]!.textContent).toContain('Showing cached data when available');
  });

  /** The bridge refuses what the browser may not ask for. A refusal nobody renders is a button that does nothing. */
  it('shows the latest hub response', () => {
    paint(document, state({ notice: 'Taking a session over happens in the editor.' }), NOW, actions);

    expect(toasts()[0]!.textContent).toContain('Taking a session over happens in the editor.');
    expect(toasts()[0]!.dataset.tone).toBe('default');
  });

  /** How old the reading is belongs in the menu: a toast for it would be one every few seconds, saying nothing. */
  it('leaves what is merely true out of the toasts', () => {
    paint(document, state(), NOW, actions);

    expect(toasts()).toHaveLength(0);
  });

  it.each([
    ['off', 'Triage is off.', false],
    ['manual', 'Triage is manual.', true],
    ['manual', 'No enabled agent supports card classification.', false],
    ['automatic', 'No configured source can provide card conversations.', false],
    ['automatic', 'Automatic triage reached its daily limit.', true],
  ] as const)('shows the %s diagnostic as a neutral notice', (mode, message, canRequest) => {
    const updated = state({ snapshot: snapshot({ triage: { mode, message, canRequest } }) });

    paint(document, updated, NOW, actions);
    paint(document, updated, NOW, actions);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]?.textContent).toContain(message);
    expect(toasts()[0]?.dataset.tone).toBe('default');
    expect(toasts()[0]?.getAttribute('role')).toBe('status');
    paint(document, state({ snapshot: snapshot({ triage: { mode, message: null, canRequest } }) }), NOW, actions);
    expect(toasts()).toHaveLength(0);
  });

  /** A scan runs every few seconds and after every board mutation. One failure is one toast, however many scans. */
  it('shows one toast per failure however many times it paints', () => {
    paint(document, state({ snapshot: failing }), NOW, actions);
    paint(document, state({ snapshot: failing }), NOW, actions);
    paint(document, state({ snapshot: failing }), NOW, actions);

    expect(toasts()).toHaveLength(1);
  });

  it('removes resolved notices', () => {
    paint(document, state({ snapshot: failing }), NOW, actions);
    paint(document, state(), NOW, actions);

    expect(toasts()).toHaveLength(0);
  });

  it('leaves one the developer closed closed, and brings it back if the trouble returns', () => {
    paint(document, state({ snapshot: failing }), NOW, actions);
    document.querySelector<HTMLElement>('.gc-dismiss')!.click();
    paint(document, state({ snapshot: failing }), NOW, actions);

    expect(toasts()).toHaveLength(0);

    paint(document, state(), NOW, actions);
    paint(document, state({ snapshot: failing }), NOW, actions);

    expect(toasts()).toHaveLength(1);
  });
});

describe('moving a card from the browser', () => {
  const CHECKOUT = { root: 'd:/work/repo.worktrees/4501-refund-window', source: 'session' as const, only: true };

  /**
   * Repaint reconciles the selected lane menu after a click.
   */
  function click(selector: string): void {
    document.querySelector<HTMLElement>(selector)!.click();
    paint(document, state(), NOW, actions);
  }

  /** The outer `click` repaints from the default board, which has no checkout on it — so this one holds ours. */
  function clickOn(selector: string, shown: Snapshot): void {
    document.querySelector<HTMLElement>(selector)!.click();
    paint(document, state({ snapshot: shown }), NOW, actions);
  }

  it('offers the lanes only once asked, and moves the card to the one chosen', () => {
    paint(document, state(), NOW, actions);

    expect(document.querySelectorAll('.gc-lanes')).toHaveLength(0);

    click('.gc-lane');

    const offered = [...document.querySelectorAll<HTMLElement>('.gc-lanes button')].map((b) => b.dataset.lane);

    expect(offered).toEqual(['unstarted', 'plan', 'build', 'review', 'done', 'icebox']);

    click('.gc-lanes button[data-lane="review"]');

    expect(actions.move).toHaveBeenCalledWith('issue-4501', 'review' satisfies LaneId);
    expect(document.querySelectorAll('.gc-lanes')).toHaveLength(0);
  });

  /** Keep the lane menu open through the scan triggered by its insertion. */
  it('keeps the lanes open across the repaints the board makes anyway', () => {
    paint(document, state(), NOW, actions);
    click('.gc-lane');

    paint(document, state(), NOW, actions);
    paint(document, state(), NOW, actions);

    expect(document.querySelectorAll('.gc-lanes button')).toHaveLength(6);
  });

  it('asks for a repaint on every click, because that is what draws the change', () => {
    paint(document, state(), NOW, actions);
    document.querySelector<HTMLElement>('.gc-lane')!.click();

    expect(actions.repaint).toHaveBeenCalledTimes(1);
  });

  /**
   * A placement written while archived is discarded by `prune`, so a lane offered here would do nothing (R9).
   * The board refuses the same move by leaving an archived card undraggable.
   */
  describe('a card the board has archived', () => {
    function archived(over: Partial<LanedCard> = {}): Snapshot {
      return snapshot({
        lanes: [{ id: 'archived', title: 'Archived', cards: [card(4501, { lane: 'archived', ...over })] }],
      });
    }

    /** The menu moves and starts, and an archived card does neither; its checkout still opens from the bar. */
    it('opens no menu, and still opens its checkout from the bar', () => {
      const shown = archived({ checkout: CHECKOUT });

      paint(document, state({ snapshot: shown }), NOW, actions);
      document.querySelector<HTMLElement>('.gc-lane')!.click();
      paint(document, state({ snapshot: shown }), NOW, actions);

      expect(document.querySelectorAll('.gc-lanes')).toHaveLength(0);
      expect(document.querySelector<HTMLElement>('.gc-lane')!.getAttribute('aria-disabled')).toBe('true');
      expect(document.querySelector<HTMLElement>('.gc-lane')!.hasAttribute('aria-haspopup')).toBe(false);
      // Still reachable, because the pictogram is the only thing naming the lane here.
      expect(tipOf(document.querySelector('.gc-lane'))).toBe('Archived');
      expect(document.querySelector('.gc-tool[aria-label="Open in VS Code"]')).not.toBeNull();
    });

    it('closes an open menu when the card is archived under it', () => {
      const open = snapshot({ lanes: [{ id: 'build', title: 'Build', cards: [card(4501)] }] });

      paint(document, state({ snapshot: open }), NOW, actions);
      clickOn('.gc-lane', open);

      expect(document.querySelectorAll('.gc-lanes')).toHaveLength(1);

      paint(document, state({ snapshot: archived() }), NOW, actions);

      expect(document.querySelectorAll('.gc-lanes')).toHaveLength(0);
    });

    /** Holding the selection would reopen the menu with no click behind it once the card came back (R9). */
    it('forgets the open menu, so a returning card does not reopen it by itself', () => {
      const open = snapshot({ lanes: [{ id: 'build', title: 'Build', cards: [card(4501)] }] });

      paint(document, state({ snapshot: open }), NOW, actions);
      clickOn('.gc-lane', open);
      paint(document, state({ snapshot: archived() }), NOW, actions);
      paint(document, state({ snapshot: open }), NOW, actions);

      expect(document.querySelectorAll('.gc-lanes')).toHaveLength(0);
    });

    it('closes the menu when the card is archived under it', () => {
      const held = snapshot({ lanes: [{ id: 'build', title: 'Build', cards: [card(4501, { checkout: CHECKOUT })] }] });

      paint(document, state({ snapshot: held }), NOW, actions);
      clickOn('.gc-lane', held);

      expect(document.querySelectorAll('.gc-lanes')).toHaveLength(1);

      paint(document, state({ snapshot: archived({ checkout: CHECKOUT }) }), NOW, actions);

      expect(document.querySelectorAll('.gc-lanes')).toHaveLength(0);
      expect(document.querySelector<HTMLElement>('.gc-lane')!.getAttribute('aria-disabled')).toBe('true');
      expect(document.querySelector<HTMLElement>('.gc-lane')!.hasAttribute('aria-haspopup')).toBe(false);
      // Still reachable, because the pictogram is the only thing naming the lane here.
      expect(tipOf(document.querySelector('.gc-lane'))).toBe('Archived');
    });
  });

  /** Open-checkout is a bar control on a card with a checkout (R45). Folder selection requires the editor (R41). */
  describe('the editor a card can be opened in', () => {
    function withCheckout(): Snapshot {
      return snapshot({ lanes: [{ id: 'build', title: 'Build', cards: [card(4501, { checkout: CHECKOUT })] }] });
    }

    const open = () => document.querySelector<HTMLButtonElement>('.gc-tool[aria-label="Open in VS Code"]');

    it('offers the checkout to open from the bar, and sends the card and nothing else', () => {
      paint(document, state({ snapshot: withCheckout() }), NOW, actions);

      expect(tipOf(open())).toBe(`Open ${CHECKOUT.root} in VS Code`);
      open()!.click();

      expect(actions.openCheckout).toHaveBeenCalledWith('issue-4501');
    });

    // Left out rather than drawn to refuse, which is the rule every other control here follows.
    it('offers nothing to open on a card with no checkout, in the bar or the menu', () => {
      paint(document, state(), NOW, actions);
      click('.gc-lane');

      expect(open()).toBeNull();
      expect(document.querySelectorAll('.gc-lanes button')).toHaveLength(6);
    });

    it('removes excluded session details and the open control on projection changes', () => {
      const shown = withCheckout();
      paint(document, state({ snapshot: shown }), NOW, actions);
      expect(document.querySelectorAll('.gc-session')).toHaveLength(1);
      expect(open()).not.toBeNull();
      expect(document.body.innerHTML).toContain(CHECKOUT.root);

      const projected = laneOf(card(4501, {
        sessions: [],
        action: { state: 'running', action: 'merge-upstream', since: NOW },
      }));
      paint(document, state({ snapshot: projected }), NOW, actions);

      expect(document.querySelectorAll('.gc-session')).toHaveLength(0);
      expect(open()).toBeNull();
      expect(document.body.innerHTML).not.toContain(CHECKOUT.root);
      expect(document.body.innerHTML).not.toContain(SESSION_ID);
      expect(document.body.innerHTML).not.toContain(session().cwd);
      expect(badges()).toHaveLength(1);
      expect(actions.openCheckout).not.toHaveBeenCalled();
    });

    // Path selection is the one thing a page may never do, whatever else the menu offers (R41).
    it('offers no way to choose a folder, whatever the card carries', () => {
      const shown = withCheckout();

      paint(document, state({ snapshot: shown }), NOW, actions);
      clickOn('.gc-lane', shown);

      const labels = [...document.querySelectorAll('.gc-lanes button')].map((b) => b.textContent ?? '');

      expect(labels.some((label) => label.includes('folder'))).toBe(false);
    });
  });

  /**
   * One start item per agent the hub says an editor can start, worded as the editor board words them
   * (`docs/testing.md` parity tables). A start needs a checkout, and a read-only card offers none (R9, R42).
   */
  describe('starting a session on a card', () => {
    const STARTABLE = [
      { agent: 'claude', takesPrompt: true },
      { agent: 'codex', takesPrompt: false },
    ];

    function startable(over: Partial<LanedCard> = {}): Snapshot {
      return snapshot({
        lanes: [{ id: 'build', title: 'Build', cards: [card(4501, { checkout: CHECKOUT, ...over })] }],
        startable: STARTABLE,
      });
    }

    function items(): HTMLElement[] {
      return [...document.querySelectorAll<HTMLElement>('.gc-lanes button[data-action="start-session"]')];
    }

    function show(shown: Snapshot): void {
      paint(document, state({ snapshot: shown }), NOW, actions);
      clickOn('.gc-lane', shown);
    }

    it('offers one item per agent, naming the agent and the checkout it starts in', () => {
      show(startable());

      expect(items().map((item) => item.textContent)).toEqual(['Start Claude session', 'Start Codex session']);
      expect(items()[0]!.title).toBe(`Open a new Claude session in ${CHECKOUT.root}, prefilled and unsent`);
    });

    /** Codex's start command takes no prompt, and the item says so rather than promising a prefill. */
    it('says an agent that takes no prompt starts empty', () => {
      show(startable());

      expect(items()[1]!.title).toBe(
        `Open a new Codex session in ${CHECKOUT.root}. Codex offers no way in that takes a prompt, so it starts empty`,
      );
    });

    it('sends the card and the agent, and closes the menu', () => {
      const shown = startable();

      show(shown);
      clickOn('.gc-lanes button[data-agent="codex"]', shown);

      expect(actions.startSession).toHaveBeenCalledWith('issue-4501', 'codex');
      expect(document.querySelectorAll('.gc-lanes')).toHaveLength(0);
    });

    it('offers no start while the hub reports no editor that can perform one', () => {
      show(snapshot({ lanes: [{ id: 'build', title: 'Build', cards: [card(4501, { checkout: CHECKOUT })] }] }));

      expect(items()).toHaveLength(0);
    });

    it('offers no start on a card with no checkout to start in', () => {
      show(snapshot({ startable: STARTABLE }));

      expect(items()).toHaveLength(0);
    });

    /** With no lane to move to either, the chip opens nothing. */
    it('offers no start on an archived card', () => {
      show(snapshot({
        lanes: [{ id: 'archived', title: 'Archived', cards: [card(4501, { checkout: CHECKOUT, lane: 'archived' })] }],
        startable: STARTABLE,
      }));

      expect(document.querySelectorAll('.gc-lanes')).toHaveLength(0);
      expect(document.querySelector('.gc-lane')!.hasAttribute('aria-haspopup')).toBe(false);
    });

    /** Archived is wider than unassigned, so the archived case above cannot stand in for this one (R9). */
    it('offers no start on a card the developer is no longer assigned', () => {
      show(startable({ unassigned: true }));

      expect(document.querySelectorAll('.gc-lanes')).toHaveLength(1);
      expect(items()).toHaveLength(0);
    });
  });

  it('closes the lanes when the badge is asked a second time', () => {
    paint(document, state(), NOW, actions);
    click('.gc-lane');
    click('.gc-lane');

    expect(document.querySelectorAll('.gc-lanes')).toHaveLength(0);
    expect(actions.move).not.toHaveBeenCalled();
  });

  /** Every control sits inside GitHub's own card, which is a button and a drag handle. A click must go no further. */
  it('keeps a click on its own controls off the card underneath', () => {
    paint(document, state(), NOW, actions);

    const onCard = vi.fn();

    document.querySelector(`[data-gc-issue="${REPO}#4501"]`)!.addEventListener('click', onCard);
    badges()[0]!.querySelector<HTMLElement>('.gc-session')!.click();
    badges()[0]!.querySelector<HTMLElement>('.gc-lane')!.click();

    expect(onCard).not.toHaveBeenCalled();
  });
});

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

/** Preserve unchanged footer nodes across scans so animation, hover, and avatars remain stable. */
describe('what a scan keeps', () => {
  const three = () => laneOf(card(4501), card(4502), card(4503));

  function footers(): Element[] {
    return [...document.querySelectorAll(`.gc-badge`)];
  }

  function records(run: () => void): MutationRecord[] {
    const seen: MutationRecord[] = [];
    const observer = new MutationObserver((all) => seen.push(...all));

    observer.observe(document.documentElement, { childList: true, subtree: true });
    run();

    const held = observer.takeRecords();

    observer.disconnect();

    return [...seen, ...held];
  }

  it('rebuilds nothing, and adds and removes no node, when the snapshot has not moved', () => {
    const shown = state({ snapshot: three() });

    paint(document, shown, NOW, actions);

    const before = footers();

    expect(before).toHaveLength(3);

    const seen = records(() => paint(document, shown, NOW + 1_000, actions));

    expect(footers()).toEqual(before);
    expect(seen).toEqual([]);
  });

  it('reports the same counts for a scan that kept everything as for one that drew it', () => {
    const shown = state({ snapshot: three() });

    expect(paint(document, shown, NOW, actions)).toEqual({ scanned: 3, badges: 3, menu: true });
    expect(paint(document, shown, NOW + 1_000, actions)).toEqual({ scanned: 3, badges: 3, menu: true });
  });

  /** Change one field per case so each signature dependency is tested independently. */
  type Side = { card?: Partial<LanedCard>; openable?: string[] };

  const bare = (over: Partial<Session> = {}) => ({ sessions: [session({ title: null, activity: null, details: {}, ...over })] });
  const saved = (over: Record<string, unknown> = {}) => ({
    sessions: [],
    lastSession: { agent: 'claude', sessionId: OTHER_ID, title: 'Past attempt', cwd: '/work/4501', branch: '4501', issueNumber: 4501, repository: `github.com/${REPO}`, updatedAt: NOW - 60_000, ...over },
  });

  const moves: [string, Side, Side][] = [
    ['the lane it is in', {}, { card: { lane: 'review' } }],
    ['coming back', {}, { card: { returned: true } }],
    ['what it wants', {}, { card: { attention: 'blocked' } }],
    [
      'a reading',
      { card: { triage: { state: 'running' } } },
      { card: { triage: { state: 'done', action: 'develop', qualifier: null, detail: 'Pick it up.', at: NOW, stale: false } } },
    ],
    [
      'how long it has held its status',
      { card: { issue: { ...card(4501).issue!, statusChangedAt: '2026-09-03T09:00:00Z' } } },
      { card: { issue: { ...card(4501).issue!, statusChangedAt: '2026-09-04T09:00:00Z' } } },
    ],
    [
      'who the avatar is',
      { card: { issue: { ...card(4501).issue!, avatar: ASSIGNEE } } },
      { card: { issue: { ...card(4501).issue!, avatar: AUTHOR } } },
    ],
    ['whether a session has ended', { card: { sessions: [session()] } }, { card: { sessions: [session({ finished: true })] } }],
    [
      'the phase a session is in',
      { card: { sessions: [session({ activity: { phase: 'running', since: NOW - 1_000, at: NOW - 1_000, event: 'PreToolUse' } })] } },
      { card: { sessions: [session({ activity: { phase: 'idle', since: NOW - 1_000, at: NOW - 1_000, event: 'Stop' } })] } },
    ],
    ['what a session calls itself', { card: { sessions: [session({ title: 'One thing' })] } }, { card: { sessions: [session({ title: 'Another' })] } }],
    ['the name the CLI gave it', { card: bare({ details: { name: 'plucky-otter' } }) }, { card: bare({ details: { name: 'brave-newt' } }) }],
    ['the short id it falls back to', { card: bare({ details: { shortId: 'a1b2' } }) }, { card: bare({ details: { shortId: 'c3d4' } }) }],
    ['the word a CLI reports', { card: bare({ details: { state: 'editing tests' } }) }, { card: bare({ details: { state: 'running the suite' } }) }],
    ['the status a CLI reports', { card: bare({ details: { status: 'working' } }) }, { card: bare({ details: { status: 'waiting' } }) }],
    ['which session it is', {}, { card: { sessions: [session({ sessionId: OTHER_ID })] } }],
    ['where a session runs', {}, { card: { sessions: [session({ cwd: 'd:/checkouts/elsewhere' })] } }],
    // The session is the same on both sides, and the other two cards keep theirs: what moves is only whether this
    // window can open the one this card names.
    [
      'whether a session can be opened',
      { card: { sessions: [session({ sessionId: OTHER_ID })] }, openable: [OTHER_ID, SESSION_ID] },
      { card: { sessions: [session({ sessionId: OTHER_ID })] }, openable: [SESSION_ID] },
    ],
    ['a saved session appearing', { card: { sessions: [] } }, { card: saved() }],
    ['what a saved session is called', { card: saved() }, { card: saved({ title: 'Renamed' }) }],
    ['when a saved session was written', { card: saved() }, { card: saved({ updatedAt: NOW - 120_000 }) }],
    ['which saved session it is', { card: saved() }, { card: saved({ sessionId: SESSION_ID }) }],
    ['where a saved session ran', { card: saved() }, { card: saved({ cwd: '/work/elsewhere' }) }],
  ];

  function laneFor(side: Side): Snapshot {
    const shown = laneOf(card(4501, side.card ?? {}), card(4502), card(4503));

    return side.openable === undefined ? shown : { ...shown, openable: side.openable };
  }

  it.each(moves)('draws the card again when %s changes, and leaves the others alone', (_what, before, after) => {
    paint(document, state({ snapshot: laneFor(before) }), NOW, actions);

    const [first, ...rest] = footers();

    paint(document, state({ snapshot: laneFor(after) }), NOW, actions);

    const drawn = footers();

    expect(drawn).toHaveLength(3);
    expect(drawn[0]).not.toBe(first);
    // The other two are the proof the signature is reading the card rather than rebuilding the board.
    expect(drawn.slice(1)).toEqual(rest);
  });

  /** Refresh timestamps on retained rows when a new turn keeps the same phase (R24). */
  it('carries a newer observation onto a row it kept', () => {
    const running = (since: number, event = 'PreToolUse') =>
      laneOf(card(4501, { sessions: [session({ activity: { phase: 'running', since, at: since, event } })] }));

    paint(document, state({ snapshot: running(NOW - 600_000) }), NOW, actions);

    const said = document.querySelector('.gc-state')!;

    expect(said.textContent).toBe('10m');

    paint(document, state({ snapshot: running(NOW - 5_000, 'PostToolUse') }), NOW, actions);

    // Update the tooltip event together with the duration timestamp (R24).
    expect(document.querySelector('.gc-state')?.getAttribute('data-gc-tip')).toContain('PostToolUse');
    // The same node, carrying the newer turn — and reading it already, rather than a tick behind the scan.
    expect(document.querySelector('.gc-state')).toBe(said);
    expect(said.getAttribute('data-gc-since')).toBe(String(NOW - 5_000));
    expect(said.textContent).toBe('5s');
    expect(tickDurations(document, NOW + 55_000)).toBe(1);
    expect(said.textContent).toBe('1m');
  });

  /** A view switch replaces every card node (`mechanics.md` M27), which is a miss rather than a footer left behind. */
  it('draws a footer again on a card node the page replaced', () => {
    const shown = state({ snapshot: three() });

    paint(document, shown, NOW, actions);

    const held = document.querySelector('[data-board-card-id]')!;
    const fresh = held.cloneNode(true) as Element;

    for (const stale of fresh.querySelectorAll('.gc-badge')) {
      stale.remove();
    }

    held.replaceWith(fresh);
    paint(document, shown, NOW, actions);

    expect(fresh.querySelector('.gc-badge')).not.toBeNull();
    expect(footers()).toHaveLength(3);
  });

  /** GitHub re-renders its own assignee stack, and a footer otherwise unchanged must not keep a slot that went. */
  it('draws the author slot again when the page has taken it back', () => {
    const shown = state({ snapshot: laneOf(actorCard(4501, AUTHOR)) });

    paint(document, shown, NOW, actions);

    // Remove only the replacement avatar slot, preserving the attribute that hides GitHub assignees, to test
    // restoration after partial DOM replacement.
    document.querySelector('.gc-actor')!.remove();
    paint(document, shown, NOW, actions);

    expect(document.querySelector('.gc-actor')).not.toBeNull();
    expect(document.querySelector('[data-gc-actor]')?.getAttribute('data-gc-actor')).toBe(AUTHOR.login);
  });

  /** Update the open menu timestamp without rebuilding it; age is excluded from its signature (R25). */
  it('carries a newer reading onto the menu it kept', () => {
    const read = (ago: number) => state({ snapshot: snapshot({ fetchedAt: new Date(NOW - ago).toISOString() }) });

    paint(document, read(300_000), NOW, actions);
    document.querySelector<HTMLElement>('#gc-menu button')!.click();
    paint(document, read(300_000), NOW, actions);

    const menu = document.getElementById('gc-menu');
    const said = document.querySelector('#gc-menu .gc-popover [data-gc-since]')!;

    expect(said.textContent).toBe('5m');

    paint(document, read(1_000), NOW, actions);

    expect(document.getElementById('gc-menu')).toBe(menu);
    expect(said.textContent).toBe('1s');
    expect(tickDurations(document, NOW + 60_000)).toBe(2);
    expect(said.textContent).toBe('1m');
  });

  /** Rebuild the open-menu card so renderBadge recreates the menu removed at the start of the scan. */
  it('keeps a lane menu open across a scan the board provoked', () => {
    const shown = state({ snapshot: three() });

    paint(document, shown, NOW, actions);
    document.querySelector<HTMLElement>('.gc-lane')!.click();
    paint(document, shown, NOW, actions);

    expect(document.querySelectorAll('.gc-lanes')).toHaveLength(1);

    paint(document, shown, NOW + 1_000, actions);

    expect(document.querySelectorAll('.gc-lanes')).toHaveLength(1);
    expect(document.querySelector('.gc-lanes [data-lane="review"]')).not.toBeNull();
  });

  it('keeps its own menu, and the item under the pointer with it', () => {
    const shown = state({ snapshot: three() });

    paint(document, shown, NOW, actions);
    document.querySelector<HTMLElement>('#gc-menu button')!.click();
    paint(document, shown, NOW, actions);

    const menu = document.getElementById('gc-menu');
    const item = document.querySelector('#gc-menu .gc-popover button[role]');

    expect(item?.textContent).toContain('Enable overlay');

    paint(document, shown, NOW + 1_000, actions);

    expect(document.getElementById('gc-menu')).toBe(menu);
    expect(document.querySelector('#gc-menu .gc-popover button[role]')).toBe(item);
  });

  it('draws its menu again when what the menu says has changed', () => {
    const shown = state({ snapshot: three() });

    paint(document, shown, NOW, actions);

    const menu = document.getElementById('gc-menu');

    paint(document, state({ snapshot: three(), trouble: 'The overlay lost its connection to Ground Control.' }), NOW, actions);

    expect(document.getElementById('gc-menu')).not.toBe(menu);
    expect(document.querySelector<HTMLElement>('#gc-menu button')!.dataset.stale).toBe('true');
  });

  /** Nothing re-places a popover between scans now, and a fixed one would stand over another card. */
  it('closes what it has open when the board scrolls under it', () => {
    const shown = state({ snapshot: three() });

    paint(document, shown, NOW, actions);
    document.querySelector<HTMLElement>('#gc-menu button')!.click();
    paint(document, shown, NOW, actions);

    expect(document.querySelectorAll('.gc-popover')).toHaveLength(1);

    actions.repaint.mockClear();
    document.querySelector('#project-items-region')!.dispatchEvent(new Event('scroll', { bubbles: true }));

    expect(actions.repaint).toHaveBeenCalled();

    paint(document, shown, NOW, actions);

    expect(document.querySelectorAll('.gc-popover')).toHaveLength(0);
  });
});

describe('how long ago', () => {
  it.each(AGO_ROWS)('reads %s', (_rung, ms, expected) => {
    expect(ago(ms)).toBe(expected);
  });

  // The rows above each pin one unit, so only this pins that a duration is ever only one of them.
  it('is a single number, with no second unit behind it', () => {
    expect(ago(90 * 60_000 + 30_000)).toBe('1h');
    expect(ago(3 * 86_400_000 + 4 * 3_600_000)).toBe('3d');
    expect(ago(16 * 86_400_000 + 5 * 3_600_000)).toBe('2w');
  });
});

/** Both clients duplicate this helper because neither can import workspace packages at runtime. */
describe('the agent display name', () => {
  it.each([
    ['claude', 'Claude'],
    ['codex', 'Codex'],
    ['gemini', 'Gemini'],
  ])('titles %s as %s', (agent, titled) => {
    expect(agentTitle(agent)).toBe(titled);
  });
});

/** Verify the same literal session-label table in core and both clients. */
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
    expect(sessionLabel(session(over))).toBe(expected);
  });

  // The rows above each set one rung, so only this pins the order: a ladder that read the bag first would pass them.
  it('prefers each rung over the one below it', () => {
    const both = { name: 'plucky-otter', shortId: 'a1b2c3d4' };

    expect(sessionLabel(session({ title: 'Fix the lane divider', cwd: 'd:/git/orez', details: both }))).toBe('Fix the lane divider');
    expect(sessionLabel(session({ title: null, cwd: 'd:/git/orez', details: both }))).toBe('plucky-otter');
    expect(sessionLabel(session({ title: null, cwd: 'd:/git/orez', details: { shortId: 'a1b2c3d4' } }))).toBe('a1b2c3d4');
  });

  it('draws the name on the chip, not the directory it is working in', () => {
    const named = snapshot({
      lanes: [
        {
          id: 'build',
          title: 'Build',
          cards: [card(4501, { sessions: [session({ title: null, details: { name: 'plucky-otter' } })] })],
        },
      ],
    });

    paint(document, state({ snapshot: named }), NOW, actions);

    expect(badges()[0]!.querySelector('.gc-session .gc-name')!.textContent).toBe('plucky-otter');
  });
});

describe('card attention', () => {
  function marked(attention: LanedCard['attention'], over: Partial<LanedCard> = {}): Snapshot {
    return snapshot({ lanes: [{ id: 'build', title: 'Build', cards: [card(4501, { attention, ...over })] }] });
  }

  it('paints the row that is waiting on you, rather than saying so a second time on the card', () => {
    paint(document, state({ snapshot: marked('blocked') }), NOW, actions);

    const row = badges()[0]!.querySelector<HTMLElement>('.gc-session')!;

    expect(row.dataset.phase).toBe('waiting');
    expect(row.querySelector('.gc-state')!.textContent).toBe('2m');
    expect(document.querySelector('.gc-returned')).toBeNull();
  });

  it('paints only the row a your-turn card is about, and leaves the working one lit instead', () => {
    const idle = session({ title: 'Reading the logs', activity: { phase: 'idle', since: NOW - 60_000, at: NOW - 60_000, event: 'Stop' } });
    const running = session({
      sessionId: OTHER_ID,
      title: 'Still going',
      activity: { phase: 'running', since: NOW - 10_000, at: NOW - 10_000, event: 'Stop' },
    });

    paint(document, state({ snapshot: marked('your-turn', { sessions: [idle, running] }) }), NOW, actions);

    const [first, second] = [...badges()[0]!.querySelectorAll<HTMLElement>('.gc-session')];

    expect(first!.dataset.phase).toBe('idle');
    expect(second!.dataset.phase).toBe('running');
  });

  // R6: a painted row lives inside the card, which is not readable from across a board. The card carries the ring.
  it('rings the card itself, and takes the ring off when the snapshot no longer has one', () => {
    paint(document, state({ snapshot: marked('blocked') }), NOW, actions);

    expect(document.querySelector(`[data-gc-issue="${REPO}#4501"]`)!.getAttribute('data-gc-attention')).toBe('blocked');

    paint(document, state({ snapshot: marked(null) }), NOW, actions);

    expect(document.querySelector('[data-gc-attention]')).toBeNull();
    expect(document.querySelector('.gc-returned')).toBeNull();
  });

  /** Returned states the card, not its work, so it rides in the card header line with its pills (R45). */
  it('marks returned cards in the card header, and takes the mark off again', () => {
    paint(document, state({ snapshot: marked(null, { returned: true }) }), NOW, actions);

    const mark = cardElement(4501).querySelector<HTMLElement>('.gc-returned')!;

    expect(mark.textContent).toBe('Returned');
    expect(tipOf(mark)).toBe('This card returned to you.');
    // In GitHub's own markup above the title rather than in the footer this board draws.
    expect(badges()[0]!.querySelector('.gc-returned')).toBeNull();

    paint(document, state({ snapshot: marked(null, { returned: false }) }), NOW, actions);

    expect(document.querySelector('.gc-returned')).toBeNull();
  });

  /**
   * The label lives in GitHub's own header rather than in the retained footer, so it is written on every paint:
   * a header GitHub redraws under an unchanged footer would otherwise lose it for good (mechanics M27).
   */
  it('writes the returned label again after GitHub redraws the header under an unchanged footer', () => {
    const shown = marked(null, { returned: true });

    paint(document, state({ snapshot: shown }), NOW, actions);

    const footer = cardElement(4501).querySelector(`.${'gc-badge'}`);

    cardElement(4501).querySelector('.gc-returned')!.remove();
    paint(document, state({ snapshot: shown }), NOW, actions);

    expect(cardElement(4501).querySelector('.gc-returned')?.textContent).toBe('Returned');
    // The footer itself was retained, which is the case that would have skipped the label.
    expect(cardElement(4501).querySelector(`.${'gc-badge'}`)).toBe(footer);
  });

  it('takes the returned label off a card the snapshot stops carrying', () => {
    paint(document, state({ snapshot: marked(null, { returned: true }) }), NOW, actions);
    paint(document, state({ snapshot: snapshot({ lanes: [] }) }), NOW, actions);

    expect(document.querySelector('.gc-returned')).toBeNull();
  });

  /**
   * GitHub draws the type, status and pull request pills as list items in a `ul[aria-label="Fields"]` after
   * the title link's box, and the label joins them there as a list item of its own (mechanics M27).
   */
  it('joins the field list GitHub draws under the title', () => {
    const title = cardElement(4501).querySelector('[id^="board-card-title-"]')!;
    const fields = document.createElement('ul');
    const label = document.createElement('li');

    fields.setAttribute('aria-label', 'Fields');
    label.textContent = 'Bug';
    fields.appendChild(label);
    title.parentElement!.parentElement!.after(fields);

    paint(document, state({ snapshot: marked(null, { returned: true }) }), NOW, actions);

    const mark = cardElement(4501).querySelector('.gc-returned')!;

    expect(mark.tagName).toBe('LI');
    expect(mark.parentElement).toBe(fields);
    expect(mark.previousElementSibling).toBe(label);
  });

  /** A card carrying no field of its own has no such list, so the header line stands in for it. */
  it('falls back to the header line on a card with no labels', () => {
    paint(document, state({ snapshot: marked(null, { returned: true }) }), NOW, actions);

    const mark = cardElement(4501).querySelector('.gc-returned')!;

    expect(mark.tagName).toBe('SPAN');
    expect(mark.previousElementSibling!.id).toBe('board-card-header-title-24501');
  });

  it('takes the returned label off with the rest of the card rows', () => {
    paint(document, state({ snapshot: marked(null, { returned: true }) }), NOW, actions, {
      animations: true,
      replaceAvatars: true,
      cardRows: false,
    });

    expect(document.querySelector('.gc-returned')).toBeNull();
  });

  it('leaves nothing of itself on the page after a clear', () => {
    paint(document, state({ snapshot: marked('blocked', { returned: true }) }), NOW, actions);
    clear(document);

    expect(document.querySelector('[data-gc-attention]')).toBeNull();
    // The label sits in GitHub's own header, so the footer sweep alone would leave it behind.
    expect(document.querySelector('.gc-returned')).toBeNull();
  });
});

describe('durations that advance on their own', () => {
  /** The reading's own age is in the menu panel, which is shut until it is opened and painted again. */
  function withPanel(shown: State): void {
    paint(document, shown, NOW, actions);
    document.querySelector<HTMLElement>('#gc-menu button')!.click();
    paint(document, shown, NOW, actions);
  }

  it('rewrites the phase where it stands, without rebuilding the chip', () => {
    paint(document, state(), NOW, actions);

    const chip = badges()[0]!.querySelector('.gc-session')!;
    const said = chip.querySelector('.gc-state')!;

    expect(said.textContent).toBe('2m');
    expect(tickDurations(document, NOW + 60_000)).toBe(1);
    expect(said.textContent).toBe('3m');
    // The same nodes: a rebuild would cost the keyboard focus and any menu open over the card.
    expect(badges()[0]!.querySelector('.gc-session')).toBe(chip);
    expect(chip.querySelector('.gc-state')).toBe(said);
  });

  it('advances nothing when the minute has not turned over', () => {
    paint(document, state(), NOW, actions);

    expect(tickDurations(document, NOW + 1_000)).toBe(0);
  });

  /** This runs over a page GitHub owns, so it may only touch what the overlay itself drew. */
  it('leaves a node of the page carrying the same attribute alone', () => {
    paint(document, state(), NOW, actions);

    const theirs = document.createElement('span');

    theirs.setAttribute('data-gc-since', String(NOW - 125_000));
    theirs.textContent = 'GitHub own text';
    document.body.appendChild(theirs);

    expect(tickDurations(document, NOW + 60_000)).toBe(1);
    expect(theirs.textContent).toBe('GitHub own text');
  });

  /**
   * Duration updates must avoid childList mutations, which trigger another board scan. Updating existing text
   * nodes produces characterData instead.
   */
  it('adds and removes no node the scan observer would answer', () => {
    const content = readFileSync(join(__dirname, '..', 'src', 'content.js'), 'utf8');
    const armed = [...content.matchAll(/observer\.observe\(document\.documentElement, (\{[^}]+\})\)/g)];

    // Verify consistent observer options initially and after rendering, log appends, and timer updates.
    expect(armed).toHaveLength(5);
    expect(new Set(armed.map(([, options]) => options))).toEqual(new Set(['{ childList: true, subtree: true }']));

    const shown = snapshot({
      lanes: [
        {
          id: 'build',
          title: 'Build',
          cards: [
            card(4501, {
              triage: { state: 'done', action: 'develop', qualifier: null, detail: 'Pick it up.', at: NOW - 7_200_000, stale: false },
              issue: { ...card(4501).issue!, statusChangedAt: '2026-09-04T09:00:00Z' },
            }),
            card(4502, { sessions: [], lastSession: { agent: 'claude', sessionId: OTHER_ID, title: 'Past attempt', cwd: '/work/4502', branch: '4502', issueNumber: 4502, repository: `github.com/${REPO}`, updatedAt: NOW - 10_800_000 } }),
          ],
        },
      ],
    });

    withPanel(state({ snapshot: shown }));

    // A live row, a saved row, a card's status age and the menu's own reading age — every kind, all at once.
    expect(document.querySelectorAll('[data-gc-since]')).toHaveLength(4);

    const seen: MutationRecord[] = [];
    const observer = new MutationObserver((records) => seen.push(...records));

    observer.observe(document.documentElement, { childList: true, subtree: true });

    const moved = tickDurations(document, NOW + 3_600_000);
    const records = observer.takeRecords();

    observer.disconnect();

    expect(moved).toBe(4);
    expect([...seen, ...records]).toEqual([]);
  });

  it('carries one age attribute and none of the three it replaced', () => {
    withPanel(state());

    expect(document.querySelectorAll('[data-activity-since], [data-history-updated], [data-status-since]')).toHaveLength(0);
    // The live row and the menu's own reading age; this snapshot has no saved row and no status age.
    expect(document.querySelectorAll('[data-gc-since]')).toHaveLength(2);
  });

  it('leaves an age it cannot read alone rather than writing NaN into it', () => {
    paint(document, state(), NOW, actions);

    const said = badges()[0]!.querySelector('.gc-state')!;

    said.setAttribute('data-gc-since', 'whenever');
    said.firstChild!.nodeValue = 'held';

    expect(tickDurations(document, NOW + 60_000)).toBe(0);
    expect(said.textContent).toBe('held');
  });

  it('leaves a session with no reported phase alone', () => {
    const only = snapshot({
      lanes: [
        {
          id: 'build',
          title: 'Build',
          cards: [card(4501, { sessions: [session({ activity: null, details: { state: 'editing tests' } })] })],
        },
      ],
    });

    paint(document, state({ snapshot: only }), NOW, actions);

    expect(tickDurations(document, NOW + 600_000)).toBe(0);
    expect(badges()[0]!.querySelector('.gc-state')!.textContent).toBe('editing tests');
  });
});

describe('going to a session from the browser', () => {

  /** Both clients attach detached runs through a VS Code terminal without requiring an agent editor extension. */
  it('sends a detached run to the attach path rather than the session, and marks it as one', () => {
    const run = session({ attachId: 'c5d0c58f', details: { kind: 'background', name: 'merge-upstream' } });
    const only = snapshot({ lanes: [{ id: 'build', title: 'Build', cards: [card(4501, { sessions: [run] })] }], openable: [] });

    paint(document, state({ snapshot: only }), NOW, actions);

    const row = document.querySelector<HTMLAnchorElement>('.gc-session')!;

    expect(row.tagName).toBe('A');
    expect(row.getAttribute('href')).toBe(`vscode://groundcontrol.ground-control/attach?session=${SESSION_ID}`);
    expect(row.getAttribute('aria-label')).toContain('attach to this run in a VS Code terminal');
    expect(row.dataset.detached).toBe('true');
    expect(row.querySelector('.gc-destination')?.getAttribute('data-destination')).toBe('terminal');
  });

  it('marks an ordinary session as opening in the editor, and leaves its name upright', () => {
    paint(document, state({ snapshot: snapshot() }), NOW, actions);

    const row = document.querySelector<HTMLElement>('.gc-session')!;

    expect(row.querySelector('.gc-destination')?.getAttribute('data-destination')).toBe('editor');
    // The VS Code mark is a path; a shape built as the wrong element would carry `d` and draw nothing.
    expect(row.querySelector('.gc-destination svg > *')?.tagName).toBe('path');
    expect(row.dataset.detached).toBeUndefined();
  });

  /**
   * Use browser link navigation for the user gesture required by VS Code foreground activation (mechanics M26,
   * M29).
   */
  it('addresses the session by id and agent, and nothing else', () => {
    paint(document, state(), NOW, actions);

    const chip = badges()[0]!.querySelector<HTMLAnchorElement>('.gc-session')!;

    expect(chip.tagName).toBe('A');
    expect(chip.getAttribute('href')).toBe(`vscode://groundcontrol.ground-control/open?session=${SESSION_ID}&agent=claude`);
    // Assert the draggable attribute: the property default alone would not prove explicit drag suppression.
    expect(chip.getAttribute('draggable')).toBe('false');
  });

  /** The reason the link names the agent: a window the link activates has no snapshot to resolve it from. */
  it('names the agent the session actually runs, not the one a cold window would assume', () => {
    const codex = session({ agent: 'codex' });

    paint(
      document,
      state({ snapshot: snapshot({
        lanes: [{ id: 'build', title: 'Build', cards: [card(4501, { sessions: [codex] })] }],
        openable: [codex.sessionId],
      }) }),
      NOW,
      actions,
    );

    expect(badges()[0]!.querySelector('.gc-session')!.getAttribute('href')).toBe(
      `vscode://groundcontrol.ground-control/open?session=${codex.sessionId}&agent=codex`,
    );
  });

  it('offers no link for a session the hub says no editor can open', () => {
    paint(document, state({ snapshot: snapshot({ openable: [] }) }), NOW, actions);

    const chip = badges()[0]!.querySelector<HTMLElement>('.gc-session')!;

    expect(chip.tagName).toBe('SPAN');
    expect(chip.getAttribute('href')).toBeNull();
    // A span prohibits an accessible name, so the row carries none and is read from its own marks (R2).
    expect(chip.hasAttribute('aria-label')).toBe(false);
    expect(chip.querySelector('.gc-dot')!.getAttribute('aria-label')).toBe('waiting for input, live');
    expect(chip.querySelector('svg.gc-agent-icon')!.getAttribute('aria-label')).toBe('claude');
  });

  it('offers a link only for the sessions the hub named', () => {
    const two = snapshot({
      lanes: [
        {
          id: 'build',
          title: 'Build',
          cards: [
            card(4501, {
              sessions: [session(), session({ sessionId: OTHER_ID, agent: 'codex' })],
            }),
          ],
        },
      ],
    });

    paint(document, state({ snapshot: two }), NOW, actions);

    expect(Array.from(badges()[0]!.querySelectorAll('.gc-session')).map((chip) => chip.tagName)).toEqual(['A', 'SPAN']);
  });

  /** GitHub's card is a button wrapped around the footer, so a click that reached it would open the issue instead. */
  it('keeps the click off the card underneath it', () => {
    paint(document, state(), NOW, actions);

    const onCard = vi.fn();

    document.querySelector('[data-gc-issue]')!.addEventListener('click', onCard);

    // Cancelled here only to keep jsdom from trying the navigation itself; the overlay leaves that to the browser.
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });

    click.preventDefault();
    badges()[0]!.querySelector<HTMLElement>('.gc-session')!.dispatchEvent(click);

    expect(onCard).not.toHaveBeenCalled();
  });
});


describe('historical session rows', () => {
  const lastSession = { agent: 'claude', sessionId: SESSION_ID, title: 'Past attempt', cwd: '/work/4501-test', branch: '4501-test', issueNumber: 4501, repository: 'github.com/example-org/example-repo', updatedAt: NOW - 60000 };
  const show = (entry: LanedCard) => paint(document, state({ snapshot: snapshot({ lanes: [{ id: 'build', title: 'Build', cards: [entry] }], openable: [] }) }), NOW, actions);
  /** Saved sessions resume in the editor; they have no process to attach to. */
  it('marks a saved session as opening in the editor, once the host offers it', () => {
    const offered = (entry: LanedCard) =>
      paint(document, state({ snapshot: snapshot({ lanes: [{ id: 'build', title: 'Build', cards: [entry] }], openable: [SESSION_ID] }) }), NOW, actions);

    show(card(4501, { sessions: [], lastSession }));

    expect(document.querySelector('.gc-historical .gc-destination')).toBeNull();

    offered(card(4501, { sessions: [], lastSession }));

    expect(document.querySelector('.gc-historical .gc-destination')?.getAttribute('data-destination')).toBe('editor');
  });

  it('renders an inert history row when not offered by the host, and updates its age', () => {
    show(card(4501, { sessions: [], lastSession }));
    const row = document.querySelector<HTMLElement>('.gc-historical')!;
    expect(row.tagName).toBe('SPAN'); expect(row.hasAttribute('href')).toBe(false);
    // Assert phase absence on the row and dot; the age attribute alone does not establish it.
    expect(row.querySelector('a, button')).toBeNull();
    // One line: the value alone floats to the right, and what it is a value of is said by the hollow mark.
    expect(row.dataset.phase).toBeUndefined();
    expect(row.querySelector('.gc-dot')?.getAttribute('data-phase')).toBe('none');
    expect(row.querySelector('.gc-dot')?.getAttribute('data-live')).toBe('false');
    expect(row.querySelector('.gc-state')!.textContent).toBe('1m');
    expect(row.textContent).not.toContain('Last session');
    row.click(); expect(actions.move).not.toHaveBeenCalled(); expect(actions.repaint).not.toHaveBeenCalled();
    tickDurations(document, NOW + 60000);
    expect(row.querySelector('.gc-state')!.textContent).toBe('2m');
    show(card(4501, { lastSession })); expect(document.querySelector('.gc-historical')).toBeNull();
    show(card(4501, { sessions: [], lastSession: { ...lastSession, title: 'Renamed' } }));
    expect(document.querySelector('.gc-historical')?.textContent).toContain('Renamed');
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
    const at = NOW - 300_000;
    const error = { kind: 'overloaded', message: 'API Error: 529 Overloaded.' };

    show(card(4501, { sessions: [], lastSession: { ...lastSession, retained: { phase, event: 'PreToolUse', at, ...(phase === 'failed' ? { error } : {}) } } }));

    const row = document.querySelector<HTMLElement>('.gc-historical')!;

    expect(row.dataset.phase).toBe(drawn);
    expect(row.querySelector('.gc-dot')?.getAttribute('data-phase')).toBe(drawn);
    // The fill is what says the process is gone, and it stays off whatever the phase.
    expect(row.querySelector('.gc-dot')?.getAttribute('data-live')).toBe('false');
    expect(tipOf(row.querySelector('.gc-dot'))).toContain(said);
    expect(tipOf(row.querySelector('.gc-dot'))).toContain('PreToolUse');
    // Use retained event time for both duration and tooltip instead of transcript modification time (R24).
    expect(row.querySelector('.gc-state')!.textContent).toBe('5m');
    expect(tipOf(row.querySelector('.gc-state'))).toContain('Last seen');
    expect(tipOf(row.querySelector('.gc-state'))).toContain(new Date(at).toLocaleString());

    // A resumable row states the retained phase itself; its dot's name would be replaced by the row's (R2).
    const entry = card(4501, { sessions: [], lastSession: { ...lastSession, retained: { phase, event: 'PreToolUse', at } } });

    paint(
      document,
      state({ snapshot: snapshot({ lanes: [{ id: 'build', title: 'Build', cards: [entry] }], openable: [SESSION_ID] }) }),
      NOW,
      actions,
    );

    expect(document.querySelector('.gc-historical')!.getAttribute('aria-label')).toBe(
      `Past attempt, Claude, ${drawn === 'waiting' ? 'waiting for input' : drawn}, ended — resume this session in VS Code.`,
    );
  });

  /** Include retained activity in the footer signature; duration updates must preserve its observation timestamp. */
  it('rebuilds a kept row when the reading on it changes', () => {
    const withReading = (phase: 'waiting' | 'idle') =>
      card(4501, { sessions: [], lastSession: { ...lastSession, retained: { phase, event: 'PreToolUse', at: NOW - 60_000 } } });

    show(withReading('waiting'));
    expect(document.querySelector<HTMLElement>('.gc-historical')!.dataset.phase).toBe('waiting');

    show(withReading('idle'));
    expect(document.querySelector<HTMLElement>('.gc-historical')!.dataset.phase).toBe('idle');
  });

  it('draws the plain hollow mark for a saved session carrying a reading it cannot read', () => {
    for (const retained of [undefined, { phase: 'waiting', event: 'PreToolUse' }, { phase: 'napping', event: 'PreToolUse', at: 1 }]) {
      show(card(4501, { sessions: [], lastSession: { ...lastSession, ...(retained ? { retained } : {}) } as typeof lastSession }));

      const row = document.querySelector<HTMLElement>('.gc-historical')!;

      expect(row.querySelector('.gc-dot')?.getAttribute('data-phase')).toBe('none');
      expect(row.querySelector('.gc-state')!.textContent).toBe('1m');
      expect(tipOf(row.querySelector('.gc-state'))).toContain('Last saved');
    }
  });

  it('handles cached payloads with absent or malformed history and falls back to the directory label', () => {
    show(card(4501, { sessions: [] })); expect(document.querySelector('.gc-historical')).toBeNull();
    show(card(4501, { sessions: [], lastSession: { ...lastSession, updatedAt: NaN } })); expect(document.querySelector('.gc-historical')).toBeNull();
    show(card(4501, { sessions: [], lastSession: { ...lastSession, agent: 'other', title: null } }));
    expect(document.querySelector('.gc-historical')?.textContent).toContain('4501-test');
  });
});


/** The hub names the connected editor; an Insiders developer's links must open Insiders, not stable. */
it('writes session links in the scheme the connected editor reports, and in stable\'s without one', () => {
  const insiders = snapshot({ editor: { uriScheme: 'vscode-insiders' } });

  paint(document, state({ snapshot: insiders }), NOW, actions);
  expect(document.querySelector<HTMLAnchorElement>('.gc-session')!.getAttribute('href')).toBe(`vscode-insiders://groundcontrol.ground-control/open?session=${SESSION_ID}&agent=claude`);

  paint(document, state({ snapshot: snapshot({ editor: { uriScheme: 'java script' } }) }), NOW, actions);
  expect(document.querySelector<HTMLAnchorElement>('.gc-session')!.getAttribute('href')).toBe(`vscode://groundcontrol.ground-control/open?session=${SESSION_ID}&agent=claude`);
});

it('links historical rows through the same VS Code handler without opening the GitHub card', () => {
  const lastSession = { agent: 'claude', sessionId: SESSION_ID, title: 'Past attempt', cwd: '/work/4501-test', branch: '4501-test', issueNumber: 4501, repository: 'github.com/example-org/example-repo', updatedAt: NOW - 60000 };
  const entry = card(4501, { sessions: [], lastSession });
  paint(document, state({ snapshot: snapshot({ lanes: [{ id: 'build', title: 'Build', cards: [entry] }], openable: [SESSION_ID] }) }), NOW, actions);
  const link = document.querySelector<HTMLAnchorElement>('a.gc-historical')!;
  expect(link.href).toBe(`vscode://groundcontrol.ground-control/open?session=${SESSION_ID}&agent=claude`);
  expect(link.draggable).toBe(false);
  expect(link.getAttribute('aria-label')).toBe('Past attempt, Claude, no state reported, ended — resume this session in VS Code.');
  expect(tipOf(link.querySelector('.gc-state'))).toContain('Resume this session');
  const parentClick = vi.fn(); link.parentElement!.addEventListener('click', parentClick);
  link.addEventListener('click', (event) => event.preventDefault()); link.click();
  expect(parentClick).not.toHaveBeenCalled();
});

describe('card actions (R39)', () => {
  const at = Date.UTC(2026, 8, 1, 19, 0, 0);
  const show = (entry: LanedCard) =>
    paint(document, state({ snapshot: snapshot({ lanes: [{ id: 'build', title: 'Build', cards: [entry] }], openable: [] }) }), NOW, actions);
  /** The run control, which the bar reveals in the age's place. */
  const mark = () => document.querySelector<HTMLButtonElement>('button.gc-run');
  /** What the bar says while an action is dispatched: the state displaces the triage qualifier. */
  const said = () => document.querySelector<HTMLElement>('.gc-verdict .gc-note')?.textContent;
  const acting = (action: NonNullable<LanedCard['action']>): LanedCard => card(4501, { sessions: [], action });

  it('stops a running action, warning that its changes may be incomplete', () => {
    show(acting({ state: 'running', action: 'merge-upstream', since: at }));

    expect(said()).toBe('Working…');
    expect(mark()?.getAttribute('aria-label')).toBe('Stop merge upstream');
    expect(tipOf(mark())).toBe(
      'Merge upstream is running. Click to stop. Changes remain in the checkout and may be incomplete.',
    );

    mark()!.click();

    expect(actions.stopAction).toHaveBeenCalledWith('issue-4501');
  });

  // Left out rather than drawn to refuse, which is the rule every other control here follows.
  it('carries a refusal and its reason, with nothing to press', () => {
    show(acting({ state: 'refused', action: 'merge-upstream', reason: 'The pull request is a draft.' }));

    expect(said()).toBe('Not run');
    expect(mark()?.getAttribute('aria-disabled')).toBe('true');
    // Reachable, or the reason it refuses could not be read.
    expect(mark()?.getAttribute('aria-description')).toBe('The pull request is a draft.');
    expect(tipOf(mark())).toBe('The pull request is a draft.');
  });

  it('offers to run an action the board could take, and sends the card key when pressed', () => {
    show(acting({ state: 'available', action: 'merge-upstream' }));

    expect(mark()?.getAttribute('aria-label')).toBe('Run merge upstream');
    expect(tipOf(mark())).toBe('Start Merge upstream in this card\u2019s checkout.');

    mark()!.click();

    expect(actions.runAction).toHaveBeenCalledWith('issue-4501');
  });

  it('offers to run a finished action again', () => {
    show(acting({ state: 'done', action: 'merge-upstream', outcome: 'halted', detail: 'Conflicts in Booking.cs.', at }));

    mark()!.click();

    expect(actions.runAction).toHaveBeenCalledWith('issue-4501');
  });

  /** Verify the same literal outcome words against board.js, which cannot share a runtime import. */
  it.each([
    ['landed', 'Merged', 'Merged master.'],
    ['halted', 'Stopped short', 'Conflicts in Booking.cs.'],
    ['failed', 'Did not run', 'Claude Code was not found.'],
    ['stopped', 'Stopped', 'Stopped by you.'],
  ] as const)('reads a %s run as "%s"', (outcome, text, detail) => {
    show(acting({ state: 'done', action: 'merge-upstream', outcome, detail, at }));

    expect(said()).toBe(text);
    expect(mark()?.dataset.outcome).toBe(outcome);
    expect(document.querySelector<HTMLElement>('.gc-verdict')?.dataset.outcome).toBe(outcome);
    expect(tipOf(mark())).toBe(`${detail} Click to run Merge upstream again.`);
  });

  it('carries nothing on a card with no action at all', () => {
    show(card(4501, { sessions: [] }));

    expect(mark()).toBeNull();
  });

  /** The footer is cached by signature, so a state change has to rebuild it or the old outcome would stand. */
  it('repaints the footer when the action changes state', () => {
    show(acting({ state: 'running', action: 'merge-upstream', since: at }));

    expect(said()).toBe('Working…');

    show(acting({ state: 'done', action: 'merge-upstream', outcome: 'landed', detail: 'Merged master.', at }));

    expect(said()).toBe('Merged');
  });
});

describe('card triage (R38)', () => {
  const show = (entry: LanedCard) =>
    paint(document, state({ snapshot: snapshot({ lanes: [{ id: 'build', title: 'Build', cards: [entry] }], openable: [] }) }), NOW, actions);
  const mark = () => document.querySelector<HTMLElement>('.gc-verdict');
  /** The reread control, which stands where the age does until the bar is pointed at. */
  const again = () => document.querySelector<HTMLButtonElement>('.gc-tool[aria-label^="Read this card"]');
  /** The status moved at `at`, which is a different time from the reading's — a test must not pass on the wrong one. */
  const moved = (entry: LanedCard, at: string): LanedCard => ({ ...entry, issue: { ...entry.issue!, statusChangedAt: at } });

  it('says a card is being read, and rings nothing while it does', () => {
    show(card(4501, { sessions: [], triage: { state: 'running' } }));

    expect(mark()?.textContent).toBe('Reading…');
    expect(mark()?.dataset.state).toBe('triaging');
    // R36 keeps colour for the two things that want the developer, and being read is neither.
    expect(document.querySelector(`[${'data-gc-attention'}]`)).toBeNull();
  });

  it('names the action, ages the status beside it, and holds the sentence and the reading age on hover', () => {
    show(
      moved(card(4501, {
        sessions: [],
        triage: { state: 'done', action: 'qa-failure', qualifier: null, detail: 'Safari still shows an empty second page.', at: NOW - 3_600_000, stale: false },
      }), new Date(NOW - 2 * 86_400_000).toISOString()),
    );

    // Display status age at the bar's right edge; keep classification time and explanation in the tooltip.
    expect(mark()?.textContent).toBe('QA failure');
    expect(document.querySelector('.gc-tail .gc-age')?.textContent).toBe('2d');
    expect(tipOf(mark())).toBe('Safari still shows an empty second page. Read 1h ago.');
  });

  // A card the project board records no move for — one off the board — carries the action and nothing after it.
  it('writes no age where GitHub records no status move', () => {
    show(
      card(4501, {
        sessions: [],
        triage: { state: 'done', action: 'qa-failure', qualifier: null, detail: 'Still empty.', at: NOW - 3_600_000, stale: false },
      }),
    );

    expect(mark()?.textContent).toBe('QA failure');
    expect(document.querySelector('.gc-age')).toBeNull();
  });

  it('advances the status age where it stands, on the same clock as a session duration', () => {
    show(
      moved(card(4501, {
        sessions: [],
        triage: { state: 'done', action: 'qa-failure', qualifier: null, detail: 'Still empty.', at: NOW, stale: false },
      }), new Date(NOW - 3_600_000).toISOString()),
    );

    const age = document.querySelector<HTMLElement>('.gc-age')!;

    tickDurations(document, NOW + 3_600_000);

    expect(age.textContent).toBe('2h');
  });

  it('marks a reading the card has moved under', () => {
    show(
      card(4501, {
        sessions: [],
        triage: { state: 'done', action: 'develop', qualifier: null, detail: 'Pick it up.', at: NOW - 60_000, stale: true },
      }),
    );

    expect(mark()?.dataset.stale).toBe('true');
    // The sentence, when it was read, and the caveat — the caveat is about the sentence, so they read together.
    expect(tipOf(mark())).toBe('Pick it up. Read 1m ago; card details have changed.');
  });

  it('says a card could not be read, and offers no control where the hub reports none', () => {
    show(card(4501, { sessions: [], triage: { state: 'failed', attempts: 2, exhausted: false } }));

    expect(mark()?.textContent).toBe('Not read');
    expect(tipOf(mark())).toBe('Triage failed.');
    expect(again()).toBeNull();
  });

  /** Same failure wording as the editor board (docs/testing.md); only the remedy differs. */
  it('reports the attempts behind a failure that stopped retrying', () => {
    show(card(4501, { sessions: [], triage: { state: 'failed', attempts: 5, exhausted: true } }));

    expect(mark()?.textContent).toBe('Not read');
    expect(tipOf(mark())).toBe('Triage failed after 5 attempts. Automatic retries stopped.');
  });

  it('says so on a card that has not been read', () => {
    show(card(4501, { sessions: [] }));

    expect(mark()?.textContent).toBe('Not read');
    expect(tipOf(mark())).toBe('This card has not been read.');
  });

  /** Paint one card of each triage state and collect the marks and controls in document order. */
  function marksFor(mode: 'manual' | 'off' | 'automatic', canRequest: boolean) {
    const cards = [
      card(4501, { sessions: [] }),
      card(4502, { sessions: [], triage: { state: 'failed', attempts: 2, exhausted: false } }),
      card(4503, { sessions: [], triage: { state: 'done', action: 'develop', qualifier: null, detail: 'Pick it up.', at: NOW, stale: false } }),
    ];

    paint(document, state({ snapshot: snapshot({
      lanes: [{ id: 'build', title: 'Build', cards }],
      triage: { mode, message: null, canRequest },
    }) }), NOW, actions);

    return [...document.querySelectorAll<HTMLElement>('.gc-verdict')];
  }

  it.each(['manual', 'automatic'] as const)('offers reading beside each result in %s mode', (mode) => {
    const marks = marksFor(mode, true);

    expect(marks.map((entry) => entry.textContent)).toEqual(['Not read', 'Not read', 'Develop']);

    const reads = [...document.querySelectorAll<HTMLElement>('.gc-tool[aria-label^="Read this card"]')];

    // Every card carries the control, whatever it has been read as.
    expect(reads.map((entry) => entry.getAttribute('aria-label'))).toEqual([
      'Read this card',
      'Read this card',
      'Read this card again',
    ]);
    // Both reads spend the allowance and both clients say so; pinned here and on the editor board.
    expect(tipOf(reads[0])).toBe('Identify the next action. Uses model usage.');
    // Hovering to reach the control is what hides the age, so the control states it for a card already read.
    expect(tipOf(reads[2])).toBe('Read this card again. Last read 0s ago. Uses model usage.');
  });

  /** Paint one read card with reading offered, the state that carries the label's own reread control. */
  function showRead(entry: LanedCard) {
    paint(document, state({ snapshot: snapshot({
      lanes: [{ id: 'build', title: 'Build', cards: [entry] }],
      triage: { mode: 'manual', message: null, canRequest: true },
    }) }), NOW, actions);
  }

  const read = card(4503, {
    sessions: [],
    triage: { state: 'done', action: 'develop', qualifier: null, detail: 'Pick it up.', at: NOW, stale: false },
  });

  /** The age is what the bar carries at rest, and the controls stand in its place, so they share one slot. */
  it('stacks the status age and the controls in one right-edge slot', () => {
    showRead(moved(read, '2026-09-04T19:00:00Z'));

    const tail = document.querySelector('.gc-cmdbar > .gc-tail')!;

    expect([...tail.children].map((el) => el.className)).toEqual(['gc-age', 'gc-tools']);
    expect([...tail.querySelectorAll('.gc-tool')].map((el) => el.getAttribute('aria-label'))).toEqual([
      'Read this card again',
    ]);
  });

  /** The worktree the card has, one press away, named for what it opens rather than for code in general. */
  it('opens the checkout from the bar, in the order read, open, run', () => {
    showRead({
      ...moved(read, '2026-09-04T19:00:00Z'),
      checkout: { root: 'c:/work/4503', source: 'session', only: true },
      action: { state: 'available', action: 'merge-upstream' },
    });

    const tools = [...document.querySelectorAll<HTMLButtonElement>('.gc-tail .gc-tool')];

    expect(tools.map((el) => el.getAttribute('aria-label'))).toEqual([
      'Read this card again',
      'Open in VS Code',
      'Run merge upstream',
    ]);
    expect(tipOf(tools[1])).toBe('Open c:/work/4503 in VS Code');

    tools[1]!.click();

    expect(actions.openCheckout).toHaveBeenCalledWith('issue-4503');
  });

  /** Keep the paid reread separate from opening the classification explanation (R38). */
  it('requests reading only from the control, not from the label or age around it', () => {
    showRead(moved(read, '2026-09-04T19:00:00Z'));

    mark()!.click();
    document.querySelector<HTMLElement>('.gc-age')!.click();
    expect(actions.retriage).not.toHaveBeenCalled();
    expect(mark()?.tagName).toBe('SPAN');

    again()!.click();
    expect(actions.retriage).toHaveBeenCalledWith('issue-4503');
  });

  /** The control sits inside GitHub's own card, which drags and opens on click (R36). */
  it('neither drags the card nor opens it when the reread is pressed', () => {
    showRead(read);

    const control = again()!;
    const opened = vi.fn();

    expect(control.getAttribute('draggable')).toBe('false');
    cardElement(4503).addEventListener('click', opened);

    const press = control.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(opened).not.toHaveBeenCalled();
    // GitHub opens the card from the link the badge sits inside, which a default press would follow.
    expect(press).toBe(false);
  });

  it('removes the controls and keeps the results in off mode', () => {
    const marks = marksFor('off', false);

    expect(marks.map((entry) => entry.textContent)).toEqual(['Not read', 'Not read', 'Develop']);
    expect(document.querySelectorAll('.gc-tool[aria-label^="Read this card"]')).toHaveLength(0);
  });

  /** The hub reports no classifier or conversation source through canRequest, whatever the mode (R38). */
  it('removes the controls when no classifier is available, even in automatic mode', () => {
    expect(marksFor('automatic', false).map((entry) => entry.textContent)).toEqual(['Not read', 'Not read', 'Develop']);
    expect(document.querySelectorAll('.gc-tool[aria-label^="Read this card"]')).toHaveLength(0);
  });

  it('sends the card key and nothing else, which is what makes it safe from a page', () => {
    marksFor('manual', true);
    document.querySelectorAll<HTMLElement>('.gc-tool[aria-label^="Read this card"]')[0]!.click();

    expect(actions.retriage).toHaveBeenCalledWith('issue-4501');
  });

  it('offers no reading on an archived or unassigned card, which is read-only', () => {
    paint(document, state({ snapshot: snapshot({
      lanes: [
        { id: 'archived', title: 'Archived', cards: [card(4501, { sessions: [], lane: 'archived' })] },
        { id: 'build', title: 'Build', cards: [card(4502, { sessions: [], unassigned: true })] },
      ],
      triage: { mode: 'manual', message: null, canRequest: true },
    }) }), NOW, actions);

    // Both cards drew a footer, so the absent control is a decision rather than a card that never rendered.
    expect(document.querySelectorAll(`.${'gc-badge'}`)).toHaveLength(2);
    expect(document.querySelectorAll('.gc-tool[aria-label^="Read this card"]')).toHaveLength(0);
  });

  /** Verify literal triage labels against packages/board and both clients, which cannot share runtime imports. */
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
    show(
      card(4501, {
        sessions: [],
        triage: { state: 'done', action: action as never, qualifier: qualifier as never, detail: 'x', at: NOW, stale: false },
      }),
    );

    expect(document.querySelector('.gc-verdict')?.textContent).toBe(expected);
  });
});

/** The browser board's half of R40: a sidebar, and the one panel a scan does not rebuild. */
describe('the log sidebar', () => {
  const line = (over: Partial<{ at: string; level: string; source: string; scope: string; message: string }> = {}) => ({
    at: '2026-09-04T12:00:00.000Z',
    level: 'info',
    source: 'hub',
    message: 'a line',
    ...over,
  });

  const sidebar = () => document.getElementById('gc-log');
  const lines = () => [...document.querySelectorAll<HTMLElement>('#gc-log-lines .gc-line')];

  function openMenu(): void {
    paint(document, state(), NOW, actions);
    document.querySelector<HTMLButtonElement>('#gc-menu button')!.click();
    paint(document, state(), NOW, actions);
  }

  it('paints no sidebar and asks for nothing until the developer opens it', () => {
    paint(document, state(), NOW, actions);

    expect(sidebar()).toBeNull();
    expect(actions.watchLog).not.toHaveBeenCalled();
  });

  it('opens from the menu, and that is what asks the hub for its log', () => {
    openMenu();

    const entry = [...document.querySelectorAll<HTMLButtonElement>('#gc-menu button')].find(
      (button) => button.textContent?.includes('Show log'),
    );

    expect(entry).toBeDefined();

    entry!.click();

    expect(actions.watchLog).toHaveBeenCalledWith(true);

    // Create the log panel before subscribing because backlog may arrive before the next frame.
    expect(sidebar()).not.toBeNull();
  });

  /** The exception to the rebuild rule: everything else on the page is redrawn, and this one is appended to. */
  it('survives a scan rather than being rebuilt, so lines already in it are not lost', () => {
    setLogOpen(document, true, actions);
    paint(document, state(), NOW, actions);

    const first = sidebar();

    appendLog(document, [line({ message: 'the hub is listening' })]);
    paint(document, state(), NOW, actions);

    expect(sidebar()).toBe(first);
    expect(lines().map((element) => element.textContent)).toEqual(['12:00:00 hub the hub is listening']);
  });

  it('tags each line by source and scope, and carries its level for the eye', () => {
    setLogOpen(document, true, actions);
    paint(document, state(), NOW, actions);
    appendLog(document, [
      line({ source: 'browser', scope: 'native', level: 'warn', message: 'the bridge went' }),
      line({ source: 'hub', scope: 'sources', message: 'github read 3 cards' }),
    ]);

    expect(lines().map((element) => element.dataset.source)).toEqual(['browser', 'hub']);
    expect(lines().map((element) => element.dataset.level)).toEqual(['warn', 'info']);
    expect(lines()[0]!.textContent).toBe('12:00:00 browser/native the bridge went');
  });

  it('holds the newest lines and drops the oldest', () => {
    setLogOpen(document, true, actions);
    paint(document, state(), NOW, actions);

    expect(appendLog(document, Array.from({ length: LOG_LIMIT + 5 }, (_, at) => line({ message: `#${at}` })))).toBe(
      LOG_LIMIT,
    );
    expect(lines()[0]!.textContent).toContain('#5');
  });

  it('hides a source the developer unticked without dropping its lines', () => {
    setLogOpen(document, true, actions);
    paint(document, state(), NOW, actions);
    appendLog(document, [line({ source: 'browser' }), line({ source: 'hub' })]);

    const box = document.querySelector<HTMLInputElement>('#gc-log input[data-shows="hub"]')!;

    box.checked = false;
    box.dispatchEvent(new Event('change'));

    expect(sidebar()!.dataset.showsHub).toBe('false');
    expect(sidebar()!.dataset.showsBrowser).toBe('true');
    // Hidden by the stylesheet, not deleted: ticking it again has to bring the same lines back.
    expect(lines()).toHaveLength(2);
  });

  /** R40 asks for the line-per-message detail a level down and off by default, on whichever board is looking. */
  it('starts with the detail level hidden, and shows it when the developer asks', () => {
    setLogOpen(document, true, actions);
    paint(document, state(), NOW, actions);
    appendLog(document, [line({ level: 'debug' }), line({ level: 'info' })]);

    const box = document.querySelector<HTMLInputElement>('#gc-log input[data-shows="debug"]')!;

    expect(box.checked).toBe(false);
    expect(sidebar()!.dataset.showsDebug).toBe('false');
    expect(getComputedStyle(lines()[0]!).display).toBe('none');
    expect(getComputedStyle(lines()[1]!).display).not.toBe('none');

    box.checked = true;
    box.dispatchEvent(new Event('change'));

    expect(sidebar()!.dataset.showsDebug).toBe('true');
    expect(getComputedStyle(lines()[0]!).display).not.toBe('none');
  });

  it('unsubscribes from hub logs on close', () => {
    setLogOpen(document, true, actions);
    paint(document, state(), NOW, actions);
    actions.watchLog.mockReset();

    document.querySelector<HTMLButtonElement>('#gc-log .gc-close')!.click();

    expect(actions.watchLog).toHaveBeenCalledWith(false);
    expect(sidebar()).toBeNull();
  });

  /** A tab that clicked through to some other page of github.com is not a viewer, so nothing is left streaming. */
  it('goes with the board when the overlay is cleared', () => {
    setLogOpen(document, true, actions);
    paint(document, state(), NOW, actions);

    clear(document);

    expect(sidebar()).toBeNull();

    // Verify a later scan does not recreate a log panel after leaving the board.
    paint(document, state(), NOW, actions);

    expect(sidebar()).toBeNull();
  });

  it('closes and unsubscribes on outside click', () => {
    setLogOpen(document, true, actions);
    paint(document, state(), NOW, actions);
    actions.watchLog.mockReset();

    document.querySelector<HTMLElement>('[data-board-card-id]')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );

    expect(actions.watchLog).toHaveBeenCalledWith(false);
    expect(sidebar()).toBeNull();
  });

  it('stays while the developer is working inside it', () => {
    setLogOpen(document, true, actions);
    paint(document, state(), NOW, actions);
    appendLog(document, [line()]);
    actions.watchLog.mockReset();

    document
      .querySelector<HTMLInputElement>('#gc-log input[data-shows="hub"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(actions.watchLog).not.toHaveBeenCalled();
    expect(sidebar()).not.toBeNull();
    expect(lines()).toHaveLength(1);
  });

  /** The menu is what the sidebar was opened from, so using it again is not clicking off the sidebar. */
  it('stays while the developer is using the menu it was opened from', () => {
    openMenu();
    setLogOpen(document, true, actions);
    paint(document, state(), NOW, actions);
    document.querySelector<HTMLButtonElement>('#gc-menu button')!.click();
    actions.watchLog.mockReset();
    paint(document, state(), NOW, actions);

    expect(sidebar()).not.toBeNull();
    expect(actions.watchLog).not.toHaveBeenCalled();
  });

  describe('pinned', () => {
    const pin = () => document.querySelector<HTMLInputElement>('#gc-log input[data-pin]')!;

    function clickTheBoard(): void {
      document.querySelector<HTMLElement>('[data-board-card-id]')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    }

    it('starts off, so the sidebar is out of the way the moment it is not being read', () => {
      setLogOpen(document, true, actions);
      paint(document, state(), NOW, actions);

      expect(pin().checked).toBe(false);
      expect(sidebar()!.dataset.pinned).toBe('false');
    });

    it('keeps the sidebar and the hub when the developer clicks back onto the board', () => {
      setLogOpen(document, true, actions);
      paint(document, state(), NOW, actions);
      pin().checked = true;
      pin().dispatchEvent(new Event('change'));
      paint(document, state(), NOW, actions);
      actions.watchLog.mockReset();

      clickTheBoard();

      expect(sidebar()).not.toBeNull();
      expect(sidebar()!.dataset.pinned).toBe('true');
      expect(actions.watchLog).not.toHaveBeenCalled();
    });

    it('gives the auto-hide back when it is unticked', () => {
      setLogOpen(document, true, actions);
      paint(document, state(), NOW, actions);
      pin().checked = true;
      pin().dispatchEvent(new Event('change'));
      paint(document, state(), NOW, actions);

      pin().checked = false;
      pin().dispatchEvent(new Event('change'));
      paint(document, state(), NOW, actions);
      actions.watchLog.mockReset();

      clickTheBoard();

      expect(actions.watchLog).toHaveBeenCalledWith(false);
      expect(sidebar()).toBeNull();
    });

    /**
     * Open a menu to install the outside-click handler, then verify dismissing it preserves the pinned
     * sidebar.
     */
    it('survives the click that closes a menu opened over it', () => {
      setLogOpen(document, true, actions);
      paint(document, state(), NOW, actions);
      pin().checked = true;
      pin().dispatchEvent(new Event('change'));

      document.querySelector<HTMLButtonElement>('#gc-menu button')!.click();
      paint(document, state(), NOW, actions);

      expect(document.querySelector('#gc-menu .gc-popover')).not.toBeNull();
      actions.watchLog.mockReset();

      clickTheBoard();
      paint(document, state(), NOW, actions);

      expect(sidebar()).not.toBeNull();
      expect(actions.watchLog).not.toHaveBeenCalled();
      expect(document.querySelector('#gc-menu .gc-popover')).toBeNull();
    });

    /** Leaving a board takes the sidebar with it, so the pin cannot outlive what it was pinning. */
    it('does not survive the overlay being cleared', () => {
      setLogOpen(document, true, actions);
      paint(document, state(), NOW, actions);
      pin().checked = true;
      pin().dispatchEvent(new Event('change'));

      clear(document);
      setLogOpen(document, true, actions);
      paint(document, state(), NOW, actions);

      expect(pin().checked).toBe(false);
    });
  });

  it('appends nothing when there is no sidebar to append to', () => {
    expect(appendLog(document, [line()])).toBe(0);
  });
});

/** Verify each duration element, timestamp attribute, and literal timer output in both clients. */
describe('the age attribute both boards share', () => {
  const AGE_ROWS: [string, string, number, string][] = [
    ['a session state', '.gc-state', 125_000, '2m'],
    ['a saved session', '.gc-historical .gc-state', 60_000, '1m'],
    ['the age of a status', '.gc-age', 10_800_000, '3h'],
    ["the reading's own age", '#gc-menu .gc-popover [data-gc-since]', 90_000, '1m'],
  ];

  it.each(AGE_ROWS)('marks %s and reads it %s', (kind, selector, held, expected) => {
    const drawn: LanedCard =
      kind === 'a saved session'
        ? card(4501, { sessions: [], lastSession: { agent: 'claude', sessionId: OTHER_ID, title: 'Past attempt', cwd: '/work/4501', branch: '4501', issueNumber: 4501, repository: `github.com/${REPO}`, updatedAt: NOW - held } })
        : card(4501, {
            sessions: [session({ activity: { phase: 'running', since: NOW - held, at: NOW - held, event: 'PreToolUse' } })],
            triage: { state: 'done', action: 'develop', qualifier: null, detail: 'Pick it up.', at: NOW - 60_000, stale: false },
            issue: { ...card(4501).issue!, statusChangedAt: new Date(NOW - held).toISOString() },
          });
    const shown = state({
      snapshot: snapshot({ lanes: [{ id: 'build', title: 'Build', cards: [drawn] }], fetchedAt: new Date(NOW - held).toISOString() }),
    });

    paint(document, shown, NOW, actions);
    document.querySelector<HTMLElement>('#gc-menu button')!.click();
    paint(document, shown, NOW, actions);

    const element = document.querySelector(selector)!;

    expect(element.getAttribute('data-gc-since')).toBe(String(NOW - held));
    expect(element.textContent).toBe(expected);
  });
});

/**
 * Assert identical tooltip geometry and timing in both client suites (mechanics M35).
 */
describe('the tooltip shape both boards share', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'overlay.js'), 'utf8');
  const rule = source.slice(source.indexOf('#${TIP_ID} {'), source.indexOf('#${TIP_ID}[data-open'));

  const numbers: [string, RegExp, number][] = [
    ['delay', /const TIP_DELAY = (\d+);/, 120],
    ['gap', /const TIP_GAP = (\d+);/, 4],
    ['margin', /const TIP_MARGIN = (\d+);/, 8],
  ];

  it.each(numbers)('pins %s at %s', (_name, pattern, expected) => {
    expect(Number(pattern.exec(source)?.[1])).toBe(expected);
  });

  const declarations: [string, string][] = [
    ['font-size', '12px'],
    ['padding', '4px 8px'],
    ['max-width', '250px'],
    ['line-height', '1.625'],
    ['text-align', 'center'],
  ];

  it.each(declarations)('pins %s at %s', (name, expected) => {
    expect(rule).toContain(`${name}: ${expected}`);
  });
});

describe('what the page says about its filter and its viewer', () => {
  it('reads the filter box GitHub renders and the login it states, from the recorded markup', () => {
    document.documentElement.innerHTML = BOARD;

    expect(filterText(document)).toBe('assignee:example-dev');
    expect(filterBox(document)).toBe(document.getElementById('filter-bar-component-input'));
    expect(viewerLogin(document)).toBe('example-dev');
  });

  /** A signed-out page carries the meta element with nothing in it; a page with no board carries no filter box. */
  it('answers with nothing rather than an empty string when signed out or off a board', () => {
    document.documentElement.innerHTML = '<head><meta name="user-login" content=""></head><body><p>Not a project board</p></body>';

    expect(viewerLogin(document)).toBeNull();
    expect(filterText(document)).toBeNull();
    expect(filterBox(document)).toBeNull();
  });
});
