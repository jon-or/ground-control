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

function card(issue) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = issue.type ? `card type-${issue.type.toLowerCase()}` : 'card';
  el.title = `#${issue.number} ${issue.title}`;

  const number = document.createElement('span');
  number.className = 'number';
  number.textContent = `#${issue.number}`;

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = issue.title;

  el.append(number, title);

  if (issue.status) {
    const status = document.createElement('span');
    status.className = 'status';
    // The project board's own status text, emoji included - the board must not invent a second vocabulary.
    status.textContent = issue.status;
    el.appendChild(status);
  }

  if (issue.type) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = issue.type;
    el.appendChild(chip);
  }

  el.addEventListener('click', () => vscode.postMessage({ type: 'openIssue', number: issue.number }));

  return el;
}

function render(payload) {
  vscode.setState(payload);

  noticesEl.replaceChildren();
  cardsEl.replaceChildren();
  cardsEl.classList.remove('stale');
  metaEl.classList.remove('stale');

  const when = new Date(payload.fetchedAt);
  metaEl.textContent = `${payload.cards.length} card${payload.cards.length === 1 ? '' : 's'} · read ${when.toLocaleTimeString()}`;

  if (payload.notOnProject > 0) {
    notice(
      `${payload.notOnProject} assigned issue${payload.notOnProject === 1 ? ' is' : 's are'} not on the configured project board, so they are not shown.`,
      'Switch groundControl.cardSource to issueSearch to include them.',
      false,
    );
  }

  if (payload.truncated) {
    // `matched` is what this board's own query found. `totalAssigned` is the wider set and would overstate the gap.
    notice(
      `More issues match than were read. Showing ${payload.cards.length} of ${payload.matched}.`,
      'The board reads a bounded number of pages per refresh.',
      false,
    );
  }

  if (payload.cards.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent =
      payload.totalAssigned === 0
        ? 'No open issues are assigned to you.'
        : 'None of your assigned issues match the current card source.';
    cardsEl.appendChild(empty);
    return;
  }

  for (const issue of payload.cards) {
    cardsEl.appendChild(card(issue));
  }
}

window.addEventListener('message', (event) => {
  const message = event.data;

  if (message.type === 'loading') {
    metaEl.textContent = 'Reading GitHub…';
    return;
  }

  if (message.type === 'cards') {
    render(message);
    return;
  }

  if (message.type === 'error') {
    // The last good list stays on screen, dimmed, and keeps its notices and read time. Clearing either would
    // imply the board had verified that there is nothing to show, or that the dimmed list is current.
    notice(message.message, message.remedy, true);
    cardsEl.classList.add('stale');
    metaEl.classList.add('stale');
    metaEl.textContent = metaEl.textContent.includes('could not refresh')
      ? metaEl.textContent
      : `${metaEl.textContent} · could not refresh`;
  }
});

const restored = vscode.getState();

if (restored) {
  render(restored);
}
