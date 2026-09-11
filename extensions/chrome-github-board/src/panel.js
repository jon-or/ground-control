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

/** GitHub's measured `--top-offset`, used where the page has no header to measure. */
const TOP_OFFSET = 72;

const PULL_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?=[/?#]|$)/;

export const PANEL_CSS = `
#${PANEL_ID} { position: fixed; inset: var(--gc-panel-top, ${TOP_OFFSET}px) 0 0 0; z-index: 100;
  --gc-ease: cubic-bezier(.25, .46, .45, .94); }
#${PANEL_ID} .gc-panel-backdrop { position: absolute; inset: 0; opacity: 0; transition: opacity ${CLOSE_DELAY}ms var(--gc-ease);
  background: var(--overlay-backdrop-bgColor, rgba(200, 209, 218, 0.4)); }
#${PANEL_ID} .gc-panel-sheet { position: absolute; top: 0; right: 0; bottom: 0; width: min(90%, 1280px); min-width: 300px;
  display: flex; flex-direction: column; opacity: 0; transform: translateX(35%);
  transition: opacity ${CLOSE_DELAY}ms var(--gc-ease), transform ${CLOSE_DELAY}ms var(--gc-ease);
  border-radius: var(--borderRadius-large, 12px) 0 0 var(--borderRadius-large, 12px); overflow: hidden;
  background: var(--bgColor-default, #ffffff); color: var(--fgColor-default, #1f2328);
  box-shadow: var(--shadow-floating-large, 0 0 0 1px rgba(209, 217, 224, 0), 0 40px 80px rgba(37, 41, 46, 0.24)); }
#${PANEL_ID}[data-open="true"] .gc-panel-backdrop { opacity: 1; }
#${PANEL_ID}[data-open="true"] .gc-panel-sheet { opacity: 1; transform: none; }
/* Sliding out, the panel is already closed: a click through the fading backdrop reaches the board. */
#${PANEL_ID}:not([data-open="true"]) { pointer-events: none; }
#${PANEL_ID} .gc-panel-bar { flex: none; display: flex; align-items: center; gap: 8px; height: 48px; padding: 8px 24px 0;
  box-sizing: border-box; font-size: 14px; }
#${PANEL_ID} .gc-panel-ref { display: inline-flex; align-items: center; gap: 6px; flex: 1 1 auto; min-width: 0;
  color: var(--fgColor-muted, #59636e); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${PANEL_ID} .gc-panel-ref:hover { color: var(--fgColor-accent, #0969da); text-decoration: underline; }
#${PANEL_ID} .gc-panel-ref svg { flex: none; fill: currentColor; }
#${PANEL_ID} .gc-panel-actions { display: flex; gap: 4px; }
#${PANEL_ID} .gc-panel-actions > * { display: grid; place-items: center; width: 32px; height: 32px; padding: 0; margin: 0;
  border: 0; border-radius: 6px; background: transparent; color: var(--fgColor-muted, #59636e); cursor: pointer; }
#${PANEL_ID} .gc-panel-actions > *:hover { background: var(--control-transparent-bgColor-hover, rgba(208, 215, 222, 0.32)); }
#${PANEL_ID} .gc-panel-actions > *:focus-visible { outline: 2px solid var(--fgColor-accent, #0969da); outline-offset: -2px; }
#${PANEL_ID} .gc-panel-actions svg { width: 16px; height: 16px; fill: currentColor; }
#${PANEL_ID} .gc-panel-frame { flex: 1 1 auto; width: 100%; border: 0; background: var(--bgColor-default, #ffffff); }
#${PANEL_ID} .gc-panel-refused { padding: 24px; }
#${PANEL_ID} .gc-panel-refused a { color: var(--fgColor-accent, #0969da); }
@media (prefers-reduced-motion: reduce) {
  #${PANEL_ID} .gc-panel-backdrop, #${PANEL_ID} .gc-panel-sheet { transition: none; }
}
[data-gc-motion="reduced"] #${PANEL_ID} .gc-panel-backdrop, [data-gc-motion="reduced"] #${PANEL_ID} .gc-panel-sheet { transition: none; }
`;

/** What the framed page hides so it reads as a panel rather than a whole site: the site header, the repository header, and the footer. */
const FRAME_CSS = `
.js-header-wrapper, header.AppHeader, #repository-container-header, footer.footer { display: none !important; }
`;

/** Octicon paths, copied from GitHub's markup (mechanics M58). */
const OCTICONS = {
  'git-pull-request':
    'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z',
  copy: 'M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25ZM5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z',
  check: 'M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z',
  'link-external':
    'M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z',
  x: 'M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z',
};

/**
 * @typedef {{ repo: string, number: number, url: string }} PullRef
 * @typedef {{ root: HTMLElement, trigger: Element, ref: PullRef, key: (event: KeyboardEvent) => void, inerted: Element[] }} Open
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
  watching = null;
  closePanel(true);
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
  const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');

  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  path.setAttribute('d', OCTICONS[name]);
  svg.appendChild(path);

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

  const root = doc.createElement('div');
  const backdrop = doc.createElement('div');
  const sheet = doc.createElement('div');
  const bar = doc.createElement('div');
  const link = doc.createElement('a');
  const actions = doc.createElement('div');
  const copy = control(doc, 'button', 'Copy link', 'copy');
  const external = /** @type {HTMLAnchorElement} */ (control(doc, 'a', 'Open in new tab', 'link-external'));
  const close = control(doc, 'button', 'Close panel', 'x');
  const frame = doc.createElement('iframe');

  root.id = PANEL_ID;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', `Side panel: Pull request: ${ref.repo}#${ref.number}`);
  root.style.setProperty('--gc-panel-top', `${topOffset(doc)}px`);
  const mine = () => open?.root === root;

  backdrop.className = 'gc-panel-backdrop';
  backdrop.addEventListener('click', () => mine() && closePanel());
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
  actions.append(copy, external, close);
  bar.append(link, actions);
  frame.className = 'gc-panel-frame';
  frame.name = FRAME_NAME;
  frame.title = `Pull request #${ref.number}`;
  frame.src = ref.url;
  frame.addEventListener('load', () => mine() && loaded(doc, root, frame, ref));
  sheet.append(bar, frame);
  root.append(backdrop, sheet);

  /** @param {KeyboardEvent} event */
  const key = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closePanel();
    }
  };

  const inerted = [...doc.body.children].filter((child) => !child.hasAttribute('inert'));

  for (const child of inerted) {
    child.setAttribute('inert', '');
  }

  doc.addEventListener('keydown', key, true);
  doc.body.appendChild(root);
  open = { root, trigger, ref, key, inerted };
  close.focus();

  // Laid out closed before it is marked open, or there is nothing for the slide to start from.
  root.getBoundingClientRect();
  root.setAttribute('data-open', 'true');
}

/**
 * The frame has a document. Chrome answers a refused frame with its own error page, which this cannot read; the
 * panel says so rather than showing the browser's page.
 *
 * @param {Document} doc
 * @param {HTMLElement} root
 * @param {HTMLIFrameElement} frame
 * @param {PullRef} ref
 */
function loaded(doc, root, frame, ref) {
  /** @type {Document | null} */
  let inner = null;

  try {
    inner = frame.contentDocument;
  } catch {
    inner = null;
  }

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

  // After the page's own handlers, so an Escape that closed a menu on the page does not close the panel too.
  inner.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented && open?.root === root) {
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
 * Close the panel, sliding out unless told to go at once, and hand focus back to the link that opened it.
 *
 * @param {boolean} [now]
 */
function closePanel(now = false) {
  if (open === null) {
    return;
  }

  const { root, trigger, key, inerted } = open;
  const doc = root.ownerDocument;

  open = null;
  doc.removeEventListener('keydown', key, true);
  root.removeAttribute('data-open');

  for (const child of inerted) {
    child.removeAttribute('inert');
  }

  if (now) {
    root.remove();
  } else {
    setTimeout(() => root.remove(), CLOSE_DELAY);
  }

  if (trigger instanceof HTMLElement && trigger.isConnected) {
    trigger.focus();
  }
}
