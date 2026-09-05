// @ts-check
/**
 * The overlay's whole DOM layer: a menu in the board's own filter bar, a toast for anything that went wrong, and a
 * footer inside each of the developer's cards. A pure function of a snapshot and a document, so it is reached under
 * jsdom against recorded board markup — nothing here touches `chrome`, which is the content script's half.
 */

/**
 * @typedef {import('@ground-control/core').Snapshot} Snapshot
 * @typedef {import('@ground-control/core').LanedCard} LanedCard
 * @typedef {import('@ground-control/core').Session} Session
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
export const PROJECT_NAV = '[role="navigation"][aria-label="Project"]';
export const VIEW_TABS = 'nav[aria-label="Select view"]';

const MENU_ID = 'gc-menu';
const PERCH_ID = 'gc-perch';
const TOASTS_ID = 'gc-toasts';
const STYLE_ID = 'gc-style';
const BADGE_CLASS = 'gc-badge';
const POPOVER_CLASS = 'gc-popover';
const HIDDEN_ATTR = 'data-gc-hidden';

/**
 * The board's address in VS Code, written by hand: this file is what Chrome loads, so it imports nothing. The same
 * string is built by `openSessionUri` in `@ground-control/host-vscode`, and both are asserted against the literal.
 */
const OPEN_SESSION_URI = 'vscode://ownerrez.ground-control/open?session=';

/** Where the collapse is remembered. Page-origin storage, so it is per developer and per browser rather than per tab. */
const COLLAPSE_KEY = 'ground-control:header-collapsed';

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

/** @type {Record<string, string>} */
const PHASE_TITLES = {
  running: 'This session is working. The duration counts the turn it is in, from the prompt that began it where the board saw one.',
  waiting: 'This session is waiting on you.',
  idle: 'The board last saw this session finish.',
};

/**
 * Where a card's attention is written, so a scan that no longer finds one can take it off again. It is the card's
 * own element that carries it, and the CSS above paints both the card and the session row the attention is about.
 */
const ATTENTION_ATTR = 'data-gc-attention';

/**
 * The card's own box pads 8px above and 12px below its content and nothing at the sides (`mechanics.md` §27), so a
 * footer reaches the card's three edges by cancelling that bottom padding alone. The columns are pulled together
 * over the attribute GitHub's own drag-and-drop needs rather than the hashed class beside it, and by 1px rather
 * than to 0: each column draws a 1px border, so meeting at 0 would draw the divider between two of them twice.
 *
 * The dividers between them are then drawn as two 1px background strips over transparent borders, rather than as
 * the borders themselves: only that way do they fade, and `border-image` — the one property that gradients a real
 * border — would take the column's 6px radius with it. `border-box` origin puts each strip on the border it
 * replaces, the radius clips them, and the token carries the colour into GitHub's dark theme.
 */
const CSS = `
${COLUMN} { margin-right: -1px !important;
  border-left-color: transparent !important; border-right-color: transparent !important;
  border-bottom-color: transparent !important;
  background-origin: border-box !important; background-repeat: no-repeat !important;
  background-position: left top, right top !important; background-size: 1px 100%, 1px 100% !important;
  background-image: linear-gradient(to bottom, var(--borderColor-default, #d0d7de), transparent),
    linear-gradient(to bottom, var(--borderColor-default, #d0d7de), transparent) !important; }
.${BADGE_CLASS} { display: flex; flex-direction: column; align-items: stretch; gap: 1px; margin: 8px 0 -12px;
  padding: 5px 6px 6px; border-top: 1px solid var(--borderColor-muted, #d1d9e0b3); border-radius: 0 0 5px 5px;
  background: var(--bgColor-muted, #f6f8fa); }
.${BADGE_CLASS} .gc-head { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; margin-bottom: 3px; }
.${BADGE_CLASS} button {
  font: inherit; font-size: 11px; line-height: 18px; padding: 0 6px; border-radius: 9px;
  display: inline-flex; align-items: center; gap: 3px;
  border: 1px solid var(--borderColor-default, #d0d7de); background: var(--bgColor-default, #ffffff);
  color: var(--fgColor-default, #1f2328); cursor: pointer; }
.${BADGE_CLASS} button:hover { background: var(--bgColor-neutral-muted, #eaeef2); }
/* No box of its own: a row is a line of the card, and a border around each one turned the footer into a stack of chips. */
.${BADGE_CLASS} .gc-session {
  display: flex; box-sizing: border-box; width: 100%; align-items: center; gap: 5px;
  font: inherit; font-size: 11px; line-height: 20px; padding: 0 6px 0 8px; border: 0; border-radius: 0;
  background: none; color: var(--fgColor-default, #1f2328); cursor: pointer; }
.${BADGE_CLASS} a.gc-session { text-decoration: none; }
.${BADGE_CLASS} a.gc-session:hover { background: var(--bgColor-neutral-muted, #eaeef2); }
.${BADGE_CLASS} span.gc-session { cursor: default; }
.${BADGE_CLASS} svg { flex: none; }
.gc-agent { flex: none; }
.gc-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gc-state { flex: none; white-space: nowrap; }
.gc-agent, .gc-state { color: var(--fgColor-muted, #59636e); }
.gc-mark { font-size: 11px; line-height: 18px; padding: 0 6px; border-radius: 9px; font-weight: 600;
  color: var(--fgColor-onEmphasis, #ffffff); background: var(--bgColor-severe-emphasis, #bc4c00); }
${CARD}[${ATTENTION_ATTR}] { outline: 2px solid var(--bgColor-attention-emphasis, #bf8700); outline-offset: -1px;
  border-radius: 6px; }
${CARD}[${ATTENTION_ATTR}="your-turn"] { outline-color: var(--bgColor-accent-emphasis, #0969da); }

/*
 * One highlight, one pass, left to right, over the session's own name rather than its row: a working session is lit,
 * not recoloured, because yellow and blue already mean the two things that want the developer. The image is three
 * times the name and never repeats, so the band leads in from off the left and leaves with nothing behind it.
 */
@keyframes gc-shimmer { from { background-position: 100% 0; } to { background-position: 0% 0; } }
.gc-session[data-phase="running"] .gc-name {
  background-image: linear-gradient(95deg, var(--fgColor-muted, #59636e) 43%,
    var(--fgColor-default, #1f2328) 50%, var(--fgColor-muted, #59636e) 57%);
  background-size: 300% 100%; background-repeat: no-repeat;
  background-clip: text; -webkit-background-clip: text; color: transparent; font-weight: 600;
  animation-name: gc-shimmer; animation-duration: 1.8s; animation-timing-function: linear;
  animation-iteration-count: infinite; }

/*
 * Scoped to the marked card, the way the editor board scopes its own: an idle row on a card asking nothing — one
 * parked in Done — must not be painted as if it were. Three channels on the row that wants you: a rule down its
 * edge — square, so it reads as a rule and not as the corner of a box — its colour, and its weight. No filled surface — a tint behind every marked row is what made a footer of
 * these read as a stack of boxes rather than lines of the card.
 */
${CARD}[${ATTENTION_ATTR}="blocked"] .gc-session[data-phase="waiting"] {
  box-shadow: inset 3px 0 0 var(--bgColor-attention-emphasis, #bf8700); }
${CARD}[${ATTENTION_ATTR}="blocked"] .gc-session[data-phase="waiting"] .gc-name,
${CARD}[${ATTENTION_ATTR}="blocked"] .gc-session[data-phase="waiting"] .gc-state {
  color: var(--fgColor-attention, #9a6700); font-weight: 600; }
${CARD}[${ATTENTION_ATTR}="your-turn"] .gc-session[data-phase="idle"] {
  box-shadow: inset 3px 0 0 var(--bgColor-accent-emphasis, #0969da); }
${CARD}[${ATTENTION_ATTR}="your-turn"] .gc-session[data-phase="idle"] .gc-name,
${CARD}[${ATTENTION_ATTR}="your-turn"] .gc-session[data-phase="idle"] .gc-state {
  color: var(--fgColor-accent, #0969da); font-weight: 600; }

/* Reduced motion must not mean less information: the running session stays marked, it just stops moving. */
@media (prefers-reduced-motion: reduce) {
  .gc-session[data-phase="running"] .gc-name {
    background-image: none; color: var(--fgColor-default, #1f2328); animation-name: none; }
}

/* The gradient is the one thing forced colours may not paint, and the name's own colour is transparent under it. */
@media (forced-colors: active) {
  .gc-session[data-phase="running"] .gc-name {
    background-image: none; color: CanvasText; animation-name: none; }
  ${CARD}[${ATTENTION_ATTR}] { outline-color: Highlight; }
}
.${POPOVER_CLASS} { position: fixed; z-index: 100; min-width: 200px; max-width: 320px; padding: 4px 0;
  font-size: 12px; color: var(--fgColor-default, #1f2328);
  background: var(--overlay-bgColor, var(--bgColor-default, #ffffff));
  border: 1px solid var(--borderColor-default, #d0d7de); border-radius: 12px;
  box-shadow: var(--shadow-floating-small, 0 6px 18px 0 rgba(31, 35, 40, 0.12)); }
.${POPOVER_CLASS} .gc-title { padding: 6px 12px; font-weight: 600; }
.${POPOVER_CLASS} .gc-note { padding: 2px 12px 6px; color: var(--fgColor-muted, #59636e); }
.${POPOVER_CLASS} hr { margin: 4px 0; border: 0; border-top: 1px solid var(--borderColor-muted, #d1d9e0b3); }
.${POPOVER_CLASS} button[role] { display: flex; width: 100%; gap: 8px; align-items: center; padding: 6px 12px;
  font: inherit; text-align: left; background: none; border: 0; color: inherit; cursor: pointer; }
.${POPOVER_CLASS} button[role]:hover { background: var(--bgColor-neutral-muted, #eaeef2); }
.${POPOVER_CLASS} .gc-tick { width: 16px; flex: none; }
.${POPOVER_CLASS} .gc-actions { display: flex; justify-content: flex-end; padding: 4px 12px 8px; }
[${HIDDEN_ATTR}] { display: none !important; }
#${MENU_ID} { display: inline-flex; gap: 4px; }
#${MENU_ID} .gc-collapse { padding-left: 6px; padding-right: 6px; }
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

/**
 * Whether the project's own header is folded away, cached from page storage on first read: the collapse is applied
 * on every scan, and a board that read storage a few times a second would be doing it for an answer that changes
 * when the developer clicks. Null until the first read.
 *
 * @type {boolean | null}
 */
let collapsed = null;

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

/**
 * The last segment of a path. Both separators, because an agent CLI reports the cwd in its platform's own shape.
 *
 * @param {string} dir
 * @returns {string}
 */
function basename(dir) {
  const parts = dir.split(/[\\/]/).filter(Boolean);

  return parts[parts.length - 1] ?? dir;
}

/**
 * What a session calls itself. The same ladder as `core`'s `sessionLabel` and the editor board's, held together by
 * the parity table in this package's tests rather than by an import — this file is loaded by Chrome as it stands.
 *
 * @param {Session} session
 * @returns {string}
 */
export function sessionLabel(session) {
  return session.title ?? session.details.name ?? session.details.shortId ?? basename(session.cwd);
}

/**
 * The phase and how long it has held (R5). Read from the element rather than the session so the tick below can
 * rewrite it without a snapshot.
 *
 * @param {string} phase
 * @param {number} since
 * @param {number} now
 * @returns {string}
 */
function phaseText(phase, since, now) {
  return `${PHASE_WORDS[phase] ?? phase} ${ago(now - since)}`;
}

/**
 * Advances every rendered duration where it stands, once a second (R5). A repaint would rebuild every footer and
 * fight the observer that watches for one, and the phase itself only changes when a hook fires — so the text is
 * rewritten and every other node is left alone.
 *
 * @param {Document} doc
 * @param {number} now
 * @returns {number} how many durations were advanced, which is what a test has to go on
 */
export function tickDurations(doc, now) {
  let moved = 0;

  // Scoped to the overlay's own rows rather than to the attribute: this runs over a page GitHub owns, and a bare
  // attribute selector would rewrite the text of anything of theirs that happened to carry the same name.
  for (const el of doc.querySelectorAll(`.${BADGE_CLASS} .gc-session[data-phase] > [data-activity-since]`)) {
    const phase = /** @type {Element} */ (el.parentElement).getAttribute('data-phase') ?? '';
    const text = phaseText(phase, Number(el.getAttribute('data-activity-since')), now);

    if (el.textContent !== text) {
      el.textContent = text;
      moved += 1;
    }
  }

  return moved;
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

/**
 * Claude's own mark, in Claude's own orange. Drawn as a node rather than fetched: an extension may load only images
 * it ships, and a node is also the one form this file can draw under jsdom. The path is the published logomark.
 */
const CLAUDE_MARK =
  'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z';

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
  const mark = doc.createElementNS(SVG_NS, 'path');

  svg.setAttribute('class', 'gc-agent-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '11');
  svg.setAttribute('height', '11');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', '#d97757');
  mark.setAttribute('d', CLAUDE_MARK);
  svg.appendChild(mark);

  return svg;
}

/**
 * A floating panel in GitHub's own shape. Unplaced: it is `place`d once it is in the document, because where it goes
 * depends on how wide it turned out.
 *
 * @param {Document} doc
 * @param {string} title
 * @returns {HTMLElement}
 */
function popover(doc, title) {
  const panel = doc.createElement('div');

  panel.className = POPOVER_CLASS;

  const heading = doc.createElement('div');

  heading.className = 'gc-title';
  heading.textContent = title;
  panel.appendChild(heading);

  return panel;
}

/** What a panel keeps between itself and the edge it would otherwise run off. */
const MARGIN = 8;

/**
 * Hangs a panel under what opened it: left edges aligned, shifted back only as far as the window makes necessary,
 * and flipped above the anchor rather than off the bottom. Measured after the panel is in the document — a guess at
 * its width puts a menu on a right-hand button hundreds of pixels from it. Read afresh on every scan, so the panel
 * follows a board that scrolled under it.
 *
 * @param {HTMLElement} panel
 * @param {Element} anchor
 */
function place(panel, anchor) {
  const view = panel.ownerDocument.defaultView;
  const rect = anchor.getBoundingClientRect();
  const own = panel.getBoundingClientRect();
  const right = view?.innerWidth ?? 0;
  const bottom = view?.innerHeight ?? 0;

  const below = rect.bottom + 4;
  const overflows = below + own.height > bottom - MARGIN;

  panel.style.top = `${overflows ? Math.max(MARGIN, rect.top - 4 - own.height) : below}px`;
  panel.style.left = `${Math.max(MARGIN, Math.min(rect.left, right - own.width - MARGIN))}px`;
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

/** What the buttons in the filter bar that belong to an unsaved filter say. Every class in that bar is hashed. */
const FILTER_ACTIONS = ['Save', 'Discard'];

/**
 * The container GitHub puts those buttons in, which is a child of the bar rather than the bar itself — hiding the
 * buttons one at a time would leave the gap they sat in.
 *
 * @param {Document} doc
 * @returns {Element[]}
 */
function filterActions(doc) {
  for (const child of doc.querySelector(TOOLBAR)?.children ?? []) {
    const acts = [...child.querySelectorAll('button')].some((button) =>
      FILTER_ACTIONS.includes((button.textContent ?? '').trim()),
    );

    if (acts) {
      return [child];
    }
  }

  return [];
}

/**
 * Everything the collapse folds away: the project's title bar, the row of view tabs, and the Save and Discard an
 * unsaved filter puts in the bar. Each row is found by an attribute GitHub gives it and then climbed to the last
 * ancestor that still does not hold the board — the wrappers are hashed per build, and hiding the tab list alone
 * would leave the container it sits in as a stripe of empty page.
 *
 * @param {Document} doc
 * @returns {Element[]}
 */
export function foldedRows(doc) {
  const region = doc.querySelector(BOARD_REGION);

  // No board on the page yet: a climb with nothing to stop it would run to the page's own root and fold the site away.
  if (region === null) {
    return [];
  }

  /** @type {Element[]} */
  const rows = [];

  for (const selector of [PROJECT_NAV, VIEW_TABS]) {
    let row = doc.querySelector(selector);

    while (row?.parentElement != null && !row.parentElement.contains(region) && row.parentElement !== doc.body) {
      row = row.parentElement;
    }

    if (row !== null && !rows.some((held) => held.contains(row))) {
      rows.push(row);
    }
  }

  return [...rows, ...filterActions(doc)];
}

/**
 * A browser told to block site data throws on the storage itself, not only on the write, and the overlay still has
 * a board to paint. An unreadable choice is the same as one never made.
 *
 * @param {Document} doc
 * @returns {boolean}
 */
function isCollapsed(doc) {
  if (collapsed === null) {
    try {
      collapsed = doc.defaultView?.localStorage.getItem(COLLAPSE_KEY) === 'true';
    } catch {
      collapsed = false;
    }
  }

  return collapsed;
}

/**
 * @param {Document} doc
 * @param {boolean} wanted
 */
function setCollapsed(doc, wanted) {
  collapsed = wanted;

  try {
    doc.defaultView?.localStorage.setItem(COLLAPSE_KEY, String(wanted));
  } catch {
    // Storage full or refused. The collapse still holds for this tab; it just will not survive a reload.
  }
}

/**
 * Folds the header away, or puts it back. Reapplied on every scan rather than once, because a view switch replaces
 * those rows along with the cards (`mechanics.md` §27) and the replacement arrives unhidden.
 *
 * @param {Document} doc
 */
function applyCollapse(doc) {
  const wanted = isCollapsed(doc) ? foldedRows(doc) : [];

  for (const stale of doc.querySelectorAll(`[${HIDDEN_ATTR}]`)) {
    if (!wanted.includes(stale)) {
      stale.removeAttribute(HIDDEN_ATTR);
    }
  }

  for (const row of wanted) {
    row.setAttribute(HIDDEN_ATTR, 'true');
  }
}

/** Octicons `chevron-up` and `chevron-down`, drawn rather than fetched — the same rule the agent mark follows. */
const CHEVRONS = {
  up: 'M3.22 10.53a.749.749 0 0 1 0-1.06l4.25-4.25a.749.749 0 0 1 1.06 0l4.25 4.25a.749.749 0 1 1-1.06 1.06L8 6.811 4.28 10.53a.749.749 0 0 1-1.06 0Z',
  down: 'M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L8 8.939l3.72-3.719a.749.749 0 0 1 1.06 0Z',
};

/**
 * The button beside Ground Control's, which folds the project's title and view tabs away to give the board the
 * height. The choice is remembered in page storage, so it holds across a reload and across every board the
 * developer opens rather than resetting each time the tab does.
 *
 * @param {Document} doc
 * @param {Element} host
 * @param {Actions} actions
 * @returns {HTMLElement}
 */
function collapseButton(doc, host, actions) {
  const button = nativeButton(doc, host);
  const folded = isCollapsed(doc);
  const svg = doc.createElementNS(SVG_NS, 'svg');
  const mark = doc.createElementNS(SVG_NS, 'path');

  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  mark.setAttribute('d', folded ? CHEVRONS.down : CHEVRONS.up);
  svg.appendChild(mark);

  button.className = `${button.className} gc-collapse`.trim();
  button.id = 'gc-collapse';
  button.appendChild(svg);
  button.setAttribute('aria-pressed', String(folded));
  button.title = folded ? 'Show the project header' : 'Hide the project header';
  button.setAttribute('aria-label', button.title);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    event.preventDefault();
    setCollapsed(doc, !folded);
    actions.repaint();
  });

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
  holder.appendChild(collapseButton(doc, host, actions));
  host.appendChild(holder);

  if (!panelOpen) {
    return holder;
  }

  const panel = popover(doc, 'Ground Control');

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

  const actionRow = doc.createElement('div');
  const refresh = nativeButton(doc, host);

  actionRow.className = 'gc-actions';
  refresh.id = 'gc-refresh';
  refresh.textContent = 'Refresh';
  refresh.addEventListener('click', (event) => {
    event.stopPropagation();
    event.preventDefault();
    panelOpen = false;
    actions.refresh();
    actions.repaint();
  });
  actionRow.appendChild(refresh);
  panel.appendChild(actionRow);

  holder.appendChild(panel);
  place(panel, button);

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
 * @param {LanedCard} card
 * @param {Actions} actions
 */
function laneMenu(doc, card, actions) {
  const menu = popover(doc, 'Move to');

  menu.classList.add('gc-lanes');
  menu.setAttribute('role', 'menu');

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
 * One session, as the developer reads it across a board: which agent reported it, what it calls itself, and the one
 * state the board will claim for it — its own observation where it has one, the CLI's own word where it does not,
 * and nothing at all where there is neither (R24).
 *
 * @param {Document} doc
 * @param {Session} session
 * @param {number} now
 * @param {readonly string[]} openable
 * @returns {HTMLElement}
 */
function sessionRow(doc, session, now, openable) {
  const reachable = openable.includes(session.sessionId);
  const row = doc.createElement(reachable ? 'a' : 'span');

  row.className = 'gc-session';
  row.dataset.phase = session.activity?.phase ?? 'none';

  if (reachable) {
    // A real link, not a button: the navigation has to read as the developer's own gesture in the application they
    // are looking at, which is the only thing that gives VS Code the foreground (`mechanics.md` §26, §29).
    row.setAttribute('href', `${OPEN_SESSION_URI}${encodeURIComponent(session.sessionId)}`);
    // A few pixels of drift on the way to a click would otherwise drag the card GitHub wraps around this.
    row.setAttribute('draggable', 'false');
  }

  const icon = agentIcon(doc, session.agent);

  // R2: which agent reported a session is always said. A mark where there is one, the CLI's own name where there
  // is not — an unnamed row would read as Claude's.
  if (icon === null) {
    const named = doc.createElement('span');

    named.className = 'gc-agent';
    named.textContent = session.agent;
    row.appendChild(named);
  } else {
    row.appendChild(icon);
  }

  const name = sessionLabel(session);
  const label = doc.createElement('span');

  label.className = 'gc-name';
  label.textContent = name;
  row.appendChild(label);

  const state = doc.createElement('span');

  state.className = 'gc-state';

  if (session.activity) {
    // The `since` too, so the second-by-second tick can advance this without a snapshot behind it.
    state.setAttribute('data-activity-since', String(session.activity.since));
    state.textContent = phaseText(session.activity.phase, session.activity.since, now);
    row.appendChild(state);
  } else {
    const reported = session.details.state ?? session.details.status;

    if (reported) {
      state.textContent = reported;
      row.appendChild(state);
    }
  }

  // The whole name, because the label ellipsises, and what the board saw, because the duration alone does not say.
  const seen = session.activity ? ` ${stateTitle(session.activity)}` : '';

  const does = reachable ? 'go to this session in VS Code' : 'no editor of yours can open this one';

  row.title = `${name} — ${does}.${seen}`;
  // Only the propagation: the card underneath is GitHub's own button, and a click reaching it opens the issue
  // instead. The navigation itself is the browser's to make, which is what gives VS Code the foreground.
  row.addEventListener('click', (event) => event.stopPropagation());

  return row;
}

/**
 * What the row says on hover: what the board concluded, and the hook it concluded it from (R13).
 *
 * @param {{ phase: string, event: string | null }} activity
 * @returns {string}
 */
function stateTitle(activity) {
  const what = PHASE_TITLES[activity.phase] ?? '';

  return activity.event ? `${what} Last seen at the ${activity.event} hook.`.trim() : what;
}

/**
 * R6, on the project board's own card: the attention goes onto GitHub's own element, which rings the card so it
 * reads from across a board, and the CSS paints the session row it is about. No word of its own — the row already
 * says `needs you` beside the session it means, and a card-level pill said the same thing without naming which one.
 *
 * @param {Document} doc
 * @param {Element} element
 * @param {HTMLElement} head
 * @param {LanedCard} card
 */
function renderAttention(doc, element, head, card) {
  if (card.returned) {
    const mark = doc.createElement('span');

    mark.className = 'gc-mark';
    mark.dataset.mark = 'returned';
    mark.textContent = 'Returned';
    mark.title = 'This card was past your hands and has come back.';
    head.appendChild(mark);
  }

  if (card.attention === null) {
    element.removeAttribute(ATTENTION_ATTR);

    return;
  }

  element.setAttribute(ATTENTION_ATTR, card.attention);
}

/**
 * One card's footer: the lane the board has it in, and a full-width row per session with its phase and how long
 * that phase has held. It goes inside the card's own box — the card element is a drag handle wrapped around it, and anything
 * appended there hangs below the border. Rebuilt from scratch every scan rather than patched: a re-render replaces
 * the card node and takes the old footer with it (`mechanics.md` §27).
 *
 * @param {Document} doc
 * @param {Element} element
 * @param {LanedCard} card
 * @param {number} now
 * @param {Actions} actions
 * @param {readonly string[]} openable
 * @returns {Element[]} the lane menu and the chip it hangs from, when this is the card whose lanes are open
 */
function renderBadge(doc, element, card, now, actions, openable) {
  const badge = doc.createElement('div');

  badge.className = BADGE_CLASS;

  // The lane and the card's own marks share one line; the sessions each get a line of their own under it.
  const head = doc.createElement('div');

  head.className = 'gc-head';
  badge.appendChild(head);

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
  head.appendChild(lane);

  renderAttention(doc, element, head, card);

  for (const session of card.sessions) {
    badge.appendChild(sessionRow(doc, session, now, openable));
  }

  // Inside the card's own bordered box, so the footer reads as a line of the card rather than a chip dropped under it.
  (element.firstElementChild ?? element).appendChild(badge);

  if (openMenu !== card.key) {
    return [];
  }

  const menu = laneMenu(doc, card, actions);

  (doc.body ?? doc.documentElement).appendChild(menu);
  place(menu, lane);

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
  collapsed = null;
  dismissed.clear();
  closeOnOutsideClick(doc, [], () => {});

  for (const row of doc.querySelectorAll(`[${HIDDEN_ATTR}]`)) {
    row.removeAttribute(HIDDEN_ATTR);
  }

  for (const id of [MENU_ID, PERCH_ID, TOASTS_ID]) {
    doc.getElementById(id)?.remove();
  }

  for (const element of doc.querySelectorAll(`.${BADGE_CLASS}, .${POPOVER_CLASS}`)) {
    element.remove();
  }

  for (const card of doc.querySelectorAll('[data-gc-issue]')) {
    card.removeAttribute('data-gc-issue');
  }

  for (const card of doc.querySelectorAll(`[${ATTENTION_ATTR}]`)) {
    card.removeAttribute(ATTENTION_ATTR);
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

  applyCollapse(doc);
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
      element.removeAttribute(ATTENTION_ATTR);

      continue;
    }

    element.setAttribute('data-gc-issue', `${ref.repo}#${ref.number}`);

    const card = index?.byRef.get(`${ref.repo}#${ref.number}`) ?? index?.byNumber.get(ref.number);

    if (card === undefined) {
      element.removeAttribute(ATTENTION_ATTR);

      continue;
    }

    open.push(...renderBadge(doc, element, card, now, actions, state.snapshot?.openable ?? []));

    badges += 1;
  }

  closeOnOutsideClick(doc, panelOpen || openMenu !== null ? open : [], () => actions.repaint());

  return { scanned, badges, menu: menu !== null };
}
