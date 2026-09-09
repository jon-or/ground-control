import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, HubConfig } from '@ground-control/core';
import { bootstrapDirOf, resolveAgentHomes } from '@ground-control/core';
import { acceptAgentHomes, uninstallAgentActivity } from '../src/agentHomes.js';
import { configureAgentHomes, defaultConfig, makeRegistries } from '../src/registry.js';
import { makeSettingsStore } from '../src/settings.js';
import { configPathOf, installLockPathOf } from '../src/paths.js';
import { syncActivity } from '../src/activityInstall.js';
import { Hub } from '../src/hub.js';
import { makeActionStore } from '../src/actionStore.js';
import { makeCheckoutStore } from '../src/checkoutStore.js';
import { makeIssueStore } from '../src/issueStore.js';
import { makeLaneStore } from '../src/lanes.js';
import { makeMarkStore } from '../src/marks.js';
import { makeStatusStore } from '../src/statusStore.js';
import { makeTriageStore } from '../src/triageStore.js';
import { captureLog, fakeClock, fakeHost, fakeReaders, fakeSession, reportingAgent, tempHome } from './helpers.js';

let home: string;
let stateDir: string;
let cleanup: () => void;
const hubs: Hub[] = [];
beforeEach(() => { ({ home, dispose: cleanup } = tempHome()); home = home.replace(/\\/g, '/'); stateDir = bootstrapDirOf(home); });
afterEach(() => { hubs.splice(0).forEach((hub) => hub.dispose()); vi.unstubAllEnvs(); vi.useRealTimers(); cleanup(); });
const settle = () => new Promise<void>((done) => setImmediate(done));

function profileAgent() {
  const held = reportingAgent();
  let root = `${home}/.fake`;
  const changes: string[] = [];
  const adapter: AgentAdapter = {
    ...held.adapter,
    storage: { environment: 'FAKE_HOME', defaultDirectory: '.fake', configure(value) { root = value; changes.push(value); } },
    activity: {
      settingsPath: () => `${root}/settings.json`, watchDir: () => `${stateDir}/fake-markers`, read: () => null,
      writer: { path: () => `${stateDir}/writer.mjs`, source: 'cached writer' },
      plan({ settingsText, wanted }) {
        let settings: Record<string, unknown>;
        try { settings = JSON.parse(settingsText ?? '{}') as Record<string, unknown>; }
        catch { return { kind: 'refuse', reason: 'Invalid fake settings', remedy: 'Fix fake settings' }; }
        const had = settings.owned === true;
        if (wanted === 'install') settings.owned = true;
        else delete settings.owned;
        return had === (wanted === 'install') ? { kind: 'up-to-date' } :
          { kind: 'write', text: JSON.stringify(settings), added: wanted === 'install' ? 1 : 0, removed: had ? 1 : 0 };
      },
    },
  };
  return { held, adapter, changes, root: () => root };
}

function harness(options: { env?: Record<string, string>; stored?: boolean; legacy?: boolean; failSave?: boolean } = {}) {
  const agent = profileAgent();
  const host = fakeHost();
  const clock = fakeClock();
  const store = makeSettingsStore(stateDir);
  const registries = { agents: [agent.adapter], hosts: [host.adapter], sources: [], agentEnvironment: options.env ?? {} };
  let config: HubConfig = { ...defaultConfig(registries, fakeReaders({}, home)), installActivity: false };
  if (options.stored !== false) {
    if (!options.legacy) config.agentHomes = { fake: `${home}/selected` };
    store.write(config);
  }
  const hub = new Hub({ home, stateDir, registries, clock: clock.clock, log: captureLog().log, watch: () => ({ dispose() {} }),
    lanes: makeLaneStore(stateDir), marks: makeMarkStore(stateDir), triage: makeTriageStore(stateDir), actions: makeActionStore(stateDir),
    issues: makeIssueStore(stateDir), status: makeStatusStore(stateDir), checkouts: makeCheckoutStore(stateDir),
    settings: { read: store.read, write(next) { if (options.failSave) throw new Error('denied'); store.write(next); config = next; } },
    syncActivity: (regs, wanted, where, state, enabled) => syncActivity(regs.agents, wanted, where, state, false, enabled),
  });
  hubs.push(hub);
  return { hub, agent, host, clock, store, config: () => config,
    update(root: string) { return hub.configure({ ...config, agentHomes: { fake: root } }); },
    async ready() { await hub.roster(); await settle(); },
  };
}

describe('accepted agent profiles', () => {
  it('loads recorded roots before detection and retains them when another client omits homes', async () => {
    const h = harness({ env: { FAKE_HOME: `${home}/wrong-launcher` } });
    expect(h.agent.changes).toEqual([`${home}/selected`, `${home}/selected`]);
    await h.ready();
    const { agentHomes: _homes, ...older } = h.config();
    h.hub.configure(older);
    expect(h.agent.root()).toBe(`${home}/selected`);
    expect(h.store.read()).toMatchObject({ config: { agentHomes: { fake: `${home}/selected` } } });
  });
  it('persists first launcher selection and restores it across a different launcher', () => {
    const h = harness({ env: { FAKE_HOME: `${home}/environment-profile` }, stored: false });
    expect(h.store.read()).toMatchObject({ config: { agentHomes: { fake: `${home}/environment-profile` } } });
    const registries = { agents: [h.agent.adapter], hosts: [], sources: [], agentEnvironment: { FAKE_HOME: `${home}/other` } };
    const saved = h.store.read();
    expect(saved && 'config' in saved && resolveAgentHomes(registries.agents, saved.config.agentHomes, home, registries.agentEnvironment))
      .toEqual({ homes: { fake: `${home}/environment-profile` } });
  });
  it('removes provably owned legacy default hooks when upgrading saved settings', () => {
    mkdirSync(`${home}/.fake`);
    writeFileSync(`${home}/.fake/settings.json`, '{"owned":true,"unrelated":"keep"}');
    const h = harness({ legacy: true, env: { FAKE_HOME: `${home}/custom` } });
    expect(h.agent.root()).toBe(`${home}/custom`);
    expect(JSON.parse(readFileSync(`${home}/.fake/settings.json`, 'utf8'))).toEqual({ unrelated: 'keep' });
    expect(h.store.read()).toMatchObject({ config: { agentHomes: { fake: `${home}/custom` } } });
  });
  it('includes the accepted home only for an authorized session check', async () => {
    const h = harness(); const session = fakeSession({ cwd: `${home}/work`, checkoutRoot: `${home}/work` });
    h.agent.held.sessions = [session]; await h.ready();
    expect(await h.hub.sessionCheck(session.sessionId)).toEqual({ allowed: true, targetActive: true, cardActive: true, agentHome: `${home}/selected` });
    expect(await h.hub.sessionCheck('unknown')).toEqual({ allowed: false, targetActive: false, cardActive: false });
    h.hub.configure({ ...h.config(), sessionScope: { excludeDirectories: [`${home}/work`] } });
    expect(await h.hub.sessionCheck(session.sessionId)).toEqual({ allowed: false, targetActive: false, cardActive: false });
  });
  it.each([undefined, {}])('isolates an injected home even when the explicit environment is %j', (env) => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', `${home}/developer-claude`);
    vi.stubEnv('CODEX_HOME', `${home}/developer-codex`);
    const regs = makeRegistries(undefined, home, env);
    expect(resolveAgentHomes(regs.agents, undefined, home, regs.agentEnvironment ?? {}))
      .toEqual({ homes: { claude: `${home.replace(/\\/g, '/')}/.claude`, codex: `${home.replace(/\\/g, '/')}/.codex` } });
  });
  it('refuses a switch with an unknown, active, failed, stale, or in-flight roster', async () => {
    const h = harness();
    h.update(`${home}/next`);
    expect(h.agent.root()).toBe(`${home}/selected`);
    h.agent.held.sessions = [fakeSession()]; await h.ready(); h.update(`${home}/next`);
    expect(h.agent.root()).toBe(`${home}/selected`);
    h.agent.held.sessions = []; h.agent.held.failure = { subject: 'fake', kind: 'unreadable', message: 'failed', remedy: 'retry' };
    await h.ready(); h.update(`${home}/next`); expect(h.agent.root()).toBe(`${home}/selected`);
    h.agent.held.failure = null; await h.ready(); h.clock.advance(2001); h.update(`${home}/next`);
    expect(h.agent.root()).toBe(`${home}/selected`);
    let release!: () => void;
    h.agent.held.holding = new Promise((done) => { release = done; });
    const refreshing = h.hub.roster(); h.update(`${home}/next`); expect(h.agent.root()).toBe(`${home}/selected`);
    release(); await refreshing; await settle(); h.update(`${home}/next`);
    expect(h.agent.root()).toBe(`${home}/next`);
  });
  it('keeps the live roster timestamp when history takes longer than the freshness window', async () => {
    const h = harness();
    let release!: () => void;
    const held = new Promise<void>((done) => { release = done; });
    h.agent.adapter.listHistory = async () => { await held; return { sessions: [], failure: null }; };
    const refreshing = h.ready(); await settle(); h.clock.advance(2001); release(); await refreshing;
    h.update(`${home}/next`);
    expect(h.agent.root()).toBe(`${home}/selected`);
    expect(h.hub.snapshot().failures).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'agent-home-active' })]));
  });
  it('does not authorize reads or hook writes after bootstrap save failure', async () => {
    const h = harness({ stored: false, failSave: true, env: { FAKE_HOME: `${home}/unrecorded` } });
    await h.ready();
    expect(h.agent.held.calls).toBe(0);
    expect(h.store.read()).toBeNull();
    expect(h.hub.snapshot().failures).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'agent-home-save-failed' })]));
  });
});

describe('profile hook transitions', () => {
  it.each([false, true])('uses accepted custom homes for uninstall and refuses malformed config=%s', (malformed) => {
    const claude = `${home}/profiles/claude`; const codex = `${home}/profiles/codex`;
    mkdirSync(claude, { recursive: true }); mkdirSync(codex, { recursive: true });
    mkdirSync(`${home}/.claude`); mkdirSync(`${home}/.codex`);
    writeFileSync(`${home}/.claude/settings.json`, 'default Claude sentinel');
    writeFileSync(`${home}/.codex/hooks.json`, 'default Codex sentinel');
    writeFileSync(`${claude}/settings.json`, '{"unrelated":"claude"}');
    writeFileSync(`${codex}/hooks.json`, '{"unrelated":"codex"}');
    const regs = makeRegistries(undefined, home, {});
    configureAgentHomes(regs, { claude, codex });
    const installed = syncActivity(regs.agents, 'install', home, stateDir);
    expect(installed.failure).toBeNull(); expect(installed.added).toBeGreaterThan(0);
    const beforeClaude = readFileSync(`${claude}/settings.json`, 'utf8'); const beforeCodex = readFileSync(`${codex}/hooks.json`, 'utf8');
    makeSettingsStore(stateDir).write({ ...defaultConfig(regs, fakeReaders({}, home)), agentHomes: { claude, codex } });
    if (malformed) writeFileSync(configPathOf(stateDir), '{broken');
    const result = uninstallAgentActivity(home, stateDir, { CLAUDE_CONFIG_DIR: `${home}/wrong-claude`, CODEX_HOME: `${home}/wrong-codex` });
    if (malformed) {
      expect(result.failure?.kind).toBe('bad-config');
      expect(readFileSync(`${claude}/settings.json`, 'utf8')).toBe(beforeClaude);
      expect(readFileSync(`${codex}/hooks.json`, 'utf8')).toBe(beforeCodex);
    } else {
      expect(result.failure).toBeNull(); expect(result.removed).toBeGreaterThan(0);
      expect(JSON.parse(readFileSync(`${claude}/settings.json`, 'utf8'))).toEqual({ unrelated: 'claude' });
      expect(JSON.parse(readFileSync(`${codex}/hooks.json`, 'utf8'))).toEqual({ unrelated: 'codex' });
    }
    expect(readFileSync(`${home}/.claude/settings.json`, 'utf8')).toBe('default Claude sentinel');
    expect(readFileSync(`${home}/.codex/hooks.json`, 'utf8')).toBe('default Codex sentinel');
  });
  function setup() {
    const agent = profileAgent();
    const before = { fake: `${home}/before` }; const after = { fake: `${home}/after` };
    mkdirSync(before.fake); mkdirSync(after.fake);
    writeFileSync(`${before.fake}/settings.json`, '{"owned":true,"unrelated":"keep"}');
    writeFileSync(`${after.fake}/settings.json`, '{"unrelated":"destination"}');
    mkdirSync(`${stateDir}/fake-markers`, { recursive: true });
    writeFileSync(`${stateDir}/fake-markers/live.json`, 'cached marker');
    writeFileSync(`${stateDir}/writer.mjs`, 'cached writer');
    return { agent, before, after, registries: { agents: [agent.adapter], hosts: [], sources: [] } };
  }
  it('removes only owned prior hooks before saving and preserves cached writers and markers', () => {
    const h = setup(); let saved = false;
    expect(acceptAgentHomes(h.registries, h.before, h.after, home, stateDir, () => {
      expect(JSON.parse(readFileSync(`${h.before.fake}/settings.json`, 'utf8'))).toEqual({ unrelated: 'keep' });
      expect(readFileSync(`${h.after.fake}/settings.json`, 'utf8')).toBe('{"unrelated":"destination"}');
      saved = true;
    })).toBeNull();
    expect(saved).toBe(true); expect(h.agent.root()).toBe(h.after.fake);
    expect(readFileSync(`${stateDir}/fake-markers/live.json`, 'utf8')).toBe('cached marker');
    expect(readFileSync(`${stateDir}/writer.mjs`, 'utf8')).toBe('cached writer');
  });
  it.each(['malformed', 'unreadable', 'locked', 'save'])('refuses %s without accepting the new profile', (kind) => {
    const h = setup(); const saved = vi.fn(() => { if (kind === 'save') throw new Error('denied'); });
    if (kind === 'malformed') writeFileSync(`${h.after.fake}/settings.json`, '{broken');
    if (kind === 'unreadable') mkdirSync(`${h.after.fake}/settings.json.directory`);
    if (kind === 'unreadable') h.agent.adapter.activity!.settingsPath = () => `${h.after.fake}/settings.json.directory`;
    if (kind === 'locked') writeFileSync(installLockPathOf(stateDir), 'other installer');
    expect(acceptAgentHomes(h.registries, h.before, h.after, home, stateDir, saved)).not.toBeNull();
    expect(h.agent.root()).not.toBe(h.after.fake);
    if (kind !== 'save') {
      expect(saved).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(`${h.before.fake}/settings.json`, 'utf8'))).toEqual({ owned: true, unrelated: 'keep' });
    }
  });
  it('keeps both profile preimages when two backups share a timestamp', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-09T16:00:00Z'));
    const h = setup();
    expect(acceptAgentHomes(h.registries, h.before, h.after, home, stateDir, () => {})).toBeNull();
    expect(syncActivity(h.registries.agents, 'install', home, stateDir).failure).toBeNull();
    const backups = readdirSync(stateDir).filter((name) => name.startsWith('settings-backup-fake-'));
    expect(backups).toHaveLength(2);
    expect(backups.sort().map((name) => JSON.parse(readFileSync(`${stateDir}/${name}`, 'utf8'))))
      .toEqual([{ owned: true, unrelated: 'keep' }, { unrelated: 'destination' }]);
  });
  it('reports unreadable saved config and preserves it after a failed durable write', () => {
    const store = makeSettingsStore(stateDir); const config = defaultConfig({ agents: [], hosts: [], sources: [] }, fakeReaders({}, home));
    store.write(config); const original = readFileSync(configPathOf(stateDir), 'utf8');
    mkdirSync(`${configPathOf(stateDir)}.${process.pid}.tmp`);
    expect(() => store.write({ ...config, installActivity: false })).toThrow();
    expect(readFileSync(configPathOf(stateDir), 'utf8')).toBe(original);
  });
});
