import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueCard, Lane, LaneId, LanedCard, Session, Snapshot } from '@ground-control/core';
import { LOG_LIMIT, ago, agentIcon, appendLog, assigneeStackOf, cardsByIssue, clear, foldedRows, issueRefOf, paint, sessionLabel, setLogOpen, tickDurations, triageText } from '../src/overlay.js';

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
    activity: { phase: 'waiting', since: NOW - 125_000, event: 'PermissionRequest' },
    finished: false,
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
    issues: { count: 1, matched: 1, totalAssigned: 1, notOnProject: 0, truncated: false, fetchedAt: '' },
    sessions: { count: 1, patternError: null, fetchedAt: '' },
    // What the hub sends a browser board: every session of an agent the host is placed for, which is Claude's (R14).
    openable: (over.lanes ?? shown)
      .flatMap((lane) => lane.cards)
      .flatMap((entry) => entry.sessions)
      .filter((entry) => entry.agent === 'claude')
      .map((entry) => entry.sessionId),
    hooks: null,
    failures: [],
    stale: false,
    needs: null,
    fetchedAt: new Date(NOW - 90_000).toISOString(),
    ...over,
  };
}

const actions = { refresh: vi.fn(), move: vi.fn(), repaint: vi.fn(), watchLog: vi.fn() };

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

  /** A session naming an issue the developer is not assigned carries a number and no issue behind it. */
  it('indexes a card the hub knows the number of but not the repository', () => {
    const unknown = card(4501, { issue: null });
    const index = cardsByIssue(snapshot({ lanes: [{ id: 'build', title: 'Build', cards: [unknown] }] }));

    expect([...index.byRef.keys()]).toEqual([]);
    expect([...index.byNumber.keys()]).toEqual([4501]);
  });
});

/**
 * The board names who a card is assigned to, which on a card in review is who was asked rather than who answered.
 * The hub has already picked between the two — `selectCardAvatar` in `@ground-control/github` — and this is the
 * overlay honouring that pick on GitHub's own markup rather than making it again.
 */
describe('swapping the assignee for the pull request author', () => {
  it('finds the assignee figure GitHub draws, and reports none where it draws none', () => {
    expect(assigneeStackOf(cardElement(4501))).not.toBeNull();
    expect(assigneeStackOf(cardElement(4503))).toBeNull();
  });

  /**
   * `closest` climbs without a limit of its own. A build that dropped the `figure` while keeping the stack would
   * otherwise hand back one above the card, and the rule that empties a taken-over figure would blank a region of
   * the board that no later scan looks inside to hand back.
   */
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

  /** Every scan rewrites from scratch (`mechanics.md` §27), so a second paint must not stack a second avatar. */
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
   * The scan's own observer watches for nodes and is armed again by the time an avatar finishes loading, so an
   * image taken out of the tree on failure schedules a scan that draws it again — a repaint loop at frame rate,
   * measured at 182 paints in three seconds before the image was hidden instead.
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
   * Every scan builds the slot again, and the board rescans on a ten-second clock. Initials the image's own load
   * event had to clear showed for a frame on each of those, measured in Chromium against a cached avatar — so they
   * wait behind the image rather than in front of it, and nothing has to fire for the avatar to be what is drawn.
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
});

/**
 * The board draws its own tooltip rather than leaving `title` to the browser: the native one opens after about a
 * second, in the operating system's shape, and cannot be made to match the page it sits on. GitHub's own geometry
 * and timing, measured (`docs/mechanics.md` §35) and pinned by the parity table both suites carry.
 */
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

  it('draws nothing until a pointer has rested on something that says something', () => {
    const avatar = document.querySelector('.gc-actor')!;

    hover(avatar);

    expect(open()).toBeNull();

    vi.advanceTimersByTime(120);

    expect(open()).toBe('true');
    expect(tip()?.textContent).toBe('colleague · pull request author');
  });

  /** One node for the whole document: a scan replaces every card, and a node per anchor would be built by the hundred. */
  it('reuses one element however many things are hovered', () => {
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
  it('leaves the text of what it names alone', () => {
    const avatar = document.querySelector('.gc-actor')!;
    const lane = document.querySelector('.gc-lane')!;

    hover(avatar);
    vi.advanceTimersByTime(120);

    expect(avatar.textContent).toBe('CO');
    expect(lane.textContent).toBe('Build');
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
   * The description is on the anchor and always there, not written as the tooltip opens: one written on `focusin`
   * lands 120ms after focus was announced, and a reader never hears it. `title` had this for free.
   */
  it('describes what it names before anything is hovered at all', () => {
    const row = document.querySelector('.gc-session')!;

    expect(row.getAttribute('aria-description')).toContain('go to this session in VS Code');
    // And nothing is wired up as the tooltip opens: GitHub's own cards carry `aria-describedby`, the overlay's do not.
    expect(document.querySelector(`[data-gc-tip][aria-describedby]`)).toBeNull();
  });

  /** A reader says the name, then the description. The same words in both is the board saying it twice. */
  it('never gives one element both a name and a description', () => {
    const both = [...document.querySelectorAll('[aria-description]')].filter((el) => el.hasAttribute('aria-label'));

    expect(both.map((el) => el.getAttribute('aria-label'))).toEqual([]);
    // The avatar is the one that would: it is named for a reader and its tooltip says the same thing.
    expect(document.querySelector('.gc-actor')!.getAttribute('aria-label')).toBe('colleague, pull request author');
    expect(document.querySelector('.gc-actor')!.hasAttribute('aria-description')).toBe(false);
  });

  it('opens on focus, for a developer who never touches the pointer', () => {
    document.querySelector('.gc-session')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    vi.advanceTimersByTime(120);

    expect(open()).toBe('true');
    expect(tip()?.textContent).toContain('go to this session in VS Code');
  });

  /**
   * `mouseout` fires as the pointer crosses between an anchor's own children, and closing on one of those shuts the
   * tooltip and reopens it as the pointer travels the width of what it is describing.
   */
  it('stays open as the pointer crosses its anchor own children', () => {
    const row = document.querySelector('.gc-session')!;
    const name = row.querySelector('.gc-name')!;

    hover(row);
    vi.advanceTimersByTime(120);

    name.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: row.querySelector('.gc-state') }));

    expect(open()).toBe('true');
  });

  /**
   * A scan inside the delay replaces the card the pointer was over. A detached anchor measures zero at the origin,
   * so the tooltip would open in the corner of the window naming a card that is gone.
   */
  it('never opens against an anchor the board has replaced', () => {
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

    paint(document, state({ snapshot: laneOf(actorCard(4501, AUTHOR)) }), NOW, actions);

    expect(open()).toBeNull();
  });

  /** Opening one is the board's own DOM change, and the scan's observer watches for exactly those (`mechanics.md` §27). */
  it('adds and removes no nodes when it opens', () => {
    const seen: MutationRecord[] = [];
    const observer = new MutationObserver((records) => seen.push(...records));

    observer.observe(document.documentElement, { childList: true, subtree: true });
    hover(document.querySelector('.gc-actor')!);
    vi.advanceTimersByTime(120);
    hover(document.querySelector('.gc-session')!);
    vi.advanceTimersByTime(120);

    const records = observer.takeRecords();

    observer.disconnect();

    expect(open()).toBe('true');
    expect([...seen, ...records]).toEqual([]);
  });

  /**
   * jsdom lays nothing out, so every rectangle here is given. The arithmetic is what is being pinned: centred on
   * the anchor, above it where there is room, below where there is not, and never outside the window either way.
   */
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
   * Nothing the overlay draws may carry `title`, in the attribute or as an SVG `<title>` child: the browser draws
   * its own from either, beside ours, saying the same thing. Counted across the whole page rather than under a list
   * of the overlay's own roots — GitHub's markup has `title` of its own, so what is asserted is that painting adds
   * none.
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
   * A project board spans repositories, and two of them numbering an issue 4501 is ordinary. Matching on the number
   * alone badges the wrong card, and its lane chip then moves a card the developer is not looking at.
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
   * A view switch replaces every card node and takes the badge with it (`mechanics.md` §27), and a repaint over
   * nodes that survived would leave two. Rewriting from scratch is what makes both cases one badge.
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
    expect(document.querySelectorAll('[data-gc-issue]')).toHaveLength(0);
  });
});

describe('the footer on a card', () => {
  function box(): Element {
    return document.querySelector(`[data-gc-issue="${REPO}#4501"]`)!.firstElementChild!;
  }

  /**
   * The card element is GitHub's drag handle wrapped around the bordered box that is drawn as the card. A footer
   * appended to the handle hangs below that border, reading as something dropped under the card rather than part of
   * it — which is what the developer sees, and the whole reason this is measured rather than assumed.
   */
  it('goes inside the card\u2019s own box, as its last line', () => {
    paint(document, state(), NOW, actions);

    expect(badges()[0]!.parentElement).toBe(box());
    expect(box().lastElementChild).toBe(badges()[0]);
  });

  it('names the lane the board has the card in', () => {
    const only = snapshot({ lanes: [{ id: 'review', title: 'Review', cards: [card(4501, { lane: 'review' })] }] });

    paint(document, state({ snapshot: only }), NOW, actions);

    expect(badges()[0]!.querySelector('.gc-lane')?.textContent).toBe('Review');
  });

  /** The name is the thing worth reading, and an inline chip clipped it — so the lane keeps one line and each session gets its own. */
  it('gives each session a line of its own, the width of the card', () => {
    const two = snapshot({
      lanes: [
        { id: 'build', title: 'Build', cards: [card(4501, { sessions: [session(), session({ sessionId: OTHER_ID })] })] },
      ],
    });

    paint(document, state({ snapshot: two }), NOW, actions);

    const badge = badges()[0]!;

    expect(badge.querySelector('.gc-lane')!.parentElement!.className).toBe('gc-head');
    expect([...badge.children].map((el) => el.className)).toEqual(['gc-head', 'gc-session', 'gc-session']);
    expect(getComputedStyle(badge.querySelector<HTMLElement>('.gc-session')!).width).toBe('100%');
  });

  it('marks a Claude session with Claude’s own mark, names it, and says the phase beside it', () => {
    paint(document, state(), NOW, actions);

    const chip = badges()[0]!.querySelector<HTMLElement>('.gc-session')!;

    expect(chip.querySelector('svg.gc-agent-icon')).not.toBeNull();
    expect(chip.querySelector('.gc-name')!.textContent).toBe('Working on it');
    expect(chip.querySelector('.gc-state')!.textContent).toBe('needs you 2m');
    // The whole name because the label ellipsises, and what the board saw because the duration does not say it.
    expect(tipOf(chip)).toBe(
      'Working on it — go to this session in VS Code. This session is waiting on you. Last seen at the PermissionRequest hook.',
    );
  });

  /** One mark, drawn for one agent. A second agent showing Claude's would be worse than showing none. */
  it('names an agent it has no mark for, rather than leaving the chip unattributed — R2', () => {
    const codex = snapshot({
      lanes: [{ id: 'build', title: 'Build', cards: [card(4501, { sessions: [session({ agent: 'codex' })] })] }],
    });

    paint(document, state({ snapshot: codex }), NOW, actions);

    const chip = badges()[0]!.querySelector('.gc-session')!;

    expect(chip.querySelector('svg')).toBeNull();
    expect(chip.querySelector('.gc-agent')!.textContent).toBe('codex');
    expect(agentIcon(document, 'codex')).toBeNull();
  });
});

describe('the menu in the board’s own filter bar', () => {
  function open(): void {
    document.querySelector<HTMLElement>('#gc-menu button')!.click();
    paint(document, state(), NOW, actions);
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

    expect(panelText()).toContain('Read this machine 1m ago');
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

    expect(panelText()).toContain('has not read this machine yet');
    expect(badges()).toHaveLength(0);
  });

  /** The button carries the one thing worth seeing without opening it: that what is on the board may be old. */
  it('marks itself when the reading is stale', () => {
    paint(document, state({ trouble: 'Ground Control is not running.' }), NOW, actions);

    expect(document.querySelector<HTMLElement>('#gc-menu button')!.dataset.stale).toBe('true');
  });

  it('asks the hub to read again, and closes', () => {
    paint(document, state(), NOW, actions);
    open();

    const refresh = document.getElementById('gc-refresh')!;

    // A button of GitHub's, not a line of text to click: the classes are the ones the bar's own buttons wear.
    expect(refresh.className).toBe(
      document.querySelector('[role="region"][aria-label="View filters"] button[data-component="Button"]')!.className,
    );

    refresh.click();
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
  /**
   * GitHub puts an 8px right margin on every column, in its own stylesheet, so this needs the `!important` — and
   * the class beside the attribute is hashed per build, which is what makes the attribute the only one to write.
   */
  it('pulls the columns together over the attribute rather than the hashed class', () => {
    paint(document, state(), NOW, actions);

    const columns = [...document.querySelectorAll<HTMLElement>('[data-board-column]')];

    expect(columns).toHaveLength(2);

    for (const column of columns) {
      expect(getComputedStyle(column).marginRight).toBe('-1px');
      expect(column.className).toMatch(/column-frame-module__Box__\w+/);
    }
  });

  /** Two strips, one per side, and the bottom line gone. `border-image` would have taken the 6px radius with it. */
  it('draws the dividers as strips that fade, over borders it has made transparent', () => {
    paint(document, state(), NOW, actions);

    const column = document.querySelector<HTMLElement>('[data-board-column]')!;
    const painted = getComputedStyle(column);

    for (const side of ['borderLeftColor', 'borderRightColor', 'borderBottomColor'] as const) {
      expect(painted[side]).toBe('rgba(0, 0, 0, 0)');
    }

    expect(painted.backgroundImage.match(/linear-gradient/g)).toHaveLength(2);
    expect(painted.backgroundImage).toContain('transparent');
    expect(painted.backgroundOrigin).toBe('border-box');
    expect(painted.backgroundSize).toBe('1px 100%, 1px 100%');
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
   * An anonymous recording can only ever show Discard: Save needs write access to the board. The container is what
   * the collapse hides, and finding it by either word is the whole of the rule.
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

  /** A view switch replaces those rows along with the cards (`mechanics.md` §27), and the replacement arrives shown. */
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
  /**
   * jsdom lays nothing out, so the two rects a placement is made of are given: where the button is, and how big the
   * panel turned out. Both are what the browser measures.
   */
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

  it('hangs under what opened it, left edges aligned', () => {
    measured({ left: 300, bottom: 120, top: 90 }, { width: 260, height: 140 });
    open();

    expect(panel().style.top).toBe('124px');
    expect(panel().style.left).toBe('300px');
  });

  /**
   * The button sits at the right-hand end of GitHub's filter bar, so left-aligning it runs off the window. Shifting
   * back by the panel's own width is the whole of the fix: a guess at that width left the menu adrift of its button.
   */
  it('shifts back from the window edge by no more than it has to', () => {
    measured({ left: 900, bottom: 120, top: 90 }, { width: 260, height: 140 });
    open();

    expect(window.innerWidth).toBe(1024);
    expect(panel().style.left).toBe('756px');
  });

  it('flips above the anchor rather than off the bottom of the window', () => {
    measured({ left: 300, top: 700, bottom: 740 }, { width: 260, height: 200 });
    open();

    expect(panel().style.top).toBe('496px');
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

  /** A bridge that lost its hub must not leave badges that look current. */
  it('says when it cannot reach the board at all', () => {
    paint(document, state({ trouble: 'Ground Control is not running.' }), NOW, actions);

    expect(toasts()[0]!.textContent).toContain('Ground Control is not running.');
    expect(toasts()[0]!.textContent).toContain('showing what it last read');
  });

  /** The bridge refuses what the browser may not ask for. A refusal nobody renders is a button that does nothing. */
  it('states what the hub last said back', () => {
    paint(document, state({ notice: 'Taking a session over happens in the editor.' }), NOW, actions);

    expect(toasts()[0]!.textContent).toContain('Taking a session over happens in the editor.');
    expect(toasts()[0]!.dataset.tone).toBe('default');
  });

  /** How old the reading is belongs in the menu: a toast for it would be one every few seconds, saying nothing. */
  it('leaves what is merely true out of the toasts', () => {
    paint(document, state(), NOW, actions);

    expect(toasts()).toHaveLength(0);
  });

  /** A scan runs every few seconds and after every board mutation. One failure is one toast, however many scans. */
  it('shows one toast per failure however many times it paints', () => {
    paint(document, state({ snapshot: failing }), NOW, actions);
    paint(document, state({ snapshot: failing }), NOW, actions);
    paint(document, state({ snapshot: failing }), NOW, actions);

    expect(toasts()).toHaveLength(1);
  });

  it('takes a toast away once what it said stopped being true', () => {
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
  /** The repaint is what a click asks for, because the board is drawn from scratch rather than patched in place. */
  function click(selector: string): void {
    document.querySelector<HTMLElement>(selector)!.click();
    paint(document, state(), NOW, actions);
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

  /**
   * Opening the list is itself a DOM change, which is what schedules the next scan — so a list the repaint does not
   * redraw is gone about one frame after the click, before anyone can choose a lane.
   */
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

/**
 * How long ago, one rung per unit and both sides of every threshold, as literal strings. The webview's suite in
 * `extensions/ground-control/test/board.test.ts` asserts this table verbatim, through its own rendered card: `ago`
 * exists in both clients because neither can import `core` at runtime, and a copy that drifts reads a duration in a
 * unit the other board never shows.
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

/**
 * The same table `packages/core/test/roster.test.ts` and the webview's suite assert, against literal strings: this
 * ladder exists three times because neither client can import `core` at runtime, and a copy that drifts renames a
 * session on one board and not the other.
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

describe('the card that wants something from you', () => {
  function marked(attention: LanedCard['attention'], over: Partial<LanedCard> = {}): Snapshot {
    return snapshot({ lanes: [{ id: 'build', title: 'Build', cards: [card(4501, { attention, ...over })] }] });
  }

  it('paints the row that is waiting on you, rather than saying so a second time on the card', () => {
    paint(document, state({ snapshot: marked('blocked') }), NOW, actions);

    const row = badges()[0]!.querySelector<HTMLElement>('.gc-session')!;

    expect(row.dataset.phase).toBe('waiting');
    expect(row.querySelector('.gc-state')!.textContent).toBe('needs you 2m');
    expect(getComputedStyle(row).boxShadow).toContain('inset 3px 0 0');
    expect(getComputedStyle(row.querySelector<HTMLElement>('.gc-name')!).fontWeight).toBe('600');
    expect(badges()[0]!.querySelector('.gc-mark')).toBeNull();
  });

  it('paints only the row a your-turn card is about, and leaves the working one lit instead', () => {
    const idle = session({ title: 'Reading the logs', activity: { phase: 'idle', since: NOW - 60_000, event: 'Stop' } });
    const running = session({
      sessionId: OTHER_ID,
      title: 'Still going',
      activity: { phase: 'running', since: NOW - 10_000, event: 'Stop' },
    });

    paint(document, state({ snapshot: marked('your-turn', { sessions: [idle, running] }) }), NOW, actions);

    const [first, second] = [...badges()[0]!.querySelectorAll<HTMLElement>('.gc-session')];

    expect(getComputedStyle(first!).boxShadow).toContain('inset 3px 0 0');
    expect(getComputedStyle(second!).boxShadow).toBe('');
    expect(getComputedStyle(second!.querySelector<HTMLElement>('.gc-name')!).animationName).toBe('gc-shimmer');
  });

  /** An idle row on a card asking nothing — one parked in Done — must not be painted as if it were your turn. */
  it('leaves an idle row on an unmarked card alone', () => {
    const idle = session({ title: 'Reading the logs', activity: { phase: 'idle', since: NOW - 60_000, event: 'Stop' } });

    paint(document, state({ snapshot: marked(null, { sessions: [idle] }) }), NOW, actions);

    expect(getComputedStyle(badges()[0]!.querySelector<HTMLElement>('.gc-session')!).boxShadow).toBe('');
  });

  // R6: a painted row lives inside the card, which is not readable from across a board. The card carries the ring.
  it('rings the card itself, and takes the ring off when the snapshot no longer has one', () => {
    paint(document, state({ snapshot: marked('blocked') }), NOW, actions);

    expect(document.querySelector(`[data-gc-issue="${REPO}#4501"]`)!.getAttribute('data-gc-attention')).toBe('blocked');

    paint(document, state({ snapshot: marked(null) }), NOW, actions);

    expect(document.querySelector('[data-gc-attention]')).toBeNull();
    expect(badges()[0]!.querySelector('.gc-mark')).toBeNull();
  });

  it('says a card has been past your hands and come back', () => {
    paint(document, state({ snapshot: marked(null, { returned: true }) }), NOW, actions);

    const mark = badges()[0]!.querySelector<HTMLElement>('.gc-mark')!;

    expect(mark.textContent).toBe('Returned');
    expect(mark.dataset.mark).toBe('returned');
  });

  it('leaves nothing of itself on the page after a clear', () => {
    paint(document, state({ snapshot: marked('blocked') }), NOW, actions);
    clear(document);

    expect(document.querySelector('[data-gc-attention]')).toBeNull();
  });
});

describe('durations that advance on their own', () => {
  it('rewrites the phase where it stands, without rebuilding the chip', () => {
    paint(document, state(), NOW, actions);

    const chip = badges()[0]!.querySelector('.gc-session')!;
    const said = chip.querySelector('.gc-state')!;

    expect(said.textContent).toBe('needs you 2m');
    expect(tickDurations(document, NOW + 60_000)).toBe(1);
    expect(said.textContent).toBe('needs you 3m');
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

    theirs.setAttribute('data-activity-since', String(NOW - 125_000));
    theirs.textContent = 'GitHub own text';
    document.body.appendChild(theirs);

    expect(tickDurations(document, NOW + 60_000)).toBe(1);
    expect(theirs.textContent).toBe('GitHub own text');
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
  /**
   * A link rather than a button: the navigation has to be the developer's own gesture in the application in front of
   * them, because that is the only thing that gives VS Code the foreground (`mechanics.md` §26, §29).
   */
  it('addresses the session by id, and nothing else', () => {
    paint(document, state(), NOW, actions);

    const chip = badges()[0]!.querySelector<HTMLAnchorElement>('.gc-session')!;

    expect(chip.tagName).toBe('A');
    expect(chip.getAttribute('href')).toBe(`vscode://ownerrez.ground-control/open?session=${SESSION_ID}`);
    // Without this, a few pixels of drift on the way to a click drag the card GitHub wraps around the footer.
    expect(chip.getAttribute('draggable')).toBe('false');
  });

  it('offers no link for a session the hub says no editor can open', () => {
    paint(document, state({ snapshot: snapshot({ openable: [] }) }), NOW, actions);

    const chip = badges()[0]!.querySelector<HTMLElement>('.gc-session')!;

    expect(chip.tagName).toBe('SPAN');
    expect(chip.getAttribute('href')).toBeNull();
    expect(tipOf(chip)).toContain('no editor of yours can open this one');
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
  it('renders an inert history row when not offered by the host, and updates its age', () => {
    show(card(4501, { sessions: [], lastSession }));
    const row = document.querySelector<HTMLElement>('.gc-historical')!;
    expect(row.tagName).toBe('SPAN'); expect(row.hasAttribute('href')).toBe(false);
    expect(row.querySelector('a, button, [data-activity-since]')).toBeNull();
    expect(row.dataset.phase).toBeUndefined(); expect(row.textContent).toContain('Last session · updated 1m ago');
    row.click(); expect(actions.move).not.toHaveBeenCalled(); expect(actions.repaint).not.toHaveBeenCalled();
    tickDurations(document, NOW + 60000);
    expect(row.textContent).toContain('updated 2m ago');
    show(card(4501, { lastSession })); expect(document.querySelector('.gc-historical')).toBeNull();
    show(card(4501, { sessions: [], lastSession: { ...lastSession, title: 'Renamed' } }));
    expect(document.querySelector('.gc-historical')?.textContent).toContain('Renamed');
  });
  it('handles cached payloads with absent or malformed history and falls back to the directory label', () => {
    show(card(4501, { sessions: [] })); expect(document.querySelector('.gc-historical')).toBeNull();
    show(card(4501, { sessions: [], lastSession: { ...lastSession, updatedAt: NaN } })); expect(document.querySelector('.gc-historical')).toBeNull();
    show(card(4501, { sessions: [], lastSession: { ...lastSession, agent: 'other', title: null } }));
    expect(document.querySelector('.gc-historical')?.textContent).toContain('4501-test');
  });
});


it('links historical rows through the same VS Code handler without opening the GitHub card', () => {
  const lastSession = { agent: 'claude', sessionId: SESSION_ID, title: 'Past attempt', cwd: '/work/4501-test', branch: '4501-test', issueNumber: 4501, repository: 'github.com/example-org/example-repo', updatedAt: NOW - 60000 };
  const entry = card(4501, { sessions: [], lastSession });
  paint(document, state({ snapshot: snapshot({ lanes: [{ id: 'build', title: 'Build', cards: [entry] }], openable: [SESSION_ID] }) }), NOW, actions);
  const link = document.querySelector<HTMLAnchorElement>('a.gc-historical')!;
  expect(link.href).toBe(`vscode://ownerrez.ground-control/open?session=${SESSION_ID}`);
  expect(link.draggable).toBe(false); expect(tipOf(link)).toContain('Resume this session');
  const parentClick = vi.fn(); link.parentElement!.addEventListener('click', parentClick);
  link.addEventListener('click', (event) => event.preventDefault()); link.click();
  expect(parentClick).not.toHaveBeenCalled();
});

describe('what a card was read to be waiting on (R38)', () => {
  const show = (entry: LanedCard) =>
    paint(document, state({ snapshot: snapshot({ lanes: [{ id: 'build', title: 'Build', cards: [entry] }], openable: [] }) }), NOW, actions);
  const mark = () => document.querySelector<HTMLElement>('.gc-mark[data-mark="triage"], .gc-mark[data-mark="triaging"]');

  it('says a card is being read, and rings nothing while it does', () => {
    show(card(4501, { sessions: [], triage: { state: 'running' } }));

    expect(mark()?.textContent).toBe('Reading…');
    // R36 keeps colour for the two things that want the developer, and being read is neither.
    expect(document.querySelector(`[${'data-gc-attention'}]`)).toBeNull();
    expect(document.querySelector('.gc-triage-detail')).toBeNull();
  });

  it('names the action on the head line and writes the sentence under it', () => {
    show(
      card(4501, {
        sessions: [],
        triage: { state: 'done', action: 'qa-failure', qualifier: null, detail: 'Safari still shows an empty second page.', at: NOW - 3_600_000, stale: false },
      }),
    );

    expect(mark()?.textContent).toBe('QA failure');
    expect(tipOf(mark())).toBe('Read 1h ago.');
    expect(document.querySelector('.gc-triage-detail')?.textContent).toBe('Safari still shows an empty second page.');
  });

  it('marks a reading the card has moved under', () => {
    show(
      card(4501, {
        sessions: [],
        triage: { state: 'done', action: 'develop', qualifier: null, detail: 'Pick it up.', at: NOW - 60_000, stale: true },
      }),
    );

    expect(mark()?.dataset.stale).toBe('true');
    expect(tipOf(mark())).toContain('has moved since');
    expect(document.querySelector<HTMLElement>('.gc-triage-detail')?.dataset.stale).toBe('true');
  });

  it('says a card could not be read, and offers no control — reading again is the editor own', () => {
    show(card(4501, { sessions: [], triage: { state: 'failed', attempts: 2, exhausted: false } }));

    expect(mark()?.textContent).toBe('Not read');
    expect(mark()?.tagName).toBe('SPAN');
    expect(document.querySelector('.gc-triage-detail')).toBeNull();
  });

  it('carries nothing on a card that has not been read', () => {
    show(card(4501, { sessions: [] }));

    expect(mark()).toBeNull();
    expect(document.querySelector('.gc-triage-detail')).toBeNull();
  });

  /**
   * The parity table. This extension imports nothing from `packages/board` at runtime, so its copy of the labels is
   * pinned by asserting the same literals its own suite does (`docs/testing.md`).
   */
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
    expect(triageText({ action, qualifier })).toBe(expected);
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

    // Built by the click rather than by the scan that follows it: what the subscription is answered with comes
    // back before the next frame, and a panel that did not exist yet would drop it.
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

  it('closes from its own button, and that is what tells the hub to stop', () => {
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

    // And stays gone through the next scan: a `clear` that only took the element off the page would have the very
    // next frame put an empty one back on a page that is not a board.
    paint(document, state(), NOW, actions);

    expect(sidebar()).toBeNull();
  });

  it('goes when the developer clicks off it, and tells the hub to stop', () => {
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
     * The case the pin needs a second guard for. With nothing else open the outside-click handler is never armed,
     * so a pinned sidebar survives on that alone; open the menu over it and the handler *is* armed — for the menu —
     * and the click that dismisses the menu must leave the sidebar where it is.
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

/**
 * The parity table. Neither board imports the other's tooltip — both are classic scripts — so the shape they share
 * is pinned by asserting the same numbers in both suites (`docs/testing.md`). Measured off GitHub's own tooltip,
 * `docs/mechanics.md` §35.
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
