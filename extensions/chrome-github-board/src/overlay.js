// @ts-check
/**
 * The overlay's whole DOM layer: a banner above the board and a badge on each of the developer's cards. A pure
 * function of a snapshot and a document, so it is reached under jsdom against recorded board markup — nothing here
 * touches `chrome`, which is the content script's half.
 */

/**
 * @typedef {import('@ground-control/core').Snapshot} Snapshot
 * @typedef {import('@ground-control/core').LanedCard} LanedCard
 * @typedef {import('@ground-control/core').LaneId} LaneId
 * @typedef {{ snapshot: Snapshot | null, trouble: string | null, notice: string | null }} State
 * @typedef {{ refresh: () => void, move: (key: string, lane: LaneId) => void, repaint: () => void }} Actions
 */

/** GitHub's board markup, as measured on 2026-09-04 (`mechanics.md` §27). Every other class on the page is hashed. */
export const BOARD_REGION = '#project-items-region';
export const CARD = '[data-board-card-id]';
export const COLUMN = '[data-board-column]';

const BANNER_ID = 'gc-banner';
const STYLE_ID = 'gc-style';
const BADGE_CLASS = 'gc-badge';

/** @type {Record<string, string>} */
export const LANE_TITLES = {
  unstarted: 'Unstarted',
  plan: 'Plan',
  build: 'Build',
  review: 'Review',
  done: 'Done',
  icebox: 'Icebox',
  archived: 'Archived',
};

/** @type {Record<string, string>} */
const PHASE_WORDS = { running: 'running', waiting: 'needs you', idle: 'idle' };

const CSS = `
.${BADGE_CLASS} { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 6px; }
.${BADGE_CLASS} button { font: inherit; font-size: 11px; line-height: 18px; padding: 0 6px; border-radius: 9px;
  border: 1px solid var(--borderColor-default, #d0d7de); background: var(--bgColor-muted, #f6f8fa);
  color: var(--fgColor-default, #1f2328); cursor: pointer; }
.${BADGE_CLASS} button[data-phase="waiting"] { background: var(--bgColor-attention-muted, #fff8c5); }
.${BADGE_CLASS} button[data-phase="running"] { background: var(--bgColor-accent-muted, #ddf4ff); }
#${BANNER_ID} { margin: 8px 16px; padding: 8px 12px; border: 1px solid var(--borderColor-default, #d0d7de);
  border-radius: 6px; font-size: 12px; display: flex; flex-direction: column; gap: 4px; }
#${BANNER_ID}[data-stale="true"] { border-color: var(--borderColor-attention-emphasis, #bf8700); }
#${BANNER_ID} .gc-line { display: flex; gap: 6px; }
#${BANNER_ID} .gc-remedy { opacity: 0.7; }
.gc-lanes { display: flex; gap: 4px; flex-wrap: wrap; }
`;

/**
 * The card whose lane list is open, if any. The overlay's own display state, and the one thing a repaint carries
 * across: appending a menu to a card is itself a mutation, which schedules the scan that rebuilds every badge — so a
 * menu held anywhere but here is destroyed one frame after it opens.
 *
 * @type {string | null}
 */
let openMenu = null;

/**
 * How long ago, coarsely, and never rounded up — the same rule the editor board follows. Overstating is the one
 * direction that matters: a session working steadily must not read older than it is.
 *
 * @param {number} ms
 * @returns {string}
 */
export function ago(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);

  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60 === 0 ? '' : ` ${minutes % 60}m`}`;
}

const ISSUE_URL = /github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/;

/**
 * The issue a project card is for: its repository and its number, from the link it carries. Null for a draft item,
 * which has no issue of its own. The repository is half the answer — a project board spans repositories, and two of
 * them numbering an issue 42 is ordinary rather than rare.
 *
 * @param {Element} card
 * @returns {{ repo: string, number: number } | null}
 */
export function issueRefOf(card) {
  for (const link of card.querySelectorAll('a[href*="/issues/"]')) {
    const match = ISSUE_URL.exec(link.getAttribute('href') ?? '');

    if (match) {
      return { repo: match[1] ?? '', number: Number(match[2]) };
    }
  }

  return null;
}

/**
 * The same, off a card the hub reported. Null where the hub knows a number but not the issue behind it.
 *
 * @param {LanedCard} card
 */
function refOfCard(card) {
  const match = ISSUE_URL.exec(card.issue?.url ?? '');

  return match ? `${match[1]}#${match[2]}` : null;
}

/**
 * Every laned card the snapshot holds, indexed twice: by repository and number where the hub knows which repository
 * the issue is in, and by number alone where it does not — a session naming an issue that is not on the developer's
 * own board carries the number and nothing else. A card in the first index is never in the second, so the fallback
 * can never hand one repository's card to another repository's issue.
 *
 * @param {Snapshot} snapshot
 * @returns {{ byRef: Map<string, LanedCard>, byNumber: Map<number, LanedCard> }}
 */
export function cardsByIssue(snapshot) {
  /** @type {Map<string, LanedCard>} */
  const byRef = new Map();
  /** @type {Map<number, LanedCard>} */
  const byNumber = new Map();

  for (const lane of snapshot.lanes) {
    for (const card of lane.cards) {
      if (card.issueNumber === null) {
        continue;
      }

      const ref = refOfCard(card);

      if (ref === null) {
        byNumber.set(card.issueNumber, card);
      } else {
        byRef.set(ref, card);
      }
    }
  }

  return { byRef, byNumber };
}

/** @param {Document} doc */
function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) {
    return;
  }

  const style = doc.createElement('style');

  style.id = STYLE_ID;
  style.textContent = CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/**
 * @param {Document} doc
 * @param {string} text
 * @param {string} [remedy]
 */
function line(doc, text, remedy) {
  const el = doc.createElement('div');

  el.className = 'gc-line';

  const body = doc.createElement('span');

  body.textContent = text;
  el.appendChild(body);

  if (remedy) {
    const hint = doc.createElement('span');

    hint.className = 'gc-remedy';
    hint.textContent = remedy;
    el.appendChild(hint);
  }

  return el;
}

/**
 * What R25 asks be said once rather than on every card: what failed, what the install did, and how old this is. A
 * bridge that lost its hub must not leave badges that look current, so the age is stated whether or not it is stale.
 *
 * @param {Document} doc
 * @param {State} state
 * @param {number} now
 * @param {Actions} actions
 * @returns {HTMLElement | null}
 */
export function renderBanner(doc, state, now, actions) {
  const region = doc.querySelector(BOARD_REGION);

  if (region === null || region.parentElement === null) {
    return null;
  }

  doc.getElementById(BANNER_ID)?.remove();

  const banner = doc.createElement('div');

  banner.id = BANNER_ID;

  const snapshot = state.snapshot;

  banner.dataset.stale = String(state.trouble !== null || (snapshot?.stale ?? false));

  if (state.trouble !== null) {
    banner.appendChild(line(doc, state.trouble, 'The overlay is showing what it last read.'));
  }

  // The answer to something the developer just did, including an action the browser is not allowed to take.
  if (state.notice !== null) {
    banner.appendChild(line(doc, state.notice));
  }

  if (snapshot === null) {
    banner.appendChild(line(doc, 'Ground Control has not read this machine yet.'));
  } else {
    for (const failure of snapshot.failures) {
      banner.appendChild(line(doc, failure.message, failure.remedy));
    }

    if (snapshot.hooks) {
      banner.appendChild(line(doc, snapshot.hooks.notice));
    }

    banner.appendChild(line(doc, `Ground Control read this machine ${ago(now - Date.parse(snapshot.fetchedAt))} ago.`));
  }

  const refresh = doc.createElement('button');

  refresh.type = 'button';
  refresh.id = 'gc-refresh';
  refresh.textContent = 'Refresh';
  refresh.addEventListener('click', () => actions.refresh());
  banner.appendChild(refresh);

  region.parentElement.insertBefore(banner, region);

  return banner;
}

/**
 * The lanes a card can be dropped into here. `archived` is left out: it is a hide, and hiding needs the board.
 *
 * @type {LaneId[]}
 */
const MOVABLE = ['unstarted', 'plan', 'build', 'review', 'done', 'icebox'];

/**
 * @param {Document} doc
 * @param {LanedCard} card
 * @param {Actions} actions
 */
function laneMenu(doc, card, actions) {
  const menu = doc.createElement('div');

  menu.className = 'gc-lanes';

  for (const lane of MOVABLE) {
    const button = doc.createElement('button');

    button.type = 'button';
    button.dataset.lane = lane;
    button.textContent = LANE_TITLES[lane] ?? lane;
    button.setAttribute('aria-current', String(lane === card.lane));
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      event.preventDefault();
      openMenu = null;
      actions.move(card.key, lane);
      actions.repaint();
    });
    menu.appendChild(button);
  }

  return menu;
}

/**
 * One card's badge: the lane the board has it in, and a chip per session with its phase and how long that phase has
 * held. Rebuilt from scratch every scan rather than patched — a re-render replaces the card node and takes the old
 * one with it (`mechanics.md` §27), so nothing here may assume what it wrote last time is still there.
 *
 * @param {Document} doc
 * @param {Element} element
 * @param {LanedCard} card
 * @param {number} now
 * @param {Actions} actions
 */
function renderBadge(doc, element, card, now, actions) {
  const badge = doc.createElement('div');

  badge.className = BADGE_CLASS;

  const lane = doc.createElement('button');

  lane.type = 'button';
  lane.className = 'gc-lane';
  lane.textContent = LANE_TITLES[card.lane] ?? card.lane;
  lane.addEventListener('click', (event) => {
    event.stopPropagation();
    event.preventDefault();
    openMenu = openMenu === card.key ? null : card.key;
    actions.repaint();
  });
  badge.appendChild(lane);

  for (const session of card.sessions) {
    const chip = doc.createElement('button');

    chip.type = 'button';
    chip.className = 'gc-session';
    chip.dataset.phase = session.activity?.phase ?? 'none';
    chip.textContent = session.activity
      ? `${PHASE_WORDS[session.activity.phase] ?? session.activity.phase} ${ago(now - session.activity.since)}`
      : session.agent;
    // Taking a session over needs the editor (R14), and this is a browser tab. The chip says so rather than
    // offering something that would move the developer's focus out of the window they are in.
    chip.title = 'Open the board in VS Code to take this session over.';
    chip.addEventListener('click', (event) => event.stopPropagation());
    badge.appendChild(chip);
  }

  if (openMenu === card.key) {
    badge.appendChild(laneMenu(doc, card, actions));
  }

  element.appendChild(badge);
}

/**
 * Everything the overlay put on the page, taken off it: what a soft navigation away from a board runs. The content
 * script is injected across github.com, because a board reached by clicking through the site is a soft navigation
 * and Chrome injects nothing for one — so leaving a board is something the overlay has to handle rather than a page
 * it never sees.
 *
 * @param {Document} doc
 */
export function clear(doc) {
  openMenu = null;
  doc.getElementById(BANNER_ID)?.remove();

  for (const badge of doc.querySelectorAll(`.${BADGE_CLASS}`)) {
    badge.remove();
  }

  for (const card of doc.querySelectorAll('[data-gc-issue]')) {
    card.removeAttribute('data-gc-issue');
  }
}

/**
 * Paints the whole board. Returns what it drew: a selector GitHub changed under it looks exactly like a developer
 * with no cards on the board, and only the scanned count tells those two apart.
 *
 * @param {Document} doc
 * @param {State} state
 * @param {number} now
 * @param {Actions} actions
 * @returns {{ scanned: number, badges: number, banner: boolean }}
 */
export function paint(doc, state, now, actions) {
  ensureStyle(doc);

  const banner = renderBanner(doc, state, now, actions);
  const index = state.snapshot === null ? null : cardsByIssue(state.snapshot);

  let badges = 0;
  let scanned = 0;

  for (const element of doc.querySelectorAll(CARD)) {
    scanned += 1;

    for (const stale of element.querySelectorAll(`.${BADGE_CLASS}`)) {
      stale.remove();
    }

    const ref = issueRefOf(element);

    if (ref === null) {
      element.removeAttribute('data-gc-issue');

      continue;
    }

    element.setAttribute('data-gc-issue', `${ref.repo}#${ref.number}`);

    const card = index?.byRef.get(`${ref.repo}#${ref.number}`) ?? index?.byNumber.get(ref.number);

    if (card === undefined) {
      continue;
    }

    renderBadge(doc, element, card, now, actions);
    badges += 1;
  }

  return { scanned, badges, banner: banner !== null };
}
