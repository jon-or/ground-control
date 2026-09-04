// @ts-check
/**
 * The overlay's whole DOM layer: a menu in the board's own filter bar, a toast for anything that went wrong, and a
 * footer inside each of the developer's cards. A pure function of a snapshot and a document, so it is reached under
 * jsdom against recorded board markup — nothing here touches `chrome`, which is the content script's half.
 */

/**
 * @typedef {import('@ground-control/core').Snapshot} Snapshot
 * @typedef {import('@ground-control/core').LanedCard} LanedCard
 * @typedef {import('@ground-control/core').LaneId} LaneId
 * @typedef {{ snapshot: Snapshot | null, trouble: string | null, notice: string | null }} State
 * @typedef {{ refresh: () => void, move: (key: string, lane: LaneId) => void, repaint: () => void }} Actions
 * @typedef {{ key: string, message: string, remedy: string | null, tone: 'danger' | 'default' }} Problem
 */

/** GitHub's board markup, as measured on 2026-09-04 (`mechanics.md` §27). Every other class on the page is hashed. */
export const BOARD_REGION = '#project-items-region';
export const CARD = '[data-board-card-id]';
export const COLUMN = '[data-board-column]';
export const TOOLBAR = '[role="region"][aria-label="View filters"]';

const MENU_ID = 'gc-menu';
const PERCH_ID = 'gc-perch';
const TOASTS_ID = 'gc-toasts';
const STYLE_ID = 'gc-style';
const BADGE_CLASS = 'gc-badge';
const POPOVER_CLASS = 'gc-popover';

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

/**
 * The card's own box pads 8px above and 12px below its content and nothing at the sides (`mechanics.md` §27), so a
 * footer reaches the card's three edges by cancelling that bottom padding alone.
 */
const CSS = `
.${BADGE_CLASS} { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; margin: 8px 0 -12px;
  padding: 6px 8px; border-top: 1px solid var(--borderColor-muted, #d1d9e0b3); border-radius: 0 0 5px 5px;
  background: var(--bgColor-muted, #f6f8fa); }
.${BADGE_CLASS} button { font: inherit; font-size: 11px; line-height: 18px; padding: 0 6px; border-radius: 9px;
  display: inline-flex; align-items: center; gap: 3px;
  border: 1px solid var(--borderColor-default, #d0d7de); background: var(--bgColor-default, #ffffff);
  color: var(--fgColor-default, #1f2328); cursor: pointer; }
.${BADGE_CLASS} button:hover { background: var(--bgColor-neutral-muted, #eaeef2); }
.${BADGE_CLASS} button[data-phase="waiting"] { background: var(--bgColor-attention-muted, #fff8c5); }
.${BADGE_CLASS} button[data-phase="running"] { background: var(--bgColor-accent-muted, #ddf4ff); }
.${BADGE_CLASS} svg { flex: none; }
.${POPOVER_CLASS} { position: fixed; z-index: 100; min-width: 200px; max-width: 320px; padding: 4px 0;
  font-size: 12px; color: var(--fgColor-default, #1f2328);
  background: var(--overlay-bgColor, var(--bgColor-default, #ffffff));
  border: 1px solid var(--borderColor-default, #d0d7de); border-radius: 12px;
  box-shadow: var(--shadow-floating-small, 0 6px 18px 0 rgba(31, 35, 40, 0.12)); }
.${POPOVER_CLASS} .gc-title { padding: 6px 12px; font-weight: 600; }
.${POPOVER_CLASS} .gc-note { padding: 2px 12px 6px; color: var(--fgColor-muted, #59636e); }
.${POPOVER_CLASS} hr { margin: 4px 0; border: 0; border-top: 1px solid var(--borderColor-muted, #d1d9e0b3); }
.${POPOVER_CLASS} button { display: flex; width: 100%; gap: 8px; align-items: center; padding: 6px 12px;
  font: inherit; text-align: left; background: none; border: 0; color: inherit; cursor: pointer; }
.${POPOVER_CLASS} button:hover { background: var(--bgColor-neutral-muted, #eaeef2); }
.${POPOVER_CLASS} .gc-tick { width: 16px; flex: none; }
#${MENU_ID} { display: inline-flex; }
#${MENU_ID} button[data-stale="true"]::after { content: ""; width: 6px; height: 6px; margin-left: 6px;
  border-radius: 50%; background: var(--bgColor-attention-emphasis, #bf8700); }
#${PERCH_ID} { display: flex; justify-content: flex-end; margin: 8px 16px; }
#${TOASTS_ID} { position: fixed; left: 16px; bottom: 16px; z-index: 200; display: flex; flex-direction: column;
  gap: 8px; max-width: 420px; }
#${TOASTS_ID} .gc-toast { display: flex; gap: 8px; align-items: flex-start; padding: 8px 12px; border-radius: 6px;
  font-size: 12px; color: var(--fgColor-onEmphasis, #ffffff); background: var(--bgColor-emphasis, #24292f);
  box-shadow: var(--shadow-floating-small, 0 6px 18px 0 rgba(31, 35, 40, 0.12)); }
#${TOASTS_ID} .gc-toast[data-tone="danger"] { background: var(--bgColor-danger-emphasis, #cf222e); }
#${TOASTS_ID} .gc-remedy { display: block; opacity: 0.8; }
#${TOASTS_ID} .gc-dismiss { margin-left: auto; font: inherit; background: none; border: 0; cursor: pointer;
  color: inherit; opacity: 0.8; }
`;

/**
 * The overlay's own display state, and the one thing a repaint carries across: opening a menu is itself a DOM
 * change, which schedules the scan that rebuilds the page — so a menu held anywhere but here is destroyed one frame
 * after it opens.
 *
 * @type {string | null}
 */
let openMenu = null;
let panelOpen = false;

/** Toasts the developer has closed, by key. Dropped again once the thing they were about is no longer true. */
const dismissed = new Set();

/** The outside-click handler for whatever is open, held so each render replaces the last rather than stacking. */
/** @type {((event: Event) => void) | null} */
let closer = null;

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

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Claude's mark: eight rays from a centre, the diagonals shorter. Drawn rather than fetched — an extension may */
/** load only images it ships, and a node is also the one form this file can draw under jsdom. */
const RAYS = [
  [0, 6],
  [45, 4.5],
  [90, 6],
  [135, 4.5],
  [180, 6],
  [225, 4.5],
  [270, 6],
  [315, 4.5],
];

/**
 * @param {Document} doc
 * @param {string} agent
 * @returns {SVGElement | null}
 */
export function agentIcon(doc, agent) {
  if (agent !== 'claude') {
    return null;
  }

  const svg = doc.createElementNS(SVG_NS, 'svg');

  svg.setAttribute('class', 'gc-agent-icon');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '11');
  svg.setAttribute('height', '11');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', '#d97757');

  for (const [angle, length] of RAYS) {
    const ray = doc.createElementNS(SVG_NS, 'rect');

    ray.setAttribute('x', '7.3');
    ray.setAttribute('y', String(8 - (length ?? 0)));
    ray.setAttribute('width', '1.4');
    ray.setAttribute('height', String(length));
    ray.setAttribute('rx', '0.7');
    ray.setAttribute('transform', `rotate(${angle} 8 8)`);
    svg.appendChild(ray);
  }

  return svg;
}

/**
 * A floating panel in GitHub's own shape, hung under whatever opened it. Position is read off the anchor at render
 * rather than held: the panel is rebuilt on every scan, so it follows a board that scrolled under it.
 *
 * @param {Document} doc
 * @param {Element} anchor
 * @param {string} title
 * @returns {HTMLElement}
 */
function popover(doc, anchor, title) {
  const panel = doc.createElement('div');

  panel.className = POPOVER_CLASS;
  panel.setAttribute('role', 'menu');

  const heading = doc.createElement('div');

  heading.className = 'gc-title';
  heading.textContent = title;
  panel.appendChild(heading);

  const rect = anchor.getBoundingClientRect();
  const width = doc.defaultView?.innerWidth ?? 0;

  panel.style.top = `${rect.bottom + 4}px`;
  panel.style.left = `${Math.max(8, Math.min(rect.left, width - 328))}px`;

  return panel;
}

/**
 * @param {Document} doc
 * @param {string} text
 * @param {() => void} chosen
 * @param {string} [tick]
 */
function item(doc, text, chosen, tick) {
  const button = doc.createElement('button');

  button.type = 'button';
  button.setAttribute('role', 'menuitem');

  const mark = doc.createElement('span');

  mark.className = 'gc-tick';
  mark.textContent = tick ?? '';
  button.appendChild(mark);

  const label = doc.createElement('span');

  label.textContent = text;
  button.appendChild(label);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    event.preventDefault();
    chosen();
  });

  return button;
}

/**
 * Closes whatever is open when the next click lands outside it. One handler, replaced on every render: an overlay
 * that added one per paint would hold hundreds by the time a developer chose a lane.
 *
 * @param {Document} doc
 * @param {Element[]} keep
 * @param {() => void} closed
 */
function closeOnOutsideClick(doc, keep, closed) {
  if (closer !== null) {
    doc.removeEventListener('click', closer, true);
    closer = null;
  }

  if (keep.length === 0) {
    return;
  }

  closer = (event) => {
    if (keep.some((element) => element.contains(/** @type {Node} */ (event.target)))) {
      return;
    }

    openMenu = null;
    panelOpen = false;
    closed();
  };

  doc.addEventListener('click', closer, true);
}

/**
 * Where the menu goes: the board's own filter bar, so the button sits with GitHub's. A board whose bar this no
 * longer matches still gets one above the columns — losing the reading's age and the refresh silently is the one
 * outcome R25 rules out.
 *
 * @param {Document} doc
 * @returns {Element | null}
 */
function perch(doc) {
  const bar = doc.querySelector(TOOLBAR);

  if (bar !== null) {
    return bar;
  }

  const region = doc.querySelector(BOARD_REGION);

  if (region === null || region.parentElement === null) {
    return null;
  }

  const own = doc.getElementById(PERCH_ID) ?? doc.createElement('div');

  own.id = PERCH_ID;
  region.parentElement.insertBefore(own, region);

  return own;
}

/**
 * The button GitHub would have drawn: its classes are hashed per build, so they are copied off a button already in
 * the bar rather than written down. Nothing else here depends on them.
 *
 * @param {Document} doc
 * @param {Element} host
 */
function nativeButton(doc, host) {
  const button = doc.createElement('button');
  const model = host.querySelector('button[data-component="Button"]');

  button.type = 'button';
  button.className = model?.className ?? '';
  button.dataset.size = 'medium';
  button.dataset.variant = 'default';
  button.setAttribute('data-component', 'Button');

  return button;
}

/**
 * What R25 asks be said once rather than on every card, in the place a developer goes looking for it: how old the
 * reading is, what the install did, and the refresh. What went wrong is a toast instead — a failure a developer has
 * to open a menu to discover is one they never see.
 *
 * @param {Document} doc
 * @param {State} state
 * @param {number} now
 * @param {Actions} actions
 * @returns {HTMLElement | null}
 */
export function renderMenu(doc, state, now, actions) {
  doc.getElementById(MENU_ID)?.remove();

  const host = perch(doc);

  if (host === null) {
    return null;
  }

  const holder = doc.createElement('div');

  holder.id = MENU_ID;

  const snapshot = state.snapshot;
  const button = nativeButton(doc, host);

  button.textContent = 'Ground Control';
  button.dataset.stale = String(state.trouble !== null || (snapshot?.stale ?? false));
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', String(panelOpen));
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    event.preventDefault();
    panelOpen = !panelOpen;
    openMenu = null;
    actions.repaint();
  });
  holder.appendChild(button);
  host.appendChild(holder);

  if (!panelOpen) {
    return holder;
  }

  const panel = popover(doc, button, 'Ground Control');

  for (const text of [
    snapshot === null
      ? 'Ground Control has not read this machine yet.'
      : `Read this machine ${ago(now - Date.parse(snapshot.fetchedAt))} ago.`,
    snapshot?.hooks?.notice ?? '',
  ]) {
    if (text !== '') {
      const note = doc.createElement('div');

      note.className = 'gc-note';
      note.textContent = text;
      panel.appendChild(note);
    }
  }

  panel.appendChild(doc.createElement('hr'));
  panel.appendChild(
    item(doc, 'Refresh', () => {
      panelOpen = false;
      actions.refresh();
      actions.repaint();
    }),
  );

  holder.appendChild(panel);

  return holder;
}

/**
 * Everything the developer has to be told rather than shown: the hub unreachable, a source that failed, the answer
 * to something they just clicked. Reconciled rather than appended — a scan runs every few seconds, and a toast per
 * scan would bury the board it sits on.
 *
 * @param {Document} doc
 * @param {State} state
 * @returns {HTMLElement}
 */
export function renderToasts(doc, state) {
  /** @type {Problem[]} */
  const problems = [];

  if (state.trouble !== null) {
    problems.push({
      key: `trouble:${state.trouble}`,
      message: state.trouble,
      remedy: 'The overlay is showing what it last read.',
      tone: 'danger',
    });
  }

  for (const failure of state.snapshot?.failures ?? []) {
    problems.push({
      key: `${failure.subject}:${failure.kind}`,
      message: failure.message,
      remedy: failure.remedy,
      tone: 'danger',
    });
  }

  // The answer to something the developer just did, including an action the browser is not allowed to take.
  if (state.notice !== null) {
    problems.push({ key: `notice:${state.notice}`, message: state.notice, remedy: null, tone: 'default' });
  }

  const live = new Set(problems.map((problem) => problem.key));

  // A toast closed by hand stays closed while what it said is still true, and comes back if the trouble does.
  for (const key of [...dismissed]) {
    if (!live.has(key)) {
      dismissed.delete(key);
    }
  }

  let stack = doc.getElementById(TOASTS_ID);

  if (stack === null) {
    stack = doc.createElement('div');
    stack.id = TOASTS_ID;
    (doc.body ?? doc.documentElement).appendChild(stack);
  }

  /** @type {Set<string>} */
  const showing = new Set();

  for (const element of [...stack.children]) {
    const key = /** @type {HTMLElement} */ (element).dataset.key ?? '';

    if (live.has(key) && !dismissed.has(key)) {
      showing.add(key);
    } else {
      element.remove();
    }
  }

  for (const problem of problems) {
    if (dismissed.has(problem.key) || showing.has(problem.key)) {
      continue;
    }

    stack.appendChild(toast(doc, problem));
  }

  return stack;
}

/**
 * @param {Document} doc
 * @param {Problem} problem
 */
function toast(doc, problem) {
  const element = doc.createElement('div');

  element.className = 'gc-toast';
  element.setAttribute('role', 'alert');
  element.dataset.key = problem.key;
  element.dataset.tone = problem.tone;

  const said = doc.createElement('div');

  said.textContent = problem.message;

  if (problem.remedy) {
    const remedy = doc.createElement('span');

    remedy.className = 'gc-remedy';
    remedy.textContent = problem.remedy;
    said.appendChild(remedy);
  }

  element.appendChild(said);

  const close = doc.createElement('button');

  close.type = 'button';
  close.className = 'gc-dismiss';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '✕';
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    dismissed.add(problem.key);
    element.remove();
  });
  element.appendChild(close);

  return element;
}

/**
 * The lanes a card can be dropped into here. `archived` is left out: it is a hide, and hiding needs the board.
 *
 * @type {LaneId[]}
 */
const MOVABLE = ['unstarted', 'plan', 'build', 'review', 'done', 'icebox'];

/**
 * @param {Document} doc
 * @param {Element} anchor
 * @param {LanedCard} card
 * @param {Actions} actions
 */
function laneMenu(doc, anchor, card, actions) {
  const menu = popover(doc, anchor, 'Move to');

  menu.classList.add('gc-lanes');

  for (const lane of MOVABLE) {
    const chosen = lane === card.lane;
    const button = item(
      doc,
      LANE_TITLES[lane] ?? lane,
      () => {
        openMenu = null;
        actions.move(card.key, lane);
        actions.repaint();
      },
      chosen ? '✓' : '',
    );

    button.dataset.lane = lane;
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-checked', String(chosen));
    menu.appendChild(button);
  }

  return menu;
}

/**
 * One card's footer: the lane the board has it in, and a chip per session with its phase and how long that phase
 * has held. It goes inside the card's own box — the card element is a drag handle wrapped around it, and anything
 * appended there hangs below the border. Rebuilt from scratch every scan rather than patched: a re-render replaces
 * the card node and takes the old footer with it (`mechanics.md` §27).
 *
 * @param {Document} doc
 * @param {Element} element
 * @param {LanedCard} card
 * @param {number} now
 * @param {Actions} actions
 * @returns {Element[]} the lane menu and the chip it hangs from, when this is the card whose lanes are open
 */
function renderBadge(doc, element, card, now, actions) {
  const badge = doc.createElement('div');

  badge.className = BADGE_CLASS;

  const lane = doc.createElement('button');

  lane.type = 'button';
  lane.className = 'gc-lane';
  lane.textContent = LANE_TITLES[card.lane] ?? card.lane;
  lane.setAttribute('aria-haspopup', 'menu');
  lane.addEventListener('click', (event) => {
    event.stopPropagation();
    event.preventDefault();
    openMenu = openMenu === card.key ? null : card.key;
    panelOpen = false;
    actions.repaint();
  });
  badge.appendChild(lane);

  for (const session of card.sessions) {
    const chip = doc.createElement('button');

    chip.type = 'button';
    chip.className = 'gc-session';
    chip.dataset.phase = session.activity?.phase ?? 'none';

    const icon = agentIcon(doc, session.agent);

    if (icon !== null) {
      chip.appendChild(icon);
    }

    const said = doc.createElement('span');

    said.textContent = session.activity
      ? `${PHASE_WORDS[session.activity.phase] ?? session.activity.phase} ${ago(now - session.activity.since)}`
      : session.agent;
    chip.appendChild(said);
    // Taking a session over needs the editor (R14), and this is a browser tab. The chip says so rather than
    // offering something that would move the developer's focus out of the window they are in.
    chip.title = 'Open the board in VS Code to take this session over.';
    chip.addEventListener('click', (event) => event.stopPropagation());
    badge.appendChild(chip);
  }

  // Inside the card's own bordered box, so the footer reads as a line of the card rather than a chip dropped under it.
  (element.firstElementChild ?? element).appendChild(badge);

  if (openMenu !== card.key) {
    return [];
  }

  const menu = laneMenu(doc, lane, card, actions);

  (doc.body ?? doc.documentElement).appendChild(menu);

  // The chip travels with its menu: a click on it is the developer closing what they opened, and an outside-click
  // handler that took the chip for an outside click would close the menu and let the chip reopen it.
  return [menu, lane];
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
  panelOpen = false;
  dismissed.clear();
  closeOnOutsideClick(doc, [], () => {});

  for (const id of [MENU_ID, PERCH_ID, TOASTS_ID]) {
    doc.getElementById(id)?.remove();
  }

  for (const element of doc.querySelectorAll(`.${BADGE_CLASS}, .${POPOVER_CLASS}`)) {
    element.remove();
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
 * @returns {{ scanned: number, badges: number, menu: boolean }}
 */
export function paint(doc, state, now, actions) {
  ensureStyle(doc);

  // Every open panel is drawn fresh below, so the ones from the last scan go first — including a card's, whose own
  // card may not be on the page any more.
  for (const stale of doc.querySelectorAll(`.${POPOVER_CLASS}`)) {
    stale.remove();
  }

  const menu = renderMenu(doc, state, now, actions);

  renderToasts(doc, state);

  const index = state.snapshot === null ? null : cardsByIssue(state.snapshot);

  let badges = 0;
  let scanned = 0;
  /** @type {Element[]} */
  const open = menu === null ? [] : [menu];

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

    open.push(...renderBadge(doc, element, card, now, actions));

    badges += 1;
  }

  closeOnOutsideClick(doc, panelOpen || openMenu !== null ? open : [], () => actions.repaint());

  return { scanned, badges, menu: menu !== null };
}
