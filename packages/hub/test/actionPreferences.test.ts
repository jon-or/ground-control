import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeClaudeAdapter } from '@ground-control/agent-claude';
import { makeCodexAdapter } from '@ground-control/agent-codex';
import { DEFAULT_ACTIONS } from '@ground-control/core';
import type { ActionSettings, AgentAdapter, AgentConfig, Lane, TriageContext, WorkSource } from '@ground-control/core';
import { ActionRunner } from '../src/actions.js';
import { makeActionStore } from '../src/actionStore.js';
import { captureLog, tempHome } from './helpers.js';

let home: string;
let dispose: () => void;

beforeEach(() => { ({ home, dispose } = tempHome()); });
afterEach(() => dispose());

const configured: AgentConfig[] = [{ id: 'claude', path: 'claude-cli', model: 'legacy-claude' }, { id: 'codex', path: 'codex-cli', model: 'legacy-codex' }];

function harness(over: Partial<ActionSettings> = {}, enabled = configured) {
  const calls: { agent: string; path: string; args: readonly string[] }[] = [];
  const notices: string[] = [];
  let reads = 0;
  let hold: Promise<void> | null = null;
  const settings: ActionSettings = { ...DEFAULT_ACTIONS, actions: { 'merge-upstream': { enabled: true, prompt: 'Merge {base} into {branch}' } }, ...over };
  const claude = makeClaudeAdapter(async () => { throw new Error('unexpected classifier or roster read'); }, async (path, args) => {
    calls.push({ agent: 'claude', path, args });
    return { ok: true, text: 'backgrounded · 46af2ac8 · merge' };
  });
  const codex = makeCodexAdapter({
    env: {}, alive: () => false, kill: () => true,
    start: async (path, args) => {
      calls.push({ agent: 'codex', path, args });
      const line = '{"type":"thread.started","thread_id":"01a07d5a-b5bd-7762-8ef8-4202ce964f31"}';
      return { pid: 42, failure: null, firstLine: async (wanted) => wanted(line) ? line : null };
    },
  });
  const agents: AgentAdapter[] = [claude, codex];
  const context: TriageContext = {
    repository: 'example/repo', issueNumber: 1, title: 'Merge upstream', body: '', status: 'Dev', stateEvents: [], comments: [],
    logins: ['developer'], defaultBranch: 'main',
    pullRequest: {
      number: 2, title: 'Fix bug', body: '', state: 'OPEN', isDraft: false, author: 'developer', authorName: null,
      baseRefName: 'main', headRefName: '1-fix', headOid: 'abcd1234', checkState: 'SUCCESS', comments: [], reviews: [], reviewRequests: [], threads: [],
    },
  };
  const source: WorkSource = {
    id: 'github', displayName: 'GitHub', configure: () => null,
    read: async () => { throw new Error('unexpected issue list read'); },
    readContext: async () => { reads++; await hold; return { context, failure: null }; },
  };
  const checkout = `${home}/checkout`;
  mkdirSync(checkout);
  const lanes: Lane[] = [{ id: 'build', title: 'Build', cards: [{
    key: 'issue:1', issueNumber: 1, lane: 'build', returned: false, attention: null, reason: '', sessions: [],
    checkout: { root: checkout, source: 'session', only: true },
    triage: { state: 'done', action: 'merge-upstream', qualifier: null, detail: 'Merge main.', at: 1, stale: false },
    issue: { number: 1, title: 'Merge upstream', url: 'https://github.com/example/repo/issues/1', type: null, typeColor: null,
      status: 'Dev', statusColor: null, statusChangedAt: null, assignees: ['developer'], avatar: null, pullRequest: null, updatedAt: '' },
  }] }];
  const store = makeActionStore(home);
  const runner = new ActionRunner({
    stateDir: home, agents, sources: [source], store, log: captureLog().log, now: () => 1000,
    changed: () => {}, announce: () => {}, notify: (message) => notices.push(message),
  });
  runner.configure(settings, enabled);
  const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
  return {
    runner, agents, calls, notices, store, settings, lanes, settle,
    get reads() { return reads; },
    hold(promise: Promise<void>) { hold = promise; },
    async request() { expect(runner.runAction(lanes, 'issue:1')).toBeNull(); await settle(); },
  };
}

describe('action agent and model preferences', () => {
  it.each(['claude', 'codex'] as const)('dispatches with explicitly selected %s while both agents stay configured', async (agent) => {
    const h = harness({ agent, model: 'action-model', permissionMode: 'dontAsk' }, [...configured].reverse());
    await h.request();

    expect(h.reads).toBe(1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ agent, path: `${agent}-cli` });
    expect(h.store.read().runs['issue:1']?.agent).toBe(agent);
    const flag = agent === 'claude' ? '--model' : '-m';
    expect(h.calls[0]!.args.slice(h.calls[0]!.args.indexOf(flag), h.calls[0]!.args.indexOf(flag) + 2)).toEqual([flag, 'action-model']);
    expect(h.calls[0]!.args).not.toContain(`legacy-${agent}`);
    if (agent === 'codex') {
      expect(h.calls[0]!.args).toContain('workspace-write');
      expect(h.calls[0]!.args).toContain('approval_policy="never"');
      expect(h.calls[0]!.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    }
  });

  it('retains registry order for auto regardless of configuration order', async () => {
    const h = harness({ agent: 'auto' }, [...configured].reverse());
    await h.request();
    expect(h.calls.map((call) => call.agent)).toEqual(['claude']);
  });

  it.each(['claude', 'codex'] as const)('preserves legacy %s model only when actions.model is absent', async (agent) => {
    const h = harness({ agent, permissionMode: 'dontAsk' });
    await h.request();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.args).toContain(`legacy-${agent}`);
  });

  it.each(['claude', 'codex'] as const)('uses the %s CLI default when actions.model is explicitly empty', async (agent) => {
    const h = harness({ agent, model: '', permissionMode: 'dontAsk' });
    await h.request();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.args).not.toContain('--model');
    expect(h.calls[0]!.args).not.toContain('-m');
    expect(h.calls[0]!.args).not.toContain(`legacy-${agent}`);
  });

  it('refuses an explicitly selected disabled agent before reading context', async () => {
    const h = harness({ agent: 'codex' }, [configured[0]!]);
    await h.request();
    expect(h.reads).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain('selected action agent "codex"');
  });

  it('refuses an enabled agent without dispatch capability before reading context', async () => {
    const h = harness({ agent: 'codex' });
    delete h.agents[1]!.dispatch;
    await h.request();
    expect(h.reads).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.notices[0]).toContain('cannot dispatch');
  });

  it('refuses auto when no enabled dispatcher exists', async () => {
    const h = harness({}, []);
    await h.request();
    expect(h.reads).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.notices).toEqual(['No enabled agent supports card actions. Enable a supported agent in groundControl.agents.']);
  });

  it.each(['manual', 'acceptEdits', 'auto'])('refuses Codex %s without reading context or dispatching', async (permissionMode) => {
    const h = harness({ agent: 'codex', permissionMode });
    await h.request();
    expect(h.reads).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain(`cannot use "${permissionMode}"`);
    expect(h.notices[0]).toContain('groundControl.actions.permissionMode');
  });

  it('refuses automatic unsupported permissions and persists the refusal without spending an attempt', async () => {
    const h = harness({ agent: 'codex', permissionMode: 'auto' });
    h.runner.consider(h.lanes, [], true, true, true);
    await h.settle();
    expect(h.reads).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.store.read().refusals['issue:1']?.kind).toBe('action-permission-unsupported');
    expect(h.store.read().runs).toEqual({});
  });

  it('refuses an adapter that declares no supported permissions', async () => {
    const h = harness({ agent: 'claude' });
    delete (h.agents[0] as { dispatchPermissions?: readonly string[] }).dispatchPermissions;
    await h.request();
    expect(h.reads).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.notices[0]).toContain('none declared');
  });

  it('does not launch with obsolete settings after a held context read', async () => {
    const h = harness({ agent: 'claude' });
    let release!: () => void;
    h.hold(new Promise<void>((resolve) => { release = resolve; }));
    await h.request();
    expect(h.reads).toBe(1);
    expect(h.calls).toEqual([]);
    h.runner.configure({ ...h.settings, agent: 'codex', permissionMode: 'dontAsk' }, configured);
    release();
    await h.settle();
    expect(h.calls).toEqual([]);
    expect(h.notices).toEqual(['Action settings changed while reading the card. Retry with the current settings.']);
  });
});
