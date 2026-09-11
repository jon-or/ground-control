import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTION_REVISION, DEFAULT_SESSION_SCOPE, bootstrapDirOf, parseHubConfig } from '@ground-control/core';
import type { HistoricalSession, HubConfig, HubMessage, IssueCard, ReadFailure, Session, SessionScope, Snapshot, WorkSource } from '@ground-control/core';
import { Hub } from '../src/hub.js';
import { makeActionStore } from '../src/actionStore.js';
import { makeCheckoutStore, makeWorktreeStore } from '../src/checkoutStore.js';
import { makeIssueStore } from '../src/issueStore.js';
import { makeLaneStore } from '../src/lanes.js';
import { makeMarkStore } from '../src/marks.js';
import { defaultConfig } from '../src/registry.js';
import { makeStatusStore } from '../src/statusStore.js';
import { makeTriageStore } from '../src/triageStore.js';
import { captureLog, fakeClock, fakeHost, fakeReaders, fakeSession, reportingAgent, tempHome } from './helpers.js';

let home: string;
let stateDir: string;
let cleanup: () => void;
const hubs: Hub[] = [];
beforeEach(() => {
  ({ home, dispose: cleanup } = tempHome());
  stateDir = bootstrapDirOf(home);
  stateDir = stateDir;
});
afterEach(() => { for (const hub of hubs.splice(0)) hub.dispose(); cleanup(); });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function issue(number = 1): IssueCard {
  return {
    number, title: `Work issue ${number}`, url: `https://github.com/work/repo/issues/${number}`,
    type: null, typeColor: null, status: null, statusColor: null, statusChangedAt: null,
    assignees: ['developer'], avatar: null, pullRequest: null, updatedAt: '2026-09-09T12:00:00Z',
  };
}

function live(secret = false, over: Partial<Session> = {}): Session {
  const root = `${home}/${secret ? 'private-checkout' : 'work-checkout'}`;
  mkdirSync(root, { recursive: true });
  return fakeSession({
    sessionId: secret ? 'private-session-id' : 'work-session-id', title: secret ? 'Private session title' : 'Work session title',
    cwd: root, checkoutRoot: root, branch: secret ? 'private-branch' : 'work-branch',
    repository: 'github.com/work/repo', issueNumber: 1, ...over,
  });
}

function past(secret = false): HistoricalSession {
  const session = live(secret);
  return {
    agent: 'fake', sessionId: secret ? 'private-history-id' : 'work-history-id',
    title: secret ? 'Private history title' : 'Work history title', cwd: session.cwd, branch: session.branch,
    repository: session.repository, issueNumber: 1, updatedAt: 100,
  };
}

function latest(inbox: HubMessage[]): Snapshot {
  const message = [...inbox].reverse().find((entry) => entry.type === 'snapshot' || entry.type === 'changed');
  if (message?.type !== 'snapshot' && message?.type !== 'changed') throw new Error('Expected a client snapshot');
  return message.snapshot;
}

function expectPrivateAbsent(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const needle of ['private-checkout', 'private-session-id', 'private-history-id', 'Private session title', 'Private history title', 'private-branch', 'personal/private-repo']) {
    expect(serialized, `Unexpected private value: ${needle}`).not.toContain(needle);
  }
}

function harness(options: {
  sessions?: Session[];
  history?: HistoricalSession[];
  scope?: Partial<SessionScope>;
  assigned?: IssueCard[];
  running?: boolean;
  stopFailure?: ReadFailure;
  readFailure?: ReadFailure;
} = {}) {
  const agent = reportingAgent();
  agent.sessions = options.sessions ?? [];
  agent.failure = options.readFailure ?? null;
  agent.adapter.listHistory = async () => ({ sessions: options.history ?? [], failure: null });
  agent.adapter.canResume = () => true;
  const stopped: string[] = [];
  agent.adapter.stopDispatch = async (_path, id) => { stopped.push(id); return options.stopFailure ?? null; };
  const host = fakeHost();
  host.resident = ['reveal-here', 'resume-here', 'open-checkout', 'start-session'];
  host.adapter.openable = (sessions, history = []) => [...sessions, ...history].map((session) => session.sessionId);
  const clock = fakeClock();
  const logs = captureLog();
  const lookups: string[] = [];
  const assigned = options.assigned ?? [issue()];
  const source: WorkSource = {
    id: 'github', displayName: 'GitHub', configure: () => null,
    read: async () => ({
      items: { cards: assigned, owners: ['developer'], matched: assigned.length, totalAssigned: assigned.length, notOnProject: 0, fieldProblem: null, truncated: false, fetchedAt: '2026-09-09T12:00:00Z' },
      failure: null, needs: null,
    }),
    readCard: async (repository, number) => { lookups.push(`${repository}#${number}`); return { card: issue(number), failure: null }; },
  };
  const registries = { agents: [agent.adapter], hosts: [host.adapter], sources: [source] };
  const raw: HubConfig = {
    ...defaultConfig(registries, fakeReaders({}, home)), agents: [{ id: 'fake', path: 'fake-cli' }],
    hosts: { 'fake-host': {} }, sources: { github: {} }, installActivity: false,
    sessionScope: { ...DEFAULT_SESSION_SCOPE, ...options.scope },
  };
  // SettingsStore returns validated, normalized values after reading durable JSON.
  const parsed = parseHubConfig(raw);
  if ('failure' in parsed) throw new Error(parsed.failure.message);
  let config = parsed.config;
  const actions = makeActionStore(stateDir);
  if (options.running) {
    actions.write({
      runs: { 'issue:1': {
        key: 'issue:1', action: 'merge-upstream', revision: ACTION_REVISION, evidence: 'test-evidence',
        startedAt: clock.clock.now(), endedAt: null, agent: 'fake', sessionId: 'private-session-id', shortId: 'private-session-id',
        outcome: 'running', detail: 'Working in private-checkout.',
      } }, refusals: {}, gates: {}, dispatches: [clock.clock.now()],
    });
  }
  const hub = new Hub({
    home, stateDir, registries, clock: clock.clock, log: logs.log, watch: () => ({ dispose() {} }),
    lanes: makeLaneStore(stateDir), marks: makeMarkStore(stateDir), triage: makeTriageStore(stateDir), actions,
    checkouts: makeCheckoutStore(stateDir), worktrees: makeWorktreeStore(stateDir), issues: makeIssueStore(stateDir), status: makeStatusStore(stateDir),
    settings: { read: () => ({ config }), write: (next) => { config = next; } },
    syncActivity: (_registries, wanted) => ({ wanted, plan: 'up-to-date', added: 0, failure: null }),
  });
  hubs.push(hub);
  const editor: HubMessage[] = [];
  const browser: HubMessage[] = [];
  const client = hub.connect({ id: 'editor', hostId: 'fake-host', workspaceRoot: null, residentRoutes: host.resident, watching: true }, (message) => editor.push(message));
  hub.connect({ id: 'browser', hostId: null, workspaceRoot: null, residentRoutes: [], watching: true }, (message) => browser.push(message));
  return {
    hub, client, editor, browser, host, agent, actions, stopped, lookups, logs,
    async ready() { await hub.refresh('asked'); await settle(); },
    configure(scope: Partial<SessionScope>) { hub.configure({ ...config, sessionScope: { ...DEFAULT_SESSION_SCOPE, ...scope } }); },
  };
}

describe('session scope at the hub boundary', () => {
  it('filters both clients and avoids issue lookups for excluded sessions', async () => {
    const h = harness({
      sessions: [live(), live(true, { repository: 'github.com/personal/private-repo', issueNumber: 87 })], history: [past(true)],
      scope: { includeRepositories: ['work/repo'], excludeDirectories: [`${home}/private-checkout`] },
    });
    await h.ready();
    const snapshot = latest(h.editor);
    expect(snapshot.sessions?.count).toBe(1);
    expect(snapshot.lanes.flatMap((lane) => lane.cards).flatMap((card) => card.sessions).map((session) => session.sessionId)).toEqual(['work-session-id']);
    expect(latest(h.browser).lanes).toEqual(snapshot.lanes);
    expect(h.lookups).toEqual([]);
    const roster = await h.hub.roster();
    expect(roster?.map((session) => session.sessionId)).toEqual(['work-session-id']);
    expectPrivateAbsent(roster);
    expectPrivateAbsent([h.editor, h.browser, h.logs.messages]);
  });

  it('removes excluded derived checkouts and refuses stale checkout and session requests without echoing private data', async () => {
    const h = harness({ sessions: [live(true)] });
    await h.ready();
    expect(latest(h.editor).lanes.flatMap((lane) => lane.cards)[0]?.checkout?.root).toContain('private-checkout');
    h.editor.length = h.browser.length = 0;
    h.configure({ excludeDirectories: [`${home}/private-checkout`] });
    await settle();
    h.hub.receive(h.client, { type: 'setCheckout', key: 'issue:1', root: `${home}/private-checkout` });
    h.hub.receive(h.client, { type: 'openCheckout', key: 'issue:1' });
    h.hub.receive(h.client, { type: 'open', sessionId: 'private-session-id', extensionReady: true });
    await settle();
    expect(h.editor.some((message) => message.type === 'notice')).toBe(true);
    expect(h.host.checkoutsPlanned).toEqual([]);
    expect(h.host.planned).toEqual([]);
    expect(h.editor.some((message) => message.type === 'perform')).toBe(false);
    expectPrivateAbsent([h.editor, h.browser]);
  });

  it('hides history in both clients and refuses a stale resume link', async () => {
    const historical = past();
    const h = harness({ history: [historical] });
    await h.ready();
    expect(latest(h.editor).openable).toContain(historical.sessionId);
    h.configure({ showHistory: false });
    await settle();
    expect(latest(h.editor).lanes.flatMap((lane) => lane.cards)[0]?.lastSession).toBeUndefined();
    expect(latest(h.browser).openable).not.toContain(historical.sessionId);
    h.editor.length = 0;
    h.hub.receive(h.client, { type: 'open', sessionId: historical.sessionId, extensionReady: true });
    await settle();
    expect(h.host.planned).toEqual([]);
    expect(h.editor.some((message) => message.type === 'notice')).toBe(true);
  });

  it('rechecks scope after a historical route waits for window discovery', async () => {
    const historical = past(true);
    const h = harness({ history: [historical] });
    await h.ready();
    let release!: () => void;
    let windows = 0;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    h.host.adapter.windows = async () => { windows++; await waiting; return { live: [], holding: null }; };
    h.host.plan = { route: 'resume-here', session: historical, root: historical.cwd, expiresAt: Date.now() + 30_000 };
    h.hub.receive(h.client, { type: 'open', sessionId: historical.sessionId, extensionReady: true });
    await settle();
    expect(windows).toBe(1);
    h.editor.length = h.browser.length = 0;
    h.configure({ excludeDirectories: [`${home}/private-checkout`] });
    release();
    await settle();
    expect(h.editor.some((message) => message.type === 'perform')).toBe(false);
    expect(h.editor.some((message) => message.type === 'notice')).toBe(true);
    expectPrivateAbsent([h.editor, h.browser]);
  });

  it('hides ad-hoc cards while continuing to read the live roster', async () => {
    const h = harness({ assigned: [], sessions: [live(true, { issueNumber: null })], scope: { showAdHoc: false } });
    await h.ready();
    expect(latest(h.editor).lanes.flatMap((lane) => lane.cards)).toEqual([]);
    expect(latest(h.browser).lanes).toEqual(latest(h.editor).lanes);
    const reads = h.agent.calls;
    await h.hub.roster();
    expect(h.agent.calls).toBeGreaterThan(reads);
    expect(latest(h.editor).lanes.flatMap((lane) => lane.cards)).toEqual([]);
  });

  it.each([false, true])('retains a stop control for excluded work after unassignment (stop fails: %s)', async (fails) => {
    const h = harness({
      assigned: [], sessions: [live(true)], running: true,
      scope: { excludeDirectories: [`${home}/private-checkout`], showAdHoc: false },
      ...(fails ? { stopFailure: { subject: 'fake', kind: 'stop-failed', message: 'private-session-id failed in private-checkout', remedy: 'Inspect private-checkout' } } : {}),
    });
    await h.ready();
    const running = latest(h.editor).lanes.flatMap((lane) => lane.cards).find((card) => card.key === 'issue:1');
    expect(running?.action?.state).toBe('running');
    expect(latest(h.browser).lanes).toEqual(latest(h.editor).lanes);
    expect(h.lookups).toEqual([]);
    expectPrivateAbsent([h.editor, h.browser]);
    h.hub.receive(h.client, { type: 'stopAction', key: 'issue:1' });
    await settle();
    expect(h.stopped).toEqual(['private-session-id']);
    // Existing lifecycle prunes completed runs for absent cards; the daily usage ledger remains.
    expect(h.actions.read().runs['issue:1']?.outcome).toBe(fails ? 'running' : undefined);
    expect(h.actions.read().dispatches).toHaveLength(1);
    if (fails) expect(h.editor.some((message) => message.type === 'notice')).toBe(true);
    expectPrivateAbsent([h.editor, h.browser]);
  });

  it('keeps a useful session failure without forwarding excluded diagnostic details', async () => {
    const h = harness({
      sessions: [live()], scope: { excludeDirectories: [`${home}/private-checkout`] },
      readFailure: { subject: 'fake', kind: 'session-read-failed', message: 'Cannot read private-checkout for private-session-id', remedy: 'Inspect private-checkout' },
    });
    await h.ready();
    expect(latest(h.editor).failures.some((failure) => failure.kind === 'session-read-failed')).toBe(true);
    expectPrivateAbsent([h.editor, h.browser, h.logs.messages]);
  });
});
