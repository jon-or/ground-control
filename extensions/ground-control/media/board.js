// @ts-check
const vscode = acquireVsCodeApi();

const cardsEl = document.getElementById('cards');
const metaEl = document.getElementById('meta');
const noticesEl = document.getElementById('notices');

document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

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

function basename(dir) {
  const parts = dir.split(/[\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

function sessionLabel(session) {
  return session.name ?? session.shortId ?? basename(session.cwd);
}

function sessionLine(session) {
  const el = document.createElement('span');
  el.className = 'session';

  const agent = document.createElement('span');
  agent.className = 'agent';
  agent.textContent = session.agent;

  const label = document.createElement('span');
  label.className = 'session-label';
  label.textContent = sessionLabel(session);

  el.append(agent, label);

  // The provider's own words for what the session is doing. R23 - the board reports state, it does not infer it.
  const reported = session.state ?? session.status;

  if (reported) {
    const state = document.createElement('span');
    state.className = 'state';
    state.textContent = reported;
    el.appendChild(state);
  }

  return el;
}

function card(boardCard) {
  const el = document.createElement('button');
  el.type = 'button';

  const issue = boardCard.issue;
  el.className = issue?.type ? `card type-${issue.type.toLowerCase()}` : 'card';

  const number = document.createElement('span');
  number.className = 'number';
  number.textContent = boardCard.issueNumber === null ? '' : `#${boardCard.issueNumber}`;

  const title = document.createElement('span');
  title.className = 'title';

  if (issue) {
    title.textContent = issue.title;
  } else if (boardCard.issueNumber !== null) {
    // A session names an issue the developer does not own. R2 forbids hiding the session, so the card says why it is bare.
    title.textContent = 'Not among your assigned issues';
    el.classList.add('unowned');
  } else {
    title.textContent = sessionLabel(boardCard.sessions[0]);
    el.classList.add('session-only');
  }

  el.title = boardCard.issueNumber === null ? title.textContent : `#${boardCard.issueNumber} ${title.textContent}`;

  el.append(number, title);

  if (issue?.status) {
    const status = document.createElement('span');
    status.className = 'status';
    // The project board's own status text, emoji included - the board must not invent a second vocabulary.
    status.textContent = issue.status;
    el.appendChild(status);
  }

  if (issue?.type) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = issue.type;
    el.appendChild(chip);
  }

  for (const session of boardCard.sessions) {
    el.appendChild(sessionLine(session));
  }

  if (issue) {
    el.addEventListener('click', () => vscode.postMessage({ type: 'openIssue', number: issue.number }));
  } else {
    el.disabled = true;
  }

  return el;
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

function render(payload) {
  vscode.setState(payload);

  noticesEl.replaceChildren();
  cardsEl.replaceChildren();

  // A failed source keeps its last good read on screen, dimmed. Clearing it would imply the board verified there is
  // nothing to show; leaving it bright would imply the read succeeded.
  const stale = payload.failures.length > 0;
  cardsEl.classList.toggle('stale', stale);
  metaEl.classList.toggle('stale', stale);

  const when = readTime(payload);
  const count = `${payload.cards.length} card${payload.cards.length === 1 ? '' : 's'}`;
  metaEl.textContent = when === null ? count : `${count} · read ${when.toLocaleTimeString()}`;

  if (stale) {
    metaEl.textContent = `${metaEl.textContent} · could not refresh`;
  }

  for (const failure of payload.failures) {
    notice(failure.message, failure.remedy, true);
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

  if (payload.issues?.truncated) {
    // `matched` is what this board's own query found. `totalAssigned` is the wider set and would overstate the gap.
    notice(
      `More issues match than were read. Showing ${payload.issues.count} of ${payload.issues.matched}.`,
      'The board reads a bounded number of pages per refresh.',
      false,
    );
  }

  if (payload.cards.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = emptyText(payload);
    cardsEl.appendChild(empty);
    return;
  }

  for (const boardCard of payload.cards) {
    cardsEl.appendChild(card(boardCard));
  }
}

window.addEventListener('message', (event) => {
  const message = event.data;

  if (message.type === 'loading') {
    metaEl.textContent = 'Reading GitHub…';
    return;
  }

  if (message.type === 'board') {
    render(message);
  }
});

const restored = vscode.getState();

if (restored) {
  render(restored);
}
