import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardMessage } from '../src/boardPanel.js';

const api = {
  postMessage: vi.fn(),
  setState: vi.fn(),
  getState: vi.fn(() => undefined),
};

const session = {
  agent: 'claude',
  sessionId: 'session-1',
  shortId: null,
  name: 'cache-remediation',
  cwd: 'c:/work/18953-cache-remediation',
  kind: 'interactive',
  startedAt: 1,
  status: 'working',
  state: 'editing tests',
  branch: '18953-cache-remediation',
  issueNumber: 18953,
  transcriptWrittenAt: null,
};

function message(overrides: Partial<BoardMessage> = {}): BoardMessage {
  return {
    type: 'board',
    cards: [],
    issues: {
      count: 0,
      matched: 0,
      totalAssigned: 0,
      notOnProject: 0,
      truncated: false,
      fetchedAt: '2026-09-01T20:00:00Z',
    },
    sessions: { count: 0, patternError: null, fetchedAt: '2026-09-01T20:00:01Z' },
    failures: [],
    ...overrides,
  };
}

function send(data: BoardMessage | { type: 'loading' }): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

beforeAll(async () => {
  vi.stubGlobal('acquireVsCodeApi', () => api);
  document.head.innerHTML = `<style>${readFileSync(resolve('media/board.css'), 'utf8')}</style>`;
  document.body.innerHTML = `
    <header><div id="meta"></div><button id="refresh" type="button">Refresh</button></header>
    <div id="notices"></div><main id="cards"></main>
  `;

  const boardScript = '../media/board.js';
  await import(boardScript);
});

beforeEach(() => {
  api.postMessage.mockClear();
  api.setState.mockClear();
  document.getElementById('meta')!.textContent = '';
  document.getElementById('meta')!.className = '';
  document.getElementById('notices')!.replaceChildren();
  document.getElementById('cards')!.replaceChildren();
  document.getElementById('cards')!.className = '';
});

describe('board webview', () => {
  it('renders an accessible avatar, retains fallback initials until load, and lays sessions out below the header', () => {
    const payload = message({
      cards: [
        {
          key: 'issue:18953',
          issueNumber: 18953,
          issue: {
            number: 18953,
            title: 'Cached counts do not update',
            type: 'Bug',
            url: 'https://github.com/example-org/example-repo/issues/18953',
            status: '🔍 Dev Review',
            assignees: ['dev-1'],
            avatar: {
              login: 'dev-2',
              url: 'https://avatars.githubusercontent.com/dev-2?s=40',
              source: 'pull-request',
            },
            updatedAt: '2026-09-01T19:00:00Z',
          },
          sessions: [session],
        },
      ],
    });

    send(payload);

    const card = document.querySelector<HTMLButtonElement>('.card')!;
    const avatar = card.querySelector<HTMLElement>('.avatar')!;
    const image = avatar.querySelector<HTMLImageElement>('img')!;
    const renderedSession = card.querySelector<HTMLElement>('.session')!;

    expect(api.setState).toHaveBeenCalledWith(payload);
    expect(card.classList).toContain('type-bug');
    expect(card.querySelector('.status')?.textContent).toBe('🔍 Dev Review');
    expect(card.querySelector('.chip')?.textContent).toBe('Bug');
    expect(avatar.getAttribute('role')).toBe('img');
    expect(avatar.getAttribute('aria-label')).toBe('dev-2, pull request author');
    expect(avatar.textContent).toContain('DE');
    expect(avatar.classList).not.toContain('has-image');
    expect(getComputedStyle(renderedSession).gridColumn).toBe('3 / -1');
    expect(renderedSession.textContent).toContain('editing tests');

    image.dispatchEvent(new Event('load'));
    expect(avatar.classList).toContain('has-image');

    image.dispatchEvent(new Event('error'));
    expect(avatar.classList).not.toContain('has-image');
    expect(avatar.querySelector('img')).toBeNull();

    card.click();
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'openIssue', number: 18953 });
  });

  it('renders disabled cards for off-board and unlinked sessions without guessing issue data', () => {
    send(
      message({
        cards: [
          { key: 'issue:42', issue: null, issueNumber: 42, sessions: [{ ...session, name: null, shortId: 'short-1' }] },
          {
            key: 'session:claude:session-2',
            issue: null,
            issueNumber: null,
            sessions: [{ ...session, sessionId: 'session-2', name: null, shortId: null, issueNumber: null, state: null }],
          },
        ],
      }),
    );

    const cards = Array.from(document.querySelectorAll<HTMLButtonElement>('.card'));
    expect(cards).toHaveLength(2);
    expect(cards[0]?.disabled).toBe(true);
    expect(cards[0]?.textContent).toContain('Not among your assigned issues');
    expect(cards[1]?.disabled).toBe(true);
    expect(cards[1]?.textContent).toContain('18953-cache-remediation');
    expect(cards[1]?.querySelector('.state')?.textContent).toBe('working');
  });

  it('shows stale-source, pattern, project-filter, and truncation notices together', () => {
    send(
      message({
        issues: {
          count: 3,
          matched: 8,
          totalAssigned: 10,
          notOnProject: 2,
          truncated: true,
          fetchedAt: '2026-09-01T20:00:00Z',
        },
        sessions: { count: 0, patternError: 'Pattern is invalid.', fetchedAt: '2026-09-01T20:00:01Z' },
        failures: [{ source: 'issues', kind: 'query-failed', message: 'GitHub failed.', remedy: 'Refresh.' }],
      }),
    );

    expect(document.querySelectorAll('.notice')).toHaveLength(4);
    expect(document.querySelectorAll('.notice.error')).toHaveLength(2);
    expect(document.getElementById('cards')?.classList).toContain('stale');
    expect(document.getElementById('meta')?.textContent).toContain('could not refresh');
    expect(document.querySelector('.empty')?.textContent).toBe('None of your assigned issues match the current card source.');
  });

  it('reports each empty state honestly and handles loading and refresh', () => {
    send(message({ issues: null, sessions: null }));
    expect(document.querySelector('.empty')?.textContent).toBe('Nothing to show yet.');
    expect(document.getElementById('meta')?.textContent).toBe('0 cards');

    send(message({ issues: { ...message().issues!, totalAssigned: 0 } }));
    expect(document.querySelector('.empty')?.textContent).toBe('No open issues are assigned to you.');

    send(message({ issues: { ...message().issues!, totalAssigned: 1 } }));
    expect(document.querySelector('.empty')?.textContent).toBe('None of your assigned issues match the current card source.');

    send({ type: 'loading' });
    expect(document.getElementById('meta')?.textContent).toBe('Reading GitHub…');

    document.getElementById('refresh')!.click();
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'refresh' });
  });
});
