// @ts-check
const vscode = acquireVsCodeApi();

const lanesEl = document.getElementById('lanes');
const metaEl = document.getElementById('meta');
const noticesEl = document.getElementById('notices');

const boardMenuEl = document.getElementById('board-menu');

/** Custom tooltip text. Geometry and timing match GitHub (mechanics M35); both client suites verify parity. */
const TIP_ATTR = 'data-gc-tip';

/** Tooltip delay and anchor gap. */
const TIP_DELAY = 120;
const TIP_GAP = 4;

/** Minimum tooltip distance from the viewport edge. */
const TIP_MARGIN = 8;

/** @type {ReturnType<typeof setTimeout> | null} */
let tipTimer = null;
/** @type {Element | null} */
let tipAnchor = null;

/**
 * Set the accessible description before focus so screen readers announce it, including in browse mode. Both
 * clients use Chromium.
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

/** Reuse one tooltip. Store text on the anchor attribute to exclude it from label textContent. */
function tipElement() {
  const existingTooltip = document.getElementById('tip');

  if (existingTooltip !== null) {
    return existingTooltip;
  }

  const panel = document.createElement('div');

  panel.id = 'tip';
  panel.setAttribute('role', 'tooltip');
  // Update the existing text node to avoid childList mutations.
  panel.appendChild(document.createTextNode(''));
  document.body.appendChild(panel);

  return panel;
}

/**
 * Measure after setting text, then center the tooltip over its anchor within the viewport.
 *
 * @param {HTMLElement} panel
 * @param {Element} anchor
 */
function placeTip(panel, anchor) {
  const rect = anchor.getBoundingClientRect();
  const panelBounds = panel.getBoundingClientRect();
  const above = rect.top - TIP_GAP - panelBounds.height;

  // Place below when necessary, then clamp to the viewport so wrapped text remains visible.
  const top = above < TIP_MARGIN ? rect.bottom + TIP_GAP : above;

  panel.style.top = `${Math.max(TIP_MARGIN, Math.min(top, window.innerHeight - panelBounds.height - TIP_MARGIN))}px`;
  panel.style.left = `${Math.max(
    TIP_MARGIN,
    Math.min(rect.left + rect.width / 2 - panelBounds.width / 2, window.innerWidth - panelBounds.width - TIP_MARGIN),
  )}px`;
}

/** @param {Element} anchor */
function showTip(anchor) {
  const text = anchor.getAttribute(TIP_ATTR);

  // Ignore anchors removed during the delay; their zero-sized bounds would place the tooltip in a corner.
  if (text === null || text === '' || !anchor.isConnected) {
    return;
  }

  const panel = tipElement();
  const words = panel.firstChild ?? panel.appendChild(document.createTextNode(''));

  words.nodeValue = text;
  panel.dataset.open = 'true';
  placeTip(panel, anchor);
}

function hideTip() {
  if (tipTimer !== null) {
    clearTimeout(tipTimer);
    tipTimer = null;
  }

  tipAnchor = null;
  document.getElementById('tip')?.removeAttribute('data-open');
}

/**
 * Delegate to the document so replaced cards need no new listeners. mouseover bubbles; mouseenter does not.
 *
 * @param {Event} event
 */
function tipOver(event) {
  const anchor = /** @type {Element} */ (event.target)?.closest?.(`[${TIP_ATTR}]`) ?? null;

  // Suppress focus tooltips inside menus to avoid covering other items; item labels remain accessible.
  if (event.type === 'focusin' && anchor?.closest('.card-popover') !== null) {
    return;
  }

  if (anchor === tipAnchor) {
    return;
  }

  hideTip();

  // Track the anchor during the delay so leaving it cancels the pending tooltip.
  tipAnchor = anchor;

  if (anchor !== null) {
    tipTimer = setTimeout(() => showTip(anchor), TIP_DELAY);
  }
}

/** @param {Event} event */
function tipOut(event) {
  const previousAnchor = /** @type {Element} */ (event.target)?.closest?.(`[${TIP_ATTR}]`) ?? null;
  const nextTarget = /** @type {Node | null} */ (event.relatedTarget ?? null);

  // Keep the tooltip open when the pointer moves between children of its anchor.
  if (previousAnchor !== null && previousAnchor === tipAnchor && !(nextTarget !== null && previousAnchor.contains(nextTarget))) {
    hideTip();
  }
}

document.addEventListener('mouseover', tipOver, true);
document.addEventListener('focusin', tipOver, true);
document.addEventListener('mouseout', tipOut, true);
document.addEventListener('focusout', tipOut, true);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') hideTip();
}, true);

// Close on scroll because viewport positioning does not follow the anchor.
document.addEventListener('scroll', hideTip, true);

/** Track the hub log subscription for the menu; the Output panel does not expose it. */
let streamingLogs = false;

/** Archive visibility and count. Offer the toggle only when the archive contains cards. */
let showArchived = false;
/** First-run choices still owed; the notice stays until the extension says they are made. */
let setupPending = false;
/** Mirrors groundControl.animations; kept in webview state so a restored board does not flash the shimmer first. */
let animations = true;

/** The stylesheet repeats its reduced-motion rules under this attribute; the OS preference still applies on its own. */
function applyMotion() {
  if (animations) {
    delete document.body.dataset.motion;
  } else {
    document.body.dataset.motion = 'reduced';
  }
}
let archivedCount = 0;

/** Build board actions with current toggle states. */
function boardActions() {
  const actions = [];

  if (archivedCount > 0) {
    actions.push({
      label: `Show archived (${archivedCount})`,
      hint: showArchived ? 'Hide the Archived lane.' : 'Show the Archived lane.',
      checked: showArchived,
      run: () => {
        showArchived = !showArchived;
        // Persist in the extension so the preference survives closing the tab.
        vscode.postMessage({ type: 'setShowArchived', shown: showArchived });

        if (board) {
          render(board);
        }
      },
    });
  }

  actions.push(
    {
      label: 'Stream hub log',
      hint: streamingLogs
        ? 'Stop streaming the hub log into Output.'
        : 'Stream the hub log into the Output panel.',
      checked: streamingLogs,
      run: () => vscode.postMessage({ type: 'toggleLogs' }),
    },
    {
      label: 'Show board log',
      hint: "Show the board log in Output.",
      run: () => vscode.postMessage({ type: 'showBoardLog' }),
    },
    {
      label: 'Refresh',
      hint: 'Refresh sessions and issues.',
      run: () => vscode.postMessage({ type: 'refresh' }),
    },
    {
      label: 'Settings',
      hint: "Open Ground Control settings.",
      run: () => vscode.postMessage({ type: 'openSettings' }),
    },
  );

  return actions;
}

function paintLogs(streaming) {
  streamingLogs = streaming;
  // Show the log subscription state even when the menu is closed.
  boardMenuEl.classList.toggle('on', streaming);
  setTooltip(boardMenuEl, streaming ? 'Board actions. The hub log is streaming into Output.' : 'Board actions');
}

// Card keys contain a kind and colon, so this menu key cannot collide with them.
const BOARD_MENU_KEY = 'board';

/** The last board the extension sent, kept so the archive toggle can re-render without a refresh. */
let board = null;
/** The card being dragged. A drop reads the dataTransfer first; this covers a browser that hands back nothing. */
let dragging = null;
/** A board that arrived mid-drag. Rendering then would replace the element under the cursor and cancel the drag. */
let deferred = null;

function endDrag() {
  dragging = null;
  lanesEl.classList.remove('dragging');

  if (deferred) {
    const next = deferred;
    deferred = null;
    render(next);
  }
}

function move(key, lane) {
  vscode.postMessage({ type: 'moveCard', key, lane });
}

function notice(text, remedy, isError) {
  const el = document.createElement('div');
  el.className = isError ? 'notice error' : 'notice';

  const body = document.createElement('span');
  body.textContent = text;
  el.appendChild(body);

  if (remedy) {
    const r = document.createElement('span');
    r.className = 'remedy';
    r.textContent = remedy;
    el.appendChild(r);
  }

  noticesEl.appendChild(el);
}

/** Accept both path separators because agents report platform-specific paths. */
function basename(dir) {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

/** Prefer title, CLI name, short ID, then checkout basename. Both client suites verify this precedence. */
function sessionLabel(session) {
  return session.title ?? session.details.name ?? session.details.shortId ?? basename(session.cwd);
}

/** Use the checkout selected and validated by the hub (`checkoutFor`); do not derive another from sessions. */
function hasCheckout(boardCard) {
  return boardCard.checkout != null;
}

/** The sessions this window can open, named by the extension - the webview never compares directories itself. */
let openable = new Set();

/** The agents this window can start a session for, host-wide: `[{ agent, takesPrompt }]`, empty until a snapshot. */
let startable = [];

/** Display the agent ID consistently; agents have no separate display names. */
function agentTitle(agent) {
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}

const SVG = 'http://www.w3.org/2000/svg';
// Claude's own mark, verbatim from the official extension's resources/claude-logo.svg, at its brand colour.
const CLAUDE_MARK =
  'M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z';

// OpenAI logo from the ChatGPT extension resources/blossom-black.svg, using the row text color.
const OPENAI_MARK =
  'M13.795 23.856q-1.188 0-2.256-.448a6.1 6.1 0 0 1-1.9-1.247 5.8 5.8 0 0 1-1.875.306 5.8 5.8 0 0 1-2.944-.777 6.1 6.1 0 0 1-2.184-2.12q-.807-1.34-.808-2.99 0-.682.19-1.482a6.3 6.3 0 0 1-1.472-2.002 5.76 5.76 0 0 1 .024-4.85q.546-1.177 1.52-2.024a5.5 5.5 0 0 1 2.303-1.2A5.55 5.55 0 0 1 5.485 2.62 6.06 6.06 0 0 1 7.575.925 5.85 5.85 0 0 1 10.21.313q1.187 0 2.255.447a6.1 6.1 0 0 1 1.9 1.248 5.8 5.8 0 0 1 1.875-.306q1.59 0 2.944.776a5.9 5.9 0 0 1 2.16 2.12q.832 1.34.832 2.99 0 .682-.19 1.483a6.2 6.2 0 0 1 1.472 2.024q.522 1.13.522 2.378 0 1.272-.546 2.449a6.1 6.1 0 0 1-1.543 2.048 5.45 5.45 0 0 1-2.28 1.177 5.4 5.4 0 0 1-1.115 2.402 5.8 5.8 0 0 1-2.066 1.695 5.85 5.85 0 0 1-2.635.612M7.93 20.913q1.188 0 2.066-.495l4.463-2.542a.52.52 0 0 0 .238-.448v-2.024L8.95 18.676a.97.97 0 0 1-1.044 0L3.419 16.11a.7.7 0 0 1-.024.165v.282q0 1.201.57 2.213.594.99 1.639 1.554 1.044.59 2.326.589m.238-3.838q.143.07.26.07a.46.46 0 0 0 .238-.07l1.781-1.012-5.722-3.296q-.522-.306-.522-.918v-5.11a4.27 4.27 0 0 0-1.9 1.602 4.13 4.13 0 0 0-.712 2.354q0 1.155.594 2.213.593 1.06 1.543 1.601zm5.627 5.227q1.258 0 2.279-.565a4.25 4.25 0 0 0 1.614-1.554q.594-.99.594-2.213v-5.085q0-.283-.237-.424l-1.805-1.036v6.568q0 .613-.522.919l-4.487 2.566q1.163.825 2.564.824m.902-8.617v-3.202l-2.683-1.507-2.707 1.507v3.202l2.707 1.507zm-6.933-7.51q0-.612.522-.918l4.488-2.567a4.34 4.34 0 0 0-2.564-.824q-1.26 0-2.28.565a4.25 4.25 0 0 0-1.614 1.554q-.57.99-.57 2.213v5.062q0 .283.237.447l1.781 1.036zm12.061 11.253a4.13 4.13 0 0 0 1.876-1.6 4.2 4.2 0 0 0 .712-2.355q0-1.154-.593-2.213-.594-1.06-1.544-1.6l-4.44-2.543q-.142-.095-.26-.071a.46.46 0 0 0-.238.07l-1.78.99 5.745 3.319q.26.141.38.377a.9.9 0 0 1 .142.518zm-4.772-11.96q.522-.33 1.045 0l4.51 2.614v-.424q0-1.13-.57-2.142a4.1 4.1 0 0 0-1.59-1.648q-1.02-.613-2.374-.613-1.187 0-2.066.495L9.545 6.292a.52.52 0 0 0-.238.448v2.025z';

/** Agent logos, with text fallback for unknown agents so every session identifies its agent (R2). */
const AGENT_MARKS = { claude: CLAUDE_MARK, codex: OPENAI_MARK };

// Visual Studio Code logo, the single-color mark at the same 24px box as the agent logos.
const VSCODE_MARK =
  'M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261a1 1 0 0 0-.001 1.479L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z';

/**
 * Where a row's click lands, in the two destinations the board has: a detached run is attached to in a terminal, and
 * every other session is opened in the editor (`docs/mechanics.md` M33). The editor destination is VS Code itself, so
 * it carries the product logo; the terminal stays a drawn glyph.
 */
const DESTINATION_SHAPES = {
  terminal: [
    ['rect', { class: 'plate', x: '1.5', y: '3.5', width: '21', height: '17', rx: '3' }],
    ['polyline', { class: 'ink', points: '6.5 9 9.75 12 6.5 15' }],
    ['line', { class: 'ink', x1: '12.5', y1: '15', x2: '17.5', y2: '15' }],
  ],
  editor: [['path', { class: 'vscode', transform: 'translate(1.6 1.6) scale(0.8667)', d: VSCODE_MARK }]],
};

/**
 * The destination icon replaces the duration on hover. Hide it from screen readers because the row already
 * names the action.
 */
function destinationMark(kind) {
  const held = document.createElement('span');
  held.className = 'destination';
  held.dataset.destination = kind;

  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');

  for (const [name, attributes] of DESTINATION_SHAPES[kind]) {
    const shape = document.createElementNS(SVG, name);

    for (const [attribute, value] of Object.entries(attributes)) {
      shape.setAttribute(attribute, value);
    }

    svg.appendChild(shape);
  }

  held.appendChild(svg);

  return held;
}

function agentMark(agent) {
  const drawn = AGENT_MARKS[agent];

  if (drawn === undefined) {
    const el = document.createElement('span');
    el.className = 'agent';
    el.textContent = agent;

    return el;
  }

  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'agent agent-mark');
  // Preserve agent brand colors; use the row color for monochrome logos.
  svg.setAttribute('data-agent', agent);
  svg.setAttribute('viewBox', '0 0 24 24');
  // Names the agent on a row with no accessible name of its own. A row that has one states the agent itself,
  // because an aria-label there replaces everything inside it.
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', agent);

  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', drawn);
  path.setAttribute('fill-rule', 'nonzero');

  // Use aria-label for the logo; an SVG title would add a duplicate native tooltip.
  svg.appendChild(path);

  return svg;
}

/**
 * What the dot conveys by color and fill, in words: the phase, then whether the session is still running.
 * "live" rather than "open", because a row's own name ends in what a click on it opens.
 */
function dotWords(phase, live) {
  return `${PHASE_WORDS[phase] ?? 'no state reported'}, ${live ? 'live' : 'ended'}`;
}

/**
 * What a row states about its session. A row name replaces everything inside it, so it must state what the
 * row shows: the observed phase, else the word the agent reported, else that there is none (R24).
 */
function rowWords(session) {
  const reported = session.details.state ?? session.details.status;

  return session.activity || typeof reported !== 'string' || reported.length === 0
    ? dotWords(session.activity?.phase, !session.finished)
    : `${reported}, ${session.finished ? 'ended' : 'live'}`;
}

/**
 * The dot color indicates phase and its fill indicates a live session. Its own name states both, which is
 * what an unreachable row reads; a reachable row carries the same words in its own name, because an
 * aria-label there replaces everything inside it (R2).
 */
function sessionDot(phase, live, title = dotTitle(phase, live)) {
  const el = document.createElement('span');

  el.className = 'dot';
  el.dataset.phase = phase ?? 'none';
  el.dataset.live = String(live);
  el.setAttribute('role', 'img');
  // Expose the state through both an accessible name and a tooltip.
  setAccessibleName(el, dotWords(phase, live));
  setTooltip(el, title);

  return el;
}

/**
 * Make the entire session row clickable when an open operation is available. Leave other rows noninteractive
 * and available for card dragging.
 */
function sessionLine(session) {
  // Attach in a terminal without requiring an agent editor extension. Opening a tab would resume a second
  // process, which exits 1.
  const attachId = typeof session.attachId === 'string' ? session.attachId : null;
  const reachable = attachId !== null || openable.has(session.sessionId);
  const el = document.createElement(reachable ? 'button' : 'span');

  el.className = 'session';
  el.dataset.sessionId = session.sessionId;

  const agent = agentMark(session.agent);
  const name = sessionLabel(session);
  const label = document.createElement('span');

  label.className = 'session-label';
  label.textContent = name;

  // The row states the agent and the dot's words because a name inside it would never be read: an
  // aria-label here replaces the row's contents (R2).
  const named = `${name}, ${agentTitle(session.agent)}, ${rowWords(session)}`;

  // Keep activity details on the state tooltip; the row label already identifies the session.
  if (reachable) {
    el.type = 'button';
    setAccessibleName(el, attachId === null ? `${named} - open this session` : `${named} - attach to this run in a terminal`);
    // Prevent session clicks from starting a card drag.
    el.draggable = false;
    el.addEventListener('click', () =>
      vscode.postMessage(
        attachId === null
          ? { type: 'openSession', sessionId: session.sessionId }
          : { type: 'attachSession', sessionId: session.sessionId },
      ),
    );
  }

  el.append(sessionDot(session.activity?.phase, !session.finished, failureTitle(session.activity, !session.finished)), agent, label);

  // Italic names identify board-dispatched runs.
  if (attachId !== null) {
    el.dataset.detached = 'true';
  }

  const activity = session.activity;

  if (activity) {
    el.dataset.phase = activity.phase;
  }

  const state = document.createElement('span');
  const activityDescription = activity ? stateTitle(activity) : null;

  state.className = 'state';

  // Prefer the board observation, then the adapter state, so the label and animation agree (R24).
  if (activity) {
    age(state, activity.since);
    setTooltip(state, activityDescription);
    el.appendChild(state);
  } else {
    const reported = session.details.state ?? session.details.status;

    if (reported) {
      state.textContent = reported;
      el.appendChild(state);
    }
  }

  // Copy the duration tooltip to the destination icon that replaces it on hover.
  if (reachable) {
    const destination = destinationMark(attachId === null ? 'editor' : 'terminal');
    const destinationDescription = attachId === null ? 'Opens this session in the editor.' : 'Attaches to this run in a terminal.';

    setTooltip(destination, activityDescription === null ? destinationDescription : `${destinationDescription} ${activityDescription}`);
    el.appendChild(destination);
  }

  return el;
}

/**
 * The dot tooltip for a failed turn: the error kind and the agent's own text. Undefined for every other phase,
 * so the dot falls back to its phase description.
 */
function failureTitle(activity, live) {
  if (!activity || activity.phase !== 'failed') return undefined;

  const kind = activity.error && typeof activity.error.kind === 'string' ? activity.error.kind : 'unknown';
  const message = activity.error && typeof activity.error.message === 'string' ? ` ${activity.error.message}` : '';

  const described = `The turn ended on an error: ${kind.replace(/_/g, ' ')}.${message}`;

  return live ? described : `${described} The session has since ended.`;
}

/**
 * Render retained activity with its timestamp and explanation. Map running to idle because the process ended.
 * `retainedPhase` in packages/board/src/lanes.ts determines card attention from the same observation.
 */
function retainedMark(retained) {
  if (!retained || typeof retained.at !== 'number' || typeof retained.event !== 'string') return undefined;

  const eventDescription = `Last event: ${retained.event}.`;

  if (retained.phase === 'waiting') {
    return { phase: 'waiting', at: retained.at, title: `The session ended while waiting for your input. ${eventDescription}` };
  }

  if (retained.phase === 'failed') {
    return { phase: 'failed', at: retained.at, title: `${failureTitle(retained, false)} ${eventDescription}` };
  }

  if (retained.phase === 'running') {
    return { phase: 'idle', at: retained.at, title: `The session ended before completing its turn. ${eventDescription}` };
  }

  if (retained.phase === 'idle') {
    return { phase: 'idle', at: retained.at, title: `The session completed its turn, then ended. ${eventDescription}` };
  }

  return undefined;
}

function historyLine(session) {
  // Cached snapshots can outlive the hub version that produced them.
  if (!session || typeof session.agent !== 'string' || typeof session.cwd !== 'string' ||
      !(session.title === null || typeof session.title === 'string') ||
      !Number.isFinite(session.updatedAt) || !Number.isFinite(new Date(session.updatedAt).getTime())) return null;
  const reachable = openable.has(session.sessionId);
  const el = document.createElement(reachable ? 'button' : 'span');
  el.className = 'session historical';
  const label = document.createElement('span');
  label.className = 'session-label';
  label.textContent = session.title ?? basename(session.cwd);
  if (reachable) {
    el.type = 'button';
    el.draggable = false;
    el.addEventListener('click', () => vscode.postMessage({ type: 'openSession', sessionId: session.sessionId }));
  }
  const mark = retainedMark(session.retained);
  const state = document.createElement('span');
  state.className = 'state';
  // Use retained activity time when available; otherwise use the last transcript timestamp.
  age(state, mark ? mark.at : session.updatedAt);
  // Put the exact timestamp on the duration tooltip, using the same time as the displayed age.
  setTooltip(state, `${reachable ? 'Resume this session in VS Code.' : 'Historical session.'} ${mark ? `Last seen ${new Date(mark.at).toLocaleString()}` : `Last saved ${new Date(session.updatedAt).toLocaleString()}`}.`);

  if (reachable) {
    setAccessibleName(
      el,
      `${label.textContent}, ${agentTitle(session.agent)}, ${dotWords(mark?.phase, false)} - resume this session`,
    );
  }

  // Apply the retained phase to the row and dot; retainedMark maps running to idle after process exit.
  if (mark) el.dataset.phase = mark.phase;

  el.append(
    sessionDot(mark?.phase, false, mark ? mark.title : 'Last session on this card. No active sessions.'),
    agentMark(session.agent),
    label,
    state,
  );

  // Saved sessions must resume in the editor; there is no process to attach to.
  if (reachable) {
    const destination = destinationMark('editor');

    setTooltip(destination, `Resumes this session in the editor. ${mark ? mark.title : ''}`.trim());
    el.appendChild(destination);
  }
  return el;
}

const PHASE_WORDS = { running: 'running', waiting: 'waiting for input', idle: 'idle', failed: 'failed' };

const PHASE_TITLES = {
  running: 'Turn in progress.',
  waiting: 'Waiting for your input.',
  idle: 'Last reported state: turn complete.',
  failed: 'The turn ended on an error.',
};

/** Accessible phase and liveness description. */
function dotTitle(phase, live) {
  const phaseDescription = PHASE_TITLES[phase] ?? 'No activity reported.';

  return live ? phaseDescription : `${phaseDescription} The session has since ended.`;
}

/** Explain the duration; the dot tooltip describes phase separately. */
const DURATION_TITLES = {
  running: 'Time in this turn, from its prompt when recorded.',
};

const DURATION_TITLE = 'Time since the phase was reported.';

/** Use the largest elapsed-time unit and round down to avoid overstating age. */
function ago(ms) {
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

/** Describe the duration and last hook event. */
function stateTitle(activity) {
  const durationDescription = DURATION_TITLES[activity.phase] ?? DURATION_TITLE;

  return activity.event ? `${durationDescription} Last event: ${activity.event}.` : durationDescription;
}

/**
 * Store the timestamp for each displayed duration so one timer updates all ages. Both clients use the same
 * attribute.
 */
const AGE_ATTR = 'data-gc-since';

/** @param {Element} el @param {number} at */
function age(el, at) {
  el.setAttribute(AGE_ATTR, String(at));
  setAge(el, ago(Date.now() - at));
}

/**
 * Update nodeValue in place. Replacing textContent would trigger childList observers and rebuild rows; neither
 * client observes characterData.
 *
 * @param {Element} el
 * @param {string} text
 */
function setAge(el, text) {
  const node = el.firstChild;

  if (node === null || node.nodeType !== Node.TEXT_NODE) {
    el.textContent = text;

    return;
  }

  if (node.nodeValue !== text) {
    node.nodeValue = text;
  }
}

/** Update duration text without rebuilding elements, preserving scroll position and keyboard focus. */
function tickDurations() {
  for (const el of document.querySelectorAll(`[${AGE_ATTR}]`)) {
    const at = Number(el.getAttribute(AGE_ATTR));

    if (Number.isFinite(at)) {
      setAge(el, ago(Date.now() - at));
    }
  }
}

/**
 * Update timestamps and hook details on retained elements. They are excluded from the signature to prevent
 * rebuilds during steady activity (R24).
 */
function syncActivity(el, boardCard) {
  const by = new Map(boardCard.sessions.map((session) => [session.sessionId, session.activity]));

  for (const row of el.querySelectorAll('.session')) {
    const activity = by.get(row.dataset.sessionId);
    const state = activity ? row.querySelector('.state') : null;

    if (state) {
      age(state, activity.since);
      // Update the tooltip event with the timestamp so both describe the current observation (R24).
      setTooltip(state, stateTitle(activity));
    }
  }
}

/** The status without the emoji the project board prefixes it with, and without the variation selector after it. */
function statusLabel(status) {
  return status.replace(/^[\p{Extended_Pictographic}\uFE0F\s]+/u, '');
}

/**
 * Copy TRIAGE_LABELS from packages/board because this script cannot import workspace packages. Both client
 * suites verify parity (docs/testing.md).
 */
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
 * One stroke-only pictogram per lane, drawn in a 16px box. The Chrome overlay carries the same table; both
 * client suites verify parity (docs/testing.md).
 */
const LANE_SHAPES = {
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

/** The lane's pictogram, in the lane color. The heading keeps its name, so this reinforces rather than replaces. */
function laneMark(lane) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'lane-mark');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.dataset.lane = lane;

  for (const [name, attributes] of LANE_SHAPES[lane] ?? []) {
    const shape = document.createElementNS(SVG, name);

    for (const [attribute, value] of Object.entries(attributes)) {
      shape.setAttribute(attribute, value);
    }

    svg.appendChild(shape);
  }

  return svg;
}

/** Map GitHub color names to theme chart colors for legibility in light and dark themes. */
const BADGE_COLORS = {
  RED: 'red',
  ORANGE: 'orange',
  YELLOW: 'yellow',
  GREEN: 'green',
  BLUE: 'blue',
  PURPLE: 'purple',
  PINK: 'purple',
  GRAY: 'foreground',
};

/** A pull request's own state colours, matching what GitHub paints them. */
const PR_COLORS = { OPEN: 'GREEN', MERGED: 'PURPLE', CLOSED: 'RED' };

/** `landed` is a session-reported push, not independently verified completion (R39). */
const ACTION_OUTCOMES = {
  landed: 'Merged',
  halted: 'Stopped short',
  failed: 'Did not run',
  stopped: 'Stopped',
};

/**
 * What to do with this card, as one line of text: the triage action, then either the dispatched action's state
 * or the triage qualifier (R38, R39). The full explanation stays in the tooltip.
 */
function verdict(boardCard) {
  const held = document.createElement('span');
  const triage = boardCard.triage;

  held.className = 'verdict';

  if (!triage) {
    held.textContent = 'Not read';
    setTooltip(held, 'This card has not been read.');
  } else if (triage.state === 'failed') {
    held.textContent = 'Not read';
    setTooltip(
      held,
      triage.exhausted ? `Triage failed after ${triage.attempts} attempts. Automatic retries stopped.` : 'Triage failed.',
    );
  } else if (triage.state === 'running') {
    held.dataset.state = 'triaging';
    held.appendChild(note('Reading…'));
    setTooltip(held, 'Identifying the next action.');
  } else {
    held.textContent = TRIAGE_LABELS[triage.action] ?? triage.action;
    held.dataset.stale = String(triage.stale);
    setTooltip(
      held,
      `${triage.detail} ${
        triage.stale
          ? `Read ${ago(Date.now() - triage.at)} ago; card details have changed.`
          : `Read ${ago(Date.now() - triage.at)} ago.`
      }`,
    );
  }

  // A dispatched run is the newer fact about the same work, so it takes the qualifier's place until it clears.
  const state = actionState(boardCard.action);

  if (state) {
    held.dataset.outcome = state.outcome;
    held.append(' · ');
    held.appendChild(note(state.text));
  } else if (triage?.state === 'done' && triage.qualifier) {
    held.append(' · ');
    held.appendChild(note(triage.qualifier));
  }

  return held;
}

/** A card with no issue has nothing to read, so the verdict names the branch its sessions are working on. */
function branchVerdict(boardCard) {
  const held = document.createElement('span');

  held.className = 'verdict';
  held.textContent = cardTitle(boardCard);

  return held;
}

/** The muted half of the verdict: the qualifier, or the dispatched state that displaces it. */
function note(text) {
  const held = document.createElement('span');

  held.className = 'note';
  held.textContent = text;

  return held;
}

/**
 * The word a dispatched action puts in the verdict, and the color it takes. An action waiting to be run states
 * nothing: its control is the whole message.
 */
function actionState(action) {
  if (!action || action.state === 'available') {
    return null;
  }

  if (action.state === 'running') {
    return { text: 'Working…', outcome: 'running' };
  }

  if (action.state === 'refused') {
    return { text: 'Not run', outcome: 'refused' };
  }

  return { text: ACTION_OUTCOMES[action.outcome] ?? ACTION_OUTCOMES.failed, outcome: action.outcome };
}

/**
 * The bar's right edge, painted twice in one slot: the status age at rest, the controls while the bar is
 * pointed at or focused. Both are flush right, so the controls take no width from the verdict and the run
 * control lands on the age's edge, above the session duration (R45).
 */
function tail(boardCard, canRequest) {
  const held = document.createElement('span');

  held.className = 'tail';

  // Status age is null outside project boards because GitHub records no move timestamp.
  const moved = boardCard.issue?.statusChangedAt ? Date.parse(boardCard.issue.statusChangedAt) : NaN;

  if (Number.isFinite(moved)) {
    const ageLabel = document.createElement('span');

    ageLabel.className = 'card-age';
    age(ageLabel, moved);
    held.appendChild(ageLabel);
  }

  const tools = document.createElement('span');

  tools.className = 'tools';

  if (canRequest) {
    // Hovering to reach this control is what hides the age, so a card already read has the control state it (R45).
    const read = boardCard.triage?.state === 'done';
    const name = read ? 'Read this card again' : 'Read this card';
    const detail = read
      ? `Read this card again. Last read ${ago(Date.now() - boardCard.triage.at)} ago. Uses model usage.`
      : 'Identify the next action. Uses model usage.';

    tools.appendChild(toolButton(name, detail, syncMark(), () => vscode.postMessage({ type: 'retriage', key: boardCard.key })));
  }

  if (hasCheckout(boardCard)) {
    tools.appendChild(
      toolButton('Open in VS Code', `Open ${boardCard.checkout.root} in VS Code`, vscodeMark(), () =>
        vscode.postMessage({ type: 'openCheckout', key: boardCard.key }),
      ),
    );
  }

  const run = runButton(boardCard);

  if (run) {
    tools.appendChild(run);
  }

  held.appendChild(tools);

  return held;
}

/**
 * The card's own action, as one control (R39). Running stops it, because an interrupted merge leaves changes
 * to resolve; a refusal states its condition and takes no press.
 */
function runButton(boardCard) {
  const action = boardCard.action;

  if (!action) {
    return null;
  }

  const label = TRIAGE_LABELS[action.action] ?? action.action;

  if (action.state === 'running') {
    const stop = toolButton(
      `Stop ${label.toLowerCase()}`,
      `${label} is running. Click to stop. Changes remain in the checkout and may be incomplete.`,
      stopMark(),
      () => vscode.postMessage({ type: 'stopAction', key: boardCard.key }),
    );

    stop.classList.add('run');
    stop.dataset.state = 'running';

    return stop;
  }

  if (action.state === 'refused') {
    const refused = toolButton(`Cannot run ${label.toLowerCase()}`, action.reason, playMark(), null);

    refused.classList.add('run');
    refused.setAttribute('aria-disabled', 'true');

    return refused;
  }

  const title =
    action.state === 'done' ? `${action.detail} Click to run ${label} again.` : `Start ${label} in this card’s checkout.`;
  const run = toolButton(`Run ${label.toLowerCase()}`, title, playMark(), () =>
    vscode.postMessage({ type: 'runAction', key: boardCard.key }),
  );

  run.classList.add('run');

  if (action.state === 'done') {
    run.dataset.outcome = action.outcome;
  }

  return run;
}

/**
 * A control rather than a label: pressing it spends the developer's model allowance or dispatches an agent.
 * A control that only states a condition takes no press, so `onPress` is null there.
 */
function toolButton(name, title, mark, onPress) {
  const button = document.createElement('button');

  button.type = 'button';
  button.className = 'tool';
  button.draggable = false;
  button.appendChild(mark);
  setAccessibleName(button, name);
  setTooltip(button, title);
  // A glyph says none of this, and the name replaces what is inside the button rather than adding to it, so
  // the sentence the tooltip carries is set past `setAccessibleName` as the description.
  button.setAttribute('aria-description', title);

  if (onPress === null) {
    return button;
  }

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onPress();
  });

  return button;
}

/** The product mark, because the control opens VS Code itself rather than code in general (R45). */
function vscodeMark() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'vscode-mark');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('class', 'vscode');
  path.setAttribute('d', VSCODE_MARK);
  svg.appendChild(path);

  return svg;
}

function playMark() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'run-mark');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', 'M4.25 2.3a.75.75 0 0 1 1.14-.64l8.1 5.7a.75.75 0 0 1 0 1.28l-8.1 5.7a.75.75 0 0 1-1.14-.64Z');
  svg.appendChild(path);

  return svg;
}

function stopMark() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'run-mark');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');

  const rect = document.createElementNS(SVG, 'rect');
  rect.setAttribute('fill', 'currentColor');
  rect.setAttribute('x', '3.5');
  rect.setAttribute('y', '3.5');
  rect.setAttribute('width', '9');
  rect.setAttribute('height', '9');
  rect.setAttribute('rx', '1.5');
  svg.appendChild(rect);

  return svg;
}

function badge(kind, text, color, title, onOpen) {
  const el = document.createElement(onOpen ? 'button' : 'span');
  el.className = onOpen ? `badge ${kind} link` : `badge ${kind}`;
  el.style.setProperty('--gc-badge', `var(--vscode-charts-${BADGE_COLORS[color] ?? 'foreground'})`);
  el.append(text);

  if (onOpen) {
    el.type = 'button';
    el.draggable = false;
    el.addEventListener('click', onOpen);
  }

  if (title) {
    setTooltip(el, title);
  }

  return el;
}

/** Offer available card actions; omit the menu when none can run. */
function cardActions(boardCard) {
  const actions = [];

  if (hasCheckout(boardCard)) {
    actions.push({
      label: 'View changes',
      hint: "Open this card's commits and uncommitted changes in one editor",
      run: () => vscode.postMessage({ type: 'openChanges', key: boardCard.key }),
    });

    // Offer one start action per available agent. Archived cards are read-only (R9), which is wider than
    // unassigned: a closed issue is archived while still assigned.
    for (const { agent, takesPrompt } of boardCard.unassigned === true || boardCard.lane === 'archived' ? [] : startable) {
      actions.push({
        label: `Start ${agentTitle(agent)} session`,
        hint: takesPrompt
          ? `Open a new ${agentTitle(agent)} session in ${boardCard.checkout.root}, prefilled and unsent`
          : `Open a new ${agentTitle(agent)} session in ${boardCard.checkout.root}. ${agentTitle(agent)} offers no way in that takes a prompt, so it starts empty`,
        run: () => vscode.postMessage({ type: 'startSession', key: boardCard.key, agent }),
      });
    }
  }

  // Offer checkout selection only for issues without a session-derived checkout, which takes precedence over
  // manual selection.
  const picked = boardCard.checkout == null || boardCard.checkout.source === 'remembered';

  if (boardCard.issue != null && picked) {
    actions.push({
      label: hasCheckout(boardCard) ? 'Change folder…' : 'Choose folder…',
      hint: 'Choose a checkout for this issue',
      run: () => vscode.postMessage({ type: 'chooseCheckout', key: boardCard.key }),
    });
  }

  return actions;
}

/** The card whose overflow menu is open: the menu itself, the control it hangs from, and how to stop watching for a close. */
let openMenu = null;

const MENU_MARGIN = 8;

/**
 * Measure the menu after insertion. Align right edges, flip above if needed, and reposition after card
 * redraws.
 */
function place(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  const menuBounds = menu.getBoundingClientRect();
  const below = rect.bottom + 4;
  const overflows = below + menuBounds.height > window.innerHeight - MENU_MARGIN;

  menu.style.top = `${overflows ? Math.max(MENU_MARGIN, rect.top - 4 - menuBounds.height) : below}px`;
  menu.style.left = `${Math.max(MENU_MARGIN, Math.min(rect.right - menuBounds.width, window.innerWidth - menuBounds.width - MENU_MARGIN))}px`;
}

/** Takes the open menu off the document. The focus goes back to the control whenever the keyboard is what closed it. */
function closeMenu(refocus) {
  if (openMenu === null) {
    return;
  }

  const { menu, anchor, unwatch } = openMenu;

  openMenu = null;
  unwatch();
  menu.remove();
  anchor.setAttribute('aria-expanded', 'false');
  anchor.removeAttribute('aria-controls');

  if (refocus && anchor.isConnected) {
    anchor.focus();
  }
}

/**
 * Install outside-close handlers while a menu is open. Read openMenu each time because redraws can replace its
 * anchor.
 */
function watchMenu() {
  const away = (event) => {
    if (openMenu && !openMenu.menu.contains(event.target) && !openMenu.anchor.contains(event.target)) {
      closeMenu(false);
    }
  };

  const escape = (event) => {
    if (event.key === 'Escape' && openMenu) {
      event.preventDefault();
      closeMenu(true);
    }
  };

  // The menu is fixed to the viewport and the lanes scroll under it, so a scroll would leave it over another card.
  const moved = () => closeMenu(false);

  document.addEventListener('click', away, true);
  document.addEventListener('keydown', escape, true);
  document.addEventListener('scroll', moved, true);
  window.addEventListener('resize', moved);

  return () => {
    document.removeEventListener('click', away, true);
    document.removeEventListener('keydown', escape, true);
    document.removeEventListener('scroll', moved, true);
    window.removeEventListener('resize', moved);
  };
}

/** Menus come and go, so each is named afresh: `aria-controls` has to point at the one on the document right now. */
let menuSeq = 0;

function showMenu(key, name, actions, anchor, from = 'first') {
  const menu = document.createElement('div');
  menu.className = 'card-popover';
  menu.id = `card-menu-${++menuSeq}`;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', name);

  for (const action of actions) {
    const item = document.createElement('button');
    item.type = 'button';
    // Use checkbox semantics for toggle actions.
    item.setAttribute('role', action.checked === undefined ? 'menuitem' : 'menuitemcheckbox');

    if (action.checked !== undefined) {
      item.setAttribute('aria-checked', String(action.checked));
    }

    const check = document.createElement('span');

    // Reserve checkmark space on every item to align labels.
    check.className = 'menu-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = action.checked ? '✓' : '';
    item.appendChild(check);
    item.append(action.label);
    // Describe the action in the tooltip without repeating the label.
    setTooltip(item, action.hint);
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      // Restore focus to the menu control even if the host refuses the action.
      closeMenu(true);
      action.run();
    });
    menu.appendChild(item);
  }

  menu.addEventListener('keydown', (event) => {
    const items = Array.from(menu.querySelectorAll('button'));

    // Restore control focus before the default Tab action so navigation follows the card, not the appended
    // menu.
    if (event.key === 'Tab') {
      closeMenu(true);

      return;
    }

    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      items[event.key === 'Home' ? 0 : items.length - 1]?.focus();

      return;
    }

    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }

    event.preventDefault();

    const at = items.indexOf(document.activeElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;

    (at === -1 ? items[step === 1 ? 0 : items.length - 1] : items[(at + step + items.length) % items.length])?.focus();
  });

  document.body.appendChild(menu);
  place(menu, anchor);
  anchor.setAttribute('aria-expanded', 'true');
  anchor.setAttribute('aria-controls', menu.id);

  const items = menu.querySelectorAll('button');

  // Focus before watching scroll events: focusing an offscreen item can scroll the document and prematurely
  // close the menu.
  items[from === 'last' ? items.length - 1 : 0]?.focus();

  openMenu = { key, menu, anchor, unwatch: watchMenu() };
}

/** GitHub's own overflow glyph, so the control reads as a menu rather than as one more of the chips beside it. */
function menuMark() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'menu-mark');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS(SVG, 'path');
  path.setAttribute(
    'd',
    'M8 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM1.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm13 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
  );

  svg.appendChild(path);

  return svg;
}

/**
 * Toggle on repeated click; open and focus an item on arrow keys. Read actions when opening so toggle states
 * are current.
 */
function wireMenuControl(el, key, name, actions) {
  el.setAttribute('aria-haspopup', 'menu');
  el.setAttribute('aria-expanded', 'false');
  el.appendChild(menuMark());
  el.addEventListener('click', (event) => {
    event.stopPropagation();

    const reopening = openMenu?.key === key;

    closeMenu(false);

    if (!reopening) {
      showMenu(key, name, actions(), el);
    }
  });

  el.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }

    event.preventDefault();
    closeMenu(false);
    showMenu(key, name, actions(), el, event.key === 'ArrowUp' ? 'last' : 'first');
  });
}

function cardMenuControl(boardCard) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'card-menu';
  // Name the control for accessibility and describe the icon action on hover.
  setTooltip(el, 'More actions');
  setAccessibleName(el, `More actions for ${cardName(boardCard)}`);
  // Disable dragging on this control.
  el.draggable = false;
  wireMenuControl(el, boardCard.key, `Actions for ${cardName(boardCard)}`, () => cardActions(boardCard));

  return el;
}

/**
 * Name ad-hoc cards by repository and branch. All sessions share one checkout; fall back to directory names
 * when Git metadata is absent.
 */
function checkoutName(boardCard) {
  const session = boardCard.sessions[0];
  if (!session) {
    return { repository: '', owner: '', branch: null, directory: 'Ground Control action' };
  }
  const dir = basename(session.checkoutRoot ?? session.cwd);
  const parts = session.repository === null ? [] : session.repository.split('/');

  return {
    repository: parts[parts.length - 1] ?? dir,
    // Omit the host from display names while retaining the repository owner to distinguish same-named
    // repositories.
    owner: parts.length === 0 ? dir : parts.slice(1).join('/'),
    branch: session.branch,
    directory: dir,
  };
}

/** Name issue controls by title and checkout controls by repository plus branch, since branch names can repeat. */
function cardName(boardCard) {
  if (boardCard.issue) {
    return cardTitle(boardCard);
  }

  const checkout = checkoutName(boardCard);

  return checkout.branch === null ? checkout.directory : `${checkout.repository} ${checkout.branch}`;
}

/** Re-anchor the open menu after a card rebuild; close it when its card leaves the board. */
function followMenu() {
  if (openMenu === null) {
    return;
  }

  if (!openMenu.anchor.isConnected) {
    const anchor = cardEls.get(openMenu.key)?.el.querySelector('.card-menu');

    // Check DOM connection, not the card cache: archived cards can be cached offscreen and return zero-sized
    // bounds.
    if (!anchor?.isConnected) {
      closeMenu(false);

      return;
    }

    openMenu.anchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    anchor.setAttribute('aria-controls', openMenu.menu.id);
  }

  place(openMenu.menu, openMenu.anchor);
}

function cardTitle(boardCard) {
  if (boardCard.issue) {
    return boardCard.issue.title;
  }

  // A card with no issue is a checkout, not one session, so it is named for the branch its sessions are working on.
  const checkout = checkoutName(boardCard);

  return checkout.branch ?? checkout.directory;
}

/**
 * Display repository name without owner, matching GitHub. Older cached snapshots may omit it; fall back to
 * issue number.
 */
function repoName(issue) {
  const full = issue.repository;

  if (typeof full !== 'string' || full === '') {
    return null;
  }

  const parts = full.split('/');

  return parts[parts.length - 1] ?? null;
}

/** GitHub's own pull-request glyph, so the badge reads as a PR rather than a second issue number. */
/** Octicon `sync`, on the control that reads a card again. */
function syncMark() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'sync-mark');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS(SVG, 'path');
  path.setAttribute(
    'd',
    'M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .655-.835ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z',
  );

  svg.appendChild(path);

  return svg;
}

function pullRequestMark() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'pr-mark');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS(SVG, 'path');
  path.setAttribute(
    'd',
    'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z',
  );

  svg.appendChild(path);

  return svg;
}

/** Role words for the hub's avatar selection; the overlay carries the same table. */
const AVATAR_ROLES = { 'pull-request': 'pull request author', 'issue-author': 'issue author', issue: 'issue assignee' };

function avatar(actor, pool) {
  const available = pool.get(actor.url);
  const reused = available?.shift();
  const el = reused ?? document.createElement('span');

  if (!reused) {
    el.className = 'avatar';
    el.textContent = actor.login.slice(0, 2).toUpperCase();

    const image = document.createElement('img');
    image.src = actor.url;
    image.alt = '';
    image.addEventListener('error', () => {
      image.remove();
      el.classList.remove('has-image');
    });
    image.addEventListener('load', () => el.classList.add('has-image'));
    el.appendChild(image);
  }

  const role = AVATAR_ROLES[actor.source] ?? 'issue assignee';

  setTooltip(el, `${actor.login} · ${role}`);
  el.setAttribute('role', 'img');
  setAccessibleName(el, `${actor.login}, ${role}`);

  return el;
}

function card(boardCard, avatarPool, placeable) {
  const el = document.createElement('article');
  const issue = boardCard.issue;
  el.className = 'card';

  const meta = document.createElement('span');
  meta.className = 'card-meta';

  const number = document.createElement(issue ? 'button' : 'span');
  number.className = issue ? 'number link' : 'number';

  if (boardCard.issueNumber === null) {
    const checkout = checkoutName(boardCard);

    // Display repository in the issue-number position. For a directory with no branch, show the session
    // count; the title already names the directory.
    if (checkout.branch === null) {
      number.textContent = boardCard.sessions.length === 1 ? 'session' : 'sessions';
    } else {
      number.className = 'number checkout';
      number.textContent = checkout.repository;
      setTooltip(number, checkout.owner);
    }
  } else {
    // Display repository beside issue number, matching GitHub and distinguishing cards across repositories.
    const repo = repoName(issue);

    number.textContent = repo === null ? `#${boardCard.issueNumber}` : `${repo} #${boardCard.issueNumber}`;
  }

  if (issue) {
    const repo = repoName(issue);
    const issueLabel = repo === null ? `issue #${issue.number}` : `issue ${repo} #${issue.number}`;

    number.type = 'button';
    // The visible label identifies the issue; the accessible name adds the open action.
    setAccessibleName(number, reading ? `Read ${issueLabel}` : `Open ${issueLabel} on GitHub`);
    // Disable dragging on this control.
    number.draggable = false;
    number.addEventListener('click', (event) => openIssueFrom(event, boardCard, number));
  }

  const avatarSlot = document.createElement('span');
  avatarSlot.className = 'avatar-slot';

  if (issue?.avatar) {
    avatarSlot.appendChild(avatar(issue.avatar, avatarPool));
  }

  // Group issue type, project status, and PR under the title.
  const badges = document.createElement('span');
  badges.className = 'badges github';
  badges.setAttribute('role', 'group');
  badges.setAttribute('aria-label', 'Labels');

  meta.appendChild(number);

  const actions = cardActions(boardCard);

  if (actions.length > 0) {
    meta.appendChild(cardMenuControl(boardCard));
  }

  meta.appendChild(avatarSlot);

  el.appendChild(meta);

  // A card with no issue has no conversation to open; its branch name titles it from the command bar instead (R45).
  if (issue) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'card-open';

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = issue.title;

    open.appendChild(title);
    open.addEventListener('click', (event) => openIssueFrom(event, boardCard, open));
    el.appendChild(open);
  }

  el.appendChild(badges);

  // Render a footer on every card for consistent layout, including cards with no sessions or triage yet.
  const foot = document.createElement('div');
  foot.className = 'card-foot';
  el.appendChild(foot);

  // Avoid repeating badge labels on hover; expose PR state in the accessible name.
  if (issue?.pullRequest) {
    const pr = badge(
      'pull-request',
      `#${issue.pullRequest.number}`,
      PR_COLORS[issue.pullRequest.state] ?? null,
      null,
      (event) => openPullRequestFrom(event, boardCard, pr),
    );
    setAccessibleName(
      pr,
      reading
        ? `Read pull request #${issue.pullRequest.number}, ${issue.pullRequest.state.toLowerCase()}`
        : `Open pull request #${issue.pullRequest.number}, ${issue.pullRequest.state.toLowerCase()}, on GitHub`,
    );
    pr.prepend(pullRequestMark());
    badges.appendChild(pr);
  }

  if (issue?.type) {
    badges.appendChild(badge('type', issue.type, issue.typeColor, null));
  }

  if (issue?.status) {
    // Remove the project status emoji; the badge already marks status.
    badges.appendChild(badge('status', statusLabel(issue.status), issue.statusColor, null));
  }

  // Attention changes the card border/tint and matching session state mark. Session text keeps its normal color
  // and weight. The mark's accessible name identifies the state without relying on color (R6).
  if (boardCard.attention) {
    el.dataset.attention = boardCard.attention;
  }

  if (boardCard.returned) {
    const mark = badge('returned', 'Returned', 'ORANGE');
    setTooltip(mark, 'This card returned to you.');
    badges.appendChild(mark);
  }

  // Keep triage separate from attention styling (R38). One line states what to do; the controls that act on it
  // take the age's place at the right edge while the bar is pointed at (R45).
  const canRequest =
    board.triage?.canRequest === true &&
    issue &&
    boardCard.issueNumber !== null &&
    boardCard.lane !== 'archived' &&
    boardCard.unassigned !== true;

  // Give the Ground Control footer's first line its own accessible group name.
  const cmdbar = document.createElement('div');

  cmdbar.className = 'cmdbar';
  cmdbar.setAttribute('role', 'group');
  cmdbar.setAttribute('aria-label', 'Board status');
  cmdbar.appendChild(issue ? verdict(boardCard) : branchVerdict(boardCard));
  cmdbar.appendChild(tail(boardCard, canRequest === true));
  foot.appendChild(cmdbar);

  // Session rows live in their own block, so the footer drops the tint where there is nothing to show.
  const rows = document.createElement('div');

  rows.className = 'card-sessions';
  foot.appendChild(rows);

  for (const session of boardCard.sessions) {
    rows.appendChild(sessionLine(session));
  }
  if (!boardCard.sessions.some((session) => !session.finished)) {
    const historical = historyLine(boardCard.lastSession);
    if (historical) rows.appendChild(historical);
  }

  // The lane is the developer's own placement, so a card carries its own way to move. Alt+arrow is the same move from
  // a keyboard, which drag alone does not give.
  if (boardCard.lane !== 'archived') {
    const at = placeable.indexOf(boardCard.lane);

    el.draggable = true;
    el.addEventListener('dragstart', (event) => {
      // A drag emits no click, so nothing else would take the menu off a card about to move to another lane.
      closeMenu(false);
      dragging = boardCard.key;
      el.classList.add('dragging');
      lanesEl.classList.add('dragging');
      event.dataTransfer?.setData('text/plain', boardCard.key);
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      endDrag();
    });

    // With no title control to land on, the card itself takes the focus so Alt+arrow still reaches it.
    if (!issue) {
      el.tabIndex = 0;
    }

    el.addEventListener('keydown', (event) => {
      if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) {
        return;
      }

      const target = placeable[at + (event.key === 'ArrowRight' ? 1 : -1)];

      if (target) {
        event.preventDefault();
        move(boardCard.key, target);
      }
    });
  }

  return el;
}

/** The keys the current board is showing. A drop carrying anything else is not a card and is ignored. */
const onBoard = new Set();
/** Lane chrome and card elements, kept across renders so a refresh does not scroll every lane back to the top. */
const laneShells = new Map();
const cardEls = new Map();

const emptyEl = document.createElement('p');
emptyEl.className = 'empty';

/** One lane's chrome, built once and reused. Rebuilding it would take the lane's scroll position with it. */
function laneShell(lane) {
  const el = document.createElement('section');
  el.className = `lane lane-${lane.id}`;

  if (lane.id !== 'archived') {
    el.addEventListener('dragover', (event) => {
      event.preventDefault();
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', (event) => {
      event.preventDefault();
      el.classList.remove('drop-target');

      // Anything at all can be dropped on a column - a text selection, a file. Only a card the board is showing moves.
      const key = event.dataTransfer?.getData('text/plain') || dragging;

      if (onBoard.has(key)) {
        move(key, lane.id);
      }
    });
  }

  const header = document.createElement('h2');

  const name = document.createElement('span');
  name.className = 'lane-name';
  name.textContent = lane.title;

  // R10 - how full the lane is, at a glance. No limit is enforced.
  const count = document.createElement('span');
  count.className = 'badge lane-count';

  header.append(laneMark(lane.id), name, count);

  const list = document.createElement('div');
  list.className = 'lane-cards';

  const empty = document.createElement('p');
  empty.className = 'lane-empty';
  empty.textContent = 'Nothing here';

  el.append(header, list);

  const shell = { el, count, list, empty };
  laneShells.set(lane.id, shell);

  return shell;
}

/**
 * Everything a card draws. Two renders with the same signature draw the same card, so the element is left alone —
 * which is what keeps its lane scrolled where it was, its avatar loaded, and the keyboard focus on it.
 */
function signature(boardCard) {
  return JSON.stringify([
    boardCard.lane,
    boardCard.returned,
    boardCard.attention,
    boardCard.triage,
    board.triage?.canRequest,
    boardCard.action,
    boardCard.issue,
    // Everything the menu branches on. A folder just picked changes only the source, a worktree deleted under a
    // card only the root, and an assignment dropped from a card already archived changes neither.
    boardCard.checkout?.root ?? null,
    boardCard.checkout?.source ?? null,
    boardCard.unassigned ?? false,
    startable.length,
    boardCard.lastSession,
    boardCard.lastSession ? openable.has(boardCard.lastSession.sessionId) : false,
    // Exclude `since`: it changes each turn and would rebuild cards, losing scroll position, avatars, and focus.
    boardCard.sessions.map((s) => [
      s.agent,
      s.sessionId,
      s.title,
      s.details.name,
      s.details.shortId,
      s.cwd,
      s.details.state,
      s.details.status,
      s.finished,
      s.activity?.phase ?? null,
      // Whether the row is a button. A restored payload renders before the live read, and the two can disagree.
      openable.has(s.sessionId),
    ]),
  ]);
}

/** The avatars on the element a rebuild is about to discard, so the replacement can adopt them rather than reload. */
function avatarPoolOf(el) {
  const pool = new Map();

  for (const existing of el?.querySelectorAll('.avatar') ?? []) {
    const src = existing.querySelector('img')?.getAttribute('src');

    if (src) {
      pool.set(src, [...(pool.get(src) ?? []), existing]);
    }
  }

  return pool;
}

/** The card element for this key, rebuilt only when what it draws has changed. */
function cardFor(boardCard, placeable) {
  const sig = signature(boardCard);
  const known = cardEls.get(boardCard.key);

  if (known && known.sig === sig) {
    syncActivity(known.el, boardCard);

    return known.el;
  }

  const actions = JSON.stringify(cardActions(boardCard));
  if (openMenu?.key === boardCard.key && known?.actions !== actions) {
    closeMenu(false);
  }

  const el = card(boardCard, avatarPoolOf(known?.el), placeable);
  known?.el.remove();
  cardEls.set(boardCard.key, { el, sig, actions });

  return el;
}

/** Reorder existing nodes and remove obsolete children. */
function reconcile(parent, nodes) {
  let at = parent.firstElementChild;

  for (const node of nodes) {
    if (node === at) {
      at = at.nextElementSibling;
    } else {
      parent.insertBefore(node, at);
    }
  }

  while (at) {
    const next = at.nextElementSibling;
    at.remove();
    at = next;
  }
}

function syncLane(lane, placeable) {
  const shell = laneShells.get(lane.id) ?? laneShell(lane);

  shell.count.textContent = String(lane.cards.length);

  // Done and Icebox are ends, not stages, so an empty one is noise. It reappears while a card is being dragged,
  // or a card could never be dropped into an empty one.
  shell.el.classList.toggle('lane-idle', lane.cards.length === 0 && (lane.id === 'done' || lane.id === 'icebox'));

  reconcile(shell.list, lane.cards.length === 0 ? [shell.empty] : lane.cards.map((c) => cardFor(c, placeable)));

  return shell.el;
}

function readTime(payload) {
  const stamps = [payload.issues?.fetchedAt, payload.sessions?.fetchedAt].filter(Boolean).map((s) => new Date(s));
  return stamps.length === 0 ? null : new Date(Math.max(...stamps.map((d) => d.getTime())));
}

function emptyText(payload) {
  if (payload.issues === null) {
    return 'Nothing to show yet.';
  }

  return payload.issues.totalAssigned === 0
    ? 'No open issues are assigned to you.'
    : 'None of your assigned issues match the current card source.';
}

/**
 * Elements kept from source-rendered conversation HTML. GitHub sanitizes its own render, and the webview runs a
 * nonce-only script policy; this is the third guard, and the one this repository controls.
 */
const DETAIL_TAGS = new Set([
  'a', 'b', 'blockquote', 'br', 'code', 'del', 'details', 'div', 'dd', 'dl', 'dt', 'em', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'hr', 'i', 'img', 'input', 'ins', 'kbd', 'li', 'markdown-accessiblity-table', 'ol', 'p', 'pre',
  'q', 'samp', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'tt', 'ul',
]);

/**
 * Elements whose children are source text rather than markup. Their subtrees are dropped: a template's content is
 * not in `childNodes` at all, and a script's or style's text is code, which must not be read as conversation prose.
 */
const DETAIL_OPAQUE = new Set(['script', 'style', 'template', 'title', 'xmp', 'iframe', 'noembed', 'noframes']);

/** Attributes kept per element. `class` is filtered by value, because board class names position and style chrome. */
const DETAIL_ATTRS = {
  '*': ['class', 'dir', 'lang'],
  a: ['href'],
  img: ['src', 'alt', 'width', 'height'],
  input: ['type', 'checked', 'disabled'],
  ol: ['start'],
  td: ['colspan', 'rowspan', 'align'],
  th: ['colspan', 'rowspan', 'align'],
};

/**
 * Class names kept from source HTML: the ones the panel's stylesheet draws. Anything else is dropped, so a comment
 * cannot borrow the board's own chrome — `.card-popover` is fixed-position and would escape the panel.
 */
/** Addresses the editor can open. Source-composed note addresses are checked against it, like conversation links. */
const DETAIL_HTTP = /^https?:\/\//i;

const DETAIL_CLASS = /^(?:highlight(?:-source-[\w-]+)?|pl-[\w-]+|task-list-item(?:-checkbox)?|contains-task-list|markdown-[\w-]+|notranslate|position-relative|overflow-auto|anchor|footnotes|email-hidden-[\w-]+)$/;

/** Only addresses the editor can open. Anything else drops the attribute, leaving the element's text in place. */
function safeUrl(value, schemes) {
  return typeof value === 'string' && schemes.test(value) ? value : null;
}

/** Keep the classes the stylesheet draws and drop the rest, rather than dropping the attribute wholesale. */
function safeClasses(value) {
  return String(value)
    .split(/\s+/)
    .filter((name) => name !== '' && DETAIL_CLASS.test(name))
    .join(' ');
}

/**
 * Rebuild source HTML from an inert document, keeping only known elements and attributes. Task-list checkboxes stay
 * disabled: this view reads a conversation and never writes one.
 */
function sanitizeDetail(html) {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const out = document.createDocumentFragment();

  const copy = (source, into) => {
    for (const node of source.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        into.appendChild(document.createTextNode(node.nodeValue));
        continue;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }

      const tag = node.localName;

      // Source text, not markup: keeping it would print code as prose, and a template holds nothing here anyway.
      if (DETAIL_OPAQUE.has(tag)) {
        continue;
      }

      // Keep the content of an unknown element, re-filtered; dropping the subtree would lose conversation text.
      if (!DETAIL_TAGS.has(tag)) {
        copy(node, into);
        continue;
      }

      const el = document.createElement(tag);
      const allowed = [...DETAIL_ATTRS['*'], ...(DETAIL_ATTRS[tag] ?? [])];

      for (const name of allowed) {
        if (!node.hasAttribute(name)) {
          continue;
        }

        const value = node.getAttribute(name);

        if (name === 'href' || name === 'src') {
          // Images must be https because the webview policy allows no other scheme; links reach the editor.
          const url = safeUrl(value, name === 'src' ? /^https:\/\//i : DETAIL_HTTP);

          if (url === null) {
            continue;
          }

          el.setAttribute(name, url);
          continue;
        }

        if (name === 'class') {
          const classes = safeClasses(value);

          if (classes !== '') {
            el.setAttribute(name, classes);
          }

          continue;
        }

        el.setAttribute(name, value);
      }

      // Checkboxes reflect the conversation's state; the board does not write it back.
      if (tag === 'input') {
        el.disabled = true;
      }

      copy(node, el);
      into.appendChild(el);
    }
  };

  copy(parsed.body, out);

  return out;
}

/** The open conversation, or null. Held outside the payload so a redraw does not close it. */
let detailFor = null;
let detailState = null;
/** Narrowest and widest the panel can be dragged, so it cannot be lost or made to cover the whole board. */
const DETAIL_MIN_WIDTH = 360;
const DETAIL_WIDTH_STEP = 40;

/** Width the developer dragged the panel to, in pixels, or null for the stylesheet's own. */
let detailWidth = null;

function detailMaxWidth() {
  return Math.max(DETAIL_MIN_WIDTH, Math.round(window.innerWidth * 0.95));
}

function applyDetailWidth(panel) {
  panel.style.width = detailWidth === null ? '' : `${Math.min(detailWidth, detailMaxWidth())}px`;
}

/** Size the panel from its own edge, and tell the extension so the next one opens the same width. */
/** Report the panel's width the way a window splitter must, so arrow keys have audible effect. */
function gripValue(grip, panel) {
  grip.setAttribute('aria-valuemin', String(DETAIL_MIN_WIDTH));
  grip.setAttribute('aria-valuemax', String(Math.round(detailMaxWidth())));
  grip.setAttribute('aria-valuenow', String(Math.round(panel.getBoundingClientRect().width)));
}

function detailGrip(panel) {
  const grip = document.createElement('button');
  grip.type = 'button';
  grip.className = 'detail-grip';
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-orientation', 'vertical');
  setAccessibleName(grip, 'Resize conversation');
  gripValue(grip, panel);

  const resize = (width) => {
    detailWidth = Math.max(DETAIL_MIN_WIDTH, Math.min(Math.round(width), detailMaxWidth()));
    applyDetailWidth(panel);
    gripValue(grip, panel);
  };

  const save = () => vscode.postMessage({ type: 'setDetailWidth', width: detailWidth });

  grip.addEventListener('pointerdown', (event) => {
    // Capture so a fast drag that leaves the grip keeps sizing, and stop the text selection a drag would start.
    grip.setPointerCapture(event.pointerId);
    grip.dataset.dragging = 'true';
    event.preventDefault();

    const from = event.clientX;
    const started = panel.getBoundingClientRect().width;

    const move = (moved) => resize(started + (from - moved.clientX));
    const done = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', done);
      grip.removeEventListener('pointercancel', done);
      delete grip.dataset.dragging;
      save();
    };

    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', done);
    grip.addEventListener('pointercancel', done);
  });

  // A separator is operable from the keyboard too; the pointer is not the only way to size a panel.
  grip.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowLeft' ? DETAIL_WIDTH_STEP : event.key === 'ArrowRight' ? -DETAIL_WIDTH_STEP : 0;

    if (step === 0) {
      return;
    }

    event.preventDefault();
    resize(panel.getBoundingClientRect().width + step);
  });

  // Save once the reader stops, not on every repeat of a held arrow key.
  grip.addEventListener('keyup', save);

  return grip;
}

function detailPanel() {
  const held = document.getElementById('detail');

  if (held) {
    return held;
  }

  const scrim = document.createElement('div');
  scrim.id = 'detail-scrim';
  scrim.addEventListener('click', () => closeDetail());

  const panel = document.createElement('aside');
  panel.id = 'detail';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Conversation');
  applyDetailWidth(panel);

  document.body.append(scrim, panel);
  // `aria-modal` claims nothing outside the panel exists, so everything outside it is held out of pointer and keyboard.
  for (const outside of behindDetail()) {
    outside.setAttribute('inert', '');
  }

  return panel;
}

/** Everything the scrim covers: the panel is modal, so none of it may be reached while a conversation is open. */
function behindDetail() {
  return [...document.body.children].filter((el) => el.id !== 'detail' && el.id !== 'detail-scrim');
}

function closeDetail() {
  const panel = document.getElementById('detail');

  if (panel === null) {
    return;
  }

  const opener = detailFor?.opener ?? null;

  detailFor = null;
  detailState = null;
  panel.remove();
  document.getElementById('detail-scrim')?.remove();

  for (const outside of behindDetail()) {
    outside.removeAttribute('inert');
  }

  // A redraw can replace the control that opened the panel; focus the board rather than dropping it on the body.
  (opener?.isConnected === true ? opener : lanesEl).focus();
}

/** Ask the hub for one conversation and show the panel in its loading state. */
function openDetail(boardCard, subject, opener) {
  detailFor = { key: boardCard.key, subject, opener: opener ?? null };
  detailState = { loading: true, detail: null, failure: null };
  paintDetail(true);
  vscode.postMessage({ type: 'readDetail', key: boardCard.key, subject });
}

/** Ignore answers for a card or subject the panel is no longer showing; requests can overtake each other. */
function detailAnswered(message) {
  if (detailFor === null || message.key !== detailFor.key || message.subject !== detailFor.subject) {
    return;
  }

  detailState = { loading: false, detail: message.detail, failure: message.failure };
  paintDetail(false);
}

function detailHeading(detail, subject) {
  const where = document.createElement('div');
  where.className = 'detail-where';

  const state = document.createElement('span');
  state.className = 'detail-state';
  state.dataset.state = (detail?.state ?? '').toLowerCase();
  state.textContent = detail === null ? (subject === 'issue' ? 'Issue' : 'Pull request') : statusWord(detail.state);
  where.appendChild(state);

  if (detail) {
    const at = document.createElement('span');
    at.className = 'detail-ref';
    at.textContent = `${detail.repository} #${detail.number}`;
    where.appendChild(at);
  }

  return where;
}

/** GitHub reports upper-case states; the panel shows them the way GitHub draws them. */
function statusWord(state) {
  const word = String(state).toLowerCase();

  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Reaction names as GitHub reports them, drawn the way GitHub draws them. */
const REACTION_EMOJI = {
  THUMBS_UP: '👍',
  THUMBS_DOWN: '👎',
  LAUGH: '😄',
  HOORAY: '🎉',
  CONFUSED: '😕',
  HEART: '❤️',
  ROCKET: '🚀',
  EYES: '👀',
};

/** What a review of each state did, in GitHub's own words rather than its enum. */
const REVIEW_WORD = {
  APPROVED: 'approved these changes',
  CHANGES_REQUESTED: 'requested changes',
  COMMENTED: 'reviewed this',
  DISMISSED: 'left a dismissed review',
  PENDING: 'started a review',
};

/** Runs of state changes shorter than this read as part of the conversation; longer ones collapse into one row. */
const ACTIVITY_RUN = 3;

function detailWhen(iso) {
  const at = Date.parse(iso);

  return Number.isNaN(at) ? '' : `${ago(Date.now() - at)} ago`;
}

/** Text for a screen reader that the sighted reader does not need, since the emoji already says it. */
function hidden(text) {
  const span = document.createElement('span');
  span.className = 'sr-only';
  span.textContent = text;

  return span;
}

function detailReactions(reactions) {
  const el = document.createElement('div');
  el.className = 'detail-reactions';

  for (const reaction of reactions) {
    const chip = document.createElement('span');
    chip.className = 'detail-reaction';
    chip.textContent = `${Object.hasOwn(REACTION_EMOJI, reaction.content) ? REACTION_EMOJI[reaction.content] : '•'} ${reaction.count}`;
    // A bare span takes no accessible name, so the count reads from the text itself.
    chip.append(hidden(` ${reaction.content.toLowerCase().replaceAll('_', ' ')}`));
    el.appendChild(chip);
  }

  return el;
}

function detailAvatar(url, size) {
  const image = document.createElement('img');
  image.className = 'detail-avatar';
  image.src = url;
  image.alt = '';
  image.width = size;
  image.height = size;

  return image;
}

/**
 * One thing somebody wrote: the opening body, a conversation comment, or a review summary. A review carries its
 * state and the inline threads it opened; a comment the source hid opens collapsed behind its reason.
 */
function detailPost(post, verb) {
  const el = document.createElement('article');
  el.className = 'detail-comment';
  el.dataset.kind = post.kind;

  const head = document.createElement('header');

  if (post.avatarUrl) {
    head.appendChild(detailAvatar(post.avatarUrl, 20));
  }

  const who = document.createElement('strong');
  who.textContent = post.author ?? 'someone';
  head.appendChild(who);

  const said = document.createElement('span');
  said.className = 'detail-when';
  const did = post.kind === 'review' && Object.hasOwn(REVIEW_WORD, post.state) ? REVIEW_WORD[post.state] : null;
  said.textContent = `${verb ?? did ?? (post.kind === 'review' ? 'reviewed this' : 'commented')} ${detailWhen(post.createdAt)}`;
  head.appendChild(said);

  if (post.editedAt) {
    const edited = document.createElement('span');
    edited.className = 'detail-when';
    edited.textContent = `edited ${detailWhen(post.editedAt)}`;
    head.appendChild(edited);
  }

  if (post.kind === 'review' && post.state) {
    // The verb above already names the state, so this only colours it.
    said.classList.add('detail-review-state');
    said.dataset.state = post.state.toLowerCase();
  }

  el.appendChild(head);

  const body = document.createElement('div');
  body.className = 'markdown-body';
  body.appendChild(sanitizeDetail(post.bodyHtml));

  if (post.hidden !== null) {
    // A hidden comment is still part of the record, so it is collapsed rather than dropped.
    const fold = document.createElement('details');
    fold.className = 'detail-hidden';

    const why = document.createElement('summary');
    why.textContent = `Hidden as ${String(post.hidden).toLowerCase().replace('_', ' ')}`;
    fold.append(why, body);
    el.appendChild(fold);
  } else if (post.bodyHtml.trim() !== '') {
    el.appendChild(body);
  }

  if (post.reactions.length > 0) {
    el.appendChild(detailReactions(post.reactions));
  }

  for (const thread of post.threads) {
    el.appendChild(detailThread(thread));
  }

  return el;
}

/**
 * One inline review conversation, headed by the file and line its comments hang off. A resolved thread opens
 * closed, because it is settled; its heading still says where it was and how much it holds.
 */
function detailThread(thread) {
  const el = document.createElement('details');
  el.className = 'detail-thread';
  el.open = thread.resolved === false;

  const where = document.createElement('summary');
  where.className = 'detail-thread-where';

  const path = document.createElement('code');
  path.textContent = thread.line === null ? thread.path : `${thread.path}:${thread.line}`;
  where.appendChild(path);

  for (const mark of [thread.outdated ? 'Outdated' : null, thread.resolved ? 'Resolved' : null]) {
    if (mark === null) {
      continue;
    }

    const tag = document.createElement('span');
    tag.className = 'detail-thread-mark';
    tag.textContent = mark;
    where.appendChild(tag);
  }

  const held = thread.comments.length;
  const count = document.createElement('span');
  count.className = 'detail-thread-count';
  count.textContent = `${held}${thread.moreComments ? '+' : ''} comment${held === 1 && !thread.moreComments ? '' : 's'}`;
  where.appendChild(count);

  el.appendChild(where);

  for (const comment of thread.comments) {
    el.appendChild(detailPost(comment));
  }

  if (thread.moreComments) {
    el.insertBefore(detailNote('Earlier replies are not shown.'), el.children[1] ?? null);
  }

  return el;
}

function detailNote(text, error) {
  const note = document.createElement('p');
  note.className = error === true ? 'detail-note error' : 'detail-note';
  note.textContent = text;

  return note;
}

/** One state change or commit: a single line naming who did what, and when. */
function detailActivityRow(event) {
  const row = document.createElement('div');
  row.className = 'detail-activity';
  row.dataset.kind = event.kind;

  if (event.avatarUrl) {
    row.appendChild(detailAvatar(event.avatarUrl, 16));
  }

  const who = document.createElement('span');
  who.className = 'detail-activity-who';
  who.textContent = event.actor ?? 'someone';
  row.appendChild(who);

  const said = document.createElement('span');
  said.className = 'detail-activity-said';

  const address = safeUrl(event.url, DETAIL_HTTP);

  if (address === null) {
    said.textContent = event.summary;
  } else {
    const link = document.createElement('a');
    link.href = address;
    link.textContent = event.summary;
    said.appendChild(link);
  }

  row.appendChild(said);

  const when = document.createElement('span');
  when.className = 'detail-when';
  when.textContent = detailWhen(event.createdAt);
  row.appendChild(when);

  return row;
}

/** Fold a long run of state changes so it does not bury the conversation, while still holding every one of them. */
function detailActivityRun(events) {
  if (events.length < ACTIVITY_RUN) {
    const loose = document.createDocumentFragment();

    for (const event of events) {
      loose.appendChild(detailActivityRow(event));
    }

    return loose;
  }

  const fold = document.createElement('details');
  fold.className = 'detail-activity-run';

  const summary = document.createElement('summary');
  summary.textContent = `${events.length} updates`;
  fold.appendChild(summary);

  for (const event of events) {
    fold.appendChild(detailActivityRow(event));
  }

  return fold;
}

/** Draw the conversation in the order it happened, folding consecutive state changes into one row. */
function detailTimeline(events) {
  const out = document.createDocumentFragment();
  let run = [];

  const flush = () => {
    if (run.length > 0) {
      out.appendChild(detailActivityRun(run));
      run = [];
    }
  };

  for (const event of events) {
    if (event.kind === 'comment' || event.kind === 'review') {
      flush();
      out.appendChild(detailPost(event));
    } else {
      run.push(event);
    }
  }

  flush();

  return out;
}

/** Threads whose opening review is not in the timeline still belong to the conversation, so they are listed apart. */
function detailThreads(threads) {
  const section = document.createElement('section');
  section.className = 'detail-threads';

  const heading = document.createElement('h3');
  heading.textContent = `Review comments (${threads.length})`;
  section.appendChild(heading);

  for (const thread of threads) {
    section.appendChild(detailThread(thread));
  }

  return section;
}

/** The line under the title: labels, author, assignees, milestone, and a pull request's branches and checks. */
function detailChips(detail) {
  const chips = document.createElement('div');
  chips.className = 'detail-chips';

  for (const label of detail.labels) {
    const chip = document.createElement('span');
    chip.className = 'detail-label';
    chip.style.setProperty('--gc-label', `#${label.color}`);
    chip.textContent = label.name;
    chips.appendChild(chip);
  }

  if (detail.assignees.length > 0) {
    const who = document.createElement('span');
    who.className = 'detail-facet';
    who.textContent = `assigned ${detail.assignees.join(', ')}`;
    chips.appendChild(who);
  }

  if (detail.milestone) {
    const milestone = document.createElement('span');
    milestone.className = 'detail-facet';
    milestone.textContent = detail.milestone;
    chips.appendChild(milestone);
  }

  if (detail.draft) {
    const draft = document.createElement('span');
    draft.className = 'detail-facet';
    draft.textContent = 'draft';
    chips.appendChild(draft);
  }

  if (detail.branches) {
    const branches = document.createElement('span');
    branches.className = 'detail-facet';
    branches.textContent = `${detail.branches.head} → ${detail.branches.base}`;
    chips.appendChild(branches);
  }

  if (detail.reviewDecision) {
    const decision = document.createElement('span');
    decision.className = 'detail-facet';
    decision.textContent = statusWord(detail.reviewDecision.replace('_', ' '));
    chips.appendChild(decision);
  }

  if (detail.checks) {
    const checks = document.createElement('span');
    checks.className = 'detail-facet';
    checks.dataset.checks = detail.checks.toLowerCase();
    checks.textContent = `checks ${detail.checks.toLowerCase()}`;
    chips.appendChild(checks);
  }

  return chips;
}

function paintDetail(opening) {
  if (detailFor === null) {
    return;
  }

  const panel = detailPanel();
  const { loading, detail, failure } = detailState;
  // Whether the reader was inside the panel must be read before the repaint detaches whatever held focus.
  const held = document.activeElement;
  const inside = held !== null && (held === document.body || panel.contains(held));

  panel.replaceChildren(detailGrip(panel));

  const head = document.createElement('header');
  const top = detailHeading(detail, detailFor.subject);

  const external = document.createElement('button');
  external.type = 'button';
  external.className = 'detail-action';
  external.textContent = 'Open on GitHub';
  external.disabled = detail === null;
  setTooltip(external, 'Open this conversation in your browser');
  external.addEventListener('click', () => detail && vscode.postMessage({ type: 'openLink', url: detail.url }));

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'detail-close';
  close.textContent = '×';
  setAccessibleName(close, 'Close conversation');
  close.addEventListener('click', () => closeDetail());

  top.append(external, close);
  head.appendChild(top);

  const heading = document.createElement('h2');
  heading.textContent = detail?.title ?? (loading ? 'Reading…' : 'Nothing to show');
  head.appendChild(heading);

  if (detail) {
    head.appendChild(detailChips(detail));
  }

  panel.appendChild(head);

  const body = document.createElement('div');
  body.className = 'detail-scroll';
  // A conversation with no links has nothing else to focus, so the scrolling region takes the keyboard itself.
  body.tabIndex = 0;
  body.setAttribute('role', 'region');
  setAccessibleName(body, 'Conversation');

  if (loading) {
    body.appendChild(detailNote('Reading the conversation…'));
  } else if (failure !== null || detail === null) {
    body.appendChild(detailNote(failure ?? 'That conversation could not be found.', true));
  } else {
    body.appendChild(
      detailPost(
        {
          kind: 'comment',
          author: detail.author,
          avatarUrl: detail.authorAvatarUrl,
          bodyHtml: detail.bodyHtml.trim() === '' ? '<p>No description.</p>' : detail.bodyHtml,
          createdAt: detail.createdAt,
          editedAt: detail.editedAt,
          reactions: detail.reactions,
          hidden: null,
          state: null,
          threads: [],
        },
        detail.subject === 'issue' ? 'opened this' : 'opened this pull request',
      ),
    );

    if (detail.moreEvents) {
      body.appendChild(detailNote('Earlier updates are not shown. Open on GitHub to read them.'));
    }

    body.appendChild(detailTimeline(detail.events));

    if (detail.threads.length > 0) {
      body.appendChild(detailThreads(detail.threads));
    }

    if (detail.moreThreads) {
      body.appendChild(detailNote('Some review threads are not shown. Open on GitHub to read them.'));
    }
  }

  panel.appendChild(body);

  // Every paint replaces the panel's children, so focus that was inside it goes back to the same control.
  if (opening || inside) {
    const wanted = (held?.className ?? '').split(' ')[0] ?? '';

    (panel.querySelector(`.${wanted === '' ? 'detail-close' : wanted}`) ?? close).focus();
  }
}

/** Whether card controls read a conversation here; off sends them to the browser, as they went before (R43). */
let reading = true;

/** Ctrl-click, or Cmd-click on macOS, sends a card's controls to the browser instead of the reading panel. */
function wantsBrowser(event) {
  return reading === false || event.ctrlKey === true || event.metaKey === true;
}

function openIssueFrom(event, boardCard, opener) {
  if (wantsBrowser(event)) {
    vscode.postMessage({ type: 'openIssue', number: boardCard.issue.number });

    return;
  }

  openDetail(boardCard, 'issue', opener);
}

function openPullRequestFrom(event, boardCard, opener) {
  if (wantsBrowser(event)) {
    vscode.postMessage({ type: 'openPullRequest', number: boardCard.issue.number });

    return;
  }

  openDetail(boardCard, 'pull-request', opener);
}

/*
 * Links inside a conversation are left to the webview host, which opens an anchor's address in the browser on its
 * own. Opening them from here as well opened every link twice. The sanitizer is what limits the address (R43).
 */

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && detailFor !== null) {
    closeDetail();
  }
});

function countCards(lanes) {
  return lanes.reduce((total, lane) => total + lane.cards.length, 0);
}

/**
 * Report rendered DOM after each draw so the extension can detect blocked or failed webview scripts (R25).
 */
function render(payload) {
  draw(payload);

  // A card this render replaced is one the tooltip is still open over, and its rect is gone with it.
  if (tipAnchor !== null && !tipAnchor.isConnected) {
    hideTip();
  }

  // Read counts and text from the DOM so the report confirms rendering.
  vscode.postMessage({
    type: 'drew',
    lanes: lanesEl.querySelectorAll('.lane').length,
    cards: lanesEl.querySelectorAll('.card').length,
    notices: noticesEl.childElementCount,
    meta: metaEl.textContent,
  });
}

function draw(payload) {
  board = payload;
  openable = new Set(payload.openable ?? []);
  startable = payload.startable ?? [];

  noticesEl.replaceChildren();

  // A failed source keeps its last good read on screen, dimmed. Clearing it would imply the board verified there is
  // nothing to show; leaving it bright would imply the read succeeded.
  const stale = payload.stale === true;
  lanesEl.classList.toggle('stale', stale);
  metaEl.classList.toggle('stale', stale);

  // The lanes a card can be moved into come from the payload, so the webview never holds a second list of lane names.
  const placeable = payload.lanes.filter((lane) => lane.id !== 'archived').map((lane) => lane.id);
  const archived = payload.lanes.find((lane) => lane.id === 'archived');

  archivedCount = archived ? archived.cards.length : 0;

  // Nothing archived means no toggle, so the state is cleared too - otherwise an empty Archived column is stranded
  // on screen with nothing left in the menu to take it off again.
  if (archivedCount === 0) {
    showArchived = false;
  }

  vscode.setState({ payload, showArchived, animations });

  const shown = payload.lanes.filter((lane) => lane.id !== 'archived' || showArchived);

  onBoard.clear();

  for (const lane of payload.lanes) {
    for (const boardCard of lane.cards) {
      onBoard.add(boardCard.key);
    }
  }
  const total = countCards(shown);
  const when = readTime(payload);

  metaEl.textContent = `${total} card${total === 1 ? '' : 's'}`;

  if (when !== null) {
    // The age is a node of its own so the tick advances it where it stands, like every other duration on the board.
    const held = document.createElement('span');

    age(held, when.getTime());
    metaEl.append(' · updated ', held, ' ago');
  }

  if (stale) {
    metaEl.append(' · could not refresh');
  }

  for (const failure of payload.failures) {
    notice(failure.message, failure.remedy, true);
  }

  if (payload.hooks) {
    notice(payload.hooks.notice, null, false);
  }

  if (setupPending) {
    notice('Ground Control setup is not finished: session hooks and triage stay off until it is.', 'Run Ground Control: Run Setup.', false);
  }

  if (payload.triage?.message) {
    notice(payload.triage.message, null, false);
  }

  if (payload.sessions?.patternError) {
    notice(payload.sessions.patternError, 'Fix groundControl.branchIssuePattern in Settings.', true);
  }

  if (payload.issues && payload.issues.notOnProject > 0) {
    notice(
      `${payload.issues.notOnProject} assigned issue${payload.issues.notOnProject === 1 ? ' is' : 's are'} not on the configured project board, so they are not shown.`,
      'Switch groundControl.cardSource to issueSearch to include them.',
      false,
    );
  }

  if (payload.issues?.fieldProblem) {
    notice(payload.issues.fieldProblem, 'Set groundControl.github.statusField to a single-select field on the project.', true);
  }

  // A status set that matches nothing archives the whole board, and no card can say that from its own status.
  if (archived && archived.cards.length > 0 && countCards(payload.lanes) === archived.cards.length) {
    notice(
      'Every issue the board read is archived, so no lane has anything in it.',
      'Check that groundControl.boardStatuses matches the status names on your project board.',
      false,
    );
  }

  if (payload.issues?.truncated) {
    // `matched` is what this board's own query found. `totalAssigned` is the wider set and would overstate the gap.
    notice(
      `More issues match than were read. Showing ${payload.issues.count} of ${payload.issues.matched}.`,
      'Raise groundControl.github.maxPages, up to 10 pages of 100, to read more at the cost of more GitHub requests per refresh.',
      false,
    );
  }

  // A card the board no longer carries keeps no element: its key can come back, but the element would be stale.
  for (const key of cardEls.keys()) {
    if (!onBoard.has(key)) {
      cardEls.get(key).el.remove();
      cardEls.delete(key);
    }
  }

  if (countCards(payload.lanes) === 0) {
    emptyEl.textContent = emptyText(payload);
    reconcile(lanesEl, [emptyEl]);
    followMenu();

    return;
  }

  reconcile(
    lanesEl,
    shown.map((lane) => syncLane(lane, placeable)),
  );

  followMenu();

  // After the cards, never before: a reused card is handed its newer observation time as it is reconciled.
  tickDurations();
}

window.addEventListener('message', (event) => {
  const message = event.data;

  if (message.type === 'loading') {
    metaEl.textContent = 'Reading GitHub…';
    return;
  }

  if (message.type === 'logs') {
    paintLogs(message.streaming === true);
    return;
  }

  if (message.type === 'setup') {
    setupPending = message.pending === true;

    if (board !== null) {
      draw(board);
    }

    return;
  }

  if (message.type === 'detail') {
    detailAnswered(message);

    return;
  }

  if (message.type === 'reading') {
    reading = message.enabled !== false;
    detailWidth = typeof message.width === 'number' ? message.width : null;

    // A board turned off while a conversation is open closes it; the setting is what says it should not be there.
    if (!reading) {
      closeDetail();
    }

    if (board) {
      render(board);
    }

    return;
  }

  if (message.type === 'presentation') {
    animations = message.animations !== false;
    applyMotion();
    vscode.setState({ payload: board, showArchived, animations });
    return;
  }

  if (message.type === 'showArchived') {
    showArchived = message.shown === true;

    if (board) {
      render(board);
    }

    return;
  }

  if (message.type === 'board') {
    if (dragging === null) {
      render(message);
    } else {
      deferred = message;
    }
  }
});

// An anchor is fixed, so its age is a function of the clock alone - no read of the machine advances it, and this is the
// only thing on the board with a clock of its own. Once a second, because that is the resolution the text is written to.
setInterval(tickDurations, 1_000);

const restored = vscode.getState();

/**
 * Whether a revived payload is the shape this script reads. A panel revived after an upgrade holds the payload the
 * previous version stored, and rendering one whose sessions predate a field a card reads throws before the first
 * live message. `details` and `repository` are the two read without a guard of their own, and a card carrying a
 * number with no issue behind it is the shape a hub stored before it looked the issue up.
 */
function isCurrentPayload(payload) {
  return (
    Array.isArray(payload?.lanes) &&
    payload.lanes.every((lane) =>
      (lane.cards ?? []).every(
        (card) =>
          (card.issueNumber === null || card.issue) &&
          (card.sessions ?? []).every((session) => session.details !== undefined && session.repository !== undefined),
      ),
    )
  );
}

/*
 * Bind the persistent board menu after SVG initialization; const declarations are unavailable before
 * initialization.
 */
setAccessibleName(boardMenuEl, 'Board actions');
wireMenuControl(boardMenuEl, BOARD_MENU_KEY, 'Board actions', boardActions);
paintLogs(false);

// Read before the payload guard: a stored board too old to draw does not make the developer's Archived choice stale.
showArchived = restored?.showArchived === true;
animations = restored?.animations !== false;
applyMotion();

if (isCurrentPayload(restored?.payload)) {
  render(restored.payload);
}

// Send ready after startup so the extension restores control state after webview reloads.
vscode.postMessage({ type: 'ready' });
