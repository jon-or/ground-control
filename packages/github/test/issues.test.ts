import { describe, expect, it } from 'vitest';
import { fetchAssignedIssues } from '../src/index.js';
import { config, fixture, runnerOf } from './helpers.js';

async function unwrap(...args: Parameters<typeof fetchAssignedIssues>) {
  const result = await fetchAssignedIssues(...args);

  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`);
  }

  return result.value;
}

describe('fetchAssignedIssues', () => {
  it('maps a recorded response to cards', async () => {
    const value = await unwrap(config(), runnerOf(fixture('project-mode')));

    expect(value.cards).toHaveLength(13);
    expect(value.cards.find((c) => c.number === 18953)).toEqual({
      number: 18953,
      title: 'Guest portal drops rows past the first page',
      type: 'Bug',
      url: 'https://github.com/example-org/example-repo/issues/18953',
      status: '⚒️ Dev',
      assignees: ['dev-1', 'dev-1-bot'],
      updatedAt: '2026-08-31T20:51:27Z',
    });
  });

  it('reads status from the configured project, not whichever project came back first', async () => {
    const value = await unwrap(config({ projectNumber: 6 }), runnerOf(fixture('project-mode')));

    expect(value.cards.every((c) => c.status === null)).toBe(true);
  });

  it('leaves type null for an issue with no issue type', async () => {
    const value = await unwrap(config({ maxPages: 1 }), runnerOf(fixture('untyped')));

    expect(value.cards.map((c) => c.type)).toEqual([null, null]);
  });

  it('counts assigned issues the project filter excluded', async () => {
    const value = await unwrap(config(), runnerOf(fixture('not-on-project')));

    expect(value.cards).toHaveLength(0);
    expect(value.matched).toBe(0);
    expect(value.totalAssigned).toBe(13);
    expect(value.notOnProject).toBe(13);
    expect(value.truncated).toBe(false);
  });

  it('asks for the unfiltered count alongside the filtered one', async () => {
    const runner = runnerOf(fixture('not-on-project'));
    await unwrap(config(), runner);

    expect(runner.calls[0]).toContain('cards=repo:example-org/example-repo is:issue is:open assignee:dev-1 project:example-org/3');
    expect(runner.calls[0]).toContain('all=repo:example-org/example-repo is:issue is:open assignee:dev-1');
  });

  it('sends the query document, not only its variables', async () => {
    const runner = runnerOf(fixture('project-mode'));
    await unwrap(config(), runner);

    expect(runner.calls[0]?.[0]).toBe('api');
    expect(runner.calls[0]?.some((a) => a.startsWith('query=') && a.includes('projectItems'))).toBe(true);
  });

  it('reports what the board matched, not the wider assigned set, when a page budget cuts the list', async () => {
    const value = await unwrap(config({ maxPages: 1 }), runnerOf(fixture('project-truncated')));

    expect(value.cards).toHaveLength(3);
    expect(value.matched).toBe(1225);
    expect(value.totalAssigned).toBe(1755);
    expect(value.notOnProject).toBe(530);
    expect(value.truncated).toBe(true);
  });

  it('finds every card in issueSearch mode and reports nothing excluded', async () => {
    const runner = runnerOf(fixture('project-mode'));
    const value = await unwrap(config({ cardSource: 'issueSearch' }), runner);

    expect(value.cards).toHaveLength(13);
    expect(value.notOnProject).toBe(0);
    expect(runner.calls[0]?.some((a) => a.startsWith('cards=') && a.includes('project:'))).toBe(false);
  });

  it('stops walking when the cursor is null even though more pages are claimed', async () => {
    // Derived, not recorded: endCursor is nullable in the schema and the live API will not serve that on demand.
    const page = structuredClone(fixture('paged-page1')) as { data: { cards: { pageInfo: { endCursor: string | null } } } };
    page.data.cards.pageInfo.endCursor = null;

    const runner = runnerOf(page);
    const value = await unwrap(config({ maxPages: 5 }), runner);

    expect(runner.calls).toHaveLength(1);
    expect(value.cards).toHaveLength(3);
    expect(value.truncated).toBe(true);
  });

  it('reports nothing excluded when the filter matched everything', async () => {
    const value = await unwrap(config(), runnerOf(fixture('project-mode')));

    expect(value.notOnProject).toBe(0);
  });

  it('follows the cursor to the next page', async () => {
    const runner = runnerOf(fixture('paged-page1'), fixture('paged-page2'));
    const value = await unwrap(config({ maxPages: 2 }), runner);

    expect(value.cards.map((c) => c.number)).toEqual([19398, 19395, 19394, 19082, 19078]);
    expect(runner.calls[1]).toContain('after=Y3Vyc29yOjEwMA==');
  });

  it('reports truncation when matches remain after the last allowed page', async () => {
    const value = await unwrap(config({ maxPages: 2 }), runnerOf(fixture('paged-page1'), fixture('paged-page2')));

    expect(value.truncated).toBe(true);
    expect(value.cards).toHaveLength(5);
    expect(value.matched).toBe(1754);
  });

  it('does not report truncation when the last page said there was no next', async () => {
    const value = await unwrap(config(), runnerOf(fixture('project-mode')));

    expect(value.truncated).toBe(false);
  });

  it('collapses an issue that appears on two pages into one card', async () => {
    const page = fixture('paged-page1');
    const value = await unwrap(config({ maxPages: 2 }), runnerOf(page, page));

    expect(value.cards).toHaveLength(3);
  });

  it('stops at maxPages rather than paging forever', async () => {
    const page = fixture('paged-page1');
    const runner = runnerOf(page, page, page);
    await unwrap(config({ maxPages: 3 }), runner);

    expect(runner.calls).toHaveLength(3);
    expect(runner.calls[2]).toContain('after=Y3Vyc29yOjEwMA==');
  });

  it('refuses to query with no logins, so the board never shows the whole repo as yours', async () => {
    const runner = runnerOf(fixture('project-mode'));
    const result = await fetchAssignedIssues(config({ logins: [] }), runner);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.kind).toBe('no-logins');
    expect(runner.calls).toHaveLength(0);
  });

  it('refuses a response whose shape it does not recognise', async () => {
    const result = await fetchAssignedIssues(config(), runnerOf({ data: { cards: {} } }));

    expect(result.ok === false && result.error.kind).toBe('bad-response');
  });

  it('passes a runner failure straight through', async () => {
    const failing = async () => ({ ok: false as const, error: { kind: 'gh-missing' as const, message: 'no gh', remedy: 'install it' } });
    const result = await fetchAssignedIssues(config(), failing);

    expect(result.ok === false && result.error.kind).toBe('gh-missing');
  });

  it('sends the query it reports sending', async () => {
    const runner = runnerOf(fixture('project-mode'));
    const value = await unwrap(config(), runner);

    expect(runner.calls[0]).toContain(`cards=${value.sourceQuery}`);
    expect(value.sourceQuery).toContain('project:example-org/3');
  });
});
