// @ts-check
/**
 * Render board menus, notices, and card footers from snapshots. Chrome APIs remain in the content script; this
 * module is tested with jsdom and recorded markup.
 */

/**
 * @typedef {import('@ground-control/core').Snapshot} Snapshot
 * @typedef {import('@ground-control/core').LanedCard} LanedCard
 * @typedef {import('@ground-control/core').Session} Session
 * @typedef {import('@ground-control/core').LaneId} LaneId
 * @typedef {{ snapshot: Snapshot | null, trouble: string | null, notice: string | null }} State
 * @typedef {{ refresh: () => void, move: (key: string, lane: LaneId) => void, repaint: () => void, watchLog: (open: boolean) => void, openCheckout: (key: string) => void }} Actions
 * @typedef {{ at: string, level: string, source: string, scope?: string, message: string }} LogEntry
 * @typedef {{ key: string, message: string, remedy: string | null, tone: 'danger' | 'default' }} Problem
 */

/** GitHub's board markup, as measured on 2026-09-04 (`mechanics.md` M27). Every other class on the page is hashed. */
export const BOARD_REGION = '#project-items-region';
export const CARD = '[data-board-card-id]';
export const COLUMN = '[data-board-column]';
export const TOOLBAR = '[role="region"][aria-label="View filters"]';
export const PROJECT_NAV = '[role="navigation"][aria-label="Project"]';
export const VIEW_TABS = 'nav[aria-label="Select view"]';

const MENU_ID = 'gc-menu';
const LOG_ID = 'gc-log';
const LOG_LINES_ID = 'gc-log-lines';
const MENU_FALLBACK_ID = 'gc-perch';
const TOASTS_ID = 'gc-toasts';
const STYLE_ID = 'gc-style';
const BADGE_CLASS = 'gc-badge';
const POPOVER_CLASS = 'gc-popover';
const HIDDEN_ATTR = 'data-gc-hidden';
const ACTOR_CLASS = 'gc-actor';
const TIP_ID = 'gc-tip';

/** Custom tooltip text. Geometry and timing match GitHub (mechanics M35); both client suites verify parity. */
const TIP_ATTR = 'data-gc-tip';

/** Mark replaced assignee figures so later scans can restore them. */
const ACTOR_ATTR = 'data-gc-actor';

/**
 * Store the timestamp for each displayed duration so one timer updates all ages. Both clients use the same
 * attribute.
 */
const AGE_ATTR = 'data-gc-since';

/**
 * Duplicate openSessionUri from @ground-control/host-vscode because Chrome loads this file without workspace
 * imports. Tests verify the literal URI.
 */
const OPEN_SESSION_URI = 'vscode://groundcontrol.ground-control/open?session=';
// Navigate to VS Code to attach in a terminal, matching the editor board.
const ATTACH_SESSION_URI = 'vscode://groundcontrol.ground-control/attach?session=';

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
const PHASE_WORDS = { running: 'running', waiting: 'waiting for input', idle: 'idle' };

/**
 * Copy TRIAGE_LABELS from packages/board because this script cannot import workspace packages. Both client
 * suites verify parity (docs/testing.md).
 */
/** @type {Record<string, string>} */
const TRIAGE_LABELS = {
  develop: 'Develop',
  'dev-question': 'Dev question',
  'qa-question': 'QA question',
  'qa-failure': 'QA failure',
  'review-others': 'Review their PR',
  'address-review': 'Answer review',
  'fix-checks': 'Fix failing checks',
  'merge-upstream': 'Merge upstream',
  other: 'Other',
};

/**
 * How a triaged card reads, the same on both boards.
 *
 * @param {{ action: string, qualifier: string | null }} triage
 * @returns {string}
 */
export function triageText(triage) {
  const label = TRIAGE_LABELS[triage.action] ?? triage.action;

  return triage.qualifier ? `${label} · ${triage.qualifier}` : label;
}

/** @type {Record<string, string>} */
/** @type {Record<string, string>} */
const PHASE_TITLES = {
  running: 'Turn in progress.',
  waiting: 'Waiting for your input.',
  idle: 'Last reported state: turn complete.',
};

/**
 * Accessible phase and liveness description.
 *
 * @param {string | undefined} phase
 * @param {boolean} live
 * @returns {string}
 */
function dotTitle(phase, live) {
  const phaseDescription = PHASE_TITLES[phase ?? ''] ?? 'No activity reported.';

  return live ? phaseDescription : `${phaseDescription} The session has since ended.`;
}

/** Explain the duration; the dot tooltip describes phase separately. */
/** @type {Record<string, string>} */
const DURATION_TITLES = {
  running: 'Time in this turn, from its prompt when recorded.',
};

const DURATION_TITLE = 'Time since the phase was reported.';

/**
 * Mark card attention on the GitHub element so CSS can style its border and session dots. Remove the attribute
 * when attention clears.
 */
const ATTENTION_ATTR = 'data-gc-attention';

/**
 * Cancel the card's bottom padding to align the footer with its edges (mechanics M27). Overlap adjacent column
 * borders by 1px. Draw fading dividers as background strips over transparent borders; border-image would
 * remove the rounded corners.
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
/* Session rows share the card footer; omit individual borders. */
.${BADGE_CLASS} .gc-session {
  display: flex; box-sizing: border-box; width: 100%; align-items: center; gap: 5px;
  font: inherit; font-size: 11px; line-height: 20px; padding: 0 6px 0 8px; border: 0; border-radius: 6px;
  background: none; color: var(--fgColor-default, #1f2328); cursor: pointer; }
.${BADGE_CLASS} a.gc-session { text-decoration: none; }
.${BADGE_CLASS} a.gc-session:hover { background: var(--bgColor-neutral-muted, #eaeef2); }
.${BADGE_CLASS} span.gc-session { cursor: default; }
/* State-mark color represents phase; fill identifies a live session. Attention also changes the card border/tint.
   Session text keeps its normal color and weight (R6). */
.gc-dot { flex: none; box-sizing: border-box; width: 8px; height: 8px; border-radius: 50%;
  border: 1px solid var(--gc-dot, var(--fgColor-muted, #59636e)); }
.gc-dot[data-live="true"] { background: var(--gc-dot, var(--fgColor-muted, #59636e)); }
.gc-dot[data-phase="running"] { --gc-dot: var(--fgColor-success, #1a7f37); }
.gc-dot[data-phase="waiting"] { --gc-dot: var(--fgColor-attention, #9a6700); }
.${BADGE_CLASS} svg { flex: none; }
.gc-agent { flex: none; }
/*
 * Avoid apostrophes in CSS comments: the measured jsdom parser treated them as string delimiters and dropped
 * intervening rules.
 */
/* Use Claude brand orange and the row text color for the monochrome OpenAI logo. */
.gc-agent-icon { fill: var(--fgColor-muted, #59636e); }
.gc-agent-icon[data-agent="claude"] { fill: #d97757; }
/*
 * The 55% blend matches editor session text (mechanics M38). Keep the name box fitted to text so the 300%
 * gradient traverses it over the full 1.8s.
 */
.gc-name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: color-mix(in srgb, var(--fgColor-default, #1f2328) 55%, var(--fgColor-muted, #59636e)); }
/* Reserve three characters for durations below 100 weeks to avoid row shifts during timer updates. */
.gc-state { flex: none; margin-left: auto; white-space: nowrap; min-width: 3ch; text-align: right;
  font-variant-numeric: tabular-nums; }
.gc-agent, .gc-state { color: var(--fgColor-muted, #59636e); }
/* Replace the duration with the destination icon at the same width to preserve row and gradient geometry. */
.gc-destination { display: none; flex: none; margin-left: auto; min-width: 3ch; text-align: right; line-height: 0; }
.gc-destination svg { width: 15px; height: 15px; vertical-align: -3px; }
.gc-plate { fill: var(--fgColor-muted, #59636e); stroke: none; }
.gc-ink { fill: none; stroke: var(--bgColor-default, #ffffff); stroke-width: 2.25; stroke-linecap: round;
  stroke-linejoin: round; }
/* Identify board-dispatched runs with italic names; retain existing state colors. */
.gc-session[data-detached] .gc-name { font-style: italic; }
.gc-frame { fill: none; stroke: var(--fgColor-accent, #0969da); stroke-width: 2; stroke-linejoin: round; }
a.gc-session:hover .gc-state, a.gc-session:focus-visible .gc-state { display: none; }
a.gc-session:hover .gc-destination, a.gc-session:focus-visible .gc-destination { display: inline-block; }
.gc-mark { font-size: 11px; line-height: 18px; padding: 0 6px; border-radius: 9px; font-weight: 600;
  color: var(--fgColor-onEmphasis, #ffffff); background: var(--bgColor-severe-emphasis, #bc4c00); }
/* Keep triage styling neutral so it does not imply session attention (R38). Fade stale results. */
.gc-mark[data-mark="triage"], .gc-mark[data-mark="triaging"] { color: var(--fgColor-muted, #59636e);
  background: transparent; border: 1px solid var(--borderColor-muted, #d1d9e0); font-weight: 400; }
.gc-mark[data-mark="triaging"] { animation: gc-triage-pulse 1.8s ease-in-out infinite; }
.gc-mark[data-mark="triage"][data-stale="true"] { border-style: dashed; opacity: 0.65; }
/* Style status age as part of the triage label. */
.gc-triage-age { font-variant-numeric: tabular-nums; display: inline-block; min-width: 3ch; text-align: center; }
@keyframes gc-triage-pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .gc-mark[data-mark="triaging"] { animation: none; opacity: 0.7; }
}
/* Use Primer foreground tokens to match session dots and editor chart colors (mechanics M38). */
${CARD}[${ATTENTION_ATTR}] { outline: 1px solid var(--fgColor-attention, #9a6700); outline-offset: -1px;
  border-radius: 6px; }
${CARD}[${ATTENTION_ATTR}="your-turn"] { outline-color: var(--fgColor-accent, #0969da); }

/* Distinguish running sessions with a faded, dashed green border, separate from attention states (R6). */
${CARD}[${ATTENTION_ATTR}="running"] { outline-style: dashed;
  outline-color: color-mix(in srgb, var(--fgColor-success, #1a7f37) 55%, transparent);
  animation: gc-working-edge 2.4s ease-in-out infinite; }
@keyframes gc-working-edge {
  0%, 100% { outline-color: color-mix(in srgb, var(--fgColor-success, #1a7f37) 30%, transparent); }
  50% { outline-color: color-mix(in srgb, var(--fgColor-success, #1a7f37) 85%, transparent); }
}

/*
 * Animate a highlight across the running session name without changing state colors. A nonrepeating gradient
 * three times the text width starts and ends outside it.
 */
@keyframes gc-shimmer { from { background-position: 100% 0; } to { background-position: 0% 0; } }
/*
 * Use white highlights in dark themes and black in light themes. Resolve GitHub auto mode through the OS
 * preference (mechanics M38).
 */
.gc-session[data-phase="running"] .gc-name { --gc-peak: var(--fgColor-default, #1f2328); }
[data-color-mode="dark"] .gc-session[data-phase="running"] .gc-name { --gc-peak: #ffffff; }
[data-color-mode="light"] .gc-session[data-phase="running"] .gc-name { --gc-peak: #000000; }
@media (prefers-color-scheme: dark) {
  [data-color-mode="auto"] .gc-session[data-phase="running"] .gc-name { --gc-peak: #ffffff; }
}
@media (prefers-color-scheme: light) {
  [data-color-mode="auto"] .gc-session[data-phase="running"] .gc-name { --gc-peak: #000000; }
}
.gc-session[data-phase="running"] .gc-name {
  background-image: linear-gradient(95deg,
    color-mix(in srgb, var(--fgColor-default, #1f2328) 55%, var(--fgColor-muted, #59636e)) 43%,
    var(--gc-peak) 50%,
    color-mix(in srgb, var(--fgColor-default, #1f2328) 55%, var(--fgColor-muted, #59636e)) 57%);
  background-size: 300% 100%; background-repeat: no-repeat;
  background-clip: text; -webkit-background-clip: text; color: transparent; font-weight: 600;
  animation-name: gc-shimmer; animation-duration: 1.8s; animation-timing-function: linear;
  animation-iteration-count: infinite; }

/*
 * Scope row attention to the card state so suppressed attention in Done does not color idle rows. Apply the
 * color only to the dot.
 */
${CARD}[${ATTENTION_ATTR}="blocked"] .gc-session[data-phase="waiting"] .gc-dot {
  --gc-dot: var(--fgColor-attention, #9a6700); }
${CARD}[${ATTENTION_ATTR}="your-turn"] .gc-session[data-phase="idle"] .gc-dot {
  --gc-dot: var(--fgColor-accent, #0969da); }

/* Keep the running indicator visible with animation disabled. */
@media (prefers-reduced-motion: reduce) {
  .gc-session[data-phase="running"] .gc-name {
    background-image: none; color: var(--fgColor-default, #1f2328); animation-name: none; }
  ${CARD}[${ATTENTION_ATTR}="running"] { animation: none; }
}

/* Restore text color when forced colors suppress the gradient. */
@media (forced-colors: active) {
  .gc-session[data-phase="running"] .gc-name {
    background-image: none; color: CanvasText; animation-name: none; }
  ${CARD}[${ATTENTION_ATTR}] { outline-color: Highlight; }
  /* Retain the dashed running border in forced colors; reserve Highlight for attention. */
  ${CARD}[${ATTENTION_ATTR}="running"] { outline-color: CanvasText; animation: none; }
  /* Use dot fill to distinguish live and ended sessions in forced colors. */
  .gc-dot { border-color: CanvasText; }
  .gc-dot[data-live="true"] { background: CanvasText; }
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

/*
 * Hide the entire assignee stack, including its accessible caption. Preserve avatar dimensions to prevent
 * header reflow.
 */
figure[${ACTOR_ATTR}] > :not(.${ACTOR_CLASS}) { display: none !important; }
/*
 * Keep initials behind the image to prevent a one-frame flash during repeated scans, including with cached
 * avatars.
 */
.${ACTOR_CLASS} { position: relative; display: grid; place-items: center; overflow: hidden;
  width: 20px; height: 20px; border-radius: 50%;
  font-size: 8px; font-weight: 600; line-height: 1; letter-spacing: 0.02em;
  color: transparent; background: var(--bgColor-neutral-muted, #eaeef2); }
.${ACTOR_CLASS}[data-avatar="failed"] { color: var(--fgColor-muted, #59636e); }
.${ACTOR_CLASS} img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
/* The [hidden] attribute is styled by a user-agent rule, which this page's own stylesheet outranks. */
.${ACTOR_CLASS} img[hidden] { display: none !important; }
#${MENU_ID} { display: inline-flex; gap: 4px; }
#${MENU_ID} .gc-collapse { padding-left: 6px; padding-right: 6px; }
#${MENU_ID} button[data-stale="true"]::after { content: ""; width: 6px; height: 6px; margin-left: 6px;
  border-radius: 50%; background: var(--bgColor-attention-emphasis, #bf8700); }
#${MENU_FALLBACK_ID} { display: flex; justify-content: flex-end; margin: 8px 16px; }
/*
 * Tooltip geometry follows mechanics M35: 12px/1.625, 4px 8px padding, 6px radius, and 250px maximum width.
 * Disable pointer events to preserve hover on the anchor.
 */
#${TIP_ID} { position: fixed; z-index: 300; display: none; box-sizing: border-box; pointer-events: none;
  width: max-content; max-width: 250px; padding: 4px 8px; border-radius: 6px;
  font-family: inherit; font-size: 12px; font-weight: 400; line-height: 1.625;
  text-align: center; white-space: normal; overflow-wrap: break-word;
  color: var(--fgColor-onEmphasis, #ffffff); background: var(--bgColor-emphasis, #25292e); }
#${TIP_ID}[data-open="true"] { display: block; animation: gc-tip-appear 0.1s ease-out; }
@keyframes gc-tip-appear { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { #${TIP_ID}[data-open="true"] { animation: none; } }
#${TOASTS_ID} { position: fixed; left: 16px; bottom: 16px; z-index: 200; display: flex; flex-direction: column;
  gap: 8px; max-width: 420px; }
#${TOASTS_ID} .gc-toast { display: flex; gap: 8px; align-items: flex-start; padding: 8px 12px; border-radius: 6px;
  font-size: 12px; color: var(--fgColor-onEmphasis, #ffffff); background: var(--bgColor-emphasis, #24292f);
  box-shadow: var(--shadow-floating-small, 0 6px 18px 0 rgba(31, 35, 40, 0.12)); }
#${TOASTS_ID} .gc-toast[data-tone="danger"] { background: var(--bgColor-danger-emphasis, #cf222e); }
#${TOASTS_ID} .gc-remedy { display: block; opacity: 0.8; }
#${TOASTS_ID} .gc-dismiss { margin-left: auto; font: inherit; background: none; border: 0; cursor: pointer;
  color: inherit; opacity: 0.8; }

/*
 * Overlay the log panel without reflowing GitHub's columns. Size it in characters with a viewport cap, and
 * wrap long lines without truncation.
 */
#${LOG_ID} { position: fixed; top: 0; right: 0; bottom: 0; width: min(140ch, 80vw); z-index: 100;
  display: flex; flex-direction: column; font-size: 12px;
  background: var(--bgColor-default, #ffffff); border-left: 1px solid var(--borderColor-default, #d1d9e0);
  box-shadow: -2px 0 12px rgba(31, 35, 40, 0.12); }
#${LOG_ID} header { flex: none; display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  border-bottom: 1px solid var(--borderColor-muted, #d1d9e0b3); }
/* Show pin state on the panel edge for visibility while reading logs. */
#${LOG_ID}[data-pinned="true"] { border-left-color: var(--borderColor-accent-emphasis, #0969da); }
#${LOG_ID} h2 { flex: 1; margin: 0; font-size: 12px; font-weight: 600; }
#${LOG_ID} label { display: inline-flex; align-items: center; gap: 3px; cursor: pointer;
  color: var(--fgColor-muted, #59636e); }
#${LOG_ID} .gc-close { font: inherit; background: none; border: 0; cursor: pointer; padding: 0 2px;
  color: var(--fgColor-muted, #59636e); }
#${LOG_LINES_ID} { flex: 1; margin: 0; padding: 6px 10px; overflow: auto; overscroll-behavior: contain;
  font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px; line-height: 16px; }
.gc-line { display: block; white-space: pre-wrap; overflow-wrap: anywhere;
  color: var(--fgColor-default, #1f2328); }
.gc-line .gc-when { color: var(--fgColor-muted, #59636e); }
.gc-line[data-source="browser"] .gc-tag { color: var(--fgColor-accent, #0969da); }
.gc-line[data-source="hub"] .gc-tag { color: var(--fgColor-done, #8250df); }
.gc-line[data-level="warn"] { color: var(--fgColor-attention, #9a6700); }
.gc-line[data-level="error"] { color: var(--fgColor-danger, #d1242f); }
.gc-line[data-level="debug"] { opacity: 0.75; }
#${LOG_ID}[data-shows-browser="false"] .gc-line[data-source="browser"],
#${LOG_ID}[data-shows-hub="false"] .gc-line[data-source="hub"],
#${LOG_ID}[data-shows-debug="false"] .gc-line[data-level="debug"] { display: none; }
#${LOG_LINES_ID} .gc-empty { color: var(--fgColor-muted, #59636e); font-family: inherit; }
`;

/**
 * Keep the selected lane menu across scans. Painting reconciles DOM from this state and can retain unchanged
 * footers.
 *
 * @type {string | null}
 */
let openMenu = null;
let panelOpen = false;

/**
 * Keep log visibility independent of card rendering. Retain the panel and append lines so scans preserve
 * scroll position.
 */
let logOpen = false;

/** Show browser and hub logs by default; hide per-message debug lines to keep failures readable (R40). */
const LOG_SHOWS_BY_DEFAULT = { browser: true, hub: true, debug: false };
const logShows = { ...LOG_SHOWS_BY_DEFAULT };

/**
 * Pinning preserves the sidebar and hub subscription on outside clicks. Default to closing so the panel does
 * not cover active cards.
 */
let logPinned = false;

/**
 * Cache header visibility from page storage; update on user changes and reapply on each scan. Null until first
 * read.
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
 * Use the largest elapsed-time unit and round down to avoid overstating age.
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

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours}h`;
  }

  const days = Math.floor(hours / 24);

  return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`;
}

/**
 * Accept both path separators because agents report platform-specific paths.
 *
 * @param {string} dir
 * @returns {string}
 */
function basename(dir) {
  const parts = dir.split(/[\\/]/).filter(Boolean);

  return parts[parts.length - 1] ?? dir;
}

/**
 * Prefer title, CLI name, short ID, then checkout basename. Both client suites verify this precedence.
 *
 * @param {Session} session
 * @returns {string}
 */
export function sessionLabel(session) {
  return session.title ?? session.details.name ?? session.details.shortId ?? basename(session.cwd);
}

/**
 * The dot color indicates phase and its fill indicates a live session. Its accessible name states both.
 *
 * @param {Document} doc
 * @param {string | undefined} phase
 * @param {boolean} live
 * @param {string} [title]
 * @returns {HTMLElement}
 */
function sessionDot(doc, phase, live, title = dotTitle(phase, live)) {
  const el = doc.createElement('span');

  el.className = 'gc-dot';
  el.dataset.phase = phase ?? 'none';
  el.dataset.live = String(live);
  el.setAttribute('role', 'img');
  // Expose the state through both an accessible name and a tooltip.
  el.setAttribute('aria-label', `${PHASE_WORDS[phase ?? ''] ?? 'no state reported'}, ${live ? 'open' : 'ended'}`);
  setTooltip(el, title);

  return el;
}

/**
 * Marks an element as an age and writes its first value.
 *
 * @param {Element} el
 * @param {number} at
 * @param {number} now
 */
function age(el, at, now) {
  el.setAttribute(AGE_ATTR, String(at));
  setAge(el, ago(now - at));
}

/**
 * Update the existing text node to avoid unnecessary child-list mutations and DOM scans (mechanics M27).
 *
 * @param {Element} el
 * @param {string} text
 * @returns {boolean} whether the value moved
 */
function setAge(el, text) {
  const node = el.firstChild;

  if (node === null || node.nodeType !== 3) {
    el.textContent = text;

    return true;
  }

  if (node.nodeValue === text) {
    return false;
  }

  node.nodeValue = text;

  return true;
}

/**
 * Update existing duration text once per second (R5), avoiding a full DOM scan for clock-only changes.
 *
 * @param {Document} doc
 * @param {number} now
 * @returns {number} how many durations were advanced, which is what a test has to go on
 */
export function tickDurations(doc, now) {
  let moved = 0;

  // Update only overlay elements; GitHub elements may use the same attribute name.
  for (const el of doc.querySelectorAll(`.${BADGE_CLASS} [${AGE_ATTR}], #${MENU_ID} [${AGE_ATTR}]`)) {
    const at = Number(el.getAttribute(AGE_ATTR));

    if (Number.isFinite(at) && setAge(el, ago(now - at))) {
      moved += 1;
    }
  }

  return moved;
}

const ISSUE_URL = /github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/;

/**
 * Read repository and issue number from the card link. Draft items return null; repository is required to
 * distinguish identical numbers across repositories.
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
 * Find the assignee figure through AvatarStack's stable attribute (mechanics M27). Include its caption so
 * replacement removes the old accessible name. Bound the ancestor lookup to this card to avoid hiding
 * unrelated content if GitHub changes its markup.
 *
 * @param {Element} card
 * @returns {Element | null} the figure, not the stack within it
 */
export function assigneeStackOf(card) {
  const figure = card.querySelector('[data-component="AvatarStack"]')?.closest('figure') ?? null;

  return figure !== null && card.contains(figure) ? figure : null;
}

/**
 * Replace GitHub's assignee figure with the avatar selected by selectCardAvatar in @ground-control/github. Use
 * the shared selection so both clients identify the same person.
 *
 * @param {Document} doc
 * @param {Element} element
 * @param {LanedCard} card
 */
function renderActor(doc, element, card) {
  const actor = card.issue?.avatar;
  const figure = assigneeStackOf(element);

  if (actor?.source !== 'pull-request' || figure === null) {
    return;
  }

  const slot = doc.createElement('span');

  slot.className = ACTOR_CLASS;
  slot.textContent = actor.login.slice(0, 2).toUpperCase();
  setTooltip(slot, `${actor.login} · pull request author`);
  slot.setAttribute('role', 'img');
  setAccessibleName(slot, `${actor.login}, pull request author`);

  const image = doc.createElement('img');

  image.src = actor.url;
  image.alt = '';

  // Hide failed images instead of removing them. Removal would trigger the childList observer and repeatedly
  // recreate the failing image.
  image.addEventListener('error', () => {
    image.hidden = true;
    slot.dataset.avatar = 'failed';
  });
  slot.appendChild(image);

  // Remove the empty figure from the accessibility tree; its replacement avatar supplies the accessible name.
  figure.setAttribute('role', 'presentation');
  figure.setAttribute(ACTOR_ATTR, actor.login);
  figure.appendChild(slot);
}

/**
 * The same, off a card the hub reported. Null where the issue's own URL is not one this pattern reads.
 *
 * @param {LanedCard} card
 */
function refOfCard(card) {
  const match = ISSUE_URL.exec(card.issue?.url ?? '');

  return match ? `${match[1]}#${match[2]}` : null;
}

/**
 * Index cards by repository and number when available, otherwise by number only. Keep indexes disjoint to
 * prevent cross-repository fallback matches.
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

/** Embed the published Claude logo as SVG in brand orange, avoiding external image loads and supporting jsdom. */
const CLAUDE_MARK =
  'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z';

/** OpenAI logo from the ChatGPT extension resources/blossom-black.svg, using the row text color. */
const OPENAI_MARK =
  'M13.795 23.856q-1.188 0-2.256-.448a6.1 6.1 0 0 1-1.9-1.247 5.8 5.8 0 0 1-1.875.306 5.8 5.8 0 0 1-2.944-.777 6.1 6.1 0 0 1-2.184-2.12q-.807-1.34-.808-2.99 0-.682.19-1.482a6.3 6.3 0 0 1-1.472-2.002 5.76 5.76 0 0 1 .024-4.85q.546-1.177 1.52-2.024a5.5 5.5 0 0 1 2.303-1.2A5.55 5.55 0 0 1 5.485 2.62 6.06 6.06 0 0 1 7.575.925 5.85 5.85 0 0 1 10.21.313q1.187 0 2.255.447a6.1 6.1 0 0 1 1.9 1.248 5.8 5.8 0 0 1 1.875-.306q1.59 0 2.944.776a5.9 5.9 0 0 1 2.16 2.12q.832 1.34.832 2.99 0 .682-.19 1.483a6.2 6.2 0 0 1 1.472 2.024q.522 1.13.522 2.378 0 1.272-.546 2.449a6.1 6.1 0 0 1-1.543 2.048 5.45 5.45 0 0 1-2.28 1.177 5.4 5.4 0 0 1-1.115 2.402 5.8 5.8 0 0 1-2.066 1.695 5.85 5.85 0 0 1-2.635.612M7.93 20.913q1.188 0 2.066-.495l4.463-2.542a.52.52 0 0 0 .238-.448v-2.024L8.95 18.676a.97.97 0 0 1-1.044 0L3.419 16.11a.7.7 0 0 1-.024.165v.282q0 1.201.57 2.213.594.99 1.639 1.554 1.044.59 2.326.589m.238-3.838q.143.07.26.07a.46.46 0 0 0 .238-.07l1.781-1.012-5.722-3.296q-.522-.306-.522-.918v-5.11a4.27 4.27 0 0 0-1.9 1.602 4.13 4.13 0 0 0-.712 2.354q0 1.155.594 2.213.593 1.06 1.543 1.601zm5.627 5.227q1.258 0 2.279-.565a4.25 4.25 0 0 0 1.614-1.554q.594-.99.594-2.213v-5.085q0-.283-.237-.424l-1.805-1.036v6.568q0 .613-.522.919l-4.487 2.566q1.163.825 2.564.824m.902-8.617v-3.202l-2.683-1.507-2.707 1.507v3.202l2.707 1.507zm-6.933-7.51q0-.612.522-.918l4.488-2.567a4.34 4.34 0 0 0-2.564-.824q-1.26 0-2.28.565a4.25 4.25 0 0 0-1.614 1.554q-.57.99-.57 2.213v5.062q0 .283.237.447l1.781 1.036zm12.061 11.253a4.13 4.13 0 0 0 1.876-1.6 4.2 4.2 0 0 0 .712-2.355q0-1.154-.593-2.213-.594-1.06-1.544-1.6l-4.44-2.543q-.142-.095-.26-.071a.46.46 0 0 0-.238.07l-1.78.99 5.745 3.319q.26.141.38.377a.9.9 0 0 1 .142.518zm-4.772-11.96q.522-.33 1.045 0l4.51 2.614v-.424q0-1.13-.57-2.142a4.1 4.1 0 0 0-1.59-1.648q-1.02-.613-2.374-.613-1.187 0-2.066.495L9.545 6.292a.52.52 0 0 0-.238.448v2.025z';

/**
 * Agent logos, with text fallback for unknown agents so every session identifies its agent (R2).
 *
 * @type {Record<string, string>}
 */
const AGENT_MARKS = { claude: CLAUDE_MARK, codex: OPENAI_MARK };

/**
 * @param {Document} doc
 * @param {string} agent
 * @returns {SVGElement | null}
 */
export function agentIcon(doc, agent) {
  const drawn = AGENT_MARKS[agent];

  if (drawn === undefined) {
    return null;
  }

  const svg = doc.createElementNS(SVG_NS, 'svg');
  const mark = doc.createElementNS(SVG_NS, 'path');

  svg.setAttribute('class', 'gc-agent-icon');
  // Preserve agent brand colors; use the row color for monochrome logos.
  svg.setAttribute('data-agent', agent);
  svg.setAttribute('viewBox', '0 0 24 24');
  // Use 13px icons to match the editor board at 13.6px.
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('aria-hidden', 'true');
  mark.setAttribute('d', drawn);
  svg.appendChild(mark);

  return svg;
}

/**
 * Create a GitHub-style panel; position after insertion so measurements include its rendered width.
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

/** Minimum panel distance from the viewport edge. */
const MARGIN = 8;

/**
 * Measure after insertion. Align left edges, clamp horizontally, and flip above if needed. Reposition on each
 * scan.
 *
 * @param {HTMLElement} panel
 * @param {Element} anchor
 */
function place(panel, anchor) {
  const view = panel.ownerDocument.defaultView;
  const rect = anchor.getBoundingClientRect();
  const panelBounds = panel.getBoundingClientRect();
  const right = view?.innerWidth ?? 0;
  const bottom = view?.innerHeight ?? 0;

  const below = rect.bottom + 4;
  const overflows = below + panelBounds.height > bottom - MARGIN;

  panel.style.top = `${overflows ? Math.max(MARGIN, rect.top - 4 - panelBounds.height) : below}px`;
  panel.style.left = `${Math.max(MARGIN, Math.min(rect.left, right - panelBounds.width - MARGIN))}px`;
}

/** Tooltip delay measured from GitHub: 120ms. */
const TIP_DELAY = 120;

/** Tooltip gap measured from GitHub: 4px. */
const TIP_GAP = 4;

/** Tooltip viewport margin, independent of the menu margin. */
const TIP_MARGIN = 8;

/** @type {ReturnType<typeof setTimeout> | null} */
let tipTimer = null;
/** @type {Element | null} */
let tipAnchor = null;
/** @type {{ doc: Document, over: (event: Event) => void, out: (event: Event) => void, key: (event: Event) => void, scrolled: () => void } | null} */
let tips = null;

/**
 * Set tooltip text and an accessible description before focus. Native title uses a delayed system tooltip;
 * adding a description only on hover misses the initial focus announcement and browse-mode readers.
 *
 * @param {Element} el
 * @param {string} text
 */
function setTooltip(el, text) {
  el.setAttribute(TIP_ATTR, text);

  // Avoid duplicate accessible names and descriptions. `setAccessibleName` also removes descriptions, regardless of
  // call order.
  if (!el.hasAttribute('aria-label')) {
    el.setAttribute('aria-description', text);
  }
}

/**
 * Set the accessible name and remove the duplicate description.
 *
 * @param {Element} el
 * @param {string} text
 */
function setAccessibleName(el, text) {
  el.setAttribute('aria-label', text);
  el.removeAttribute('aria-description');
}

/**
 * Measure after setting text, then center the tooltip over its anchor within the viewport.
 *
 * @param {HTMLElement} panel
 * @param {Element} anchor
 */
function placeTip(panel, anchor) {
  const view = panel.ownerDocument.defaultView;
  const rect = anchor.getBoundingClientRect();
  const panelBounds = panel.getBoundingClientRect();
  const above = rect.top - TIP_GAP - panelBounds.height;

  // Place below when necessary, then clamp to the viewport so wrapped text remains visible.
  const top = above < TIP_MARGIN ? rect.bottom + TIP_GAP : above;

  panel.style.top = `${Math.max(TIP_MARGIN, Math.min(top, (view?.innerHeight ?? 0) - panelBounds.height - TIP_MARGIN))}px`;
  panel.style.left = `${Math.max(
    TIP_MARGIN,
    Math.min(rect.left + rect.width / 2 - panelBounds.width / 2, (view?.innerWidth ?? 0) - panelBounds.width - TIP_MARGIN),
  )}px`;
}

/**
 * Reuse one tooltip. Store text on the anchor attribute to exclude it from label textContent.
 *
 * @param {Document} doc
 * @returns {HTMLElement}
 */
function tipElement(doc) {
  const existingTooltip = doc.getElementById(TIP_ID);

  if (existingTooltip !== null) {
    return /** @type {HTMLElement} */ (existingTooltip);
  }

  const panel = doc.createElement('div');

  panel.id = TIP_ID;
  panel.setAttribute('role', 'tooltip');
  // Update the existing text node to avoid childList mutations.
  panel.appendChild(doc.createTextNode(''));
  (doc.body ?? doc.documentElement).appendChild(panel);

  return panel;
}

/**
 * @param {Document} doc
 * @param {Element} anchor
 */
function showTip(doc, anchor) {
  const text = anchor.getAttribute(TIP_ATTR);

  // Ignore anchors removed during the delay; their zero-sized bounds would place the tooltip in a corner.
  if (text === null || text === '' || !anchor.isConnected) {
    return;
  }

  const panel = tipElement(doc);
  const words = panel.firstChild ?? panel.appendChild(doc.createTextNode(''));

  words.nodeValue = text;
  panel.dataset.open = 'true';
  placeTip(panel, anchor);
}

/** @param {Document} doc */
function hideTip(doc) {
  if (tipTimer !== null) {
    clearTimeout(tipTimer);
    tipTimer = null;
  }

  tipAnchor = null;
  doc.getElementById(TIP_ID)?.removeAttribute('data-open');
}

/**
 * Delegate tooltip handlers to the document so newly created or replaced cards work without rebinding
 * listeners. mouseover bubbles; mouseenter does not.
 *
 * @param {Document} doc
 */
function ensureTips(doc) {
  // Create the tooltip while the observer is paused; appending it during hover would trigger another scan
  // (mechanics M27).
  tipElement(doc);

  if (tips?.doc === doc) {
    return;
  }

  if (tips !== null) {
    removeTips();
  }

  /** @param {Event} event */
  const over = (event) => {
    const anchor = /** @type {Element} */ (event.target)?.closest?.(`[${TIP_ATTR}]`) ?? null;

    if (anchor === tipAnchor) {
      return;
    }

    hideTip(doc);

    // Track the anchor during the delay so leaving it cancels the pending tooltip.
    tipAnchor = anchor;

    if (anchor !== null) {
      tipTimer = setTimeout(() => showTip(doc, anchor), TIP_DELAY);
    }
  };

  /** @param {Event} event */
  const out = (event) => {
    const going = /** @type {Element} */ (event.target)?.closest?.(`[${TIP_ATTR}]`) ?? null;
    const to = /** @type {Node | null} */ (/** @type {MouseEvent | FocusEvent} */ (event).relatedTarget ?? null);

    // Keep the tooltip open when the pointer moves between children of its anchor.
    if (going !== null && going === tipAnchor && !(to !== null && going.contains(to))) {
      hideTip(doc);
    }
  };

  /** @param {Event} event */
  const key = (event) => {
    if (/** @type {KeyboardEvent} */ (event).key === 'Escape') {
      hideTip(doc);
    }
  };

  // Close fixed-position tooltips and menus on scroll because their anchors move without triggering a scan.
  const scrolled = () => {
    hideTip(doc);

    if (openMenu !== null || panelOpen) {
      openMenu = null;
      panelOpen = false;
      repaintNow();
    }
  };

  doc.addEventListener('mouseover', over, true);
  doc.addEventListener('mouseout', out, true);
  doc.addEventListener('focusin', over, true);
  doc.addEventListener('focusout', out, true);
  doc.addEventListener('keydown', key, true);
  doc.addEventListener('scroll', scrolled, true);
  doc.defaultView?.addEventListener('resize', scrolled);

  tips = { doc, over, out, key, scrolled };
}

/** Current repaint callback for closing menus on scroll. */
let repaintNow = () => {};

/** Remove tooltip handlers and DOM when leaving a board. */
function removeTips() {
  if (tips === null) {
    return;
  }

  const { doc, over, out, key, scrolled } = tips;

  doc.removeEventListener('mouseover', over, true);
  doc.removeEventListener('mouseout', out, true);
  doc.removeEventListener('focusin', over, true);
  doc.removeEventListener('focusout', out, true);
  doc.removeEventListener('keydown', key, true);
  doc.removeEventListener('scroll', scrolled, true);
  doc.defaultView?.removeEventListener('resize', scrolled);
  hideTip(doc);
  doc.getElementById(TIP_ID)?.remove();
  tips = null;
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
 * Replace the outside-click handler on each render to avoid accumulating listeners.
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
 * Insert the menu in the filter bar, with a fallback above the columns if GitHub changes the bar markup (R25).
 *
 * @param {Document} doc
 * @returns {Element | null}
 */
function menuHost(doc) {
  const bar = doc.querySelector(TOOLBAR);

  if (bar !== null) {
    return bar;
  }

  const region = doc.querySelector(BOARD_REGION);

  if (region === null || region.parentElement === null) {
    return null;
  }

  const fallbackHost = doc.getElementById(MENU_FALLBACK_ID) ?? doc.createElement('div');

  fallbackHost.id = MENU_FALLBACK_ID;
  region.parentElement.insertBefore(fallbackHost, region);

  return fallbackHost;
}

/**
 * Copy current filter-button classes because GitHub hashes them per build.
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
 * Hide the unsaved-filter button container so its layout gap also disappears.
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
 * Find the title, view tabs, and unsaved-filter controls by stable attributes. Hide their outer wrappers
 * without including the board, so hashed wrapper classes and empty containers do not affect collapse behavior.
 *
 * @param {Document} doc
 * @returns {Element[]}
 */
export function foldedRows(doc) {
  const region = doc.querySelector(BOARD_REGION);

  // Stop if the board is absent; otherwise ancestor traversal could hide the page root.
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
 * Blocked site data can throw on storage access. Treat unreadable preferences as unset so rendering continues.
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
 * Reapply header visibility on each scan because view switches replace header nodes (mechanics M27).
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
 * Toggle project title and view-tab visibility. Persist in page storage across reloads and project boards.
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
  const label = folded ? 'Show the project header' : 'Hide the project header';

  setTooltip(button, label);
  setAccessibleName(button, label);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    event.preventDefault();
    setCollapsed(doc, !folded);
    actions.repaint();
  });

  return button;
}

/**
 * Show snapshot age, installation status, and refresh in the menu. Display failures as visible notices (R25).
 *
 * @param {Document} doc
 * @param {State} state
 * @param {number} now
 * @param {Actions} actions
 * @returns {HTMLElement | null}
 */
export function renderMenu(doc, state, now, actions) {
  const host = menuHost(doc);

  if (host === null) {
    doc.getElementById(MENU_ID)?.remove();

    return null;
  }

  const snapshot = state.snapshot;
  const held = doc.getElementById(MENU_ID);
  // Exclude age from the menu signature; the timer updates it in place. Preserve items under the pointer
  // across scans.
  const sig = JSON.stringify([
    state.trouble !== null || (snapshot?.stale ?? false),
    panelOpen,
    logOpen,
    snapshot === null,
    snapshot?.hooks?.notice ?? null,
    isCollapsed(doc),
  ]);

  if (held !== null && held.dataset.sig === sig && held.parentElement === host) {
    const panel = held.querySelector(`.${POPOVER_CLASS}`);
    const read = held.querySelector(`.${POPOVER_CLASS} [${AGE_ATTR}]`);

    // Update the retained panel timestamp so its age reflects the latest snapshot.
    if (read !== null && snapshot !== null) {
      age(read, Date.parse(snapshot.fetchedAt), now);
    }

    // Read afresh even when nothing was rebuilt: the bar the panel hangs from moves with the window.
    if (panel !== null) {
      place(/** @type {HTMLElement} */ (panel), /** @type {Element} */ (held.firstElementChild));
    }

    return held;
  }

  held?.remove();

  const holder = doc.createElement('div');

  holder.id = MENU_ID;
  holder.dataset.sig = sig;
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
  const read = doc.createElement('div');

  read.className = 'gc-note';

  if (snapshot === null) {
    read.textContent = 'No session or issue data received yet.';
  } else {
    // The age is a node of its own so the tick advances it where it stands, like every other duration on the page.
    const held = doc.createElement('span');

    age(held, Date.parse(snapshot.fetchedAt), now);
    read.append('Board updated ', held, ' ago.');
  }

  panel.appendChild(read);

  if (snapshot?.hooks?.notice) {
    const note = doc.createElement('div');

    note.className = 'gc-note';
    note.textContent = snapshot.hooks.notice;
    panel.appendChild(note);
  }

  panel.appendChild(doc.createElement('hr'));

  // Keep the infrequently used log action in the menu to conserve filter-bar width.
  panel.appendChild(
    item(doc, logOpen ? 'Hide log' : 'Show log', () => setLogOpen(doc, !logOpen, actions), logOpen ? '✓' : ''),
  );

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
 * Reconcile connection errors, source failures, and action notices by key to avoid duplicate notices on each
 * scan.
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
      remedy: 'Showing cached data when available.',
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

  // Display the latest action result, including browser permission refusals.
  if (state.notice !== null) {
    problems.push({ key: `notice:${state.notice}`, message: state.notice, remedy: null, tone: 'default' });
  }

  const live = new Set(problems.map((problem) => problem.key));

  // Keep dismissed notices hidden until the condition clears and recurs.
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

  const message = doc.createElement('div');

  message.textContent = problem.message;

  if (problem.remedy) {
    const remedy = doc.createElement('span');

    remedy.className = 'gc-remedy';
    remedy.textContent = problem.remedy;
    message.appendChild(remedy);
  }

  element.appendChild(message);

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

  // Offer open-checkout only when a checkout exists. Folder selection and session starts require the editor
  // (R41).
  if (card.checkout != null) {
    menu.appendChild(doc.createElement('hr'));

    const open = item(doc, 'Open in VS Code', () => {
      openMenu = null;
      actions.openCheckout(card.key);
      actions.repaint();
    });

    open.dataset.action = 'open-checkout';
    open.title = `Open ${card.checkout.root} in VS Code`;
    menu.appendChild(open);
  }

  return menu;
}

/**
 * Where a row's click lands, in the two destinations a board has: a detached run is attached to in a terminal, which
 * is a control on the editor board, and every other session opens in the editor itself. Solid against outline rather
 * than two line drawings of a rectangle, which read as one mark at this size.
 *
 * @type {Record<'terminal' | 'editor', [string, Record<string, string>][]>}
 */
const DESTINATION_SHAPES = {
  terminal: [
    ['rect', { class: 'gc-plate', x: '1.5', y: '3.5', width: '21', height: '17', rx: '3' }],
    ['polyline', { class: 'gc-ink', points: '6.5 9 9.75 12 6.5 15' }],
    ['line', { class: 'gc-ink', x1: '12.5', y1: '15', x2: '17.5', y2: '15' }],
  ],
  editor: [
    ['rect', { class: 'gc-frame', x: '1.75', y: '3.75', width: '20.5', height: '16.5', rx: '3' }],
    ['line', { class: 'gc-frame', x1: '8.5', y1: '3.75', x2: '8.5', y2: '20.25' }],
  ],
};

/**
 * The destination icon replaces the duration on hover. Hide it from screen readers because the row already
 * names the action.
 *
 * @param {Document} doc
 * @param {'terminal' | 'editor'} kind
 * @returns {HTMLElement}
 */
function destinationMark(doc, kind) {
  const held = doc.createElement('span');
  held.className = 'gc-destination';
  held.dataset.destination = kind;

  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');

  for (const [name, attributes] of DESTINATION_SHAPES[kind]) {
    const shape =
      name === 'rect'
        ? doc.createElementNS(SVG_NS, 'rect')
        : name === 'polyline'
          ? doc.createElementNS(SVG_NS, 'polyline')
          : doc.createElementNS(SVG_NS, 'line');

    for (const [attribute, value] of Object.entries(attributes)) {
      shape.setAttribute(attribute, value);
    }

    svg.appendChild(shape);
  }

  held.appendChild(svg);

  return held;
}

/**
 * Accessible session action name. Detached runs attach through a VS Code terminal.
 *
 * @param {boolean} reachable
 * @param {string | null} attachId
 * @returns {string}
 */
function destinationWords(reachable, attachId) {
  if (!reachable) {
    return 'cannot open this session in VS Code';
  }

  return attachId === null ? 'open this session in VS Code' : 'attach to this run in a VS Code terminal';
}

/**
 * Render agent, session name, and one state: prefer the board observation, then the reported state (R24).
 *
 * @param {Document} doc
 * @param {Session} session
 * @param {number} now
 * @param {readonly string[]} openable
 * @returns {HTMLElement}
 */
function sessionRow(doc, session, now, openable) {
  // Detached runs use the VS Code attach URI independently of editor session-open capabilities.
  const attachId = typeof session.attachId === 'string' ? session.attachId : null;
  const reachable = attachId !== null || openable.includes(session.sessionId);
  const row = doc.createElement(reachable ? 'a' : 'span');

  row.className = 'gc-session';
  row.dataset.phase = session.activity?.phase ?? 'none';

  if (reachable) {
    // Use link navigation as the browser user gesture for VS Code foreground activation (mechanics M26, M29).
    row.setAttribute('href', `${attachId === null ? OPEN_SESSION_URI : ATTACH_SESSION_URI}${encodeURIComponent(session.sessionId)}`);
    // A few pixels of drift on the way to a click would otherwise drag the card GitHub wraps around this.
    row.setAttribute('draggable', 'false');
  }

  row.appendChild(sessionDot(doc, session.activity?.phase, !session.finished));

  const icon = agentIcon(doc, session.agent);

  // Identify every agent by logo or text fallback (R2).
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
    age(state, session.activity.since, now);
    row.appendChild(state);
  } else {
    const reported = session.details.state ?? session.details.status;

    if (reported) {
      state.textContent = reported;
      row.appendChild(state);
    }
  }

  // Put activity details on the state tooltip; the row label already identifies the session.
  if (session.activity) {
    setTooltip(state, stateTitle(session.activity));
  }

  row.setAttribute('aria-label', `${name} — ${destinationWords(reachable, attachId)}.`);

  // Italic names identify board-dispatched runs.
  if (attachId !== null) {
    row.dataset.detached = 'true';
  }

  if (reachable) {
    const destination = destinationMark(doc, attachId === null ? 'editor' : 'terminal');
    const destinationDescription = attachId === null ? 'Opens this session in VS Code.' : 'Attaches to this run in a terminal in VS Code.';

    // Copy the duration tooltip to the destination icon that replaces it on hover.
    setTooltip(destination, session.activity ? `${destinationDescription} ${stateTitle(session.activity)}` : destinationDescription);
    row.appendChild(destination);
  }
  // Stop propagation to prevent GitHub from opening the issue, but preserve link navigation for VS Code
  // foreground activation.
  row.addEventListener('click', (event) => event.stopPropagation());

  return row;
}

/**
 * @param {Document} doc
 * @param {import('@ground-control/core').HistoricalSession | undefined} session
 * @param {number} now
 * @param {readonly string[]} openable
 * @returns {HTMLElement | null}
 */
function historyRow(doc, session, now, openable) {
  if (!session || typeof session.agent !== 'string' || typeof session.cwd !== 'string' ||
      !(session.title === null || typeof session.title === 'string') ||
      !Number.isFinite(session.updatedAt) || !Number.isFinite(new Date(session.updatedAt).getTime())) return null;
  const reachable = openable.includes(session.sessionId);
  const row = doc.createElement(reachable ? 'a' : 'span');
  if (reachable) {
    row.setAttribute('href', `${OPEN_SESSION_URI}${encodeURIComponent(session.sessionId)}`);
    row.setAttribute('draggable', 'false');
  }
  row.className = 'gc-session gc-historical';
  const mark = retainedMark(session.retained);
  // Set the retained phase on the row and dot; retainedMark maps ended running sessions to idle.
  if (mark) row.dataset.phase = mark.phase;
  row.appendChild(sessionDot(doc, mark?.phase, false, mark ? mark.title : 'Last session on this card. No active sessions.'));
  const icon = agentIcon(doc, session.agent);
  if (icon) row.appendChild(icon);
  else {
    const named = doc.createElement('span');
    named.className = 'gc-agent';
    named.textContent = session.agent;
    row.appendChild(named);
  }
  const name = doc.createElement('span');
  name.className = 'gc-name';
  name.textContent = session.title ?? basename(session.cwd);
  const state = doc.createElement('span');
  state.className = 'gc-state';
  // Use retained activity time when available; otherwise use the last transcript timestamp.
  age(state, mark ? mark.at : session.updatedAt, now);
  // Put the exact timestamp on the duration tooltip, using the same time as the displayed age.
  setTooltip(state, `${reachable ? 'Resume this session in VS Code.' : 'Historical session.'} ${mark ? `Last seen ${new Date(mark.at).toLocaleString()}` : `Last saved ${new Date(session.updatedAt).toLocaleString()}`}.`);
  row.setAttribute('aria-label', `${name.textContent} — ${reachable ? 'resume this session in VS Code' : 'historical session'}.`);
  row.append(name, state);

  // Saved sessions must resume in the editor; there is no process to attach to.
  if (reachable) {
    const destination = destinationMark(doc, 'editor');

    setTooltip(destination, `Resumes this session in VS Code. ${mark ? mark.title : ''}`.trim());
    row.appendChild(destination);
  }

  row.addEventListener('click', (event) => event.stopPropagation());
  return row;
}

/**
 * Render retained activity with its timestamp and explanation. Map running to idle because the process ended.
 * `retainedPhase` in packages/board/src/lanes.ts determines card attention from the same observation.
 *
 * @param {{ phase?: string, event?: unknown, at?: unknown } | undefined} retained
 * @returns {{ phase: string, at: number, title: string } | undefined}
 */
function retainedMark(retained) {
  if (!retained || typeof retained.at !== 'number' || typeof retained.event !== 'string') return undefined;

  const eventDescription = `Last seen at the ${retained.event} hook.`;

  if (retained.phase === 'waiting') {
    return { phase: 'waiting', at: retained.at, title: `The session ended while waiting for your input. ${eventDescription}` };
  }

  if (retained.phase === 'running') {
    return { phase: 'idle', at: retained.at, title: `The session ended before completing its turn. ${eventDescription}` };
  }

  if (retained.phase === 'idle') {
    return { phase: 'idle', at: retained.at, title: `The session completed its turn, then ended. ${eventDescription}` };
  }

  return undefined;
}

/**
 * Describe the duration and last hook event.
 *
 * @param {{ phase: string, event: string | null }} activity
 * @returns {string}
 */
function stateTitle(activity) {
  const durationDescription = DURATION_TITLES[activity.phase] ?? DURATION_TITLE;

  return activity.event ? `${durationDescription} Last event: ${activity.event}.` : durationDescription;
}

/**
 * Set attention on the GitHub card for border and session-dot styling. Session rows already identify the
 * affected session (R6).
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
    setTooltip(mark, 'This card returned to you.');
    head.appendChild(mark);
  }

  if (card.attention === null) {
    element.removeAttribute(ATTENTION_ATTR);

    return;
  }

  element.setAttribute(ATTENTION_ATTR, card.attention);
}

/**
 * Build the lane and session footer inside the card box, not on its outer drag handle. The drawn cache retains
 * it until its content changes or GitHub replaces the card node (mechanics M27).
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
  renderTriage(doc, head, card, now);

  for (const session of card.sessions) {
    badge.appendChild(sessionRow(doc, session, now, openable));
  }
  if (!card.sessions.some((session) => !session.finished)) {
    const historical = historyRow(doc, card.lastSession, now, openable);
    if (historical) badge.appendChild(historical);
  }

  // Inside the card's own bordered box, so the footer reads as a line of the card rather than a chip dropped under it.
  (element.firstElementChild ?? element).appendChild(badge);

  if (openMenu !== card.key) {
    return [];
  }

  const menu = laneMenu(doc, card, actions);

  (doc.body ?? doc.documentElement).appendChild(menu);
  place(menu, lane);

  // Treat the menu control as inside the menu so its click closes it without reopening.
  return [menu, lane];
}

/**
 * Display the triage action and age, with its explanation on hover (R38). Triage does not affect attention
 * styling. Retriage is editor-only; the browser bridge refuses it.
 *
 * @param {Document} doc
 * @param {HTMLElement} head
 * @param {LanedCard} card
 * @param {number} now
 */
function renderTriage(doc, head, card, now) {
  const triage = card.triage;

  if (!triage) {
    return;
  }

  const mark = doc.createElement('span');

  mark.className = 'gc-mark';
  mark.dataset.mark = triage.state === 'done' ? 'triage' : 'triaging';
  head.appendChild(mark);

  if (triage.state === 'running') {
    mark.textContent = 'Reading…';
    setTooltip(mark, 'Identifying the next action.');

    return;
  }

  // Retriage consumes model usage and is editor-only; the browser bridge refuses it (R38).
  if (triage.state === 'failed') {
    mark.textContent = 'Not read';
    setTooltip(mark, 'Triage failed. Retry from the card in VS Code.');

    return;
  }

  mark.textContent = triageText(triage);
  mark.dataset.stale = String(triage.stale);
  setTooltip(
    mark,
    `${triage.detail} ${triage.stale ? `Read ${ago(now - triage.at)} ago; card details have changed.` : `Read ${ago(now - triage.at)} ago.`}`,
  );

  // Display status age; put classification time and explanation in the tooltip. Status age is null outside
  // project boards because GitHub records no move timestamp.
  const moved = card.issue?.statusChangedAt ? Date.parse(card.issue.statusChangedAt) : NaN;

  if (Number.isFinite(moved)) {
    const ageLabel = doc.createElement('span');

    ageLabel.className = 'gc-triage-age';
    age(ageLabel, moved, now);
    mark.append(' · ', ageLabel);
  }
}


/**
 * Match the worker log buffer limit so an incoming backlog is retained. This file cannot import worker state;
 * parity tests verify the limit.
 */
export const LOG_LIMIT = 4000;

/**
 * Create the log panel once by ID. Later scans reconcile visibility and source filters while appended lines
 * and scroll state remain intact.
 *
 * @param {Document} doc
 * @param {Actions} actions
 * @returns {HTMLElement | null}
 */
export function renderLog(doc, actions) {
  const existing = doc.getElementById(LOG_ID);

  if (!logOpen) {
    existing?.remove();

    return null;
  }

  const panel = existing ?? buildLog(doc, actions);

  panel.dataset.showsBrowser = String(logShows.browser);
  panel.dataset.showsHub = String(logShows.hub);
  panel.dataset.showsDebug = String(logShows.debug);
  panel.dataset.pinned = String(logPinned);

  return panel;
}

/** Map filter controls to the dataset keys used by CSS. */
const SHOWS = { browser: 'showsBrowser', hub: 'showsHub', debug: 'showsDebug' };

/**
 * @param {Document} doc
 * @param {Actions} actions
 * @returns {HTMLElement}
 */
function buildLog(doc, actions) {
  const panel = doc.createElement('aside');

  panel.id = LOG_ID;
  panel.setAttribute('aria-label', 'Ground Control log');

  const bar = doc.createElement('header');
  const title = doc.createElement('h2');

  title.textContent = 'Ground Control log';
  bar.appendChild(title);

  // Filter sources with CSS while retaining log nodes so filters can be reversed.
  for (const shown of /** @type {const} */ (['browser', 'hub', 'debug'])) {
    const label = doc.createElement('label');
    const box = doc.createElement('input');

    box.type = 'checkbox';
    box.checked = logShows[shown];
    box.dataset.shows = shown;
    box.addEventListener('change', () => {
      logShows[shown] = box.checked;
      panel.dataset[SHOWS[shown]] = String(box.checked);
    });
    label.append(box, doc.createTextNode(shown));
    bar.appendChild(label);
  }

  const pinLabel = doc.createElement('label');
  const pin = doc.createElement('input');

  pin.type = 'checkbox';
  pin.checked = logPinned;
  pin.dataset.pin = 'true';
  pin.addEventListener('change', () => {
    logPinned = pin.checked;
    panel.dataset.pinned = String(logPinned);
  });
  setTooltip(pinLabel, 'Keep the log open when clicking outside it.');
  pinLabel.append(pin, doc.createTextNode('pin'));
  bar.appendChild(pinLabel);

  const close = doc.createElement('button');

  close.type = 'button';
  close.className = 'gc-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close the log');
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    event.preventDefault();
    setLogOpen(doc, false, actions);
  });
  bar.appendChild(close);

  const lines = doc.createElement('div');

  lines.id = LOG_LINES_ID;
  lines.setAttribute('role', 'log');
  lines.setAttribute('aria-live', 'polite');

  const empty = doc.createElement('span');

  empty.className = 'gc-empty';
  empty.textContent = 'Waiting for log entries…';
  lines.appendChild(empty);

  panel.append(bar, lines);
  (doc.body ?? doc.documentElement).appendChild(panel);

  return panel;
}

/**
 * Create the log panel before subscribing: the initial backlog can arrive before the next repaint. Closing the
 * panel unsubscribes from hub logs (R40).
 *
 * @param {Document} doc
 * @param {boolean} open
 * @param {Actions} actions
 */
export function setLogOpen(doc, open, actions) {
  if (open === logOpen) {
    return;
  }

  logOpen = open;
  panelOpen = false;
  renderLog(doc, actions);
  actions.watchLog(open);
  actions.repaint();
}

/**
 * Append log lines. Autoscroll only when already at the bottom so reading earlier lines remains possible.
 *
 * @param {Document} doc
 * @param {readonly LogEntry[]} entries
 * @returns {number} how many lines the sidebar now holds
 */
export function appendLog(doc, entries) {
  const lines = doc.getElementById(LOG_LINES_ID);

  if (lines === null) {
    return 0;
  }

  lines.querySelector('.gc-empty')?.remove();

  // Read before anything is added: the measurement is whether they were at the bottom, and appending moves it.
  const atBottom = lines.scrollHeight - lines.scrollTop - lines.clientHeight < 24;

  for (const entry of entries) {
    lines.appendChild(logLine(doc, entry));
  }

  for (let over = lines.childElementCount - LOG_LIMIT; over > 0; over--) {
    lines.firstElementChild?.remove();
  }

  if (atBottom) {
    lines.scrollTop = lines.scrollHeight;
  }

  return lines.childElementCount;
}

/**
 * @param {Document} doc
 * @param {LogEntry} entry
 * @returns {HTMLElement}
 */
function logLine(doc, entry) {
  const line = doc.createElement('span');

  line.className = 'gc-line';
  line.dataset.source = entry.source;
  line.dataset.level = entry.level;

  const when = doc.createElement('span');

  // Display time of day using the original hub timestamp, preserving restart gaps in the log.
  when.className = 'gc-when';
  when.textContent = `${entry.at.slice(11, 19)} `;

  const tag = doc.createElement('span');

  tag.className = 'gc-tag';
  tag.textContent = `${entry.source}${entry.scope === undefined ? '' : `/${entry.scope}`} `;

  line.append(when, tag, doc.createTextNode(entry.message));

  return line;
}

/**
 * Remove overlay DOM on navigation away from a board. The content script runs across github.com because Chrome
 * does not reinject it on soft navigation.
 *
 * @param {Document} doc
 */
export function clear(doc) {
  removeTips();
  openMenu = null;
  panelOpen = false;
  logOpen = false;
  logPinned = false;
  Object.assign(logShows, LOG_SHOWS_BY_DEFAULT);
  collapsed = null;
  dismissed.clear();
  closeOnOutsideClick(doc, [], () => {});

  for (const row of doc.querySelectorAll(`[${HIDDEN_ATTR}]`)) {
    row.removeAttribute(HIDDEN_ATTR);
  }

  for (const id of [MENU_ID, MENU_FALLBACK_ID, TOASTS_ID, LOG_ID]) {
    doc.getElementById(id)?.remove();
  }

  // Clear per-card state and open menus when leaving the board.
  drawn = new WeakMap();

  for (const element of doc.querySelectorAll(`.${BADGE_CLASS}, .${POPOVER_CLASS}, .${ACTOR_CLASS}`)) {
    element.remove();
  }

  for (const figure of doc.querySelectorAll(`[${ACTOR_ATTR}]`)) {
    figure.removeAttribute(ACTOR_ATTR);
    figure.removeAttribute('role');
  }

  for (const card of doc.querySelectorAll('[data-gc-issue]')) {
    card.removeAttribute('data-gc-issue');
  }

  for (const card of doc.querySelectorAll(`[${ATTENTION_ATTR}]`)) {
    card.removeAttribute(ATTENTION_ATTR);
  }
}

/**
 * Cache each footer by card node and content signature. Preserve unchanged nodes to keep animation, hover, and
 * avatars stable. A GitHub view switch replaces the card node and forces a rebuild (mechanics M27).
 *
 * @type {WeakMap<Element, { sig: string, badge: Element }>}
 */
let drawn = new WeakMap();

/**
 * Exclude activity timestamps and events from the signature to preserve rows during steady activity;
 * syncActivity updates them in place.
 *
 * @param {LanedCard} card
 * @param {readonly string[]} openable
 * @returns {string}
 */
function badgeSignature(card, openable) {
  return JSON.stringify([
    // Include the card key because GitHub recycles nodes between issues and footer handlers capture card
    // identity.
    card.key,
    card.lane,
    card.returned,
    card.attention,
    card.triage,
    card.issue?.statusChangedAt ?? null,
    card.issue?.avatar ?? null,
    // The lane menu offers the checkout, so a card that gains or loses one has to be rebuilt to stop offering it.
    card.checkout?.root ?? null,
    card.lastSession === undefined
      ? null
      : [
          card.lastSession.agent,
          card.lastSession.sessionId,
          card.lastSession.title,
          card.lastSession.cwd,
          card.lastSession.updatedAt,
          // Include retained activity in the signature: it is a fixed observation whose changes require a row
          // rebuild.
          card.lastSession.retained?.phase ?? null,
          card.lastSession.retained?.at ?? null,
          openable.includes(card.lastSession.sessionId),
        ],
    card.sessions.map((s) => [
      s.agent,
      s.sessionId,
      s.title,
      s.details.name,
      s.details.shortId,
      s.details.state,
      s.details.status,
      s.cwd,
      s.finished,
      s.activity?.phase ?? null,
      openable.includes(s.sessionId),
    ]),
  ]);
}

/**
 * Update timestamps and hook details on retained elements. They are excluded from the signature to prevent
 * rebuilds during steady activity (R24).
 *
 * @param {Element} badge
 * @param {LanedCard} card
 * @param {number} now
 */
function syncActivity(badge, card, now) {
  const rows = badge.querySelectorAll('.gc-session:not(.gc-historical)');

  card.sessions.forEach((session, at) => {
    const state = session.activity ? rows[at]?.querySelector('.gc-state') : null;

    if (state && session.activity) {
      age(state, session.activity.since, now);
      setTooltip(state, stateTitle(session.activity));
    }
  });
}

/**
 * Retain the footer only if its content signature and avatar slot match. GitHub can replace the assignee
 * figure independently.
 *
 * @param {Element} element
 * @param {LanedCard} card
 * @param {string} sig
 * @returns {Element | null} the footer to keep, or null to rebuild
 */
function keptBadge(element, card, sig) {
  const held = drawn.get(element);
  const box = element.firstElementChild ?? element;

  if (held === undefined || held.sig !== sig || !held.badge.isConnected || held.badge.parentElement !== box) {
    return null;
  }

  const actor = card.issue?.avatar;

  // Check the avatar slot: GitHub can replace it while leaving the attribute that hides original assignees,
  // producing a blank area.
  if (actor?.source === 'pull-request' && assigneeStackOf(element)?.querySelector(`.${ACTOR_CLASS}`) == null) {
    return null;
  }

  return held.badge;
}

/**
 * Report scanned and matched card counts separately to diagnose card matching and selector failures.
 *
 * @param {Document} doc
 * @param {State} state
 * @param {number} now
 * @param {Actions} actions
 * @returns {{ scanned: number, badges: number, menu: boolean }}
 */
export function paint(doc, state, now, actions) {
  ensureStyle(doc);
  ensureTips(doc);
  repaintNow = actions.repaint;

  // Remove previous lane menus before rendering because their cards may have disappeared. Keep the unchanged
  // board menu inside #gc-menu.
  for (const stale of doc.querySelectorAll(`body > .${POPOVER_CLASS}`)) {
    stale.remove();
  }

  const menu = renderMenu(doc, state, now, actions);
  const log = renderLog(doc, actions);

  applyCollapse(doc);
  renderToasts(doc, state);

  const index = state.snapshot === null ? null : cardsByIssue(state.snapshot);

  let badges = 0;
  let scanned = 0;
  /** @type {Element[]} */
  const open = menu === null ? [] : [menu];

  // Outside clicks close the sidebar and unsubscribe from hub logs (R40).
  if (log !== null) {
    open.push(log);
  }

  const openable = state.snapshot?.openable ?? [];

  for (const element of doc.querySelectorAll(CARD)) {
    scanned += 1;

    const ref = issueRefOf(element);
    const card = ref === null ? undefined : index?.byRef.get(`${ref.repo}#${ref.number}`) ?? index?.byNumber.get(ref.number);
    const sig = card === undefined ? null : badgeSignature(card, openable);
    // Rebuild the card with an open lane menu because renderBadge must recreate the menu removed above.
    const kept = card === undefined || sig === null || openMenu === card.key ? null : keptBadge(element, card, sig);

    if (kept === null) {
      for (const stale of element.querySelectorAll(`.${BADGE_CLASS}, .${ACTOR_CLASS}`)) {
        stale.remove();
      }

      // Restore the original assignee figure before recalculating avatar replacement; a card may have lost
      // its PR. Remove roles from bare figures.
      for (const figure of element.querySelectorAll(`[${ACTOR_ATTR}]`)) {
        figure.removeAttribute(ACTOR_ATTR);
        figure.removeAttribute('role');
      }
    }

    if (ref === null) {
      element.removeAttribute('data-gc-issue');
      element.removeAttribute(ATTENTION_ATTR);

      continue;
    }

    element.setAttribute('data-gc-issue', `${ref.repo}#${ref.number}`);

    if (card === undefined) {
      element.removeAttribute(ATTENTION_ATTR);

      continue;
    }

    // A kept footer still takes the newer observation, and still counts: `badges` is how many cards carry one.
    if (kept !== null) {
      syncActivity(kept, card, now);
      badges += 1;

      continue;
    }

    renderActor(doc, element, card);
    open.push(...renderBadge(doc, element, card, now, actions, openable));
    drawn.set(element, { sig: /** @type {string} */ (sig), badge: element.querySelector(`.${BADGE_CLASS}`) ?? element });

    badges += 1;
  }

  // Close tooltips after rebuilding so removed anchors are detected.
  if (tipAnchor !== null && !tipAnchor.isConnected) {
    hideTip(doc);
  }

  closeOnOutsideClick(doc, panelOpen || openMenu !== null || (logOpen && !logPinned) ? open : [], () => {
    // Read state after the menu handler runs so an outside click closes all unpinned panels and unsubscribes
    // from logs.
    if (logOpen && !logPinned) {
      setLogOpen(doc, false, actions);
    }

    actions.repaint();
  });

  return { scanned, badges, menu: menu !== null };
}
