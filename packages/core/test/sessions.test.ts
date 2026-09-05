import { describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentReading } from '../src/agent.js';
import { fetchSessions, fetchSessionHistory } from '../src/sessions.js';
import type { MachineDeps, MachineReaders } from '../src/machine.js';
import type { Session, SessionsConfig } from '../src/types.js';
import { HOME, gitReads } from './helpers.js';

/** Whole, not cast: a partial literal would go on compiling the day `Session` grows a field. */
const SESSION: Session = {
  agent: 'fake',
  sessionId: 'a1b2c3d4-0000-4000-8000-000000000000',
  pid: 4242,
  title: null,
  cwd: '/nowhere/checkout',
  startedAt: 0,
  branch: null,
  issueNumber: null,
  transcriptWrittenAt: null,
  activity: null,
  finished: false,
  details: {},
};

const readers: MachineReaders = {
  readText: gitReads(),
  mtime: () => null,
  listDir: () => null,
  readTail: () => null,
  readHead: () => null,
  home: HOME,
};

function config(over: Partial<SessionsConfig> = {}): SessionsConfig {
  return { agents: [{ id: 'fake', path: 'fake' }], branchIssuePattern: '^(\\d+)-', ...over };
}

/** An adapter that records what it was asked and answers with what it was given. */
function adapter(id: string, reading: AgentReading = { sessions: [{ ...SESSION, agent: id }], failure: null }) {
  const calls: { path: string; deps: MachineDeps }[] = [];

  const fake: AgentAdapter & { calls: typeof calls } = {
    id,
    displayName: id,
    defaultPath: `${id}-cli`,
    defaultEnabled: true,
    calls,
    async listSessions(path, deps) {
      calls.push({ path, deps });

      return reading;
    },
  };

  return fake;
}

describe('fetchSessions', () => {
  it('asks the configured adapter at the configured path', async () => {
    const fake = adapter('fake');
    await fetchSessions(config({ agents: [{ id: 'fake', path: 'C:/tools/fake.exe' }] }), [fake], readers);

    expect(fake.calls.map((call) => call.path)).toEqual(['C:/tools/fake.exe']);
  });

  it('falls back to the adapter default when the configured path is empty', async () => {
    const fake = adapter('fake');
    await fetchSessions(config({ agents: [{ id: 'fake', path: '' }] }), [fake], readers);

    expect(fake.calls[0]?.path).toBe('fake-cli');
  });

  it('hands the adapter the readers it was given and the compiled pattern', async () => {
    const fake = adapter('fake');
    await fetchSessions(config(), [fake], readers);

    const deps = fake.calls[0]?.deps;

    expect(deps?.home).toBe(HOME);
    expect(deps?.readText).toBe(readers.readText);
    expect(deps?.pattern?.exec('18941-inbox')?.[1]).toBe('18941');
  });

  it('returns what the adapter listed, and stamps the read time', async () => {
    const before = Date.now();
    const snapshot = await fetchSessions(config(), [adapter('fake')], readers);

    expect(snapshot.sessions.map((s) => s.sessionId)).toEqual([SESSION.sessionId]);
    expect(snapshot.failures).toEqual([]);
    expect(Date.parse(snapshot.fetchedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(snapshot.fetchedAt)).toBeLessThanOrEqual(Date.now());
  });

  it('says why nothing linked when the pattern is unusable, and hands the adapter no pattern', async () => {
    const fake = adapter('fake');
    const snapshot = await fetchSessions(config({ branchIssuePattern: '^(\\d+' }), [fake], readers);

    expect(snapshot.patternError).toContain('groundControl.branchIssuePattern');
    expect(snapshot.patternError).toContain('not a valid regular expression');
    expect(fake.calls[0]?.deps.pattern).toBeNull();
  });

  it('says why nothing linked when the pattern captures nothing', async () => {
    const snapshot = await fetchSessions(config({ branchIssuePattern: '^\\d+-' }), [adapter('fake')], readers);

    expect(snapshot.patternError).toContain('no capturing group');
  });

  it('reads nothing at all when no agent is configured', async () => {
    const fake = adapter('fake');
    const snapshot = await fetchSessions(config({ agents: [] }), [fake], readers);

    expect(snapshot).toMatchObject({ sessions: [], failures: [], patternError: null });
    expect(fake.calls).toEqual([]);
  });

  it('names an agent it does not know how to read', async () => {
    const snapshot = await fetchSessions(config({ agents: [{ id: 'gemini', path: 'gemini' }] }), [adapter('fake')], readers);

    expect(snapshot.failures).toHaveLength(1);
    expect(snapshot.failures[0]).toMatchObject({ subject: 'gemini', kind: 'unknown-agent' });
    expect(snapshot.failures[0]?.message).toContain('gemini');
  });

  it('keeps one CLI failing from hiding another CLI sessions', async () => {
    const failing = adapter('broken', {
      sessions: [],
      failure: { subject: 'broken', kind: 'agent-missing', message: 'not here', remedy: 'install it' },
    });
    const snapshot = await fetchSessions(
      config({
        agents: [
          { id: 'gemini', path: 'gemini' },
          { id: 'broken', path: 'broken' },
          { id: 'fake', path: 'fake' },
        ],
      }),
      [adapter('fake'), failing],
      readers,
    );

    expect(snapshot.sessions.map((s) => s.agent)).toEqual(['fake']);
    expect(snapshot.failures.map((f) => f.subject)).toEqual(['gemini', 'broken']);
  });

  it('keeps the sessions an adapter listed beside the failure it reported', async () => {
    const partial = adapter('fake', {
      sessions: [SESSION],
      failure: { subject: 'fake', kind: 'bad-response', message: 'one entry unreadable', remedy: 'refresh' },
    });
    const snapshot = await fetchSessions(config(), [partial], readers);

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.failures).toHaveLength(1);
  });
});


describe('history fan-out', () => {
  it('keeps an absent capability empty and catches a history reader failure independently of liveness', async () => {
    expect(await fetchSessionHistory(config(), [adapter('fake')], readers)).toEqual({ sessions: [], failures: [] });
    const fake = adapter('fake');
    fake.listHistory = async () => { throw new Error('unreadable'); };
    expect((await fetchSessionHistory(config(), [fake], readers)).failures[0]?.kind).toBe('history-failed');
    expect((await fetchSessions(config(), [fake], readers)).failures).toEqual([]);
  });
});
