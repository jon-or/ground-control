import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = { postMessage: vi.fn(), setState: vi.fn(), getState: vi.fn(() => undefined) };

const review = { action: 'review-others', qualifier: 'initial', prompt: '/review-pr {pr}', automatic: true };

/** Load the page afresh: its state lives in the module, and each test starts from a page that has just opened. */
async function open(): Promise<void> {
  vi.resetModules();
  api.postMessage.mockClear();
  vi.stubGlobal('acquireVsCodeApi', () => api);
  document.body.innerHTML = '<main id="table"></main>';
  const script = '../media/actions.js';
  await import(script);
}

function send(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector);
const all = <T extends Element>(selector: string) => Array.from(document.querySelectorAll<T>(selector));
const saveButton = () => $<HTMLButtonElement>('#save')!;
const problems = () => all('#problems li').map((item) => item.textContent);

function change(control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string | boolean, event = 'change'): void {
  if (typeof value === 'boolean') (control as HTMLInputElement).checked = value;
  else control.value = value;
  control.dispatchEvent(new Event(event));
}

describe('the action table page', () => {
  beforeEach(open);

  it('asks for the table as it opens, and edits nothing until it has it', () => {
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'ready' });
    expect($('#table')?.textContent).toBe('Reading the action table…');
    expect($('#save')).toBeNull();
  });

  it('shows each saved row with its action, qualifier, prompt, and automatic choice', () => {
    send({ type: 'table', rows: [review, { action: 'merge', qualifier: null, prompt: '/merge', automatic: false }], pattern: '^QA-' });

    const [action, qualifier] = all<HTMLSelectElement>('#rows tbody tr:first-child select');

    expect(action?.value).toBe('review-others');
    expect(qualifier?.value).toBe('initial');
    expect(Array.from(qualifier!.options).map((option) => option.value)).toEqual(['', 'initial', 'followup']);
    expect($<HTMLTextAreaElement>('#rows tbody tr:first-child textarea')?.value).toBe('/review-pr {pr}');
    expect($<HTMLInputElement>('#rows tbody tr:first-child input[type=checkbox]')?.checked).toBe(true);
    expect($<HTMLSelectElement>('#rows tbody tr:nth-child(2) select:nth-of-type(1)')?.value).toBe('merge');
    expect(all<HTMLSelectElement>('#rows tbody tr:nth-child(2) select')[1]?.value).toBe('');
    expect($<HTMLInputElement>('#pattern')?.value).toBe('^QA-');
    // Nothing edited yet, so nothing to save or revert.
    expect(saveButton().disabled).toBe(true);
    expect($<HTMLButtonElement>('#revert')?.disabled).toBe(true);
  });

  it('says a table with no rows offers no action', () => {
    send({ type: 'table', rows: [], pattern: '^Test-' });

    expect($('td.empty')?.textContent).toBe('No rows. Cards offer no action until a row names theirs.');
  });

  it('saves an added row as the developer filled it in', () => {
    send({ type: 'table', rows: [], pattern: '^Test-' });
    $<HTMLButtonElement>('#add')!.click();

    const [action] = all<HTMLSelectElement>('#rows tbody select');
    change(action!, 'address-review');
    change(all<HTMLSelectElement>('#rows tbody select')[1]!, 'followup');
    change($<HTMLTextAreaElement>('#rows tbody textarea')!, '/answer-review-followup {pr}', 'input');
    change($<HTMLInputElement>('#rows tbody input[type=checkbox]')!, true);

    saveButton().click();

    expect(api.postMessage).toHaveBeenLastCalledWith({
      type: 'save',
      rows: [{ action: 'address-review', qualifier: 'followup', prompt: '/answer-review-followup {pr}', automatic: true }],
      pattern: '^Test-',
    });
    expect($('#status')?.textContent).toBe('Saving…');
  });

  it('keeps a typed prompt when the action changes, and drops a qualifier the new action does not take', () => {
    send({ type: 'table', rows: [review], pattern: '^Test-' });
    change($<HTMLTextAreaElement>('#rows tbody textarea')!, '/typed', 'input');
    change(all<HTMLSelectElement>('#rows tbody select')[0]!, 'merge');

    saveButton().click();

    expect(api.postMessage).toHaveBeenLastCalledWith({
      type: 'save',
      rows: [{ action: 'merge', qualifier: null, prompt: '/typed', automatic: true }],
      pattern: '^Test-',
    });
  });

  it('keeps a qualifier both actions take', () => {
    send({ type: 'table', rows: [review], pattern: '^Test-' });
    change(all<HTMLSelectElement>('#rows tbody select')[0]!, 'address-review');

    expect(all<HTMLSelectElement>('#rows tbody select')[1]?.value).toBe('initial');
  });

  it('will not save two rows for one reading, or a pattern that is not a regular expression', () => {
    send({ type: 'table', rows: [review, { ...review, prompt: '/other' }], pattern: '^Test-' });

    expect(problems()).toContain('Review their PR · initial has more than one row.');

    $<HTMLButtonElement>('#rows tbody tr:nth-child(2) button.remove')!.click();

    expect(problems()).toEqual([]);
    expect(saveButton().disabled).toBe(false);

    change($<HTMLInputElement>('#pattern')!, '(', 'input');

    expect(problems()).toEqual(['The test branch pattern is not a valid regular expression.']);
    expect(saveButton().disabled).toBe(true);

    change($<HTMLInputElement>('#pattern')!, ' ', 'input');

    expect(problems()).toEqual(['Set a test branch pattern.']);
  });

  it('warns about a row with no prompt without refusing to save it', () => {
    send({ type: 'table', rows: [], pattern: '^Test-' });
    $<HTMLButtonElement>('#add')!.click();

    expect(problems()).toEqual(['Merge has no prompt, so the card says so instead of running it.']);
    expect(saveButton().disabled).toBe(false);
  });

  it('puts the saved table back on revert', () => {
    send({ type: 'table', rows: [review], pattern: '^Test-' });
    $<HTMLButtonElement>('#rows tbody button.remove')!.click();
    change($<HTMLInputElement>('#pattern')!, '^QA-', 'input');

    $<HTMLButtonElement>('#revert')!.click();

    expect(all('#rows tbody tr select')).toHaveLength(2);
    expect($<HTMLInputElement>('#pattern')?.value).toBe('^Test-');
    expect(saveButton().disabled).toBe(true);
  });

  it('says a save landed, and does not mistake the settings echoing it for a change made elsewhere', () => {
    send({ type: 'table', rows: [review], pattern: '^Test-' });
    change($<HTMLInputElement>('#rows tbody input[type=checkbox]')!, false);
    saveButton().click();

    send({ type: 'table', rows: [{ ...review, automatic: false }], pattern: '^Test-' });
    send({ type: 'saved' });

    expect($('#status')?.textContent).toBe('Saved.');
    expect(problems()).toEqual([]);
    expect(saveButton().disabled).toBe(true);
  });

  it('saves the pattern trimmed, as the settings will hold it, so their echo is not an edit made elsewhere', () => {
    send({ type: 'table', rows: [], pattern: '^Test-' });
    change($<HTMLInputElement>('#pattern')!, ' ^QA- ', 'input');
    saveButton().click();

    expect(api.postMessage).toHaveBeenLastCalledWith({ type: 'save', rows: [], pattern: '^QA-' });

    send({ type: 'table', rows: [], pattern: '^QA-' });

    expect(problems()).toEqual([]);
    expect(saveButton().disabled).toBe(true);
  });

  it('keeps unsaved edits when the settings change elsewhere, and says saving replaces them', () => {
    send({ type: 'table', rows: [review], pattern: '^Test-' });
    change($<HTMLTextAreaElement>('#rows tbody textarea')!, '/mine', 'input');

    send({ type: 'table', rows: [{ ...review, prompt: '/theirs' }], pattern: '^Test-' });

    expect($<HTMLTextAreaElement>('#rows tbody textarea')?.value).toBe('/mine');
    expect(problems()).toEqual(['The settings changed outside this page. Saving replaces them.']);
  });

  it('takes a change made elsewhere at once where nothing here is unsaved', () => {
    send({ type: 'table', rows: [review], pattern: '^Test-' });
    send({ type: 'table', rows: [{ ...review, prompt: '/theirs' }], pattern: '^QA-' });

    expect($<HTMLTextAreaElement>('#rows tbody textarea')?.value).toBe('/theirs');
    expect($<HTMLInputElement>('#pattern')?.value).toBe('^QA-');
  });

  it('shows why a save failed, and clears it on the next edit', () => {
    send({ type: 'table', rows: [review], pattern: '^Test-' });
    change($<HTMLInputElement>('#rows tbody input[type=checkbox]')!, false);
    saveButton().click();
    send({ type: 'failed', message: 'Could not save: settings are read-only.' });

    expect($('#status')?.textContent).toBe('Could not save: settings are read-only.');

    $<HTMLButtonElement>('#add')!.click();

    expect($('#status')?.textContent).toBe('');
  });

  it('skips a stored row it cannot read rather than showing an empty one', () => {
    send({ type: 'table', rows: [review, 'on', null, { prompt: '/no-action' }], pattern: 7 });

    expect(all('#rows tbody tr')).toHaveLength(1);
    expect($<HTMLInputElement>('#pattern')?.value).toBe('^Test-');
  });

  it('lists the placeholders a prompt can use, and the actions each is filled for', () => {
    send({ type: 'table', rows: [], pattern: '^Test-' });

    const listed = all('#placeholders tbody tr').map((line) => {
      const [name, , actions] = Array.from(line.children).map((cell) => cell.textContent);

      return [name, actions];
    });

    expect(listed).toEqual([
      ['{issue}', 'All'],
      ['{repo}', 'All'],
      ['{pr}', 'All'],
      ['{branch}', 'All'],
      ['{base}', 'All'],
      ['{default}', 'All'],
      ['{target}', 'Merge · test; empty for every other row'],
      ['{checkout}', 'All'],
      ['{resultPath}', 'All'],
    ]);
  });
});
