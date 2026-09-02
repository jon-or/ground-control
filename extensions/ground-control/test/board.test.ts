import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LANE_ORDER, LANE_TITLES, boardStatuses } from '@ground-control/board';
import type { Lane, LaneId, LanedCard } from '@ground-control/board';
import type { Session } from '@ground-control/sessions';
import type { BoardMessage } from '../src/boardPanel.js';

const api = {
  postMessage: vi.fn(),
  setState: vi.fn(),
  getState: vi.fn(() => undefined),
};

const session: Session = {
  agent: 'claude',
  sessionId: 'session-1',
  shortId: null,
  name: 'cache-remediation',
  title: null,
  cwd: 'c:/work/18953-cache-remediation',
  kind: 'interactive',
  startedAt: 1,
  status: 'working',
  state: 'editing tests',
  branch: '18953-cache-remediation',
  issueNumber: 18953,
  transcriptWrittenAt: null,
  activity: null,
};

/** Every lane, always, so a payload here has the shape `assignLanes` produces rather than a hand-picked subset. */
function lanes(cards: Partial<Record<LaneId, LanedCard[]>>): Lane[] {
  return LANE_ORDER.map((id) => ({ id, title: LANE_TITLES[id], cards: cards[id] ?? [] }));
}

function message(overrides: Partial<BoardMessage> = {}): BoardMessage {
  return {
    type: 'board',
    lanes: lanes({}),
    issues: {
      count: 0,
      matched: 0,
      totalAssigned: 0,
      notOnProject: 0,
      truncated: false,
      fetchedAt: '2026-09-01T20:00:00Z',
    },
    sessions: { count: 0, patternError: null, fetchedAt: '2026-09-01T20:00:01Z' },
    hooks: null,
    failures: [],
    ...overrides,
  };
}

function send(data: BoardMessage | { type: 'loading' }): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

function laneEl(id: LaneId): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.lane-${id}`);
}

const liveCard: LanedCard = {
  key: 'issue:18953',
  issueNumber: 18953,
  lane: 'unstarted',
  returned: false,
  reason: '⚒️ Dev',
  issue: {
    number: 18953,
    title: 'Cached counts do not update',
    type: 'Bug',
    url: 'https://github.com/example-org/example-repo/issues/18953',
    typeColor: 'RED',
    status: '🔍 Dev Review',
    statusColor: 'GRAY',
    assignees: ['dev-1'],
    pullRequest: { number: 19403, url: 'https://github.com/example-org/example-repo/pull/19403', state: 'OPEN' },
    avatar: {
      login: 'dev-2',
      url: 'https://avatars.githubusercontent.com/dev-2?s=40',
      source: 'pull-request',
    },
    updatedAt: '2026-09-01T19:00:00Z',
  },
  sessions: [session],
};

/** The board's own duration clock, captured rather than started: a test drives it, and no interval outlives the run. */
let tick: (() => void) | null = null;
let tickMs = 0;

beforeAll(async () => {
  vi.stubGlobal('acquireVsCodeApi', () => api);
  vi.stubGlobal('setInterval', (fn: () => void, ms: number) => {
    tick = fn;
    tickMs = ms;

    return 0;
  });
  document.head.innerHTML = `<style>${readFileSync(resolve('media/board.css'), 'utf8')}</style>`;
  document.body.innerHTML = `
    <header>
      <div id="meta"></div>
      <label id="archived-toggle" hidden><input id="show-archived" type="checkbox"> Show archived (<span id="archived-count">0</span>)</label>
      <button id="refresh" type="button">Refresh</button>
    </header>
    <div id="notices"></div><main id="lanes"></main>
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
  // The renderer keeps its lane and card elements across renders, so a test starts from a board that carries none.
  send(message());
  document.getElementById('lanes')!.replaceChildren();
  document.getElementById('lanes')!.className = '';
  (document.getElementById('show-archived') as HTMLInputElement).checked = false;
});

describe('board webview', () => {
  it('renders an accessible avatar, retains fallback initials until load, and lays sessions out below the header', () => {
    const payload = message({ lanes: lanes({ unstarted: [liveCard] }) });

    send(payload);

    const card = document.querySelector<HTMLElement>('.card')!;
    const open = card.querySelector<HTMLButtonElement>('.card-open')!;
    const avatar = card.querySelector<HTMLElement>('.avatar')!;
    const image = avatar.querySelector<HTMLImageElement>('img')!;
    const renderedSession = card.querySelector<HTMLElement>('.session')!;

    expect(api.setState).toHaveBeenCalledWith({ payload, showArchived: false });
    expect(card.classList).toContain('type-bug');
    expect(card.querySelector('.status')?.textContent).toBe('Dev Review');
    expect(card.querySelector<HTMLElement>('.status')?.title).toBe('🔍 Dev Review');
    expect(card.querySelector('.type')?.textContent).toBe('Bug');
    expect(avatar.getAttribute('role')).toBe('img');
    expect(avatar.getAttribute('aria-label')).toBe('dev-2, pull request author');
    expect(avatar.textContent).toContain('DE');
    expect(avatar.classList).not.toContain('has-image');
    expect(card.querySelector('.card-meta')?.contains(card.querySelector('.avatar'))).toBe(true);
    expect(getComputedStyle(card.querySelector('.title')!).overflowWrap).toBe('anywhere');
    expect(card.querySelector('.card-meta')?.contains(card.querySelector('.status'))).toBe(true);
    expect(renderedSession.textContent).toContain('editing tests');

    image.dispatchEvent(new Event('load'));
    expect(avatar.classList).toContain('has-image');

    image.dispatchEvent(new Event('error'));
    expect(avatar.classList).not.toContain('has-image');
    expect(avatar.querySelector('img')).toBeNull();

    open.click();
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'openIssue', number: 18953 });
  });

  it('renders disabled cards for off-board and unlinked sessions without guessing issue data', () => {
    send(
      message({
        lanes: lanes({
          unstarted: [
            {
              key: 'issue:42',
              issue: null,
              issueNumber: 42,
              lane: 'unstarted',
              returned: false,
              reason: 'Not among your assigned issues.',
              sessions: [{ ...session, name: null, shortId: 'short-1' }],
            },
            {
              key: 'session:c:/work/18953-cache-remediation',
              issue: null,
              issueNumber: null,
              lane: 'unstarted',
              returned: false,
              reason: 'Ad-hoc work with no issue.',
              sessions: [
                { ...session, sessionId: 'session-2', name: null, shortId: null, issueNumber: null, state: null },
              ],
            },
          ],
        }),
      }),
    );

    const cards = Array.from(document.querySelectorAll<HTMLElement>('.card'));
    const opens = Array.from(document.querySelectorAll<HTMLButtonElement>('.card-open'));

    expect(cards).toHaveLength(2);
    expect(opens[0]?.disabled).toBe(true);
    expect(cards[0]?.textContent).toContain('Not among your assigned issues');
    expect(opens[1]?.disabled).toBe(true);
    expect(cards[1]?.textContent).toContain('18953-cache-remediation');
    expect(cards[1]?.querySelector('.state')?.textContent).toBe('working');
  });

  it('badges the type before the status, then the pull request, in GitHub own colours', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));

    const badges = Array.from(document.querySelectorAll<HTMLElement>('.card-meta .badge'));

    expect(badges.map((b) => b.className.replace('badge ', ''))).toEqual([
      'type',
      'status',
      'pull-request link',
    ]);
    expect(badges[0]?.style.getPropertyValue('--gc-badge')).toBe('var(--vscode-charts-red)');
    expect(badges[1]?.style.getPropertyValue('--gc-badge')).toBe('var(--vscode-charts-foreground)');
    expect(badges[2]?.textContent).toBe('#19403');
    expect(badges[2]?.style.getPropertyValue('--gc-badge')).toBe('var(--vscode-charts-green)');
    expect(badges[2]?.querySelector('.pr-mark')).not.toBeNull();
  });

  it('opens the issue from its number and the pull request from its badge', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));

    const number = document.querySelector<HTMLButtonElement>('.card-meta .number')!;
    const pr = document.querySelector<HTMLButtonElement>('.card-meta .badge.pull-request')!;

    expect(number.tagName).toBe('BUTTON');
    expect(number.title).toBe('Open issue #18953 on GitHub');
    // The button's own text is a bare number, so without this a screen reader announces only "18953, button".
    expect(number.getAttribute('aria-label')).toBe('Open issue #18953 on GitHub');
    expect(number.draggable).toBe(false);
    expect(pr.tagName).toBe('BUTTON');
    expect(pr.title).toBe('Pull request #19403 — open');
    expect(pr.getAttribute('aria-label')).toBe('Open pull request #19403, open, on GitHub');
    expect(pr.draggable).toBe(false);
    expect(getComputedStyle(pr).cursor).toBe('pointer');

    number.click();
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'openIssue', number: 18953 });

    pr.click();
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'openPullRequest', number: 18953 });
  });

  it('labels a session with its own title, falling back to the name Claude derived from the directory', () => {
    const titled: LanedCard = {
      key: 'session:c:/work/scratch',
      issue: null,
      issueNumber: null,
      lane: 'build',
      returned: false,
      reason: 'Ad-hoc work with no issue.',
      sessions: [
        { ...session, sessionId: 'a', title: 'Grouping orphan sessions', cwd: 'c:/work/scratch', issueNumber: null },
        { ...session, sessionId: 'b', title: null, name: 'scratch-7b', cwd: 'c:/work/scratch', issueNumber: null },
      ],
    };

    send(message({ lanes: lanes({ build: [titled] }) }));

    const labels = Array.from(document.querySelectorAll<HTMLElement>('.session-label')).map((el) => el.textContent);

    expect(labels).toEqual(['Grouping orphan sessions', 'scratch-7b']);
  });

  it('names a card for its directory when the CLI reports a Windows path', () => {
    const win = 'd:\\git\\ground-control';
    const grouped: LanedCard = {
      key: 'session:d:/git/ground-control',
      issue: null,
      issueNumber: null,
      lane: 'build',
      returned: false,
      reason: 'Ad-hoc work with no issue.',
      sessions: [
        { ...session, sessionId: 'a', name: null, shortId: null, cwd: win, issueNumber: null },
        { ...session, sessionId: 'b', name: null, shortId: null, cwd: win, issueNumber: null },
      ],
    };

    send(message({ lanes: lanes({ build: [grouped] }) }));

    const card = document.querySelector<HTMLElement>('.card')!;

    expect(document.querySelectorAll('.card')).toHaveLength(1);
    expect(card.querySelector('.title')?.textContent).toBe('ground-control');
    expect(Array.from(card.querySelectorAll('.session-label')).map((el) => el.textContent)).toEqual([
      'ground-control',
      'ground-control',
    ]);
  });

  it('names a card with no issue for its directory and lists every session running there', () => {
    const grouped: LanedCard = {
      key: 'session:c:/work/scratch',
      issue: null,
      issueNumber: null,
      lane: 'build',
      returned: false,
      reason: 'Ad-hoc work with no issue.',
      sessions: [
        { ...session, sessionId: 'a', name: 'reading logs', cwd: 'c:/work/scratch', issueNumber: null },
        { ...session, sessionId: 'b', name: 'drafting notes', cwd: 'c:/work/scratch', issueNumber: null },
      ],
    };

    send(message({ lanes: lanes({ build: [grouped] }) }));

    const card = document.querySelector<HTMLElement>('.card')!;
    const labels = Array.from(card.querySelectorAll<HTMLElement>('.session-label')).map((el) => el.textContent);

    expect(card.querySelector('.title')?.textContent).toBe('scratch');
    expect(card.querySelector('.number')?.textContent).toBe('sessions');
    expect(labels).toEqual(['reading logs', 'drafting notes']);
  });

  it('leaves the number as plain text on a card with no issue behind it', () => {
    send(
      message({
        lanes: lanes({
          unstarted: [
            {
              key: 'session:c:/work/18953-cache-remediation',
              issue: null,
              issueNumber: null,
              lane: 'unstarted',
              returned: false,
              reason: 'Ad-hoc work with no issue.',
              sessions: [session],
            },
          ],
        }),
      }),
    );

    const number = document.querySelector<HTMLElement>('.card-meta .number')!;

    expect(number.tagName).toBe('SPAN');
    expect(number.textContent).toBe('session');
    expect(number.classList).not.toContain('link');
  });

  it('leaves out a badge the issue has nothing for', () => {
    const bare = { ...liveCard, issue: { ...liveCard.issue!, type: null, status: null, pullRequest: null } };

    send(message({ lanes: lanes({ build: [bare] }) }));

    expect(document.querySelectorAll('.card-meta .badge')).toHaveLength(0);
  });

  it('marks a Claude session with its own icon, and names any other agent in text — R2', () => {
    send(message({ lanes: lanes({ build: [liveCard] }) }));

    const mark = document.querySelector<SVGElement>('.session .agent-mark')!;

    expect(mark).not.toBeNull();
    expect(mark.getAttribute('aria-label')).toBe('claude');
    expect(mark.querySelector('title')?.textContent).toBe('claude');

    send(
      message({
        lanes: lanes({ build: [{ ...liveCard, sessions: [{ ...session, agent: 'codex' }] }] }),
      }),
    );

    expect(document.querySelector('.session .agent-mark')).toBeNull();
    expect(document.querySelector('.session .agent')?.textContent).toBe('codex');
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
    expect(document.getElementById('lanes')?.classList).toContain('stale');
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

describe('reported activity', () => {
  const withPhase = (phase: 'running' | 'waiting' | 'idle', since = Date.now(), over: Partial<Session> = {}) => ({
    ...session,
    ...over,
    activity: { phase, since, event: 'PostToolBatch' },
  });

  const cardWith = (sessions: Session[]): LanedCard => ({ ...liveCard, sessions });

  const sendCard = (sessions: Session[]): HTMLElement => {
    send(message({ lanes: lanes({ unstarted: [cardWith(sessions)] }) }));

    return document.querySelector<HTMLElement>('.card')!;
  };

  it('shimmers the running session and only the running session', () => {
    const card = sendCard([
      withPhase('running', Date.now(), { sessionId: 's-run' }),
      withPhase('waiting', Date.now(), { sessionId: 's-wait' }),
      withPhase('idle', Date.now(), { sessionId: 's-idle' }),
    ]);

    const rows = Array.from(card.querySelectorAll<HTMLElement>('.session'));

    expect(rows.map((row) => row.dataset.phase)).toEqual(['running', 'waiting', 'idle']);

    const names = rows.map((row) => getComputedStyle(row.querySelector('.session-label')!));

    // jsdom leaves an unanimated element's animation-name empty rather than at its 'none' initial value.
    expect(names.map((style) => style.animationName)).toEqual(['gc-shimmer', '', '']);
  });

  // A gradient that is not clipped to the glyphs paints a solid block over the name, which is how this breaks.
  it('clips the gradient to the text rather than painting a block', () => {
    const label = sendCard([withPhase('running')]).querySelector('.session-label')!;
    const style = getComputedStyle(label);

    expect(style.backgroundClip).toBe('text');
    expect(style.backgroundImage).toContain('linear-gradient');
    expect(style.backgroundRepeat).toBe('no-repeat');
    expect(style.color).toBe('rgba(0, 0, 0, 0)');
  });

  /**
   * The two halves of "one band, one pass": the image must not tile, and the position must not travel further than
   * one traverse of it. A repeating background or a range past 0% puts a second highlight on screen behind the first.
   */
  it('sweeps one highlight across once, left to right', () => {
    const css = readFileSync(resolve('media/board.css'), 'utf8');
    const frames = /@keyframes gc-shimmer \{([\s\S]*?)\n\}/.exec(css)?.[1];

    expect(frames).toBeTruthy();
    expect(/from \{\s*background-position: 100% 0;/.test(frames!)).toBe(true);
    expect(/to \{\s*background-position: 0% 0;/.test(frames!)).toBe(true);
    expect(frames).not.toContain('-100%');

    const style = getComputedStyle(sendCard([withPhase('running')]).querySelector('.session-label')!);

    expect(style.backgroundSize).toBe('300% 100%');
    expect(style.backgroundRepeat).toBe('no-repeat');

    // With a 3x image the visible window at each endpoint is the outer third, so both outer stops must sit inside
    // the middle third or the band is partly on screen when the cycle wraps - which is a visible jump.
    const stops = Array.from(style.backgroundImage.matchAll(/(\d+(?:\.\d+)?)%/g), (m) => Number(m[1]));

    expect(stops.length).toBeGreaterThanOrEqual(3);
    expect(Math.min(...stops)).toBeGreaterThan(100 / 3);
    expect(Math.max(...stops)).toBeLessThan(200 / 3);
  });

  it('marks the card, not only the row, when a session is waiting on the developer', () => {
    const card = sendCard([withPhase('idle'), withPhase('waiting', Date.now(), { sessionId: 's-2' })]);

    expect(card.dataset.waiting).toBe('');
    expect(card.querySelector('.badge.waiting')?.textContent).toBe('Needs you');
    expect(card.querySelector<HTMLElement>('.badge.waiting')?.title).toContain('waiting on you');
  });

  it('marks nothing when no session is waiting', () => {
    const card = sendCard([withPhase('running'), withPhase('idle', Date.now(), { sessionId: 's-2' })]);

    expect(card.dataset.waiting).toBeUndefined();
    expect(card.querySelector('.badge.waiting')).toBeNull();
  });

  it('shows one state per row, and it is the board own observation', () => {
    const row = sendCard([withPhase('running', Date.now(), { status: 'idle', state: 'editing tests' })])
      .querySelector<HTMLElement>('.session')!;

    expect(row.querySelectorAll('.state')).toHaveLength(1);
    expect(row.querySelector('.state')?.textContent).toContain('running');
    expect(row.textContent).not.toContain('editing tests');
    expect(row.textContent).not.toContain('idle');
  });

  it('falls back to the CLI own word when no hook has reported', () => {
    const row = sendCard([{ ...session, activity: null }]).querySelector<HTMLElement>('.session')!;

    expect(row.dataset.phase).toBeUndefined();
    expect(row.querySelector('.state')?.textContent).toBe('editing tests');
    expect(getComputedStyle(row.querySelector('.session-label')!).animationName).toBeFalsy();
  });

  it('rebuilds the card when a phase changes', () => {
    const before = sendCard([withPhase('idle', 1)]);
    const after = sendCard([withPhase('running', 1)]);

    expect(after).not.toBe(before);
    expect(after.querySelector<HTMLElement>('.session')?.dataset.phase).toBe('running');
  });

  // Without this the test above passes on a renderer that rebuilds everything, which is not what it claims to prove.
  it('leaves the card alone when nothing about it changed', () => {
    const before = sendCard([withPhase('running', 1)]);

    expect(sendCard([withPhase('running', 1)])).toBe(before);
  });

  it('advances the duration in place, without rebuilding the card', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T12:00:00Z'));

    try {
      const since = Date.now() - 90_000;
      const card = sendCard([withPhase('running', since)]);

      expect(card.querySelector('.state')?.textContent).toBe('running 1m');

      vi.advanceTimersByTime(10 * 60 * 1000);
      sendCard([withPhase('running', since)]);

      expect(document.querySelector('.card')).toBe(card);
      expect(card.querySelector('.state')?.textContent).toBe('running 11m');

      // A render inside the same turn keeps the count where it is; the next turn starts it again, on the same element.
      sendCard([withPhase('running', Date.now())]);

      expect(document.querySelector('.card')).toBe(card);
      expect(card.querySelector('.state')?.textContent).toBe('running 0s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('says what the duration counts, and what it last saw, on hover', () => {
    const state = sendCard([withPhase('running')]).querySelector<HTMLElement>('.state')!;

    expect(state.title).toBe(
      'This session is working. The duration counts the turn it is in, from the prompt that began it where the board saw one. Last seen at the PostToolBatch hook.',
    );
  });

  /**
   * The anchor does not move, so its age is a function of the clock: the text has to advance with no message from the
   * extension host and no read of the machine behind it.
   */
  it('advances the duration on its own clock, with nothing arriving from the host', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T12:00:00Z'));

    try {
      const card = sendCard([withPhase('running', Date.now())]);

      expect(card.querySelector('.state')?.textContent).toBe('running 0s');

      api.postMessage.mockClear();
      vi.setSystemTime(new Date('2026-09-02T12:00:07Z'));
      tick?.();

      expect(document.querySelector('.card')).toBe(card);
      expect(card.querySelector('.state')?.textContent).toBe('running 7s');
      expect(api.postMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // Seconds are what the text is written to below a minute, so a slower clock leaves a card reading 0s for that long.
  it('runs that clock at the resolution the text is written to', () => {
    expect(tickMs).toBe(1_000);
  });

  it('never rounds a duration up', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T12:00:00Z'));

    try {
      const card = sendCard([
        withPhase('idle', Date.now() - 59_900, { sessionId: 's-a' }),
        withPhase('idle', Date.now() - 3_599_000, { sessionId: 's-b' }),
      ]);

      expect(Array.from(card.querySelectorAll('.state')).map((el) => el.textContent)).toEqual([
        'idle 59s',
        'idle 59m',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads a duration under a minute in seconds and one over an hour in hours', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T12:00:00Z'));

    try {
      const card = sendCard([
        withPhase('idle', Date.now() - 4_000, { sessionId: 's-seconds' }),
        withPhase('idle', Date.now() - 5_400_000, { sessionId: 's-hours' }),
        withPhase('idle', Date.now() - 7_200_000, { sessionId: 's-round-hours' }),
      ]);

      expect(Array.from(card.querySelectorAll('.state')).map((el) => el.textContent)).toEqual([
        'idle 4s',
        'idle 1h 30m',
        'idle 2h',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * jsdom does not honour prefers-reduced-motion, so the stylesheet is read instead. The assertion that matters is
   * that the block still paints a colour: reduced motion must not mean less information.
   */
  it('keeps a running session marked when motion is reduced', () => {
    const css = readFileSync(resolve('media/board.css'), 'utf8');
    const block = /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/.exec(css)?.[0];

    expect(block).toBeTruthy();
    expect(block).toContain('animation-name: none');
    expect(block).toMatch(/color: var\(--vscode-foreground\)/);
  });

  it('states once above the lanes what it did about the hooks', () => {
    send(message({ hooks: { notice: 'Session activity hooks installed. 3 sessions started before that and will not report until restarted.' } }));

    const notices = Array.from(document.querySelectorAll('#notices .notice'));

    expect(notices).toHaveLength(1);
    expect(notices[0]?.classList).not.toContain('error');
    expect(notices[0]?.textContent).toContain('3 sessions started before that');
  });

  it('reports a failed install as an error, and says nothing when there is nothing to say', () => {
    send(
      message({
        failures: [{ source: 'hooks', kind: 'hooks-failed', message: 'could not be installed', remedy: 'Fix it.' }],
      }),
    );

    expect(document.querySelector('#notices .notice.error')?.textContent).toContain('could not be installed');

    send(message());
    expect(document.querySelectorAll('#notices .notice')).toHaveLength(0);
  });
});

describe('the manifest and the code agree on every default', () => {
  const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { default: unknown }> } };
  };
  const declared = (name: string) => manifest.contributes.configuration.properties[`groundControl.${name}`]?.default;

  // Two copies of a default is what VS Code's settings UI costs; a test is what keeps them from drifting apart.
  it('ships the board statuses the package computes', () => {
    expect(declared('boardStatuses')).toEqual(boardStatuses(undefined));
  });

  it('ships the intervals the extension falls back to', () => {
    expect(declared('sessionRefreshSeconds')).toBe(30);
    expect(declared('refreshIntervalSeconds')).toBe(300);
  });

  it('ships the hook install default the extension falls back to', () => {
    expect(declared('installSessionHooks')).toBe(true);
  });
});

describe('lanes', () => {
  const planCard: LanedCard = { ...liveCard, lane: 'plan', reason: '🎁 Assigned' };
  const archivedCard: LanedCard = {
    ...liveCard,
    key: 'issue:18900',
    issueNumber: 18900,
    lane: 'archived',
    reason: '🏃 Testing — not yours to act on right now.',
    sessions: [],
  };

  it('renders every lane the payload carries, with its count — R10', () => {
    send(message({ lanes: lanes({ plan: [planCard] }) }));

    const rendered = Array.from(document.querySelectorAll<HTMLElement>('.lane h2 .lane-name')).map((h) => h.textContent);

    expect(rendered).toEqual(LANE_ORDER.filter((id) => id !== 'archived').map((id) => LANE_TITLES[id]));
    expect(laneEl('plan')?.querySelector('.lane-count')?.textContent).toBe('1');
    expect(laneEl('unstarted')?.querySelector('.lane-count')?.textContent).toBe('0');
    expect(laneEl('plan')?.querySelectorAll('.card')).toHaveLength(1);
  });

  it('says a lane is empty rather than leaving a blank column', () => {
    send(message({ lanes: lanes({ plan: [planCard] }) }));

    expect(laneEl('unstarted')?.querySelector('.lane-empty')?.textContent).toBe('Nothing here');
    expect(laneEl('plan')?.querySelector('.lane-empty')).toBeNull();
  });

  it('hides archived work until the toggle asks for it — R9', () => {
    send(message({ lanes: lanes({ plan: [planCard], archived: [archivedCard] }) }));

    const toggle = document.getElementById('show-archived') as HTMLInputElement;

    expect(laneEl('archived')).toBeNull();
    expect(document.getElementById('archived-toggle')?.hidden).toBe(false);
    expect(document.getElementById('archived-count')?.textContent).toBe('1');
    expect(document.getElementById('meta')?.textContent).toContain('1 card');

    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));

    expect(laneEl('archived')?.querySelectorAll('.card')).toHaveLength(1);
    expect(document.getElementById('meta')?.textContent).toContain('2 cards');
  });

  it('says so when the configured statuses archive the whole board — R25', () => {
    send(message({ lanes: lanes({ archived: [archivedCard] }) }));

    expect(document.querySelector('.notice')?.textContent).toContain('Every issue the board read is archived');
  });

  it('says nothing of the sort while any lane holds a card', () => {
    send(message({ lanes: lanes({ plan: [planCard], archived: [archivedCard] }) }));

    expect(document.querySelectorAll('.notice')).toHaveLength(0);
  });

  it('drops the emoji off a status but keeps the board own word', () => {
    const statuses = ['🎁 Assigned', '⚒️ Dev', '👟 Ready For Testing', '🧊 On Ice'];

    for (const status of statuses) {
      send(message({ lanes: lanes({ plan: [{ ...planCard, issue: { ...planCard.issue!, status } }] }) }));

      expect(document.querySelector('.status')?.textContent).toBe(status.replace(/^\S+\s+/u, ''));
    }
  });

  it('offers no archive toggle when nothing is archived', () => {
    send(message({ lanes: lanes({ plan: [planCard] }) }));

    expect(document.getElementById('archived-toggle')?.hidden).toBe(true);
  });

  it('marks a returned card, and leaves the card itself without a tooltip — R6', () => {
    send(message({ lanes: lanes({ unstarted: [{ ...liveCard, returned: true }] }) }));

    const card = document.querySelector<HTMLElement>('.card')!;

    expect(card.querySelector('.card-meta .badges .returned')?.textContent).toBe('Returned');
    expect(card.querySelector<HTMLElement>('.card-open')?.title).toBe('');
    expect(card.title).toBe('');
  });

  it('moves a focused card one lane with alt and an arrow', () => {
    send(message({ lanes: lanes({ plan: [planCard] }) }));

    const open = document.querySelector<HTMLElement>('.card-open')!;

    open.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true }));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'moveCard', key: 'issue:18953', lane: 'build' });

    open.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true }));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'moveCard', key: 'issue:18953', lane: 'unstarted' });
  });

  it('does not move a card on an arrow without alt, nor past either end', () => {
    // Distinct keys: one card is one element, so the same key in two lanes would be one card, not two.
    const parked: LanedCard = { ...planCard, key: 'issue:18900', issueNumber: 18900, lane: 'icebox' };

    send(message({ lanes: lanes({ unstarted: [liveCard], icebox: [parked] }) }));

    const [first, last] = Array.from(document.querySelectorAll<HTMLElement>('.card-open'));

    first!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    first!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true }));
    last!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true }));

    expect(api.postMessage).not.toHaveBeenCalled();
  });

  it('moves a card dropped onto another lane', () => {
    send(message({ lanes: lanes({ plan: [planCard] }) }));

    const card = document.querySelector<HTMLElement>('.card')!;
    const target = laneEl('build')!;

    // jsdom has no DataTransfer, which is the case the drop's own fallback to the dragged key exists for.
    card.dispatchEvent(new Event('dragstart', { bubbles: true }));
    expect(card.classList).toContain('dragging');

    target.dispatchEvent(new Event('drop', { bubbles: true }));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'moveCard', key: 'issue:18953', lane: 'build' });

    card.dispatchEvent(new Event('dragend', { bubbles: true }));
    expect(card.classList).not.toContain('dragging');
  });

  it('hides an empty Done and Icebox, and brings them back as drop targets while a card is dragged', () => {
    send(message({ lanes: lanes({ plan: [planCard], done: [{ ...planCard, key: 'issue:1', lane: 'done' }] }) }));

    expect(laneEl('done')?.classList).not.toContain('lane-idle');
    expect(laneEl('icebox')?.classList).toContain('lane-idle');
    expect(document.getElementById('lanes')?.classList).not.toContain('dragging');

    const card = document.querySelector<HTMLElement>('.card')!;

    expect(getComputedStyle(laneEl('icebox')!).display).toBe('none');

    card.dispatchEvent(new Event('dragstart', { bubbles: true }));
    expect(document.getElementById('lanes')?.classList).toContain('dragging');
    expect(getComputedStyle(laneEl('icebox')!).display).toBe('flex');

    card.dispatchEvent(new Event('dragend', { bubbles: true }));
    expect(document.getElementById('lanes')?.classList).not.toContain('dragging');
  });

  it('clears the archive toggle when the last archived card leaves, so no empty column is stranded', () => {
    const toggle = document.getElementById('show-archived') as HTMLInputElement;

    send(message({ lanes: lanes({ plan: [planCard], archived: [archivedCard] }) }));
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));

    expect(laneEl('archived')).not.toBeNull();

    send(message({ lanes: lanes({ plan: [planCard] }) }));

    expect(toggle.checked).toBe(false);
    expect(laneEl('archived')).toBeNull();
    expect(document.getElementById('archived-toggle')?.hidden).toBe(true);
  });

  it('keeps the element of a card a refresh did not change, so its lane stays scrolled where it was', () => {
    const other: LanedCard = { ...planCard, key: 'issue:18900', issueNumber: 18900 };

    send(message({ lanes: lanes({ plan: [planCard, other] }) }));

    const before = Array.from(document.querySelectorAll<HTMLElement>('.card'));
    const list = laneEl('plan')!.querySelector('.lane-cards')!;

    send(message({ lanes: lanes({ plan: [planCard, other] }) }));

    expect(laneEl('plan')!.querySelector('.lane-cards')).toBe(list);
    expect(Array.from(document.querySelectorAll<HTMLElement>('.card'))).toEqual(before);
  });

  it('rebuilds a card whose session was retitled, so the new title is on it', () => {
    send(message({ lanes: lanes({ plan: [planCard] }) }));

    const before = document.querySelector<HTMLElement>('.card')!;
    const retitled = { ...planCard, sessions: [{ ...session, title: 'Now checking the migration' }] };

    send(message({ lanes: lanes({ plan: [retitled] }) }));

    const after = document.querySelector<HTMLElement>('.card')!;

    expect(after).not.toBe(before);
    expect(after.querySelector('.session-label')?.textContent).toBe('Now checking the migration');
  });

  it('rebuilds only the card whose content changed, and reorders the rest in place', () => {
    const other: LanedCard = { ...planCard, key: 'issue:18900', issueNumber: 18900 };

    send(message({ lanes: lanes({ plan: [planCard, other] }) }));

    const [first, second] = Array.from(document.querySelectorAll<HTMLElement>('.card'));

    send(message({ lanes: lanes({ plan: [other, { ...planCard, returned: true }] }) }));

    const after = Array.from(document.querySelectorAll<HTMLElement>('.card'));

    expect(after[0]).toBe(second);
    expect(after[1]).not.toBe(first);
    expect(after[1]?.querySelector('.returned')).not.toBeNull();
  });

  it('drops the element of a card the board no longer carries', () => {
    send(message({ lanes: lanes({ plan: [planCard] }) }));
    send(message({ lanes: lanes({}) }));

    expect(document.querySelectorAll('.card')).toHaveLength(0);
    expect(document.querySelector('.empty')?.textContent).toBe('No open issues are assigned to you.');
  });

  it('holds a refresh that arrives mid-drag until the drag ends', () => {
    send(message({ lanes: lanes({ plan: [planCard] }) }));

    const card = document.querySelector<HTMLElement>('.card')!;
    card.dispatchEvent(new Event('dragstart', { bubbles: true }));

    send(message({ lanes: lanes({ build: [{ ...planCard, lane: 'build' }] }) }));

    expect(laneEl('plan')?.querySelectorAll('.card')).toHaveLength(1);
    expect(laneEl('build')?.querySelectorAll('.card')).toHaveLength(0);

    card.dispatchEvent(new Event('dragend', { bubbles: true }));

    expect(laneEl('plan')?.querySelectorAll('.card')).toHaveLength(0);
    expect(laneEl('build')?.querySelectorAll('.card')).toHaveLength(1);
  });

  it('renders a refresh straight away when nothing is being dragged', () => {
    send(message({ lanes: lanes({ plan: [planCard] }) }));
    send(message({ lanes: lanes({ build: [{ ...planCard, lane: 'build' }] }) }));

    expect(laneEl('build')?.querySelectorAll('.card')).toHaveLength(1);
  });

  it('ignores a drop carrying something that is not a card on the board', () => {
    send(message({ lanes: lanes({ plan: [planCard] }) }));

    // A file or a text selection dropped on a column arrives exactly like this, with a key the board never issued.
    const drop = new Event('drop', { bubbles: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { getData: () => 'issue:99999' } });

    laneEl('build')!.dispatchEvent(drop);
    expect(api.postMessage).not.toHaveBeenCalled();
  });

  it('keeps a card with no issue reachable from a keyboard, since its open button is disabled', () => {
    const adHoc: LanedCard = {
      key: 'session:c:/work/18953-cache-remediation',
      issue: null,
      issueNumber: null,
      lane: 'plan',
      returned: false,
      reason: 'Ad-hoc work with no issue.',
      sessions: [{ ...session, issueNumber: null }],
    };

    send(message({ lanes: lanes({ plan: [adHoc] }) }));

    const card = document.querySelector<HTMLElement>('.card')!;

    expect(card.querySelector<HTMLButtonElement>('.card-open')!.disabled).toBe(true);
    expect(card.tabIndex).toBe(0);

    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true }));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'moveCard', key: adHoc.key, lane: 'build' });
  });

  it('offers no way to move an archived card — only a status takes a card off the board', () => {
    const toggle = document.getElementById('show-archived') as HTMLInputElement;
    toggle.checked = true;

    send(message({ lanes: lanes({ archived: [archivedCard] }) }));

    const card = laneEl('archived')!.querySelector<HTMLElement>('.card')!;

    expect(card.draggable).toBe(false);

    card.querySelector<HTMLElement>('.card-open')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true }),
    );
    expect(api.postMessage).not.toHaveBeenCalled();
  });
});
