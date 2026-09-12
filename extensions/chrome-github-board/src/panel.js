// @ts-check
/**
 * Read a card's pull request in a side panel over the board (R43). GitHub opens an issue in a panel of its own
 * and a pull request in a new tab; this panel frames the pull request page and is drawn as GitHub draws the
 * issue panel (mechanics M58). The frame loads only because `rules.json` strips the framing refusal from pull
 * request responses.
 */

export const PANEL_ID = 'gc-panel';
/** The frame's `name`, which is how a browser test addresses it. */
const FRAME_NAME = 'gc-pull-panel';
/** Must match `overlay.js`, whose delegated handler draws the tooltip; importing it would be circular. */
const TIP_ATTR = 'data-gc-tip';
const CLOSE_DELAY = 200;
const GRIP_CLASS = 'gc-grip';

/** GitHub's measured `--top-offset`, used where the page has no header to measure. */
const TOP_OFFSET = 72;

/** GitHub's own keys for its issue panel, shared so the two panels pin and dock as one (mechanics M58). */
const PINNED_KEY = 'projects.sidePanelPinned';
const PINNED_WIDTH_KEY = 'projects.sidePanelWidth';
/** Browser-local: the floating width, which GitHub keeps none of. */
const WIDTH_KEY = 'ground-control:panel-width';

/** Width bounds and the keyboard step, as the editor board's conversation panel has them; docked, GitHub's own 256px floor. */
const MIN_WIDTH = 360;
const PINNED_MIN_WIDTH = 256;
const WIDTH_STEP = 40;
/** What a docked panel leaves the board: GitHub's own panel floor. */
const BOARD_MIN_WIDTH = 300;

/** The framed pull request page's own sticky header, marked stuck once its title has scrolled away, and the row it draws the title in (mechanics M58). */
const STICKY_HEADER = '[class*="StickyPullRequestHeader-module__prHeader"]';
const STICKY_STUCK = '[class*="is-stuck"]';
const STICKY_TITLE_AREA = '[class*="StickyPullRequestHeader-module__prTitleArea"]';

/** GitHub's own issue panel, unpinned: the sheet carries its width as an inline variable, which is the hook for resizing it. */
const ISSUE_PANEL = '[role="dialog"][aria-label^="Side panel"]:not(#gc-panel)';
const ISSUE_SHEET = '[style*="--side-panel-width"]';
/** GitHub's issue panel pinned: a page pane that stays in the page closed, and is named for the issue only while open. */
const ISSUE_PANE = '[data-component="PageLayout.Pane"][aria-label^="Side panel: "]';
/** GitHub's content column in either form of its issue panel, capped at 1280px, which a wider panel would leave empty. */
const ISSUE_CONTENT = '[class*="ContentWrapper-module__contentContainer"]';

const PULL_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?=[/?#]|$)/;

export const PANEL_CSS = `
#${PANEL_ID} { position: fixed; inset: var(--gc-panel-top, ${TOP_OFFSET}px) 0 0 0; z-index: 100;
  --gc-ease: cubic-bezier(.25, .46, .45, .94); }
#${PANEL_ID} .gc-panel-backdrop { position: absolute; inset: 0; opacity: 0; transition: opacity ${CLOSE_DELAY}ms var(--gc-ease);
  background: var(--overlay-backdrop-bgColor, rgba(200, 209, 218, 0.4)); }
#${PANEL_ID} .gc-panel-sheet { position: absolute; top: 0; right: 0; bottom: 0; width: var(--gc-panel-width, min(90%, 1280px));
  min-width: 300px; display: flex; flex-direction: column; opacity: 0; transform: translateX(35%);
  transition: opacity ${CLOSE_DELAY}ms var(--gc-ease), transform ${CLOSE_DELAY}ms var(--gc-ease);
  border-radius: var(--borderRadius-large, 12px) 0 0 var(--borderRadius-large, 12px);
  background: var(--bgColor-default, #ffffff); color: var(--fgColor-default, #1f2328);
  box-shadow: var(--shadow-floating-large, 0 0 0 1px rgba(209, 217, 224, 0), 0 40px 80px rgba(37, 41, 46, 0.24)); }
#${PANEL_ID}[data-open="true"] .gc-panel-backdrop { opacity: 1; }
#${PANEL_ID}[data-open="true"] .gc-panel-sheet { opacity: 1; transform: none; }
/* Sliding out, the panel is already closed: a click through the fading backdrop reaches the board. */
#${PANEL_ID}:not([data-open="true"]) { pointer-events: none; }
/* Pinned, the panel is a pane beside the board, as GitHub docks its own: no backdrop, no shadow, a divider on its edge. */
#${PANEL_ID}[data-pinned="true"] { left: auto; width: var(--gc-panel-width); }
#${PANEL_ID}[data-pinned="true"] .gc-panel-backdrop { display: none; }
#${PANEL_ID}[data-pinned="true"] .gc-panel-sheet { width: 100%; box-sizing: border-box; border-radius: 0; box-shadow: none;
  transition: none; border-left: 1px solid var(--borderColor-default, #d1d9e0); }
/* The edge is dragged to size the panel: a 7px target astride the edge, tinted while pointed at or held, as GitHub's pane splitter is. */
.${GRIP_CLASS} { position: absolute; top: 0; bottom: 0; left: -3px; width: 7px; padding: 0; border: 0; background: transparent;
  cursor: col-resize; touch-action: none; z-index: 1; }
.${GRIP_CLASS}:hover, .${GRIP_CLASS}:focus-visible, .${GRIP_CLASS}[data-dragging="true"] { background: var(--bgColor-neutral-muted, #818b981f); }
.${GRIP_CLASS}:focus-visible { outline: 2px solid var(--fgColor-accent, #0969da); outline-offset: -2px; }
/* A frame swallows the pointer, so the drag would end at its edge. */
#${PANEL_ID}[data-dragging="true"] .gc-panel-frame { pointer-events: none; }
/* GitHub's own panel: the grip stands on the dialog beside the sheet, which scrolls, at the sheet's width from the right. */
${ISSUE_PANEL} > .${GRIP_CLASS} { position: fixed; left: auto; top: var(--top-offset, ${TOP_OFFSET}px); z-index: 1; }
#${PANEL_ID} .gc-panel-bar { flex: none; display: flex; align-items: center; gap: 8px; height: 48px; padding: 8px 24px 0;
  box-sizing: border-box; font-size: 14px; }
#${PANEL_ID} .gc-panel-ref { display: inline-flex; align-items: center; gap: 6px; flex: 1 1 auto; min-width: 0;
  color: var(--fgColor-muted, #59636e); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${PANEL_ID} .gc-panel-ref:hover { color: var(--fgColor-accent, #0969da); text-decoration: underline; }
#${PANEL_ID} .gc-panel-ref svg { flex: none; fill: currentColor; }
${actionsCss(`#${PANEL_ID} `)}
/* Scrolled, the page's own sticky header carries the controls, and the bar gives the page its height back. */
#${PANEL_ID}[data-scrolled="true"] .gc-panel-bar { display: none; }
/* The sheet does not clip, so the grip can stand astride its edge; the frame rounds its own corner instead. */
#${PANEL_ID} .gc-panel-frame { flex: 1 1 auto; width: 100%; border: 0; background: var(--bgColor-default, #ffffff);
  border-radius: 0 0 0 var(--borderRadius-large, 12px); }
#${PANEL_ID}[data-pinned="true"] .gc-panel-frame { border-radius: 0; }
#${PANEL_ID} .gc-panel-refused { padding: 24px; }
#${PANEL_ID} .gc-panel-refused a { color: var(--fgColor-accent, #0969da); }
/* GitHub's issue panel lays its content in a 1280px column; a wider panel is for reading, not for margins. */
${ISSUE_PANEL} ${ISSUE_CONTENT}, ${ISSUE_PANE} ${ISSUE_CONTENT} { max-width: none; }
@media (prefers-reduced-motion: reduce) {
  #${PANEL_ID} .gc-panel-backdrop, #${PANEL_ID} .gc-panel-sheet { transition: none; }
}
[data-gc-motion="reduced"] #${PANEL_ID} .gc-panel-backdrop, [data-gc-motion="reduced"] #${PANEL_ID} .gc-panel-sheet { transition: none; }
`;

/**
 * What the framed page hides so it reads as a panel rather than a whole site: the site header, the repository header,
 * and the footer. The controls are drawn there too, for the page's sticky header to carry (mechanics M58).
 */
const FRAME_CSS = `
.js-header-wrapper, header.AppHeader, #repository-container-header, footer.footer { display: none !important; }
main .container-xl, main [class*="prc-PageLayout-Content-"], main [class*="prc-PageLayout-ContentWrapper-"] { max-width: none !important; }
${actionsCss('')}
${STICKY_TITLE_AREA} > .gc-panel-actions { order: 2; margin-left: auto; align-self: center; flex: none; }
`;

/**
 * The panel's controls, as GitHub's issue panel draws them: 32px icon buttons in the muted colour, 4px apart.
 *
 * @param {string} scope
 */
function actionsCss(scope) {
  return `${scope}.gc-panel-actions { display: flex; gap: 4px; }
${scope}.gc-panel-actions > * { display: grid; place-items: center; width: 32px; height: 32px; padding: 0; margin: 0;
  border: 0; border-radius: 6px; background: transparent; color: var(--fgColor-muted, #59636e); cursor: pointer; }
${scope}.gc-panel-actions > *:hover { background: var(--control-transparent-bgColor-hover, rgba(208, 215, 222, 0.32)); }
${scope}.gc-panel-actions > *:focus-visible { outline: 2px solid var(--fgColor-accent, #0969da); outline-offset: -2px; }
${scope}.gc-panel-actions svg { width: 16px; height: 16px; fill: currentColor; }`;
}

/** Octicon paths, copied from GitHub's markup (mechanics M58). */
const OCTICONS = {
  'git-pull-request':
    'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z',
  copy: 'M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25ZM5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z',
  check: 'M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z',
  'link-external':
    'M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z',
  x: 'M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z',
  pin: 'm11.294.984 3.722 3.722a1.75 1.75 0 0 1-.504 2.826l-1.327.613a3.089 3.089 0 0 0-1.707 2.084l-.584 2.454c-.317 1.332-1.972 1.8-2.94.832L5.75 11.311 1.78 15.28a.749.749 0 1 1-1.06-1.06l3.969-3.97-2.204-2.204c-.968-.968-.5-2.623.832-2.94l2.454-.584a3.08 3.08 0 0 0 2.084-1.707l.613-1.327a1.75 1.75 0 0 1 2.826-.504ZM6.283 9.723l2.732 2.731a.25.25 0 0 0 .42-.119l.584-2.454a4.586 4.586 0 0 1 2.537-3.098l1.328-.613a.25.25 0 0 0 .072-.404l-3.722-3.722a.25.25 0 0 0-.404.072l-.613 1.328a4.584 4.584 0 0 1-3.098 2.537l-2.454.584a.25.25 0 0 0-.119.42l2.731 2.732Z',
  'pin-slash': [
    'm1.655.595 13.75 13.75q.22.219.22.53 0 .311-.22.53-.219.22-.53.22-.311 0-.53-.22L.595 1.655q-.22-.219-.22-.53 0-.311.22-.53.219-.22.53-.22.311 0 .53.22ZM.72 14.22l4.5-4.5q.219-.22.53-.22.311 0 .53.22.22.219.22.53 0 .311-.22.53l-4.5 4.5q-.219.22-.53.22-.311 0-.53-.22-.22-.219-.22-.53 0-.311.22-.53Z',
    'm5.424 6.146-1.759.419q-.143.034-.183.175-.04.141.064.245l5.469 5.469q.104.104.245.064.141-.04.175-.183l.359-1.509q.072-.302.337-.465.264-.163.567-.091.302.072.465.337.162.264.09.567l-.359 1.509q-.238.999-1.226 1.278-.988.28-1.714-.446L2.485 8.046q-.726-.726-.446-1.714.279-.988 1.278-1.226l1.759-.419q.303-.072.567.091.265.163.337.465.072.302-.091.567-.163.264-.465.336ZM7.47 3.47q.155-.156.247-.355l.751-1.627Q8.851.659 9.75.498q.899-.16 1.544.486l3.722 3.722q.646.645.486 1.544-.161.899-.99 1.282l-1.627.751q-.199.092-.355.247-.219.22-.53.22-.311 0-.53-.22-.22-.219-.22-.53 0-.311.22-.53.344-.345.787-.549l1.627-.751q.118-.055.141-.183.023-.128-.069-.221l-3.722-3.722q-.092-.092-.221-.069-.128.023-.183.141l-.751 1.627q-.204.443-.549.787-.219.22-.53.22-.311 0-.53-.22-.22-.219-.22-.53 0-.311.22-.53Z',
  ],
};

/**
 * @typedef {{ repo: string, number: number, url: string }} PullRef
 * @typedef {{ root: HTMLElement, pin: HTMLElement, trigger: Element, ref: PullRef, key: (event: KeyboardEvent) => void, inerted: Element[], pinned: boolean, report: () => void, replaced: string | null }} Open
 * @typedef {{ width: () => number, min: () => number, max: () => number, resize: (width: number) => void, done: () => void }} Sizing
 */

/** @type {Open | null} */
let open = null;
/** @type {{ doc: Document, click: (event: MouseEvent) => void } | null} */
let watching = null;

/**
 * The pull request a link names, or null for any other address. The fragment is kept so a comment link lands on
 * its comment.
 *
 * @param {string} href
 * @returns {PullRef | null}
 */
export function pullRefOf(href) {
  const match = PULL_URL.exec(href);

  return match ? { repo: match[1] ?? '', number: Number(match[2]), url: href } : null;
}

/**
 * Open every pull request link inside a card in the panel. A modified or non-primary click is GitHub's to handle,
 * as it is on the editor board (R43).
 *
 * @param {Document} doc
 * @param {string} within selector for the cards whose links are taken
 */
export function watchPulls(doc, within) {
  if (watching?.doc === doc) {
    return;
  }

  unwatchPulls();

  /** @param {MouseEvent} event */
  const click = (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.defaultPrevented) {
      return;
    }

    const link = linkOf(event);
    const ref = link === null || link.closest(within) === null ? null : pullRefOf(new URL(link.getAttribute('href') ?? '', doc.baseURI).href);

    if (link === null || ref === null) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    openPanel(doc, ref, link);
  };

  doc.addEventListener('click', click, true);
  watching = { doc, click };
}

/**
 * The anchor a click landed in. Read by method rather than `instanceof`: a node of the framed document belongs to
 * another realm, whose `Element` is not this one.
 *
 * @param {Event} event
 * @returns {Element | null}
 */
function linkOf(event) {
  const target = /** @type {Element | null} */ (event.target);

  return typeof target?.closest === 'function' ? target.closest('a[href]') : null;
}

/** Stop taking the links and close the panel, when leaving the board. */
export function unwatchPulls() {
  if (watching === null) {
    return;
  }

  watching.doc.removeEventListener('click', watching.click, true);
  undressIssuePanel(watching.doc);
  watching = null;
  closePanel(true);
}

/**
 * A stored number, or null where there is none or storage is refused.
 *
 * @param {Document} doc
 * @param {string} key
 */
function stored(doc, key) {
  try {
    const value = Number(doc.defaultView?.localStorage.getItem(key));

    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * @param {Document} doc
 * @param {string} key
 * @param {string} value
 */
function store(doc, key, value) {
  try {
    doc.defaultView?.localStorage.setItem(key, value);
  } catch {
    // Storage full or refused: the choice holds for this panel and does not survive a reload.
  }
}

/** @param {Document} doc */
function pinnedByDefault(doc) {
  try {
    return doc.defaultView?.localStorage.getItem(PINNED_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * The widest a panel can go: a floating one nearly the window, as the editor board allows; a docked one leaves the
 * board its floor.
 *
 * @param {Document} doc
 * @param {boolean} pinned
 */
function maxWidth(doc, pinned) {
  const window = doc.defaultView?.innerWidth ?? 0;

  return pinned ? Math.max(PINNED_MIN_WIDTH, window - BOARD_MIN_WIDTH) : Math.max(MIN_WIDTH, Math.round(window * 0.95));
}

/**
 * @param {number} width
 * @param {number} min
 * @param {number} max
 */
function clamp(width, min, max) {
  return Math.max(min, Math.min(Math.round(width), max));
}

/**
 * The control on a panel's left edge that sizes it, by pointer and by arrow key. A separator, as the editor board's
 * is, reporting the width so the keys have audible effect.
 *
 * @param {Document} doc
 * @param {Sizing} sizing
 */
function grip(doc, sizing) {
  const handle = doc.createElement('button');
  const report = () => {
    handle.setAttribute('aria-valuemin', String(sizing.min()));
    handle.setAttribute('aria-valuemax', String(sizing.max()));
    handle.setAttribute('aria-valuenow', String(Math.round(sizing.width())));
  };
  // Only a size the developer set is kept: a Tab through the grip must not turn the stylesheet's width into a fixed one.
  let changed = false;
  /** @param {number} width */
  const resize = (width) => {
    const next = clamp(width, sizing.min(), sizing.max());

    if (next === Math.round(sizing.width())) {
      return;
    }

    sizing.resize(next);
    report();
    changed = true;
  };
  const save = () => {
    if (changed) {
      changed = false;
      sizing.done();
    }
  };

  handle.type = 'button';
  handle.className = GRIP_CLASS;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', 'Resize conversation');
  report();

  handle.addEventListener('pointerdown', (event) => {
    // Captured, so a fast drag that leaves the grip keeps sizing, and the text selection a drag would start does not.
    handle.setPointerCapture(event.pointerId);
    handle.dataset.dragging = 'true';
    handle.closest(`#${PANEL_ID}`)?.setAttribute('data-dragging', 'true');
    event.preventDefault();

    const from = event.clientX;
    const started = sizing.width();
    /** @param {PointerEvent} moved */
    const move = (moved) => resize(started + (from - moved.clientX));
    const done = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', done);
      handle.removeEventListener('pointercancel', done);
      delete handle.dataset.dragging;
      handle.closest(`#${PANEL_ID}`)?.removeAttribute('data-dragging');
      save();
    };

    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', done);
    handle.addEventListener('pointercancel', done);
  });

  handle.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowLeft' ? WIDTH_STEP : event.key === 'ArrowRight' ? -WIDTH_STEP : 0;

    if (step === 0) {
      return;
    }

    event.preventDefault();
    resize(sizing.width() + step);
  });

  // Once the keys stop, not on every repeat of a held one.
  handle.addEventListener('keyup', save);

  return { handle, report };
}

/**
 * Give GitHub's own issue panel the same edge, since GitHub sizes it only once pinned. The sheet's inline width
 * variable is set to the stored width, and set again on every paint, because GitHub redraws the sheet on its own
 * schedule. The grip stands beside the sheet on the dialog, fixed at the sheet's edge, because the sheet scrolls.
 * GitHub's panel, in either form, also takes the pull request panel's place, and its pinned pane is let grow to the
 * docked width the two share.
 *
 * @param {Document} doc
 */
export function dressIssuePanel(doc) {
  const dialog = doc.querySelector(ISSUE_PANEL);
  const sheet = /** @type {HTMLElement | null} */ (dialog?.querySelector(ISSUE_SHEET) ?? null);
  const pane = /** @type {HTMLElement | null} */ (doc.querySelector(ISSUE_PANE));

  // GitHub's panel has taken the pull request panel's place; a pinned one keeps the width, from the shared key.
  // The pane this panel closed on opening is still on its way out until a paint finds it gone.
  if (open !== null) {
    if (pane === null && open.replaced !== null) {
      open.replaced = null;

      // GitHub's pane hands focus back to the board as it goes; the panel that took its place takes that too.
      if (!open.root.contains(doc.activeElement)) {
        /** @type {HTMLElement | null} */ (open.root.querySelector('[aria-label="Close panel"]'))?.focus();
      }
    }

    if (dialog !== null || (pane !== null && pane.getAttribute('aria-label') !== open.replaced)) {
      closePanel(true, false);
    }
  }

  if (pane !== null) {
    // GitHub caps its pane below the shared width; the cap is lifted to the docked panel's own.
    pane.style.setProperty('--pane-max-width', `${maxWidth(doc, true)}px`);
  }

  if (dialog === null || sheet === null) {
    return;
  }

  const width = stored(doc, WIDTH_KEY);
  const wanted = width === null ? '' : `${clamp(width, MIN_WIDTH, maxWidth(doc, false))}px`;
  /** @type {HTMLElement | null} */
  let handle = dialog.querySelector(`:scope > .${GRIP_CLASS}`);

  if (handle === null) {
    // GitHub may replace the sheet under a dialog that stays, so the sheet is looked up again on every use.
    const current = () => /** @type {HTMLElement} */ (dialog.querySelector(ISSUE_SHEET) ?? sheet);
    const measure = () => current().getBoundingClientRect().width;
    const made = grip(doc, {
      width: measure,
      min: () => MIN_WIDTH,
      max: () => maxWidth(doc, false),
      resize: (next) => {
        current().style.setProperty('--side-panel-width', `${next}px`);
        placeGrip(made.handle, current());
      },
      done: () => store(doc, WIDTH_KEY, String(Math.round(measure()))),
    });

    handle = made.handle;
    // The width GitHub gave the sheet, put back when the overlay leaves the board.
    handle.dataset.was = sheet.style.getPropertyValue('--side-panel-width');
    dialog.appendChild(handle);

    // The sheet slides in and follows the window, and the grip follows the sheet's edge.
    const Observer = doc.defaultView?.ResizeObserver;

    if (Observer !== undefined) {
      new Observer(() => placeGrip(made.handle, current())).observe(sheet);
    }
  }

  if (wanted !== '' && sheet.style.getPropertyValue('--side-panel-width') !== wanted) {
    sheet.style.setProperty('--side-panel-width', wanted);
  }

  placeGrip(handle, sheet);
}

/**
 * Take the place of GitHub's pinned issue pane: its width becomes the shared docked width, and it is closed by its
 * own control, so the pull request panel opens where it stood.
 *
 * @param {Document} doc
 */
function takeIssuePane(doc) {
  const pane = /** @type {HTMLElement | null} */ (doc.querySelector(ISSUE_PANE));

  if (pane === null) {
    return null;
  }

  const width = Math.round(pane.getBoundingClientRect().width) || parseInt(pane.style.getPropertyValue('--pane-width'), 10);

  if (width > 0) {
    store(doc, PINNED_WIDTH_KEY, String(width));
  }

  namedControl(pane, 'Close panel')?.click();

  return pane.getAttribute('aria-label');
}

/**
 * GitHub names its panel controls by tooltip elements, `aria-labelledby`, rather than `aria-label`.
 *
 * @param {Element} root
 * @param {string} name
 */
function namedControl(root, name) {
  const doc = root.ownerDocument;

  for (const button of root.querySelectorAll('button')) {
    const by = button.getAttribute('aria-labelledby');
    const label = by === null ? button.getAttribute('aria-label') : by.split(/\s+/).map((id) => doc.getElementById(id)?.textContent ?? '').join(' ');

    if (label?.trim() === name) {
      return button;
    }
  }

  return null;
}

/**
 * @param {HTMLElement} handle
 * @param {HTMLElement} sheet
 */
function placeGrip(handle, sheet) {
  handle.style.right = `${sheet.getBoundingClientRect().width - 4}px`;
}

/**
 * Take the grip off GitHub's panel and give the sheet its own width back.
 *
 * @param {Document} doc
 */
function undressIssuePanel(doc) {
  for (const handle of doc.querySelectorAll(`${ISSUE_PANEL} > .${GRIP_CLASS}`)) {
    const sheet = /** @type {HTMLElement | null} */ (handle.parentElement?.querySelector(ISSUE_SHEET) ?? null);

    sheet?.style.setProperty('--side-panel-width', /** @type {HTMLElement} */ (handle).dataset.was ?? '');
    handle.remove();
  }
}

/**
 * Where the panel starts: under GitHub's site header, which stays reachable above it, as GitHub's own panel leaves it.
 *
 * @param {Document} doc
 */
function topOffset(doc) {
  const header = doc.querySelector('header');
  const bottom = header?.getBoundingClientRect().bottom ?? 0;

  return bottom > 0 ? Math.round(bottom) : TOP_OFFSET;
}

/**
 * @param {Document} doc
 * @param {keyof typeof OCTICONS} name
 */
function octicon(doc, name) {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');

  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');

  for (const d of [OCTICONS[name]].flat()) {
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');

    path.setAttribute('d', d);
    svg.appendChild(path);
  }

  return svg;
}

/**
 * @param {Document} doc
 * @param {'button' | 'a'} tag
 * @param {string} name
 * @param {keyof typeof OCTICONS} mark
 */
function control(doc, tag, name, mark) {
  const element = doc.createElement(tag);

  if (element instanceof HTMLButtonElement) {
    element.type = 'button';
  }

  element.setAttribute('aria-label', name);
  element.setAttribute(TIP_ATTR, name);
  element.appendChild(octicon(doc, mark));

  return element;
}

/**
 * Open the panel on a pull request, replacing one already open. Everything else in the page is `inert` while it is
 * open, as `aria-modal` says, so neither Tab nor the pointer reaches the board. Focus lands on the close control so
 * Escape works at once; it returns to the trigger on close. Each control acts on its own panel, since a closed one
 * stays in the page while it slides out.
 *
 * @param {Document} doc
 * @param {PullRef} ref
 * @param {Element} trigger
 */
function openPanel(doc, ref, trigger) {
  if (open !== null) {
    if (open.ref.url === ref.url) {
      return;
    }

    closePanel(true);
  }

  const replaced = takeIssuePane(doc);

  const root = doc.createElement('div');
  const backdrop = doc.createElement('div');
  const sheet = doc.createElement('div');
  const bar = doc.createElement('div');
  const link = doc.createElement('a');
  const actions = doc.createElement('div');
  const copy = control(doc, 'button', 'Copy link', 'copy');
  const pin = control(doc, 'button', 'Pin side panel', 'pin');
  const external = /** @type {HTMLAnchorElement} */ (control(doc, 'a', 'Open in new tab', 'link-external'));
  const close = control(doc, 'button', 'Close panel', 'x');
  const frame = doc.createElement('iframe');
  const mine = () => open?.root === root;

  root.id = PANEL_ID;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', `Side panel: Pull request: ${ref.repo}#${ref.number}`);
  root.style.setProperty('--gc-panel-top', `${topOffset(doc)}px`);
  pin.addEventListener('click', () => mine() && setPinned(doc, !(/** @type {Open} */ (open).pinned)));

  backdrop.className = 'gc-panel-backdrop';
  backdrop.addEventListener('click', () => mine() && !(/** @type {Open} */ (open).pinned) && closePanel());
  sheet.className = 'gc-panel-sheet';
  bar.className = 'gc-panel-bar';
  link.className = 'gc-panel-ref';
  link.href = ref.url;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.append(octicon(doc, 'git-pull-request'), `${ref.repo} #${ref.number}`);
  actions.className = 'gc-panel-actions';
  external.href = ref.url;
  external.target = '_blank';
  external.rel = 'noreferrer';
  copy.addEventListener('click', () => {
    // A refused write, as when focus is in the frame, leaves the mark as it is.
    void doc.defaultView?.navigator.clipboard?.writeText(ref.url).then(
      () => {
        copy.replaceChildren(octicon(doc, 'check'));
        setTimeout(() => copy.replaceChildren(octicon(doc, 'copy')), 2000);
      },
      () => {},
    );
  });
  close.addEventListener('click', () => mine() && closePanel());
  actions.append(copy, pin, external, close);
  bar.append(link, actions);
  frame.className = 'gc-panel-frame';
  frame.name = FRAME_NAME;
  frame.title = `Pull request #${ref.number}`;
  frame.src = ref.url;
  frame.addEventListener('load', () => mine() && loaded(doc, root, frame, ref, bar, actions));

  const measure = () => sheet.getBoundingClientRect().width;
  const { handle, report } = grip(doc, {
    width: measure,
    min: () => (open?.pinned === true ? PINNED_MIN_WIDTH : MIN_WIDTH),
    max: () => maxWidth(doc, open?.pinned === true),
    resize: (next) => mine() && setWidth(doc, root, next),
    done: () => mine() && store(doc, open?.pinned === true ? PINNED_WIDTH_KEY : WIDTH_KEY, String(Math.round(measure()))),
  });

  sheet.append(handle, bar, frame);
  root.append(backdrop, sheet);

  // Only a floating panel is modal: Escape leaves a docked one where it is, as it leaves GitHub's.
  /** @param {KeyboardEvent} event */
  const key = (event) => {
    if (event.key === 'Escape' && open?.pinned === false) {
      event.stopPropagation();
      closePanel();
    }
  };

  doc.addEventListener('keydown', key, true);
  doc.body.appendChild(root);
  open = { root, pin, trigger, ref, key, inerted: [], pinned: false, report, replaced };
  setPinned(doc, pinnedByDefault(doc));
  close.focus();

  // Laid out closed before it is marked open, or there is nothing for the slide to start from.
  root.getBoundingClientRect();
  root.setAttribute('data-open', 'true');
}

/**
 * Dock the panel beside the board, or float it over the board again. Floating, the panel is modal and everything
 * else on the page is `inert`; docked, the board keeps the width the panel leaves it and stays live. The choice is
 * kept for the next panel, as GitHub keeps its own.
 *
 * @param {Document} doc
 * @param {boolean} pinned
 */
function setPinned(doc, pinned) {
  if (open === null) {
    return;
  }

  const { root, pin, inerted } = open;

  open.pinned = pinned;
  root.setAttribute('data-pinned', String(pinned));
  root.setAttribute('aria-modal', String(!pinned));
  store(doc, PINNED_KEY, String(pinned));
  pin.setAttribute('aria-label', pinned ? 'Unpin side panel' : 'Pin side panel');
  pin.setAttribute(TIP_ATTR, pinned ? 'Unpin side panel' : 'Pin side panel');
  pin.replaceChildren(octicon(doc, pinned ? 'pin-slash' : 'pin'));

  for (const child of inerted) {
    child.removeAttribute('inert');
  }

  open.inerted = pinned ? [] : [...doc.body.children].filter((child) => child !== root && !child.hasAttribute('inert'));

  for (const child of open.inerted) {
    child.setAttribute('inert', '');
  }

  const width = stored(doc, pinned ? PINNED_WIDTH_KEY : WIDTH_KEY);

  setWidth(doc, root, width === null ? null : width);
  open.report();
}

/**
 * Size the panel, and docked, leave the board the rest. Null is the stylesheet's own width: GitHub's `min(90%, 1280px)`
 * floating, and GitHub's 320px docked.
 *
 * @param {Document} doc
 * @param {HTMLElement} root
 * @param {number | null} width
 */
function setWidth(doc, root, width) {
  const pinned = root.getAttribute('data-pinned') === 'true';
  const chosen = width === null ? (pinned ? 320 : null) : clamp(width, pinned ? PINNED_MIN_WIDTH : MIN_WIDTH, maxWidth(doc, pinned));

  root.style.setProperty('--gc-panel-width', chosen === null ? '' : `${chosen}px`);
  shrinkBoard(doc, pinned ? chosen : null);
}

/**
 * The board gives a docked panel its width from the right, as GitHub's page layout gives its own pane.
 *
 * @param {Document} doc
 * @param {number | null} width
 */
function shrinkBoard(doc, width) {
  const host = /** @type {HTMLElement | null} */ (doc.querySelector('main') ?? doc.body);

  if (host !== null) {
    host.style.marginRight = width === null ? '' : `${width}px`;
  }
}

/**
 * The frame has a document. Chrome answers a refused frame with its own error page, which this cannot read; the
 * panel says so rather than showing the browser's page.
 *
 * @param {Document} doc
 * @param {HTMLElement} root
 * @param {HTMLIFrameElement} frame
 * @param {PullRef} ref
 * @param {HTMLElement} bar
 * @param {HTMLElement} actions
 */
function loaded(doc, root, frame, ref, bar, actions) {
  /** @type {Document | null} */
  let inner = null;

  try {
    inner = frame.contentDocument;
  } catch {
    inner = null;
  }

  // A new document starts unscrolled, and the last one took the controls with it.
  showBar(root, bar, actions);

  if (inner === null) {
    const refused = doc.createElement('p');
    const link = doc.createElement('a');

    refused.className = 'gc-panel-refused';
    link.href = ref.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = 'open it in a new tab';
    refused.append('GitHub refused to load this pull request in the panel; ', link, '.');
    frame.replaceWith(refused);

    return;
  }

  // The frame's first document, before the page arrives, is blank.
  if (!inner.location.href.startsWith('https://github.com/')) {
    return;
  }

  const title = inner.querySelector('h1')?.textContent?.trim() ?? '';

  root.setAttribute('aria-label', `Side panel: Pull request: ${title === '' ? `${ref.repo}#${ref.number}` : title}`);
  dress(inner);
  follow(inner, root, bar, actions);

  // After the page's own handlers, so an Escape that closed a menu on the page does not close the panel too.
  inner.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented && open?.root === root && !open.pinned) {
      closePanel();
    }
  });

  // Only this pull request's pages can load in the frame (`rules.json`); a link anywhere else opens a tab.
  inner.addEventListener(
    'click',
    (event) => {
      const link = linkOf(event);

      if (link === null || event.defaultPrevented) {
        return;
      }

      const target = new URL(link.getAttribute('href') ?? '', inner.location.href);
      const same = pullRefOf(target.href);

      if (!target.protocol.startsWith('http') || (same !== null && same.repo === ref.repo && same.number === ref.number)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      doc.defaultView?.open(target.href, '_blank', 'noreferrer');
    },
    true,
  );
}

/**
 * Give the controls to the page's sticky header while it is stuck, and take the bar away, so the scrolled panel reads
 * as GitHub's own: one row with the state, the title, and the controls. The page redraws its header, so the controls
 * are placed again whenever the page changes, and come back to the bar when the header goes or unsticks.
 *
 * @param {Document} inner
 * @param {HTMLElement} root
 * @param {HTMLElement} bar
 * @param {HTMLElement} actions
 */
function follow(inner, root, bar, actions) {
  const sync = () => {
    const header = inner.querySelector(STICKY_HEADER);
    const area = header?.matches(STICKY_STUCK) ? header.querySelector(STICKY_TITLE_AREA) : null;

    if (area == null) {
      showBar(root, bar, actions);

      return;
    }

    place(actions, area);
    root.setAttribute('data-scrolled', 'true');
  };
  const view = inner.defaultView ?? globalThis;
  let queued = false;
  const later = () => {
    if (!queued) {
      queued = true;
      view.requestAnimationFrame(() => {
        queued = false;
        sync();
      });
    }
  };

  inner.addEventListener('scroll', later, { passive: true });
  new view.MutationObserver(later).observe(inner.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  // The page can leave while stuck; the controls come home before the next document loads, or fails to.
  view.addEventListener('pagehide', () => showBar(root, bar, actions));
  sync();
}

/**
 * @param {HTMLElement} root
 * @param {HTMLElement} bar
 * @param {HTMLElement} actions
 */
function showBar(root, bar, actions) {
  place(actions, bar);
  root.removeAttribute('data-scrolled');
}

/**
 * Move the controls into another row, and another document; a control that held focus keeps it, since adoption blurs.
 *
 * @param {HTMLElement} actions
 * @param {Element} into
 */
function place(actions, into) {
  if (actions.parentElement === into) {
    return;
  }

  const active = actions.ownerDocument.activeElement;
  const held = actions.contains(active) ? /** @type {HTMLElement | null} */ (active) : null;

  into.appendChild(actions);
  held?.focus();
}

/**
 * Hide the framed page's site chrome. The page replaces its head on navigation, so the style is put back when it goes.
 *
 * @param {Document} inner
 */
function dress(inner) {
  const style = inner.createElement('style');

  style.id = `${PANEL_ID}-frame-style`;
  style.textContent = FRAME_CSS;
  inner.head.appendChild(style);

  // The frame's own observer: one from this realm refuses that document's nodes.
  new (inner.defaultView ?? globalThis).MutationObserver(() => {
    if (!style.isConnected) {
      inner.head.appendChild(style);
    }
  }).observe(inner.head, { childList: true });
}

/**
 * Close the panel, sliding out unless told to go at once, and hand focus back to the link that opened it, unless
 * another panel has taken its place and focus.
 *
 * @param {boolean} [now]
 * @param {boolean} [refocus]
 */
function closePanel(now = false, refocus = true) {
  if (open === null) {
    return;
  }

  const { root, trigger, key, inerted } = open;
  const doc = root.ownerDocument;

  open = null;
  doc.removeEventListener('keydown', key, true);
  root.removeAttribute('data-open');
  shrinkBoard(doc, null);

  for (const child of inerted) {
    child.removeAttribute('inert');
  }

  if (now) {
    root.remove();
  } else {
    setTimeout(() => root.remove(), CLOSE_DELAY);
  }

  if (refocus && trigger instanceof HTMLElement && trigger.isConnected) {
    trigger.focus();
  }
}
