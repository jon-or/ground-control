import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { MachineDeps } from '@ground-control/core';
import { makeClaudeAdapter } from '../src/claude.js';
import { historyMetadata, makeHistoryReader } from '../src/history.js';

const ID = 'a1b2c3d4-0000-4000-8000-000000000000';
const row = (over: Record<string, unknown> = {}) => JSON.stringify({ sessionId: ID, type: 'user', cwd: '/work/42-example', gitBranch: '42-example', ...over });
function machine() {
  const root = '/isolated/.claude/projects';
  const file = `${root}/-work-42-example/${ID}.jsonl`;
  const dirs: Record<string, string[]> = { [root]: ['-work-42-example'], [`${root}/-work-42-example`]: [`${ID}.jsonl`, ID, 'agent-abc.jsonl'] };
  const text: Record<string, string> = { [file]: row(), '/work/42-example/.git/config': '[remote "origin"]\n url = git@github.com:org/repo.git' };
  const times: Record<string, number> = { [file]: 100 };
  const deps: MachineDeps = { home: '/isolated', pattern: /^(\d+)-/, listDir: (p) => dirs[p] ?? null,
    mtime: (p) => times[p] ?? null, readText: (p) => text[p] ?? null,
    readHead: vi.fn((p) => text[p] ?? null), readTail: vi.fn((p) => text[p] ?? null) };
  return { deps, root, file, dirs, text, times };
}
describe('historical metadata', () => {
  it('reads a scrubbed recording of real parent-session records', () => {
    const records: unknown[] = JSON.parse(readFileSync(new URL('./fixtures/history-records.json', import.meta.url), 'utf8'));
    const text = records.map((r) => JSON.stringify(r)).join('\n');
    expect(historyMetadata(text, text, ID)).toMatchObject({ cwd: '/work/42-example', branch: '42-example' });
    expect(historyMetadata(text, text, ID)?.title).toMatch(/^Recorded (custom|automatic) title$/);
  });
  it('uses the latest saved branch/cwd and prefers a manual title across both windows', () => {
    const head = [row(), row({ type: 'custom-title', customTitle: 'My title' })].join('\n');
    const tail = ['fragment', row({ cwd: '/work/43-next', gitBranch: '43-next' }), row({ type: 'ai-title', aiTitle: 'Automatic' }), '{truncated'].join('\n');
    expect(historyMetadata(head, tail, ID)).toEqual({ cwd: '/work/43-next', branch: '43-next', title: 'My title' });
  });
  it('ignores other sessions, subagents, malformed records and unprompted sessions', () => {
    expect(historyMetadata(row({ sessionId: 'different' }), row({ isSidechain: true }), ID)).toBeNull();
    expect(historyMetadata(row({ type: 'custom-title', customTitle: 'Empty' }), 'garbage', ID)).toBeNull();
    expect(historyMetadata(row({ cwd: 12 }), row({ cwd: '' }), ID)).toBeNull();
    expect(historyMetadata(row(), row({ gitBranch: '' }), ID)?.branch).toBeNull();
    expect(historyMetadata(row(), row({ type: 'ai-title', aiTitle: 'Automatic' }), ID)?.title).toBe('Automatic');
  });
});
describe('history discovery', () => {
  it('reads only parent transcripts under the injected home and caches metadata until the file changes', async () => {
    const m = machine(); const read = makeHistoryReader();
    const first = await read(m.deps);
    expect(first.failure).toBeNull();
    expect(first.sessions).toEqual([{ agent: 'claude', sessionId: ID, title: null, cwd: '/work/42-example', branch: '42-example', issueNumber: 42, repository: 'github.com/org/repo', updatedAt: 100 }]);
    await read(m.deps);
    expect(m.deps.readTail).toHaveBeenCalledTimes(1);
    m.times[m.file] = 101; m.text[m.file] += '\n' + row({ type: 'custom-title', customTitle: 'Updated title' });
    expect((await read(m.deps)).sessions[0]?.title).toBe('Updated title');
    expect(m.deps.readTail).toHaveBeenCalledTimes(2);
    m.dirs[`${m.root}/-work-42-example`] = [];
    expect((await read(m.deps)).sessions).toEqual([]);
  });
  it('recomputes links for pattern and remote changes without rereading unchanged transcripts', async () => {
    const m = machine(); const read = makeHistoryReader(); await read(m.deps);
    m.deps.pattern = null; delete m.text['/work/42-example/.git/config'];
    expect((await read(m.deps)).sessions[0]).toMatchObject({ issueNumber: null, repository: null });
    expect(m.deps.readHead).toHaveBeenCalledTimes(1);
    m.deps.pattern = /^(\d+)-/; m.times[m.file] = 102; m.text[m.file] = row({ gitBranch: '' });
    expect((await read(m.deps)).sessions[0]?.issueNumber).toBe(42);
  });
  it('does not substitute the present-day branch or infer a directory from an encoded project slug', async () => {
    const m = machine(); m.text['/work/42-example/.git/HEAD'] = 'ref: refs/heads/99-other';
    expect((await makeHistoryReader()(m.deps)).sessions[0]?.issueNumber).toBe(42);
    m.text[m.file] = row({ cwd: '' });
    expect((await makeHistoryReader()(m.deps)).sessions).toEqual([]);
  });
  it('keeps separate injected homes isolated even with an equal timestamp', async () => {
    const m = machine(); const read = makeHistoryReader(); await read(m.deps);
    expect((await read({ ...m.deps, home: '/another-home' })).sessions).toEqual([]);
  });
  it.each(['stat', 'head', 'directory', 'root'])('reports an incomplete %s read without claiming the newest session', async (kind) => {
    const m = machine();
    if (kind === 'stat') delete m.times[m.file];
    if (kind === 'head') m.deps.readHead = () => null;
    if (kind === 'directory') delete m.dirs[`${m.root}/-work-42-example`];
    if (kind === 'root') { delete m.dirs[m.root]; m.dirs['/isolated/.claude'] = ['projects']; }
    const reading = await makeHistoryReader()(m.deps);
    expect(reading.sessions).toEqual([]); expect(reading.failure?.kind).toBe('history-failed');
  });
  it('tolerates an absent projects folder and non-directory entries', async () => {
    const m = machine(); m.dirs[m.root]!.push('notes'); m.times[`${m.root}/notes`] = 1;
    expect((await makeHistoryReader()(m.deps)).failure).toBeNull();
    delete m.dirs[m.root]; expect((await makeHistoryReader()(m.deps)).failure).toBeNull();
  });
});


it('offers resume only while both the saved directory and its transcript are readable', async () => {
  const m = machine(); const historical = (await makeHistoryReader()(m.deps)).sessions[0]!;
  const adapter = makeClaudeAdapter();
  expect(adapter.canResume!(historical, m.deps)).toBe(false);
  m.dirs[historical.cwd] = ['.git']; expect(adapter.canResume!(historical, m.deps)).toBe(true);
  delete m.times[m.file]; expect(adapter.canResume!(historical, m.deps)).toBe(false);
});
