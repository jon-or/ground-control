// @ts-check
/* global acquireVsCodeApi */

/**
 * The action table editor (R39). The extension host sends the saved table and saves what this page sends back; the
 * settings stay the record, and settings.json edits the same values.
 */
const vscode = acquireVsCodeApi();

/** Actions a row can name, with the labels the board shows for them. */
const ACTIONS = [
  ['merge', 'Merge'],
  ['review-others', 'Review their PR'],
  ['address-review', 'Answer review'],
];

/** The qualifiers each action's rows may name; a row with none matches any. */
const QUALIFIERS = {
  merge: ['upstream', 'stacked', 'test', 'base'],
  'review-others': ['initial', 'followup'],
  'address-review': ['initial', 'followup'],
};

/** Each placeholder, what fills it, and the actions it is filled for. Merge · base fills them from the base's pull request. */
const PLACEHOLDERS = [
  ['{issue}', 'Issue number', 'All'],
  ['{repo}', 'Repository, owner/name', 'All'],
  ['{pr}', 'Pull request number', 'All'],
  ['{branch}', 'Pull request head branch', 'All'],
  ['{base}', 'Pull request base branch; on a stacked pull request, the board first merges the default branch into it with Merge · base', 'All'],
  ['{default}', 'Repository default branch, where every merge leg starts', 'All'],
  ['{target}', 'Test branch the request named', 'Merge · test; empty for every other row'],
  ['{checkout}', 'The worktree the run works in', 'All'],
  ['{resultPath}', 'Result file; the contract is appended when the prompt omits it', 'All'],
];

/** @typedef {{ action: string, qualifier: string | null, prompt: string, automatic: boolean }} Row */

/** @type {{ rows: Row[], pattern: string }} */
let saved = { rows: [], pattern: '^Test-' };
/** @type {Row[]} */
let rows = [];
let pattern = '^Test-';
/** Whether the table has been sent at least once; nothing is editable before. */
let loaded = false;
/** Settings changed outside this page while it held unsaved edits. */
let changedElsewhere = false;
/** The host's answer to the last save, shown until the next edit. */
let status = '';

const root = /** @type {HTMLElement} */ (document.getElementById('table'));

/** @param {unknown} value @returns {Row[]} */
function readRows(value) {
  if (!Array.isArray(value)) return [];

  return value.flatMap((row) =>
    row !== null && typeof row === 'object' && typeof row.action === 'string'
      ? [{
          action: row.action,
          qualifier: typeof row.qualifier === 'string' ? row.qualifier : null,
          prompt: typeof row.prompt === 'string' ? row.prompt : '',
          automatic: row.automatic === true,
        }]
      : [],
  );
}

function dirty() {
  return pattern !== saved.pattern || JSON.stringify(rows) !== JSON.stringify(saved.rows);
}

/** @param {string} action */
function actionLabel(action) {
  return ACTIONS.find(([id]) => id === action)?.[1] ?? action;
}

/** @param {Row} row */
function rowLabel(row) {
  return row.qualifier === null ? actionLabel(row.action) : `${actionLabel(row.action)} · ${row.qualifier}`;
}

/** What blocks a save, and what only warns. */
function problems() {
  /** @type {string[]} */
  const blocking = [];
  /** @type {string[]} */
  const warnings = [];
  const seen = new Set();

  for (const row of rows) {
    const key = `${row.action}|${row.qualifier}`;

    if (seen.has(key)) blocking.push(`${rowLabel(row)} has more than one row.`);
    seen.add(key);

    if (row.prompt.trim() === '') warnings.push(`${rowLabel(row)} has no prompt, so the card says so instead of running it.`);
  }

  if (pattern.trim() === '') {
    blocking.push('Set a test branch pattern.');
  } else {
    try {
      new RegExp(pattern.trim());
    } catch {
      blocking.push('The test branch pattern is not a valid regular expression.');
    }
  }

  return { blocking, warnings };
}

/**
 * @param {string} tag
 * @param {Record<string, string>} [attributes]
 * @param {string} [text]
 */
function el(tag, attributes = {}, text) {
  const node = document.createElement(tag);

  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;

  return node;
}

/** @param {Row} row @param {number} index */
function rowElement(row, index) {
  const line = el('tr');
  const n = index + 1;

  const action = /** @type {HTMLSelectElement} */ (el('select', { 'aria-label': `Action, row ${n}` }));
  for (const [id, label] of ACTIONS) action.appendChild(el('option', { value: id }, label));
  action.value = row.action;
  action.addEventListener('change', () => {
    const allowed = QUALIFIERS[/** @type {keyof typeof QUALIFIERS} */ (action.value)] ?? [];

    rows[index] = { ...rows[index], action: action.value, qualifier: row.qualifier !== null && allowed.includes(row.qualifier) ? row.qualifier : null };
    edited();
  });

  const qualifier = /** @type {HTMLSelectElement} */ (el('select', { 'aria-label': `Qualifier, row ${n}` }));
  qualifier.appendChild(el('option', { value: '' }, 'Any'));
  for (const id of QUALIFIERS[/** @type {keyof typeof QUALIFIERS} */ (row.action)] ?? []) qualifier.appendChild(el('option', { value: id }, id));
  qualifier.value = row.qualifier ?? '';
  qualifier.addEventListener('change', () => {
    rows[index] = { ...rows[index], qualifier: qualifier.value === '' ? null : qualifier.value };
    edited();
  });

  const prompt = /** @type {HTMLTextAreaElement} */ (el('textarea', { 'aria-label': `Prompt, row ${n}`, rows: '2', spellcheck: 'false' }));
  prompt.value = row.prompt;
  // Typing keeps focus: the table is not redrawn until the field is left.
  prompt.addEventListener('input', () => {
    rows[index] = { ...rows[index], prompt: prompt.value };
    paintState();
  });

  const automatic = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', 'aria-label': `Start without a click, row ${n}` }));
  automatic.checked = row.automatic;
  automatic.addEventListener('change', () => {
    rows[index] = { ...rows[index], automatic: automatic.checked };
    edited();
  });

  const remove = el('button', { type: 'button', class: 'remove', 'aria-label': `Remove row ${n}`, title: 'Remove this row' }, 'Remove');
  remove.addEventListener('click', () => {
    rows.splice(index, 1);
    edited();
  });

  for (const control of [action, qualifier, prompt, automatic, remove]) {
    const cell = el('td');

    cell.appendChild(control);
    line.appendChild(cell);
  }

  return line;
}

function edited() {
  status = '';
  render();
}

/** Save, revert, and the messages, which change on every keystroke without redrawing the rows. */
function paintState() {
  const { blocking, warnings } = problems();
  const save = /** @type {HTMLButtonElement | null} */ (root.querySelector('#save'));
  const revert = /** @type {HTMLButtonElement | null} */ (root.querySelector('#revert'));
  const list = root.querySelector('#problems');
  const said = root.querySelector('#status');

  if (save) save.disabled = !dirty() || blocking.length > 0;
  if (revert) revert.disabled = !dirty();

  if (list) {
    list.replaceChildren(
      ...blocking.map((text) => el('li', { class: 'blocking' }, text)),
      ...warnings.map((text) => el('li', { class: 'warning' }, text)),
      ...(changedElsewhere && dirty() ? [el('li', { class: 'warning' }, 'The settings changed outside this page. Saving replaces them.')] : []),
    );
  }

  if (said) said.textContent = status;
}

function render() {
  if (!loaded) {
    root.replaceChildren(el('p', {}, 'Reading the action table…'));

    return;
  }

  const heading = el('h1', {}, 'Action table');
  const lead = el(
    'p',
    { class: 'lead' },
    'Each row runs its prompt on a card whose triage names that action. A row with a qualifier takes precedence over one with Any. ' +
      'An automatic row starts without a click; every row can be started from the card. ' +
      'Merge · base runs first on a pull request based on another branch: it merges the default branch into that base, in the base’s worktree, ' +
      'with the base’s pull request filling the placeholders. Give it a single merge with no test merge or status change. ' +
      'The card’s own row decides whether it starts automatically.',
  );

  const table = el('table', { id: 'rows' });
  const head = el('tr');

  for (const title of ['Action', 'Qualifier', 'Prompt', 'Automatic', '']) head.appendChild(el('th', { scope: 'col' }, title));
  table.appendChild(el('thead')).appendChild(head);

  const body = table.appendChild(el('tbody'));

  if (rows.length === 0) {
    const empty = el('td', { colspan: '5', class: 'empty' }, 'No rows. Cards offer no action until a row names theirs.');

    body.appendChild(el('tr')).appendChild(empty);
  } else {
    rows.forEach((row, index) => body.appendChild(rowElement(row, index)));
  }

  const add = el('button', { type: 'button', id: 'add' }, 'Add row');
  add.addEventListener('click', () => {
    rows.push({ action: 'merge', qualifier: null, prompt: '', automatic: false });
    edited();
  });

  const patternLabel = el('label', { for: 'pattern' }, 'Test branch pattern');
  const patternInput = /** @type {HTMLInputElement} */ (el('input', { id: 'pattern', type: 'text', spellcheck: 'false' }));
  patternInput.value = pattern;
  patternInput.addEventListener('input', () => {
    pattern = patternInput.value;
    status = '';
    paintState();
  });
  const patternHint = el('p', { class: 'hint' }, 'A regular expression. A merge request naming a matching branch is a test merge.');

  const save = el('button', { type: 'button', id: 'save', class: 'primary' }, 'Save');
  save.addEventListener('click', () => {
    // Saved as the host will store it, so the settings echoing the save compare equal.
    pattern = pattern.trim();
    status = 'Saving…';
    paintState();
    vscode.postMessage({ type: 'save', rows, pattern });
  });

  const revert = el('button', { type: 'button', id: 'revert' }, 'Revert');
  revert.addEventListener('click', () => {
    rows = saved.rows.map((row) => ({ ...row }));
    pattern = saved.pattern;
    changedElsewhere = false;
    edited();
  });

  const bar = el('div', { class: 'bar' });
  bar.append(save, revert, el('span', { id: 'status', role: 'status' }));

  const help = el('details');
  help.appendChild(el('summary', {}, 'Placeholders'));
  const placeholders = help.appendChild(el('table', { id: 'placeholders' }));
  const placeholderHead = placeholders.appendChild(el('thead')).appendChild(el('tr'));
  for (const title of ['Placeholder', 'Filled with', 'Actions']) placeholderHead.appendChild(el('th', { scope: 'col' }, title));
  const placeholderBody = placeholders.appendChild(el('tbody'));
  for (const [name, meaning, rowsFilled] of PLACEHOLDERS) {
    placeholderBody.appendChild(el('tr')).append(el('td', {}, name), el('td', {}, meaning), el('td', {}, rowsFilled));
  }

  root.replaceChildren(
    heading,
    lead,
    table,
    add,
    el('div', { class: 'pattern' }),
    el('ul', { id: 'problems', 'aria-live': 'polite' }),
    bar,
    help,
  );
  /** @type {HTMLElement} */ (root.querySelector('.pattern')).append(patternLabel, patternInput, patternHint);
  paintState();
}

window.addEventListener('message', (event) => {
  const message = event.data;

  if (message?.type === 'table') {
    const edited = loaded && dirty();

    saved = { rows: readRows(message.rows), pattern: typeof message.pattern === 'string' ? message.pattern : '^Test-' };

    // Unsaved edits stay, and the page says the saved values moved underneath them. Edits equal to what arrived are
    // the echo of this page's own save.
    if (edited && dirty()) {
      changedElsewhere = true;
      paintState();

      return;
    }

    rows = saved.rows.map((row) => ({ ...row }));
    pattern = saved.pattern;
    changedElsewhere = false;
    loaded = true;
    render();
  } else if (message?.type === 'saved') {
    status = 'Saved.';
    changedElsewhere = false;
    paintState();
  } else if (message?.type === 'failed') {
    status = String(message.message);
    paintState();
  }
});

render();
vscode.postMessage({ type: 'ready' });
