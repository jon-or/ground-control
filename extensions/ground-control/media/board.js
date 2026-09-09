// @ts-check
const vscode = acquireVsCodeApi();

const lanesEl = document.getElementById('lanes');
const metaEl = document.getElementById('meta');
const noticesEl = document.getElementById('notices');

const boardMenuEl = document.getElementById('board-menu');

/**
 * What an element says on hover, in place of the browser's own tooltip: `title` opens after about a second, in the
 * operating system's shape rather than the editor's. The geometry and the timing are GitHub's own, measured off a
 * live board (`docs/mechanics.md` §35) and copied here, because this script imports nothing — pinned by the parity
 * table in both suites, since a tooltip that behaves differently on one board is the drift that table exists for.
 */
const TIP_ATTR = 'data-gc-tip';

/** How long a pointer rests on something before its tooltip opens, and how far the tooltip sits from it. */
const TIP_DELAY = 120;
const TIP_GAP = 4;

/** What a tooltip keeps between itself and the edge it would otherwise run off. */
const TIP_MARGIN = 8;

/** @type {ReturnType<typeof setTimeout> | null} */
let tipTimer = null;
/** @type {Element | null} */
let tipAnchor = null;

/**
 * What an element says on hover, and what a reader is told about it. `aria-description` rather than a description
 * written while the tooltip shows: that one arrives after focus has already been announced, and a reader in browse
 * mode never reaches a tooltip on something it cannot focus. Chromium exposes it exactly as it exposed `title`,
 * which is what both boards run in.
 *
 * @param {Element} el
 * @param {string} text
 */
function tip(el, text) {
  el.setAttribute(TIP_ATTR, text);

  // Not where the element is already named with these words — a reader would say them twice, once as the name and
  // once as the description. Order-independent, because `nameFor` takes the description back off.
  if (!el.hasAttribute('aria-label')) {
    el.setAttribute('aria-description', text);
  }
}

/**
 * Names an element for a reader. Its tooltip then says what the name says, so it stops being the description too.
 *
 * @param {Element} el
 * @param {string} text
 */
function nameFor(el, text) {
  el.setAttribute('aria-label', text);
  el.removeAttribute('aria-description');
}

/**
 * One tooltip for the whole board, moved and re-worded rather than built per element. The text lives in an
 * attribute rather than in a child, because a child is part of `textContent` and every label that reads its own
 * would gain it.
 */
function tipElement() {
  const held = document.getElementById('tip');

  if (held !== null) {
    return held;
  }

  const panel = document.createElement('div');

  panel.id = 'tip';
  panel.setAttribute('role', 'tooltip');
  // Its own text node, written through rather than replaced, so opening one adds and removes no nodes at all.
  panel.appendChild(document.createTextNode(''));
  document.body.appendChild(panel);

  return panel;
}

/**
 * Centred over what it names and pushed to the side that has room. Measured after the text is in it: a tooltip's
 * width is its words, and a guess at that centres it somewhere else entirely.
 *
 * @param {HTMLElement} panel
 * @param {Element} anchor
 */
function placeTip(panel, anchor) {
  const rect = anchor.getBoundingClientRect();
  const own = panel.getBoundingClientRect();
  const above = rect.top - TIP_GAP - own.height;

  // Below where it will not fit above, and then held inside the window either way: a tooltip long enough to wrap,
  // on an anchor near the bottom, is drawn off the edge by the flip that was meant to rescue it.
  const top = above < TIP_MARGIN ? rect.bottom + TIP_GAP : above;

  panel.style.top = `${Math.max(TIP_MARGIN, Math.min(top, window.innerHeight - own.height - TIP_MARGIN))}px`;
  panel.style.left = `${Math.max(
    TIP_MARGIN,
    Math.min(rect.left + rect.width / 2 - own.width / 2, window.innerWidth - own.width - TIP_MARGIN),
  )}px`;
}

/** @param {Element} anchor */
function showTip(anchor) {
  const text = anchor.getAttribute(TIP_ATTR);

  // A render inside the delay replaces what the pointer was over, and an anchor off the page measures zero at the
  // origin — the tooltip would open in the corner of the window, naming something no longer there.
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
 * On the document rather than on each element: a render replaces cards wholesale, and listeners bound to the
 * elements themselves would be re-bound every time. `mouseover` rather than `mouseenter` for the same reason — only
 * the first of the two carries far enough up to be delegated.
 *
 * @param {Event} event
 */
function tipOver(event) {
  const anchor = /** @type {Element} */ (event.target)?.closest?.(`[${TIP_ATTR}]`) ?? null;

  // A menu hands the keyboard to an item as it opens, and a tooltip below that item covers the items under it. So
  // a hint inside a menu is the pointer's alone: the label is what a keyboard reads, and the item is the target.
  if (event.type === 'focusin' && anchor?.closest('.card-popover') !== null) {
    return;
  }

  if (anchor === tipAnchor) {
    return;
  }

  hideTip();

  // Held from the moment the pointer arrives rather than from when the tooltip opens, so a pointer that leaves
  // inside the delay is one `hideTip` still recognises — otherwise it opens over something already left behind.
  tipAnchor = anchor;

  if (anchor !== null) {
    tipTimer = setTimeout(() => showTip(anchor), TIP_DELAY);
  }
}

/** @param {Event} event */
function tipOut(event) {
  const going = /** @type {Element} */ (event.target)?.closest?.(`[${TIP_ATTR}]`) ?? null;
  const to = /** @type {Node | null} */ (event.relatedTarget ?? null);

  // Not for a pointer crossing between an anchor's own children: `mouseout` fires on each of those, and closing
  // there means the tooltip shuts and reopens as the pointer travels the width of what it is describing.
  if (going !== null && going === tipAnchor && !(to !== null && going.contains(to))) {
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

// Placed once, in viewport coordinates, so a lane scrolling under it would leave it behind. Closed rather than
// followed: the pointer is still over the anchor, and the next move opens it where the anchor now is.
document.addEventListener('scroll', hideTip, true);

/**
 * Whether the hub's log is being streamed into the Output panel. Nothing else carries it - the Output panel gives no
 * sign of which channel is subscribed, and the hub is read only while this says on. Read when the menu is opened.
 */
let streamingLogs = false;

/**
 * Whether the archived lane is drawn, and how many cards are in it. The count decides whether the toggle is offered
 * at all: an archive nothing has reached is a control that could only ever show an empty column.
 */
let showArchived = false;
let archivedCount = 0;

/**
 * What the board itself can be asked to do. A toggle among these is checked rather than acted on, and its own words
 * say what choosing it will do.
 */
function boardActions() {
  const actions = [];

  if (archivedCount > 0) {
    actions.push({
      label: `Show archived (${archivedCount})`,
      hint: showArchived ? 'Take the Archived lane back off the board.' : 'Draw the Archived lane beside the others.',
      checked: showArchived,
      run: () => {
        showArchived = !showArchived;
        // The extension keeps it: this webview's state goes with the tab, and the choice outlives the tab.
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
        ? 'The hub log is streaming into Output. Choose this to stop reading it.'
        : 'Stream the hub log into the Output panel.',
      checked: streamingLogs,
      run: () => vscode.postMessage({ type: 'toggleLogs' }),
    },
    {
      label: 'Show board log',
      hint: "Reveal this board's own output channel in the Output panel.",
      run: () => vscode.postMessage({ type: 'showBoardLog' }),
    },
    {
      label: 'Refresh',
      hint: 'Read the sessions and the project board again now.',
      run: () => vscode.postMessage({ type: 'refresh' }),
    },
    {
      label: 'Settings',
      hint: "Open the editor's settings, filtered to Ground Control.",
      run: () => vscode.postMessage({ type: 'openSettings' }),
    },
  );

  return actions;
}

function paintLogs(streaming) {
  streamingLogs = streaming;
  // The state is inside a menu that is shut almost all of the time, so the control it hangs from carries a mark too.
  boardMenuEl.classList.toggle('on', streaming);
  tip(boardMenuEl, streaming ? 'Board actions. The hub log is streaming into Output.' : 'Board actions');
}

// A key no card can have: every card's is its kind and a colon, so the board's own menu can never be taken for one.
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

/** The last segment of a path. Both separators, because an agent CLI reports the cwd in its platform's own shape. */
function basename(dir) {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

/** What a session calls itself. `name` is the CLI's own and often derived from the directory — the weakest of the three. */
function sessionLabel(session) {
  return session.title ?? session.details.name ?? session.details.shortId ?? basename(session.cwd);
}

/**
 * Whether the card has a directory to read changes from. `core`'s `checkoutOf` decides which of several sessions
 * answers; the board only needs whether one does, which is the same condition and is pinned to it by the parity
 * table in `test/board.test.ts` — this file is a classic script and can import nothing.
 */
function hasCheckout(boardCard) {
  return boardCard.sessions.length > 0 || boardCard.lastSession != null;
}

/** The sessions this window can open, named by the extension - the webview never compares directories itself. */
let openable = new Set();

const SVG = 'http://www.w3.org/2000/svg';
// Claude's own mark, verbatim from the official extension's resources/claude-logo.svg, at its brand colour.
const CLAUDE_MARK =
  'M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z';

// OpenAI's own mark, verbatim from the ChatGPT extension's resources/blossom-black.svg. It ships black and white
// rather than in a brand colour, so the board draws it at the row's own tone rather than at one of the two.
const OPENAI_MARK =
  'M13.795 23.856q-1.188 0-2.256-.448a6.1 6.1 0 0 1-1.9-1.247 5.8 5.8 0 0 1-1.875.306 5.8 5.8 0 0 1-2.944-.777 6.1 6.1 0 0 1-2.184-2.12q-.807-1.34-.808-2.99 0-.682.19-1.482a6.3 6.3 0 0 1-1.472-2.002 5.76 5.76 0 0 1 .024-4.85q.546-1.177 1.52-2.024a5.5 5.5 0 0 1 2.303-1.2A5.55 5.55 0 0 1 5.485 2.62 6.06 6.06 0 0 1 7.575.925 5.85 5.85 0 0 1 10.21.313q1.187 0 2.255.447a6.1 6.1 0 0 1 1.9 1.248 5.8 5.8 0 0 1 1.875-.306q1.59 0 2.944.776a5.9 5.9 0 0 1 2.16 2.12q.832 1.34.832 2.99 0 .682-.19 1.483a6.2 6.2 0 0 1 1.472 2.024q.522 1.13.522 2.378 0 1.272-.546 2.449a6.1 6.1 0 0 1-1.543 2.048 5.45 5.45 0 0 1-2.28 1.177 5.4 5.4 0 0 1-1.115 2.402 5.8 5.8 0 0 1-2.066 1.695 5.85 5.85 0 0 1-2.635.612M7.93 20.913q1.188 0 2.066-.495l4.463-2.542a.52.52 0 0 0 .238-.448v-2.024L8.95 18.676a.97.97 0 0 1-1.044 0L3.419 16.11a.7.7 0 0 1-.024.165v.282q0 1.201.57 2.213.594.99 1.639 1.554 1.044.59 2.326.589m.238-3.838q.143.07.26.07a.46.46 0 0 0 .238-.07l1.781-1.012-5.722-3.296q-.522-.306-.522-.918v-5.11a4.27 4.27 0 0 0-1.9 1.602 4.13 4.13 0 0 0-.712 2.354q0 1.155.594 2.213.593 1.06 1.543 1.601zm5.627 5.227q1.258 0 2.279-.565a4.25 4.25 0 0 0 1.614-1.554q.594-.99.594-2.213v-5.085q0-.283-.237-.424l-1.805-1.036v6.568q0 .613-.522.919l-4.487 2.566q1.163.825 2.564.824m.902-8.617v-3.202l-2.683-1.507-2.707 1.507v3.202l2.707 1.507zm-6.933-7.51q0-.612.522-.918l4.488-2.567a4.34 4.34 0 0 0-2.564-.824q-1.26 0-2.28.565a4.25 4.25 0 0 0-1.614 1.554q-.57.99-.57 2.213v5.062q0 .283.237.447l1.781 1.036zm12.061 11.253a4.13 4.13 0 0 0 1.876-1.6 4.2 4.2 0 0 0 .712-2.355q0-1.154-.593-2.213-.594-1.06-1.544-1.6l-4.44-2.543q-.142-.095-.26-.071a.46.46 0 0 0-.238.07l-1.78.99 5.745 3.319q.26.141.38.377a.9.9 0 0 1 .142.518zm-4.772-11.96q.522-.33 1.045 0l4.51 2.614v-.424q0-1.13-.57-2.142a4.1 4.1 0 0 0-1.59-1.648q-1.02-.613-2.374-.613-1.187 0-2.066.495L9.545 6.292a.52.52 0 0 0-.238.448v2.025z';

/** The mark each agent is drawn with. A CLI absent here keeps its name in text - R2 says the board says which agent
 * reported a session, and an unmarked row would read as the one that has a mark. */
const AGENT_MARKS = { claude: CLAUDE_MARK, codex: OPENAI_MARK };

/**
 * Where a row's click lands, in the two destinations the board has: a detached run is attached to in a terminal, and
 * every other session is opened in the editor (`docs/mechanics.md` §33). Stroke rather than fill, so neither reads as
 * a third brand mark beside the agent's.
 */
const DESTINATION_SHAPES = {
  terminal: [
    ['rect', { class: 'plate', x: '1.5', y: '3.5', width: '21', height: '17', rx: '3' }],
    ['polyline', { class: 'ink', points: '6.5 9 9.75 12 6.5 15' }],
    ['line', { class: 'ink', x1: '12.5', y1: '15', x2: '17.5', y2: '15' }],
  ],
  editor: [
    ['rect', { class: 'frame', x: '1.75', y: '3.75', width: '20.5', height: '16.5', rx: '3' }],
    ['line', { class: 'frame', x1: '8.5', y1: '3.75', x2: '8.5', y2: '20.25' }],
  ],
};

/**
 * The mark for one destination, in the slot the state holds. `aria-hidden`: the row's own accessible name already
 * says where the click goes, and a second announcement of the same fact is one to learn to ignore.
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
  // What the fill is keyed by: a mark with a brand colour of its own keeps it, and a monochrome one takes the row's.
  svg.setAttribute('data-agent', agent);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', agent);

  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', drawn);
  path.setAttribute('fill-rule', 'nonzero');

  // No `<title>` child: an SVG one draws the browser's own tooltip exactly as the attribute does, and on a row that
  // carries a tooltip already it draws a second one beside it. `aria-label` above is what names the mark.
  svg.appendChild(path);

  return svg;
}

/**
 * The session's own state, at the head of its row: the phase in the colour, and whether the agent still has the
 * session open in whether the ring is filled. The word is the mark's accessible name, because a colour is not a
 * fact that reaches everyone who reads this board.
 */
function sessionDot(phase, live, title = dotTitle(phase, live)) {
  const el = document.createElement('span');

  el.className = 'dot';
  el.dataset.phase = phase ?? 'none';
  el.dataset.live = String(live);
  el.setAttribute('role', 'img');
  // Named for a reader and described for a pointer: the colour is the one thing on the row that cannot be read.
  nameFor(el, `${PHASE_WORDS[phase] ?? 'no state reported'}, ${live ? 'open' : 'ended'}`);
  tip(el, title);

  return el;
}

/**
 * The whole row is the control where there is a command to run, which is what the browser overlay makes of the same
 * row: the surface a hover paints is then the row rather than the words in it, and everything the surface covers is
 * the target. A control only where there is something to run — another CLI's session has none, and a button that
 * could only ever refuse is worse than no button, as well as costing the card a strip it could be dragged by.
 */
function sessionLine(session) {
  // A detached run is always reachable: `attach` needs a terminal rather than the agent's editor extension, and it
  // is the only way into a session no window holds - opening one as a tab starts a second process that exits 1.
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

  // No tooltip on the row: its words are on it, and a hover that repeats them is a hover to learn to ignore. What
  // the row does not say — what the board saw, and when — stays on the state at the other end of it.
  if (reachable) {
    el.type = 'button';
    nameFor(el, attachId === null ? `${name} - go to this session` : `${name} - attach to this run in a terminal`);
    // Without this, a few pixels of drift on the way to a click starts a drag of the card and the click never fires.
    el.draggable = false;
    el.addEventListener('click', () =>
      vscode.postMessage(
        attachId === null
          ? { type: 'openSession', sessionId: session.sessionId }
          : { type: 'attachSession', sessionId: session.sessionId },
      ),
    );
  }

  el.append(sessionDot(session.activity?.phase, !session.finished), agent, label);

  // What the italic name is keyed by: a run the board started is not a session the developer is sitting in.
  if (attachId !== null) {
    el.dataset.detached = 'true';
  }

  const activity = session.activity;

  if (activity) {
    el.dataset.phase = activity.phase;
  }

  const state = document.createElement('span');
  const said = activity ? stateTitle(activity) : null;

  state.className = 'state';

  // One state per row, never two. The board's own observation where it has one, the adapter's reading of what the
  // CLI said where it does not - a row reading "idle" beside a shimmering label is two claims disagreeing (R24).
  if (activity) {
    age(state, activity.since);
    tip(state, said);
    el.appendChild(state);
  } else {
    const reported = session.details.state ?? session.details.status;

    if (reported) {
      state.textContent = reported;
      el.appendChild(state);
    }
  }

  // The pointer takes the state's slot, so what the state had to say goes on the mark that stands there instead -
  // otherwise the one row carrying a reading is the one row whose reading cannot be read.
  if (reachable) {
    const destination = destinationMark(attachId === null ? 'editor' : 'terminal');
    const goes = attachId === null ? 'Opens this session in the editor.' : 'Attaches to this run in a terminal.';

    tip(destination, said === null ? goes : `${goes} ${said}`);
    el.appendChild(destination);
  }

  return el;
}

/**
 * What a reading kept past its own process draws: the phase to paint, the moment to count from, and what the mark means. Undefined where the
 * saved session carries no usable reading, and `running` is never one of the three — the process is gone, so the work stopped mid-turn, which
 * is the developer's move: `idle`'s answer, in `idle`'s colour, and with no shimmer. `retainedPhase` in `packages/board/src/lanes.ts` decides
 * the card's own mark from the same reading.
 */
function retainedMark(retained) {
  if (!retained || typeof retained.at !== 'number' || typeof retained.event !== 'string') return undefined;

  const said = `Last seen at the ${retained.event} hook.`;

  if (retained.phase === 'waiting') {
    return { phase: 'waiting', at: retained.at, title: `This session was waiting on you when its process ended. ${said}` };
  }

  if (retained.phase === 'running') {
    return { phase: 'idle', at: retained.at, title: `This session was working when its process ended, so it stopped short. ${said}` };
  }

  if (retained.phase === 'idle') {
    return { phase: 'idle', at: retained.at, title: `This session finished its turn, and its process has since ended. ${said}` };
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
  // The reading's own event where there is one, so the row's duration is the age of what the mark claims rather than of the last transcript
  // write. Otherwise the value alone, and no words about what it is: a row is one line, and what it says is said by its hollow mark.
  age(state, mark ? mark.at : session.updatedAt);
  // On the age rather than the row, as a live row's is: the exact moment is the one thing the rounded value drops. It names whichever
  // moment the value counts from, so the hover and the number are never two claims about one row.
  tip(state, `${reachable ? 'Resume this session in VS Code.' : 'Historical session.'} ${mark ? `Last seen ${new Date(mark.at).toLocaleString()}` : `Last saved ${new Date(session.updatedAt).toLocaleString()}`}.`);

  if (reachable) {
    nameFor(el, `${label.textContent} - resume this session`);
  }

  // The phase colours the mark and nothing else on the row: `data-phase` also drives the running shimmer and the your-turn tone, and both
  // are claims about a session with a process. An outline says the process is gone, which is the whole of what this row adds to the phase.
  if (mark) el.dataset.phase = mark.phase;

  el.append(
    sessionDot(mark?.phase, false, mark ? mark.title : 'The last session that ran here. Nothing is running on this card now.'),
    agentMark(session.agent),
    label,
    state,
  );

  // A saved session has no process, so there is nothing to attach to: resuming it in the editor is the only way back.
  if (reachable) {
    const destination = destinationMark('editor');

    tip(destination, `Resumes this session in the editor. ${mark ? mark.title : ''}`.trim());
    el.appendChild(destination);
  }
  return el;
}

const PHASE_WORDS = { running: 'running', waiting: 'needs you', idle: 'idle' };

const PHASE_TITLES = {
  running: 'This session is working.',
  waiting: 'This session is waiting on you.',
  idle: 'The board last saw this session finish.',
};

/** What the mark means, since a colour is the one thing on a row that cannot be read. Its fill is the second half. */
function dotTitle(phase, live) {
  const what = PHASE_TITLES[phase] ?? 'No hook has reported on this session.';

  return live ? what : `${what} The agent has since ended it.`;
}

/**
 * What the duration counts, and what the board last saw. Not the phase, which is the mark's at the other end of the
 * row: a hover on one repeating the other is two tooltips to learn to ignore.
 */
const DURATION_TITLES = {
  running: 'Counts the turn it is in, from the prompt that began it where the board saw one.',
};

const DURATION_TITLE = 'Counts from the event that reported the phase.';

/**
 * How long ago, as one number in the largest unit that fits, and never rounded up. Overstating is the one direction
 * that matters: a session working steadily must not read older than it is, because that is what a stuck one looks like.
 */
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

/** What the row says on hover: what the board concluded, and the hook event it concluded it from. */
function stateTitle(activity) {
  const what = DURATION_TITLES[activity.phase] ?? DURATION_TITLE;

  return activity.event ? `${what} Last seen at the ${activity.event} hook.` : what;
}

/**
 * The moment an element's text is the age of. One attribute for every duration on the board — a session's state, a
 * saved session's, the age of a card's status — because all three are `ago(now - x)` and one pass advances them all.
 */
const AGE_ATTR = 'data-gc-since';

/** @param {Element} el @param {number} at */
function age(el, at) {
  el.setAttribute(AGE_ATTR, String(at));
  setAge(el, ago(Date.now() - at));
}

/**
 * Writes an age into the text node already there rather than over the element's children. `textContent` replaces
 * the node, which is a `childList` record and a relayout of the row - once a second, under the shimmering label
 * beside it. Writing `nodeValue` is a `characterData` record, which nothing on either board watches for.
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

/**
 * Advances every rendered duration where it stands. A rebuild would cost the lane's scroll and the keyboard focus,
 * and the phase itself only changes when a hook fires - so the text is rewritten and the elements are left alone.
 */
function tickDurations() {
  for (const el of document.querySelectorAll(`[${AGE_ATTR}]`)) {
    const at = Number(el.getAttribute(AGE_ATTR));

    if (Number.isFinite(at)) {
      setAge(el, ago(Date.now() - at));
    }
  }
}

/**
 * Carries a newer observation onto a card that was not rebuilt. `signature` ignores the timestamps on purpose, so a session working steadily
 * keeps its element - and its next turn would otherwise be counted from the prompt of the one before it.
 */
function syncActivity(el, boardCard) {
  const by = new Map(boardCard.sessions.map((session) => [session.sessionId, session.activity]));

  for (const row of el.querySelectorAll('.session')) {
    const activity = by.get(row.dataset.sessionId);
    const state = activity ? row.querySelector('.state') : null;

    if (state) {
      age(state, activity.since);
      // The event too, not only the time: a tooltip naming what the board saw two events ago beside a duration
      // that just refreshed is two of the board's own claims about one session disagreeing (R24).
      tip(state, stateTitle(activity));
    }
  }
}

/** The status without the emoji the project board prefixes it with, and without the variation selector after it. */
function statusLabel(status) {
  return status.replace(/^[\p{Extended_Pictographic}\uFE0F\s]+/u, '');
}

/**
 * GitHub names a colour rather than giving one, so the board maps its eight names onto the editor's chart palette —
 * the theme's own colours, which stay legible in light and dark where GitHub's hexes would not.
 */
/**
 * What each triage action is called. A copy of `TRIAGE_LABELS` in `packages/board`, because this script is a classic
 * script and imports nothing — pinned by the parity table in both suites, since a copy that drifts labels one board
 * differently from the other (`docs/testing.md`).
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

/** The one place a triage label is spelled, so both boards read a card the same way. */
function triageText(triage) {
  const label = TRIAGE_LABELS[triage.action] ?? triage.action;

  return triage.qualifier ? `${label} · ${triage.qualifier}` : label;
}

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

/** What a finished run reads as. `landed` is the run's own signal that it pushed; nothing else claims it (R23). */
const ACTION_OUTCOMES = {
  landed: { text: 'Merged', color: 'GREEN' },
  halted: { text: 'Stopped short', color: 'ORANGE' },
  failed: { text: 'Did not run', color: 'GRAY' },
  stopped: { text: 'Stopped', color: 'GRAY' },
};

/**
 * The control for a card action (R39). Four states, and only two of them do anything: a card the board can act on
 * offers to run it, and one it is running offers to take it back. A refusal is a chip with no click, because the
 * remedy is a setting or the card itself rather than pressing again.
 */
function actionChip(action, key) {
  const label = TRIAGE_LABELS[action.action] ?? action.action;

  if (action.state === 'running') {
    // R15: what stopping costs is said before it is pressed. A merge stopped mid-way leaves the working tree
    // part-merged, which is the developer's to finish or throw away.
    const chip = badge(
      'action-running',
      'Working…',
      'GRAY',
      `The board is running ${label} on this card. Click to stop it — whatever it has already done to the checkout stays there.`,
      () => vscode.postMessage({ type: 'stopAction', key }),
    );
    chip.dataset.running = 'true';

    return chip;
  }

  if (action.state === 'done') {
    const outcome = ACTION_OUTCOMES[action.outcome] ?? ACTION_OUTCOMES.failed;

    return badge('action-done', outcome.text, outcome.color, `${action.detail} Click to run ${label} again.`, () =>
      vscode.postMessage({ type: 'runAction', key }),
    );
  }

  if (action.state === 'refused') {
    return badge('action-refused', 'Not run', 'GRAY', action.reason);
  }

  return badge('action', `Run ${label.toLowerCase()}`, 'GRAY', `Start ${label} on this card, in its own checkout.`, () =>
    vscode.postMessage({ type: 'runAction', key }),
  );
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
    tip(el, title);
  }

  return el;
}

/**
 * What this card can be asked to do beyond its own chips. An item that could only ever refuse is worse than none —
 * the rule the session rows already follow — so a card with nothing to offer draws no control at all.
 */
function cardActions(boardCard) {
  const actions = [];

  if (hasCheckout(boardCard)) {
    actions.push({
      label: 'View changes',
      hint: "Open this card's commits and uncommitted changes in one editor",
      run: () => vscode.postMessage({ type: 'openChanges', key: boardCard.key }),
    });
  }

  return actions;
}

/** The card whose overflow menu is open: the menu itself, the control it hangs from, and how to stop watching for a close. */
let openMenu = null;

const MENU_MARGIN = 8;

/**
 * Hangs the menu under the control that opened it, right edges aligned and measured after it is on the document — a
 * guess at its width puts a menu on a right-hand lane hundreds of pixels from it. Flipped above rather than off the
 * bottom, and read afresh on every draw so it follows a card the board moved under it.
 */
function place(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  const own = menu.getBoundingClientRect();
  const below = rect.bottom + 4;
  const overflows = below + own.height > window.innerHeight - MENU_MARGIN;

  menu.style.top = `${overflows ? Math.max(MENU_MARGIN, rect.top - 4 - own.height) : below}px`;
  menu.style.left = `${Math.max(MENU_MARGIN, Math.min(rect.right - own.width, window.innerWidth - own.width - MENU_MARGIN))}px`;
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
 * What closes a menu from outside itself, installed while one is open and torn down with it. Every handler reads
 * `openMenu` rather than closing over what opened them, because a draw can re-anchor a menu to a rebuilt card.
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
    // A checked item is a state the menu is about to change rather than an action, and the two read differently.
    item.setAttribute('role', action.checked === undefined ? 'menuitem' : 'menuitemcheckbox');

    if (action.checked !== undefined) {
      item.setAttribute('aria-checked', String(action.checked));
    }

    const check = document.createElement('span');

    // Drawn on every item, checkable or not, so one item carrying a mark does not indent the labels beside it.
    check.className = 'menu-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = action.checked ? '✓' : '';
    item.appendChild(check);
    item.append(action.label);
    // The label names the item, so the tooltip is what it does rather than a second copy of the name.
    tip(item, action.hint);
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      // Back to the control, not to the top of the document: an action the host refuses must leave the keyboard here.
      closeMenu(true);
      action.run();
    });
    menu.appendChild(item);
  }

  menu.addEventListener('keydown', (event) => {
    const items = Array.from(menu.querySelectorAll('button'));

    // Not preventing the default: the focus is on the control by the time the browser acts on it, so Tab leaves for
    // whatever follows the card rather than for the end of the board, which is where this menu sits in the document.
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

  // Focused before the watch is armed: a menu that lands partly off screen scrolls the document to bring its item
  // into view, and a scroll watch already armed would read that as the board moving and close what it just opened.
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
 * The behaviour every overflow control shares: a second click on the one already open closes it rather than drawing
 * a second, and either arrow opens it with the keyboard already on an item. The items are fetched at the moment of
 * opening, because a toggle among them carries the state it had then.
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
  // The glyph says nothing on its own, so the pointer gets a tooltip; the name is what carries which card it is about.
  tip(el, 'More actions');
  nameFor(el, `More actions for ${cardName(boardCard)}`);
  // Without this, a few pixels of drift on the way to a click starts a drag of the card and the click never fires.
  el.draggable = false;
  wireMenuControl(el, boardCard.key, `Actions for ${cardName(boardCard)}`, () => cardActions(boardCard));

  return el;
}

/**
 * What a card with no issue is called: the repository and the branch its sessions share. Every session on such a
 * card is in one checkout, so the first speaks for all of them. Both fall back to the directory where git is silent.
 */
function checkoutName(boardCard) {
  const session = boardCard.sessions[0];
  const dir = basename(session.checkoutRoot ?? session.cwd);
  const parts = session.repository === null ? [] : session.repository.split('/');

  return {
    repository: parts[parts.length - 1] ?? dir,
    // Without the key's host, which is in it so two hosts' copies of one name compare unequal and says nothing about
    // which checkout this is. The owner does, where two of one name are checked out at once.
    owner: parts.length === 0 ? dir : parts.slice(1).join('/'),
    branch: session.branch,
    directory: dir,
  };
}

/**
 * The card in one phrase, for a control that is read rather than looked at. The title alone is enough on a card that
 * carries an issue; on a checkout it is a branch, which names no repository, and two `master` cards would read alike.
 */
function cardName(boardCard) {
  if (boardCard.issue) {
    return cardTitle(boardCard);
  }

  const checkout = checkoutName(boardCard);

  return checkout.branch === null ? checkout.directory : `${checkout.repository} ${checkout.branch}`;
}

/**
 * A menu open while the board redrew. A card whose element was rebuilt hands the menu its new control; a card that
 * left the board takes its menu with it, rather than leaving one hanging off an element no longer on the page.
 */
function followMenu() {
  if (openMenu === null) {
    return;
  }

  if (!openMenu.anchor.isConnected) {
    const anchor = cardEls.get(openMenu.key)?.el.querySelector('.card-menu');

    // The element itself, never the roster: `cardEls` keeps the card an archived lane is holding off screen, and a
    // menu re-anchored to one measures a zero rect and parks itself in the corner of the board.
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
 * An issue's repository as the card draws it: the name without its owner, which is how GitHub writes it on a card of
 * its own. Absent on a snapshot an older hub cached, and the card then carries the number alone rather than a blank.
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

  const role = actor.source === 'pull-request' ? 'pull request author' : 'issue assignee';

  tip(el, `${actor.login} · ${role}`);
  el.setAttribute('role', 'img');
  nameFor(el, `${actor.login}, ${role}`);

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

    // The repository stands where an issue card carries its number. Under no branch the card is a bare directory,
    // which the title already names, so the count of what is running there is the more useful word.
    if (checkout.branch === null) {
      number.textContent = boardCard.sessions.length === 1 ? 'session' : 'sessions';
    } else {
      number.className = 'number checkout';
      number.textContent = checkout.repository;
      tip(number, checkout.owner);
    }
  } else {
    // The repository beside the number, as GitHub writes it on its own card: two boards' cards for one issue read alike,
    // and a board spanning repositories says which one a card is from.
    const repo = repoName(issue);

    number.textContent = repo === null ? `#${boardCard.issueNumber}` : `${repo} #${boardCard.issueNumber}`;
  }

  if (issue) {
    const repo = repoName(issue);
    const said = repo === null ? `issue #${issue.number}` : `issue ${repo} #${issue.number}`;

    number.type = 'button';
    // No tooltip: the number and its repository are the whole fact, and opening the issue is what a link on a card
    // does. The button's text says neither, so a reader still gets the action as the accessible name.
    nameFor(number, `Open ${said} on GitHub`);
    // Without this, a few pixels of drift on the way to a click starts a drag of the card and the click never fires.
    number.draggable = false;
    number.addEventListener('click', () => vscode.postMessage({ type: 'openIssue', number: issue.number }));
  }

  const avatarSlot = document.createElement('span');
  avatarSlot.className = 'avatar-slot';

  if (issue?.avatar) {
    avatarSlot.appendChild(avatar(issue.avatar, avatarPool));
  }

  // What GitHub says the card is, under its title: the type, the stage the team put it in, and its pull request.
  const badges = document.createElement('span');
  badges.className = 'badges github';
  badges.setAttribute('role', 'group');
  badges.setAttribute('aria-label', 'GitHub labels');

  // What this board adds on top of that, set apart in the card's own footer so the two are never read as one row.
  // Named as well as painted: a tint and a rule split them for the eye and for nothing else.
  const marks = document.createElement('span');
  marks.className = 'badges marks';
  marks.setAttribute('role', 'group');
  marks.setAttribute('aria-label', 'Board status');

  meta.appendChild(number);

  const actions = cardActions(boardCard);

  if (actions.length > 0) {
    meta.appendChild(cardMenuControl(boardCard));
  }

  meta.appendChild(avatarSlot);

  el.appendChild(meta);

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'card-open';

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = cardTitle(boardCard);

  open.appendChild(title);

  if (issue) {
    open.addEventListener('click', () => vscode.postMessage({ type: 'openIssue', number: issue.number }));
  } else {
    open.disabled = true;
  }

  el.appendChild(open);
  el.appendChild(badges);

  // The board's own reading of the card, its sessions, and the controls it will grow — set apart from GitHub's facts
  // above it. Drawn on every card, including one with nothing in it yet, so a lane of cards has one silhouette.
  const foot = document.createElement('div');
  foot.className = 'card-foot';
  foot.appendChild(marks);
  el.appendChild(foot);

  if (issue?.type) {
    // No tooltip on any of the three below: the chip is the whole fact, and a hover repeating it is a hover to learn
    // to ignore. What the pull-request chip's colour says about its state stays in its own accessible name.
    badges.appendChild(badge('type', issue.type, issue.typeColor, null));
  }

  if (issue?.status) {
    // The board's own status word without its emoji: the badge is the marker, so the emoji would say it twice.
    badges.appendChild(badge('status', statusLabel(issue.status), issue.statusColor, null));
  }

  if (issue?.pullRequest) {
    const pr = badge(
      'pull-request',
      `#${issue.pullRequest.number}`,
      PR_COLORS[issue.pullRequest.state] ?? null,
      null,
      () => vscode.postMessage({ type: 'openPullRequest', number: issue.number }),
    );
    nameFor(
      pr,
      `Open pull request #${issue.pullRequest.number}, ${issue.pullRequest.state.toLowerCase()}, on GitHub`,
    );
    pr.prepend(pullRequestMark());
    badges.appendChild(pr);
  }

  // R6, and no chip of its own: the card's edge carries it, and so does the row it is about, whose mark, words and
  // weight all take that colour. A pill saying `Needs you` beside a row already painted yellow was the same claim
  // twice. What a colour cannot reach is carried instead by the state mark's own accessible name.
  if (boardCard.attention) {
    el.dataset.attention = boardCard.attention;
  }

  if (boardCard.returned) {
    const mark = badge('returned', 'Returned', 'ORANGE');
    tip(mark, 'This card was past your hands and has come back.');
    marks.appendChild(mark);
  }

  // R38. Deliberately none of R6's three channels: a card being read, or one that has been, is asking for nothing.
  const triage = boardCard.triage;

  const readAgain = () => vscode.postMessage({ type: 'retriage', key: boardCard.key });

  if (triage?.state === 'running') {
    marks.appendChild(badge('triage-running', 'Reading…', 'GRAY', 'Working out what this card is waiting on.'));
  } else if (triage?.state === 'failed') {
    // No words about what went wrong: that is one line above the lanes (R25). What this is, is somewhere to click,
    // without which the cards that most need reading again are the only ones with nothing to press.
    marks.appendChild(
      badge(
        'triage-failed',
        'Not read',
        'GRAY',
        triage.exhausted
          ? `The board could not read this card after ${triage.attempts} tries and has stopped trying. Click to try now.`
          : `The board could not read this card. Click to try now.`,
        readAgain,
      ),
    );
  } else if (triage?.state === 'done') {
    // GRAY rather than a colour: YELLOW and BLUE are R6's two marks and GREEN is a working session, so none is free.
    // The sentence the reading produced is the chip's tooltip rather than a line of the card: it is a paragraph of
    // prose on every card that has one, and a lane of them was more of the footer than the cards themselves.
    const read = triage.stale
      ? `Read ${ago(Date.now() - triage.at)} ago; the card has moved since.`
      : `Read ${ago(Date.now() - triage.at)} ago.`;
    const chip = badge('triage', triageText(triage), 'GRAY', `${triage.detail} ${read}`);

    chip.dataset.stale = String(triage.stale);

    // The age and the control stand in one another's place at the end of the chip: the reading is what a lane is
    // scanned for, and a button per card is a row of controls waiting to be used rather than a list to read.
    const end = document.createElement('span');

    end.className = 'triage-end';

    // How long the card has held the status it is in — not when the board read it, which is in the tooltip with the
    // sentence it produced. A reading is about a card in a state, and how long that state has held is what says
    // whether it is still the card to pick up: a review handed over an hour ago and one sitting a week read alike
    // otherwise. Null off the project board, where GitHub records no move to date.
    const moved = issue?.statusChangedAt ? Date.parse(issue.statusChangedAt) : NaN;

    if (Number.isFinite(moved)) {
      const held = document.createElement('span');

      held.className = 'triage-age';
      age(held, moved);
      end.appendChild(held);
      // Only where there is an age to separate: a card off the project board carries the control and nothing before it.
      chip.append(' · ');
    }

    // The control, not the chip: reading a card again spends the developer's usage, so it takes a press of its own
    // rather than being what happens to anyone who clicked the words to see them in full.
    const again = document.createElement('button');

    again.type = 'button';
    again.className = 'triage-again';
    again.draggable = false;
    again.appendChild(syncMark());
    nameFor(again, 'Read this card again');
    tip(again, 'Read this card again.');
    again.addEventListener('click', (event) => {
      event.stopPropagation();
      readAgain();
    });
    end.appendChild(again);
    chip.appendChild(end);
    marks.appendChild(chip);
  }

  // R39. Beside the reading it acts on, and never one of R6's channels: work the board started is work in progress,
  // which is the one thing a card is not asking the developer for.
  const action = boardCard.action;

  if (action) {
    marks.appendChild(actionChip(action, boardCard.key));
  }

  for (const session of boardCard.sessions) {
    foot.appendChild(sessionLine(session));
  }
  if (!boardCard.sessions.some((session) => !session.finished)) {
    const historical = historyLine(boardCard.lastSession);
    if (historical) foot.appendChild(historical);
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

    if (open.disabled) {
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

  header.append(name, count);

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
    boardCard.action,
    boardCard.issue,
    boardCard.lastSession,
    boardCard.lastSession ? openable.has(boardCard.lastSession.sessionId) : false,
    // The phase, not the activity: `since` moves at every turn, and including it would rebuild the card each time -
    // losing the scroll, the avatars and the focus this whole mechanism exists to keep.
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

  const el = card(boardCard, avatarPoolOf(known?.el), placeable);
  known?.el.remove();
  cardEls.set(boardCard.key, { el, sig });

  return el;
}

/** Walks `nodes` into `parent` in order, moving what is already there rather than replacing the lot. */
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

function countCards(lanes) {
  return lanes.reduce((total, lane) => total + lane.cards.length, 0);
}

/**
 * What this webview put on screen, told to the extension after every render. Nothing else can see it: a script the
 * content policy or a bundling mistake stopped from running leaves the board on its loading line forever, and the
 * extension has no other way to know (R25).
 */
function render(payload) {
  draw(payload);

  // A card this render replaced is one the tooltip is still open over, and its rect is gone with it.
  if (tipAnchor !== null && !tipAnchor.isConnected) {
    hideTip();
  }

  // Every field is read off the document, never off the payload: a report that echoed what it was given would
  // hold just as well for a board that drew nothing at all.
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

  vscode.setState({ payload, showArchived });

  const shown = payload.lanes.filter((lane) => lane.id !== 'archived' || showArchived);

  onBoard.clear();

  for (const lane of payload.lanes) {
    for (const boardCard of lane.cards) {
      onBoard.add(boardCard.key);
    }
  }
  const total = countCards(shown);
  const when = readTime(payload);
  const count = `${total} card${total === 1 ? '' : 's'}`;
  metaEl.textContent = when === null ? count : `${count} · updated ${when.toLocaleTimeString()}`;

  if (stale) {
    metaEl.textContent = `${metaEl.textContent} · could not refresh`;
  }

  for (const failure of payload.failures) {
    notice(failure.message, failure.remedy, true);
  }

  if (payload.hooks) {
    notice(payload.hooks.notice, null, false);
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
      'The board reads a bounded number of pages per refresh.',
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
 * The board's own overflow control, wired once: the header is in the document from the start, so unlike a card's
 * this one is never rebuilt. Wired here rather than beside `boardActions` because the glyph needs `SVG`, which a
 * `const` declared further down the file does not hoist to there.
 */
nameFor(boardMenuEl, 'Board actions');
wireMenuControl(boardMenuEl, BOARD_MENU_KEY, 'Board actions', boardActions);
paintLogs(false);

// Read before the payload guard: a stored board too old to draw does not make the developer's Archived choice stale.
showArchived = restored?.showArchived === true;

if (isCurrentPayload(restored?.payload)) {
  render(restored.payload);
}

// Last, and once per run of this script. The extension answers with the state of the controls it owns - a webview
// reloads on its own (a tab returning from the background, a renderer restored) and nothing else tells it that.
vscode.postMessage({ type: 'ready' });
