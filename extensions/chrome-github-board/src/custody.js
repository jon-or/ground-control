// @ts-check
/**
 * The custody popup: where a card's issue has been and who held it (R47). The hub folds the timeline and words
 * every line; this draws the words in GitHub's own tokens. The editor board draws the same fixture, and both
 * suites pin the same text.
 *
 * @typedef {import('@ground-control/core').Custody} Custody
 * @typedef {{ key: string, loading: boolean, custody: Custody | null, failure: string | null }} CustodyState
 */

/** Must match `overlay.js`, whose delegated handler draws the tooltip; importing it would be circular. */
const TIP_ATTR = 'data-gc-tip';

export const CUSTODY_CLASS = 'gc-custody';

/** The tabs in strip order. The chosen one is kept for the next popup, as the editor board keeps it. */
export const CUSTODY_TABS = [
  ['health', 'Health'],
  ['time', 'Time'],
  ['route', 'Route'],
];

export const CUSTODY_CSS = `
.${CUSTODY_CLASS} { width: 380px; max-width: calc(100vw - 16px); padding: 12px 14px 14px; font-size: 13px;
  line-height: 1.4; --gc-fn-intake: var(--fgColor-attention, #9a6700); --gc-fn-dev: var(--fgColor-accent, #0969da);
  --gc-fn-product: var(--fgColor-done, #8250df); --gc-fn-qa: var(--fgColor-severe, #bc4c00);
  --gc-fn-release: var(--fgColor-success, #1a7f37); --gc-fn-none: var(--fgColor-muted, #59636e);
  --gc-bad: var(--fgColor-danger, #d1242f); --gc-ground: var(--overlay-bgColor, var(--bgColor-default, #ffffff));
  --gc-muted: var(--bgColor-muted, #f6f8fa); --gc-edge: var(--borderColor-muted, #d1d9e0b3); }
.${CUSTODY_CLASS} .gc-c-head { display: flex; align-items: center; gap: 8px; font-size: 12px;
  color: var(--fgColor-muted, #59636e); }
.${CUSTODY_CLASS} .gc-c-number { font-weight: 600; color: var(--fgColor-default, #1f2328); }
.${CUSTODY_CLASS} .gc-c-state { padding: 0 7px; font-size: 11px; font-weight: 600; line-height: 20px;
  color: var(--fgColor-default, #1f2328); border: 1px solid var(--borderColor-default, #d0d7de); border-radius: 999px; }
.${CUSTODY_CLASS} .gc-c-state[data-state="open"] { color: var(--fgColor-success, #1a7f37);
  border-color: color-mix(in srgb, var(--fgColor-success, #1a7f37) 50%, transparent); }
.${CUSTODY_CLASS} .gc-c-age { margin-left: auto; font-variant-numeric: tabular-nums; }
.${CUSTODY_CLASS} .gc-c-title { display: -webkit-box; margin: 4px 0 10px; overflow: hidden; font-size: 14px;
  font-weight: 600; line-height: 1.3; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.${CUSTODY_CLASS} [data-function="intake"] { --gc-fn: var(--gc-fn-intake); }
.${CUSTODY_CLASS} [data-function="dev"] { --gc-fn: var(--gc-fn-dev); }
.${CUSTODY_CLASS} [data-function="product"] { --gc-fn: var(--gc-fn-product); }
.${CUSTODY_CLASS} [data-function="qa"] { --gc-fn: var(--gc-fn-qa); }
.${CUSTODY_CLASS} [data-function="release"] { --gc-fn: var(--gc-fn-release); }
.${CUSTODY_CLASS} [data-function="none"] { --gc-fn: var(--gc-fn-none); }
.${CUSTODY_CLASS} .gc-c-bar { display: flex; height: 14px; overflow: hidden; background: var(--gc-muted); border-radius: 7px; }
.${CUSTODY_CLASS} .gc-c-seg { flex: 0 1 auto; min-width: 2px; background: var(--gc-fn); }
.${CUSTODY_CLASS} .gc-c-seg[data-held="false"] { opacity: 0.38; }
.${CUSTODY_CLASS} .gc-c-ends { display: flex; justify-content: space-between; margin-top: 4px; font-size: 11px;
  color: var(--fgColor-muted, #59636e); }
.${CUSTODY_CLASS} .gc-c-note { padding: 12px 0 4px; color: var(--fgColor-muted, #59636e); }
.${CUSTODY_CLASS} .gc-c-note.failure { color: var(--gc-bad); }
.${CUSTODY_CLASS} .gc-c-tabs { display: flex; gap: 2px; margin: 12px 0 10px; padding: 2px; background: var(--gc-muted); border-radius: 8px; }
.${CUSTODY_CLASS} .gc-c-tab { flex: 1; padding: 4px 0; font: inherit; font-size: 12px; font-weight: 500; text-align: center;
  display: inline-flex; justify-content: center; align-items: center; color: var(--fgColor-muted, #59636e); background: transparent; border: 0; border-radius: 6px; cursor: pointer; }
.${CUSTODY_CLASS} .gc-c-tab[aria-selected="true"] { color: var(--fgColor-default, #1f2328); background: var(--gc-ground);
  box-shadow: var(--shadow-resting-xsmall, 0 1px 2px rgba(31, 35, 40, 0.15)); }
.${CUSTODY_CLASS} .gc-c-headline { font-size: 18px; font-weight: 600; line-height: 1.25; letter-spacing: -0.01em; }
.${CUSTODY_CLASS} .gc-c-headline[data-bad="true"], .${CUSTODY_CLASS} .gc-c-figure[data-bad="true"] .gc-c-value,
.${CUSTODY_CLASS} .gc-c-duration[data-bad="true"], .${CUSTODY_CLASS} .gc-c-loop { color: var(--gc-bad); }
.${CUSTODY_CLASS} .gc-c-subline { margin-top: 4px; color: var(--fgColor-muted, #59636e); }
.${CUSTODY_CLASS} .gc-c-figures { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 14px 0; }
.${CUSTODY_CLASS} .gc-c-figure { display: flex; flex-direction: column; }
.${CUSTODY_CLASS} .gc-c-value { font-size: 18px; font-weight: 600; line-height: 1.2; font-variant-numeric: tabular-nums; }
.${CUSTODY_CLASS} .gc-c-label { font-size: 11px; color: var(--fgColor-muted, #59636e); }
.${CUSTODY_CLASS} .gc-c-chip { display: inline-flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden;
  font-size: 12px; font-weight: 500; white-space: nowrap; text-overflow: ellipsis; }
.${CUSTODY_CLASS} .gc-c-chip::before { content: ''; flex: none; width: 8px; height: 8px; background: var(--gc-fn); border-radius: 50%; }
.${CUSTODY_CLASS} .gc-c-now { display: flex; align-items: center; gap: 8px; padding-top: 10px; border-top: 1px solid var(--gc-edge); }
.${CUSTODY_CLASS} .gc-c-now-word, .${CUSTODY_CLASS} .gc-c-section { font-size: 11px; font-weight: 600;
  letter-spacing: 0.04em; text-transform: uppercase; color: var(--fgColor-muted, #59636e); }
.${CUSTODY_CLASS} .gc-c-holder { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.${CUSTODY_CLASS} .gc-c-holder[data-held="false"] { font-style: italic; color: var(--fgColor-muted, #59636e); }
.${CUSTODY_CLASS} .gc-c-since, .${CUSTODY_CLASS} .gc-c-duration { margin-left: auto; font-variant-numeric: tabular-nums; white-space: nowrap; }
.${CUSTODY_CLASS} .gc-c-section { margin: 8px 0 6px; }
.${CUSTODY_CLASS} .gc-c-row + .gc-c-section { margin-top: 12px; }
.${CUSTODY_CLASS} .gc-c-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; column-gap: 8px;
  align-items: center; padding: 2px 0; }
.${CUSTODY_CLASS} .gc-c-row.totals { grid-template-columns: minmax(0, 1fr) auto; }
.${CUSTODY_CLASS} .gc-c-track { display: block; grid-column: 1 / -1; height: 4px; margin-top: 1px; overflow: hidden;
  background: var(--gc-muted); border-radius: 2px; }
.${CUSTODY_CLASS} .gc-c-fill { display: block; height: 100%; background: var(--gc-fn); border-radius: 2px; }
.${CUSTODY_CLASS} .gc-c-stops { position: relative; margin: 0; padding: 0; list-style: none; }
.${CUSTODY_CLASS} .gc-c-stops::before { content: ''; position: absolute; top: 12px; bottom: 12px; left: 5px; width: 2px; background: var(--gc-edge); }
.${CUSTODY_CLASS} .gc-c-stop { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 8px; padding: 5px 0 5px 20px; }
.${CUSTODY_CLASS} .gc-c-dot { position: absolute; top: 9px; left: 0; width: 12px; height: 12px; background: var(--gc-fn);
  border-radius: 50%; box-shadow: 0 0 0 2px var(--gc-ground); }
.${CUSTODY_CLASS} .gc-c-dot[data-second] { background: linear-gradient(135deg, var(--gc-fn) 50%, var(--gc-second) 50%); }
.${CUSTODY_CLASS} .gc-c-dot[data-second="intake"] { --gc-second: var(--gc-fn-intake); }
.${CUSTODY_CLASS} .gc-c-dot[data-second="dev"] { --gc-second: var(--gc-fn-dev); }
.${CUSTODY_CLASS} .gc-c-dot[data-second="product"] { --gc-second: var(--gc-fn-product); }
.${CUSTODY_CLASS} .gc-c-dot[data-second="qa"] { --gc-second: var(--gc-fn-qa); }
.${CUSTODY_CLASS} .gc-c-dot[data-second="release"] { --gc-second: var(--gc-fn-release); }
.${CUSTODY_CLASS} .gc-c-dot[data-second="none"] { --gc-second: var(--gc-fn-none); }
.${CUSTODY_CLASS} .gc-c-stop[data-current="true"] .gc-c-dot { box-shadow: 0 0 0 2px var(--gc-ground), 0 0 0 3.5px var(--fgColor-default, #1f2328); }
.${CUSTODY_CLASS} .gc-c-stop[data-current="true"] .gc-c-stop-text { font-weight: 600; }
.${CUSTODY_CLASS} .gc-c-stop[data-folded="true"] .gc-c-stop-text { color: var(--fgColor-muted, #59636e); }
.${CUSTODY_CLASS} .gc-c-stop-text { overflow: hidden; font-weight: 500; white-space: nowrap; text-overflow: ellipsis; }
.${CUSTODY_CLASS} .gc-c-now-mark { font-weight: 400; color: var(--fgColor-muted, #59636e); }
.${CUSTODY_CLASS} .gc-c-stop .gc-c-holder { grid-column: 1 / -1; font-size: 12px; color: var(--fgColor-muted, #59636e); }
.${CUSTODY_CLASS} .gc-c-stop .gc-c-holder[data-held="true"] { color: var(--fgColor-default, #1f2328); }
`;

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {string} className
 * @param {string} [text]
 */
function el(doc, tag, className, text) {
  const node = doc.createElement(tag);

  node.className = className;

  if (text !== undefined) {
    node.textContent = text;
  }

  return node;
}

/** @param {HTMLElement} node @param {string | null} fn */
function tone(node, fn) {
  node.dataset.function = fn ?? 'none';
}

/**
 * @param {Document} doc
 * @param {{ number: number, title: string, state?: string } | null} issue
 * @param {Custody | null} custody
 */
function header(doc, issue, custody) {
  const head = el(doc, 'div', 'gc-c-head');
  const state = custody === null ? issue?.state ?? null : custody.closed ? 'CLOSED' : 'OPEN';

  head.appendChild(el(doc, 'span', 'gc-c-number', `#${custody?.number ?? issue?.number ?? ''}`));

  if (state) {
    const pill = el(doc, 'span', 'gc-c-state', state === 'CLOSED' ? 'Closed' : 'Open');

    pill.dataset.state = state.toLowerCase();
    head.appendChild(pill);
  }

  if (custody) {
    head.appendChild(el(doc, 'span', 'gc-c-age', `${custody.age} old`));
  }

  return [head, el(doc, 'div', 'gc-c-title', custody?.title ?? issue?.title ?? '')];
}

/** @param {Document} doc @param {Custody} custody */
function bar(doc, custody) {
  const wrap = el(doc, 'div', 'gc-c-bar-wrap');
  const strip = el(doc, 'div', 'gc-c-bar');

  strip.setAttribute('role', 'img');
  strip.setAttribute('aria-label', `${custody.bar.length === 1 ? 'One leg' : `${custody.bar.length} legs`} over ${custody.age}`);

  for (const segment of custody.bar) {
    const piece = el(doc, 'span', 'gc-c-seg');

    tone(piece, segment.function);
    piece.style.flexGrow = String(Math.max(segment.share, 0.004));
    piece.dataset.held = String(segment.held);
    piece.setAttribute(TIP_ATTR, segment.title);
    piece.setAttribute('aria-description', segment.title);
    strip.appendChild(piece);
  }

  const ends = el(doc, 'div', 'gc-c-ends');

  ends.appendChild(el(doc, 'span', '', custody.createdLabel));
  ends.appendChild(el(doc, 'span', '', custody.endLabel));
  wrap.append(strip, ends);

  return wrap;
}

/** @param {Document} doc @param {string} label @param {string | null} fn */
function chip(doc, label, fn) {
  const node = el(doc, 'span', 'gc-c-chip', label);

  tone(node, fn);

  return node;
}

/** @param {Document} doc @param {number} share @param {string | null} fn */
function track(doc, share, fn) {
  const rail = el(doc, 'span', 'gc-c-track');
  const fill = el(doc, 'span', 'gc-c-fill');

  tone(fill, fn);
  fill.style.width = `${Math.round(Math.max(0, Math.min(1, share)) * 100)}%`;
  rail.appendChild(fill);

  return rail;
}

/** @param {Document} doc @param {string} tab @param {(tab: string) => void} onTab */
function tabs(doc, tab, onTab) {
  const strip = el(doc, 'div', 'gc-c-tabs');

  strip.setAttribute('role', 'tablist');

  for (const [id = 'health', label = ''] of CUSTODY_TABS) {
    const button = doc.createElement('button');

    button.className = 'gc-c-tab';
    button.textContent = label;
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(tab === id));
    button.tabIndex = tab === id ? 0 : -1;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      event.preventDefault();
      onTab(id);
    });
    button.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;

      if (step === 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const at = CUSTODY_TABS.findIndex(([known]) => known === tab);

      onTab(CUSTODY_TABS[(at + step + CUSTODY_TABS.length) % CUSTODY_TABS.length]?.[0] ?? 'health');
    });
    strip.appendChild(button);
  }

  return strip;
}

/** @param {Document} doc @param {Custody} custody */
function health(doc, custody) {
  const body = el(doc, 'div', 'gc-c-body health');
  const headline = el(doc, 'div', 'gc-c-headline', custody.health.headline);

  headline.dataset.bad = String(custody.health.bad);
  body.append(headline, el(doc, 'div', 'gc-c-subline', custody.health.subline));

  const figures = el(doc, 'div', 'gc-c-figures');

  for (const figure of custody.health.figures) {
    const cell = el(doc, 'div', 'gc-c-figure');

    cell.dataset.bad = String(figure.bad);
    cell.append(el(doc, 'span', 'gc-c-value', figure.value), el(doc, 'span', 'gc-c-label', figure.label));
    figures.appendChild(cell);
  }

  body.appendChild(figures);

  const now = el(doc, 'div', 'gc-c-now');
  const holder = el(doc, 'span', 'gc-c-holder', custody.health.now.holder);

  holder.dataset.held = String(custody.health.now.held);
  now.append(el(doc, 'span', 'gc-c-now-word', 'Now'), chip(doc, custody.health.now.label, custody.health.now.function), holder, el(doc, 'span', 'gc-c-since', custody.health.now.since));
  body.appendChild(now);

  return body;
}

/** @param {Document} doc @param {Custody} custody */
function time(doc, custody) {
  const body = el(doc, 'div', 'gc-c-body time');

  body.appendChild(el(doc, 'div', 'gc-c-section', 'Where the time went'));

  for (const row of custody.time.longest) {
    const line = el(doc, 'div', 'gc-c-row');
    const holder = el(doc, 'span', 'gc-c-holder', row.holder ?? 'unassigned');
    const duration = el(doc, 'span', 'gc-c-duration', row.duration);

    holder.dataset.held = String(row.holder !== null);
    duration.dataset.bad = String(row.bad);
    line.append(chip(doc, row.label, row.function), holder, duration, track(doc, row.share, row.function));
    body.appendChild(line);
  }

  body.appendChild(el(doc, 'div', 'gc-c-section', 'Total per status'));

  for (const row of custody.time.totals) {
    const line = el(doc, 'div', 'gc-c-row totals');

    line.append(chip(doc, row.label, row.function), el(doc, 'span', 'gc-c-duration', row.duration), track(doc, row.share, row.function));
    body.appendChild(line);
  }

  return body;
}

/** @param {Document} doc @param {Custody} custody */
function route(doc, custody) {
  const body = el(doc, 'div', 'gc-c-body route');
  const list = el(doc, 'ol', 'gc-c-stops');

  for (const stop of custody.route) {
    const item = el(doc, 'li', 'gc-c-stop');
    const dot = el(doc, 'span', 'gc-c-dot');
    const text = el(doc, 'span', 'gc-c-stop-text');

    item.dataset.current = String(stop.current);
    item.dataset.folded = String(stop.folded > 0);
    tone(dot, stop.functions[0] ?? null);

    if (stop.labels.length === 2) {
      dot.dataset.second = stop.functions[1] ?? 'none';
      text.append(stop.labels[0] ?? '', el(doc, 'span', 'gc-c-loop', ' ⇄ '), stop.labels[1] ?? '', el(doc, 'span', 'gc-c-loop', ` ×${stop.rounds}`));
    } else {
      text.append(stop.labels[0] ?? '');
    }

    if (stop.current) {
      text.append(el(doc, 'span', 'gc-c-now-mark', ' now'));
    }

    const holders = el(doc, 'span', 'gc-c-holder', stop.holders);

    holders.dataset.held = String(stop.holders !== 'unassigned');
    item.append(dot, text, el(doc, 'span', 'gc-c-duration', stop.duration), holders);
    list.appendChild(item);
  }

  body.appendChild(list);

  return body;
}

/**
 * Fill a popover with the popup for its state: the header and bar above the tab strip, then the chosen tab.
 *
 * @param {Document} doc
 * @param {HTMLElement} panel
 * @param {{ number: number, title: string, state?: string } | null} issue
 * @param {CustodyState} state
 * @param {string} tab
 * @param {(tab: string) => void} onTab
 */
export function fillCustody(doc, panel, issue, state, tab, onTab) {
  const custody = state.custody;

  panel.classList.add(CUSTODY_CLASS);
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Custody');
  panel.append(...header(doc, issue, custody));

  if (state.loading) {
    panel.appendChild(el(doc, 'div', 'gc-c-note', 'Reading timeline…'));
  } else if (state.failure !== null) {
    panel.appendChild(el(doc, 'div', 'gc-c-note failure', `Couldn't read the timeline — ${state.failure}`));
  } else if (custody === null) {
    panel.appendChild(el(doc, 'div', 'gc-c-note', 'GitHub has no timeline for this issue.'));
  } else {
    panel.appendChild(bar(doc, custody));

    if (custody.truncated) {
      panel.appendChild(el(doc, 'div', 'gc-c-note', 'The timeline was cut short; the newest moves are missing.'));
    }

    panel.appendChild(tabs(doc, tab, onTab));
    panel.appendChild(tab === 'time' ? time(doc, custody) : tab === 'route' ? route(doc, custody) : health(doc, custody));
  }

  return panel;
}
