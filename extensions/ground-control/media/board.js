// @ts-check
const vscode = acquireVsCodeApi();

const lanesEl = document.getElementById('lanes');
const metaEl = document.getElementById('meta');
const noticesEl = document.getElementById('notices');
const archivedEl = /** @type {HTMLInputElement} */ (document.getElementById('show-archived'));

document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

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
  return session.title ?? session.name ?? session.shortId ?? basename(session.cwd);
}

const SVG = 'http://www.w3.org/2000/svg';
// Claude's own mark, verbatim from the official extension's resources/claude-logo.svg, at its brand colour.
const CLAUDE_MARK =
  'M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z';

/** Claude's mark. Any other CLI keeps its name in text - R2 says the board says which agent reported a session. */
function agentMark(agent) {
  if (agent !== 'claude') {
    const el = document.createElement('span');
    el.className = 'agent';
    el.textContent = agent;

    return el;
  }

  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'agent agent-mark');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', agent);

  const title = document.createElementNS(SVG, 'title');
  title.textContent = agent;

  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', CLAUDE_MARK);
  path.setAttribute('fill-rule', 'nonzero');

  svg.append(title, path);

  return svg;
}

function sessionLine(session) {
  const el = document.createElement('span');
  el.className = 'session';
  el.dataset.sessionId = session.sessionId;

  const agent = agentMark(session.agent);

  const label = document.createElement('span');
  label.className = 'session-label';
  label.textContent = sessionLabel(session);

  el.append(agent, label);

  const activity = session.activity;

  if (activity) {
    el.dataset.phase = activity.phase;
  }

  const state = document.createElement('span');
  state.className = 'state';

  // One state per row, never two. The board's own observation where it has one, the CLI's own word where it does
  // not - a row reading "idle" beside a shimmering label is two of the board's claims disagreeing (R24).
  if (activity) {
    state.dataset.activitySince = String(activity.since);
    state.textContent = phaseText(activity);
    state.title = stateTitle(activity);
    el.appendChild(state);

    return el;
  }

  const reported = session.state ?? session.status;

  if (reported) {
    state.textContent = reported;
    el.appendChild(state);
  }

  return el;
}

const PHASE_WORDS = { running: 'running', waiting: 'needs you', idle: 'idle' };

const PHASE_TITLES = {
  running: 'This session is working. The duration counts the turn it is in, from the prompt that began it where the board saw one.',
  waiting: 'This session is waiting on you.',
  idle: 'The board last saw this session finish.',
};

/**
 * How long ago, coarsely, and never rounded up. Overstating is the one direction that matters: a session working
 * steadily must not read older than it is, because that is what a stuck one is supposed to look like.
 */
function ago(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);

  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60 === 0 ? '' : ` ${minutes % 60}m`}`;
}

/** The phase and how long it has held: a running session's turn, and the reporting event for every other phase (R5). */
function phaseText(activity) {
  return `${PHASE_WORDS[activity.phase] ?? activity.phase} ${ago(Date.now() - activity.since)}`;
}

/** What the row says on hover: what the board concluded, and the hook event it concluded it from. */
function stateTitle(activity) {
  const what = PHASE_TITLES[activity.phase] ?? '';

  return activity.event ? `${what} Last seen at the ${activity.event} hook.`.trim() : what;
}

/**
 * Advances every rendered duration where it stands. A rebuild would cost the lane's scroll and the keyboard focus,
 * and the phase itself only changes when a hook fires - so the text is rewritten and the elements are left alone.
 */
function tickDurations() {
  for (const el of document.querySelectorAll('[data-activity-since]')) {
    const since = Number(el.dataset.activitySince);
    const phase = el.closest('.session')?.dataset.phase;

    if (!Number.isFinite(since) || !phase) {
      continue;
    }

    const text = phaseText({ phase, since });

    if (el.textContent !== text) {
      el.textContent = text;
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
      state.dataset.activitySince = String(activity.since);
      // The event too, not only the time: a tooltip naming what the board saw two events ago beside a duration
      // that just refreshed is two of the board's own claims about one session disagreeing (R24).
      state.title = stateTitle(activity);
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

/**
 * How each kind of attention reads on a card. `blocked` is an agent that cannot go on without the developer; `your-turn` is one that ended
 * its turn and handed control back. `phase` is the session phase whose rows the badge names, so the tooltip says which session it means.
 */
const ATTENTION = {
  blocked: { text: 'Needs you', color: 'YELLOW', phase: 'waiting', said: 'is waiting on you.' },
  'your-turn': { text: 'Your turn', color: 'BLUE', phase: 'idle', said: 'finished its turn — you have not replied since.' },
};

/** The agent's own word for finished. A session that said it is blocked cannot still be blocked on anybody. */
function isTerminal(session) {
  return session.state === 'done' || session.state === 'stopped';
}

/** A pull request's own state colours, matching what GitHub paints them. */
const PR_COLORS = { OPEN: 'GREEN', MERGED: 'PURPLE', CLOSED: 'RED' };

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
    el.title = title;
  }

  return el;
}

function cardTitle(boardCard) {
  if (boardCard.issue) {
    return boardCard.issue.title;
  }

  // A card with no issue is a directory, not one session, so it is named for the directory its sessions run in.
  if (boardCard.issueNumber === null) {
    return basename(boardCard.sessions[0].cwd);
  }

  // A session names an issue the developer does not own. R2 forbids hiding the session, so the card says why it is bare.
  return 'Not among your assigned issues';
}

/** GitHub's own pull-request glyph, so the badge reads as a PR rather than a second issue number. */
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
  el.title = `${actor.login} · ${role}`;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', `${actor.login}, ${role}`);

  return el;
}

function card(boardCard, avatarPool, placeable) {
  const el = document.createElement('article');
  const issue = boardCard.issue;
  el.className = issue?.type ? `card type-${issue.type.toLowerCase()}` : 'card';

  const meta = document.createElement('span');
  meta.className = 'card-meta';

  const number = document.createElement(issue ? 'button' : 'span');
  number.className = issue ? 'number link' : 'number';
  number.textContent =
    boardCard.issueNumber === null
      ? `${boardCard.sessions.length === 1 ? 'session' : 'sessions'}`
      : `#${boardCard.issueNumber}`;

  if (issue) {
    number.type = 'button';
    number.title = `Open issue #${issue.number} on GitHub`;
    // The button's text is a bare number, and that is the name a screen reader uses — `title` is only a description.
    number.setAttribute('aria-label', `Open issue #${issue.number} on GitHub`);
    // Without this, a few pixels of drift on the way to a click starts a drag of the card and the click never fires.
    number.draggable = false;
    number.addEventListener('click', () => vscode.postMessage({ type: 'openIssue', number: issue.number }));
  }

  const avatarSlot = document.createElement('span');
  avatarSlot.className = 'avatar-slot';

  if (issue?.avatar) {
    avatarSlot.appendChild(avatar(issue.avatar, avatarPool));
  }

  const badges = document.createElement('span');
  badges.className = 'badges';

  meta.append(number, badges, avatarSlot);
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

  if (issue?.type) {
    badges.appendChild(badge('type', issue.type, issue.typeColor, issue.type));
  }

  if (issue?.status) {
    // The board's own status word without its emoji: the badge is the marker, so the emoji would say it twice.
    badges.appendChild(badge('status', statusLabel(issue.status), issue.statusColor, issue.status));
  }

  if (issue?.pullRequest) {
    const pr = badge(
      'pull-request',
      `#${issue.pullRequest.number}`,
      PR_COLORS[issue.pullRequest.state] ?? null,
      `Pull request #${issue.pullRequest.number} — ${issue.pullRequest.state.toLowerCase()}`,
      () => vscode.postMessage({ type: 'openPullRequest', number: issue.number }),
    );
    pr.setAttribute(
      'aria-label',
      `Open pull request #${issue.pullRequest.number}, ${issue.pullRequest.state.toLowerCase()}, on GitHub`,
    );
    pr.prepend(pullRequestMark());
    badges.appendChild(pr);
  }

  if (boardCard.returned) {
    const mark = badge('returned', 'Returned', 'ORANGE');
    mark.title = 'This card was past your hands and has come back.';
    badges.appendChild(mark);
  }

  // R6: on the card, not only on the session row, so it reads from across a full board. Three channels - the word,
  // the border, and the row's own weight - because colour alone is not unmistakable to everyone who uses this.
  const attention = ATTENTION[boardCard.attention];

  if (attention) {
    const named = boardCard.sessions.filter(
      (session) => session.activity?.phase === attention.phase && !(attention.phase === 'waiting' && isTerminal(session)),
    );

    el.dataset.attention = boardCard.attention;
    badges.appendChild(
      badge(
        boardCard.attention,
        attention.text,
        attention.color,
        named.map((s) => `${sessionLabel(s)} ${attention.said}`).join(' '),
      ),
    );
  }

  for (const session of boardCard.sessions) {
    el.appendChild(sessionLine(session));
  }

  // The lane is the developer's own placement, so a card carries its own way to move. Alt+arrow is the same move from
  // a keyboard, which drag alone does not give.
  if (boardCard.lane !== 'archived') {
    const at = placeable.indexOf(boardCard.lane);

    el.draggable = true;
    el.addEventListener('dragstart', (event) => {
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
    boardCard.issue,
    // The phase, not the activity: `since` moves at every turn, and including it would rebuild the card each time -
    // losing the scroll, the avatars and the focus this whole mechanism exists to keep.
    boardCard.sessions.map((s) => [
      s.agent,
      s.sessionId,
      s.title,
      s.name,
      s.shortId,
      s.cwd,
      s.state,
      s.status,
      s.activity?.phase ?? null,
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

function render(payload) {
  board = payload;

  noticesEl.replaceChildren();

  // A failed source keeps its last good read on screen, dimmed. Clearing it would imply the board verified there is
  // nothing to show; leaving it bright would imply the read succeeded.
  const stale = payload.failures.length > 0;
  lanesEl.classList.toggle('stale', stale);
  metaEl.classList.toggle('stale', stale);

  // The lanes a card can be moved into come from the payload, so the webview never holds a second list of lane names.
  const placeable = payload.lanes.filter((lane) => lane.id !== 'archived').map((lane) => lane.id);
  const archived = payload.lanes.find((lane) => lane.id === 'archived');

  // Nothing archived means no toggle, so the box is cleared too - otherwise an empty Archived column has no control.
  if (!archived || archived.cards.length === 0) {
    archivedEl.checked = false;
  }

  vscode.setState({ payload, showArchived: archivedEl.checked });

  const shown = payload.lanes.filter((lane) => lane.id !== 'archived' || archivedEl.checked);

  onBoard.clear();

  for (const lane of payload.lanes) {
    for (const boardCard of lane.cards) {
      onBoard.add(boardCard.key);
    }
  }
  document.getElementById('archived-toggle').hidden = !archived || archived.cards.length === 0;
  document.getElementById('archived-count').textContent = archived ? String(archived.cards.length) : '0';

  const total = countCards(shown);
  const when = readTime(payload);
  const count = `${total} card${total === 1 ? '' : 's'}`;
  metaEl.textContent = when === null ? count : `${count} · read ${when.toLocaleTimeString()}`;

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

    return;
  }

  reconcile(
    lanesEl,
    shown.map((lane) => syncLane(lane, placeable)),
  );

  // After the cards, never before: a reused card is handed its newer observation time as it is reconciled.
  tickDurations();
}

archivedEl.addEventListener('change', () => {
  if (board) {
    render(board);
  }
});

window.addEventListener('message', (event) => {
  const message = event.data;

  if (message.type === 'loading') {
    metaEl.textContent = 'Reading GitHub…';
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

if (restored?.payload?.lanes) {
  archivedEl.checked = restored.showArchived === true;
  render(restored.payload);
}
