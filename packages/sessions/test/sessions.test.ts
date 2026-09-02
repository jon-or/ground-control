import { describe, expect, it } from 'vitest';
import { fetchSessions } from '../src/sessions.js';
import type { AgentEntry } from '../src/providers/claude.js';
import {
  claudeWith,
  config,
  expectedTitle,
  failingRunner,
  fixture,
  gitReads,
  listRecordedDirs,
  readRecordedTails,
  recordedMtimes,
  runnerOf,
  transcripts,
} from './helpers.js';

const active = fixture('agents-active') as AgentEntry[];
const all = fixture('agents-all') as (AgentEntry & { state?: string })[];

function deps(response: unknown = active) {
  const run = runnerOf(response);

  return {
    run,
    agents: claudeWith(run),
    readText: gitReads(),
    mtime: recordedMtimes,
    listDir: listRecordedDirs,
    readTail: readRecordedTails,
    home: transcripts.home,
  };
}

describe('the recording these tests rest on', () => {
  it('covers a session that reported a status and sessions that reported none', () => {
    expect(active.filter((e) => e.status !== undefined).length).toBeGreaterThan(0);
    expect(active.filter((e) => e.status === undefined).length).toBeGreaterThan(0);
  });

  it('covers sessions with a transcript and sessions with none', () => {
    expect(transcripts.entries.filter((e) => e.writtenAt !== null).length).toBeGreaterThan(0);
    expect(transcripts.entries.filter((e) => e.writtenAt === null).length).toBeGreaterThan(0);
  });

  it('covers background sessions carrying a short id and a state, which no active session does', () => {
    expect(all.filter((e) => e.id !== undefined && e.state !== undefined).length).toBeGreaterThan(0);
    expect(active.filter((e) => e.id !== undefined)).toEqual([]);
    expect(active.filter((e) => e.state !== undefined)).toEqual([]);
  });

  it('shows what --all adds and the board declines: sessions that have already finished', () => {
    // A property of each file on its own. The two `claude` calls are separate invocations, so one is not
    // guaranteed to be a superset of the other and no test may assert a relation between them.
    expect(all.filter((e) => e.state === 'stopped' || e.state === 'done').length).toBeGreaterThan(0);
    expect(active.filter((e) => e.state === 'stopped' || e.state === 'done')).toEqual([]);
  });
});

describe('fetchSessions', () => {
  it('asks the configured CLI for active sessions only, never --all', async () => {
    const d = deps();
    await fetchSessions(config(), d);

    expect(d.run.calls).toEqual([['claude', ['agents', '--json']]]);
  });

  it('honours a configured path over the provider default', async () => {
    const d = deps();
    await fetchSessions(config({ agents: [{ id: 'claude', path: 'C:/tools/claude.exe' }] }), d);

    expect(d.run.calls[0]?.[0]).toBe('C:/tools/claude.exe');
  });

  it('falls back to the provider default when the configured path is empty', async () => {
    const d = deps();
    await fetchSessions(config({ agents: [{ id: 'claude', path: '' }] }), d);

    expect(d.run.calls[0]?.[0]).toBe('claude');
  });

  it('returns every session the CLI listed, in the order it listed them', async () => {
    const snapshot = await fetchSessions(config(), deps());

    expect(snapshot.sessions.map((s) => s.sessionId)).toEqual(active.map((e) => e.sessionId));
    expect(snapshot.failures).toEqual([]);
  });

  it('stamps every session with the agent that reported it', async () => {
    const snapshot = await fetchSessions(config(), deps());

    expect(snapshot.sessions.every((s) => s.agent === 'claude')).toBe(true);
  });

  it('reports status, state, and the short id exactly where the CLI supplied them', async () => {
    const { sessions } = await fetchSessions(config(), deps());

    for (const [i, entry] of active.entries()) {
      expect(sessions[i]?.status).toBe(entry.status ?? null);
      expect(sessions[i]?.state).toBe(entry.state ?? null);
      expect(sessions[i]?.shortId).toBe(entry.id ?? null);
      expect(sessions[i]?.name).toBe(entry.name ?? null);
      expect(sessions[i]?.cwd).toBe(entry.cwd);
      expect(sessions[i]?.startedAt).toBe(entry.startedAt);
      expect(sessions[i]?.kind).toBe(entry.kind);
    }
  });

  it('reports a short id and a state where a background session carries them', async () => {
    const { sessions } = await fetchSessions(config(), deps(all));
    const background = all.find((e) => e.id !== undefined && e.state !== undefined)!;
    const mapped = sessions.find((s) => s.sessionId === background.sessionId);

    expect(mapped?.shortId).toBe(background.id);
    expect(mapped?.state).toBe(background.state);
  });

  it('links a worktree session by the branch its checkout is on', async () => {
    const { sessions } = await fetchSessions(config(), deps());

    expect(sessions.find((s) => s.branch === '18941-inbox-badge-overwrites-a-manual-edit')?.issueNumber).toBe(18941);
  });

  it('leaves a session on a branch with no issue number unlinked', async () => {
    const { sessions } = await fetchSessions(config(), deps());

    expect(sessions.find((s) => s.branch === 'main')?.issueNumber).toBeNull();
    expect(sessions.find((s) => s.branch === 'team/worker-1')?.issueNumber).toBeNull();
  });

  it('carries each session its own recorded transcript write time', async () => {
    const { sessions } = await fetchSessions(config(), deps());

    for (const entry of transcripts.entries) {
      expect(sessions.find((s) => s.sessionId === entry.sessionId)?.transcriptWrittenAt).toBe(entry.writtenAt);
    }
  });

  it('carries each session its own recorded title, and none where the transcript held none', async () => {
    const { sessions } = await fetchSessions(config(), deps());

    expect(transcripts.entries.filter((e) => e.titles.length > 0).length).toBeGreaterThan(0);
    expect(transcripts.entries.filter((e) => e.titles.length === 0).length).toBeGreaterThan(0);

    for (const entry of transcripts.entries) {
      expect(sessions.find((s) => s.sessionId === entry.sessionId)?.title).toBe(expectedTitle(entry));
    }
  });

  it('reports no title for a session whose transcript cannot be read at all', async () => {
    const { sessions } = await fetchSessions(config(), { ...deps(), readTail: () => null });

    expect(sessions.every((s) => s.title === null)).toBe(true);
  });

  it('keeps a session whose kind the board has never seen', async () => {
    const unknown = structuredClone(active);
    unknown[0]!.kind = 'something-new';

    const snapshot = await fetchSessions(config(), deps(unknown));

    expect(snapshot.sessions[0]?.kind).toBe('something-new');
  });

  it('keeps a session with no display name', async () => {
    const unnamed = structuredClone(active);
    delete unnamed[0]!.name;

    const snapshot = await fetchSessions(config(), deps(unnamed));

    expect(snapshot.sessions[0]?.name).toBeNull();
  });

  it('says why nothing linked when the pattern is unusable, rather than linking silently', async () => {
    const snapshot = await fetchSessions(config({ branchIssuePattern: '^(\\d+' }), deps());

    expect(snapshot.patternError).toContain('groundControl.branchIssuePattern');
    expect(snapshot.patternError).toContain('not a valid regular expression');
    expect(snapshot.sessions.every((s) => s.issueNumber === null)).toBe(true);
    expect(snapshot.sessions.some((s) => s.branch !== null)).toBe(true);
  });

  it('says why nothing linked when the pattern captures nothing', async () => {
    const snapshot = await fetchSessions(config({ branchIssuePattern: '^\\d+-' }), deps());

    expect(snapshot.patternError).toContain('no capturing group');
    expect(snapshot.sessions.every((s) => s.issueNumber === null)).toBe(true);
  });

  it('reports an empty machine as no sessions and no failures', async () => {
    const snapshot = await fetchSessions(config(), deps([]));

    expect(snapshot.sessions).toEqual([]);
    expect(snapshot.failures).toEqual([]);
    expect(snapshot.patternError).toBeNull();
  });

  it('reads nothing at all when no agent is configured', async () => {
    const d = deps();
    const snapshot = await fetchSessions(config({ agents: [] }), d);

    expect(snapshot.sessions).toEqual([]);
    expect(snapshot.failures).toEqual([]);
    expect(d.run.calls).toEqual([]);
  });

  it('names an agent it does not know how to read', async () => {
    const snapshot = await fetchSessions(config({ agents: [{ id: 'gemini', path: 'gemini' }] }), deps());

    expect(snapshot.failures).toHaveLength(1);
    expect(snapshot.failures[0]).toMatchObject({ agent: 'gemini', kind: 'unknown-agent' });
    expect(snapshot.failures[0]?.message).toContain('gemini');
  });

  it('keeps one CLI failing from hiding another CLI sessions', async () => {
    const snapshot = await fetchSessions(
      config({
        agents: [
          { id: 'gemini', path: 'gemini' },
          { id: 'claude', path: 'claude' },
        ],
      }),
      deps(),
    );

    expect(snapshot.sessions).toHaveLength(active.length);
    expect(snapshot.failures.map((f) => f.agent)).toEqual(['gemini']);
  });

  it('reports a missing CLI as a failure with its own remedy, and no sessions', async () => {
    const snapshot = await fetchSessions(config(), { ...deps(), agents: claudeWith(failingRunner('missing', 'spawn ENOENT')) });

    expect(snapshot.sessions).toEqual([]);
    expect(snapshot.failures[0]).toMatchObject({ agent: 'claude', kind: 'agent-missing' });
    expect(snapshot.failures[0]?.message).toContain('"claude"');
    expect(snapshot.failures[0]?.remedy).toContain('groundControl.agents');
    expect(snapshot.failures[0]?.remedy).toContain('"claude"');
  });

  it('carries through what the CLI printed when the call failed', async () => {
    const snapshot = await fetchSessions(config(), { ...deps(), agents: claudeWith(failingRunner('failed', 'unknown command')) });

    expect(snapshot.failures[0]).toMatchObject({ agent: 'claude', kind: 'agent-failed' });
    expect(snapshot.failures[0]?.message).toContain('unknown command');
    expect(snapshot.failures[0]?.remedy).toContain('groundControl.agents');
  });

  it('tells a shim apart from an absent CLI, and says what to point the setting at', async () => {
    const detail = 'C:/npm/claude.cmd is a batch shim, which cannot be run directly';
    const snapshot = await fetchSessions(config(), {
      ...deps(),
      agents: claudeWith(failingRunner('not-executable', detail)),
    });

    expect(snapshot.sessions).toEqual([]);
    expect(snapshot.failures[0]).toMatchObject({ agent: 'claude', kind: 'agent-missing' });
    expect(snapshot.failures[0]?.message).toContain(detail);
    expect(snapshot.failures[0]?.remedy).toContain('the executable the shim wraps');
  });

  it('reports output that is not JSON as a bad response', async () => {
    const snapshot = await fetchSessions(config(), { ...deps(), agents: claudeWith(failingRunner('unparsable', 'not json')) });

    expect(snapshot.failures[0]).toMatchObject({ agent: 'claude', kind: 'bad-response' });
  });

  it('refuses a response that is not a list of sessions', async () => {
    const snapshot = await fetchSessions(config(), deps({ sessions: [] }));

    expect(snapshot.failures[0]?.kind).toBe('bad-response');
    expect(snapshot.sessions).toEqual([]);
  });

  it('counts more than one unreadable entry in the plural', async () => {
    const broken = structuredClone(active) as unknown as Record<string, unknown>[];
    delete broken[0]!.sessionId;
    delete broken[1]!.cwd;

    const snapshot = await fetchSessions(config(), deps(broken));

    expect(snapshot.sessions).toHaveLength(active.length - 2);
    expect(snapshot.failures[0]?.message).toContain('2 sessions the board could not read');
    expect(snapshot.failures[0]?.message).toContain('sessionId');
    expect(snapshot.failures[0]?.message).not.toContain('cwd');
  });

  it('keeps every readable session when one entry is not, and says how many it dropped', async () => {
    const broken = structuredClone(active) as unknown as Record<string, unknown>[];
    delete broken[0]!.sessionId;

    const snapshot = await fetchSessions(config(), deps(broken));

    expect(snapshot.sessions).toHaveLength(active.length - 1);
    expect(snapshot.failures[0]?.message).toContain('1 session the board could not read');
    expect(snapshot.failures[0]?.message).toContain('sessionId');
  });

  it('ignores a field it never reads, so a CLI dropping one does not empty the board', async () => {
    const withoutPid = structuredClone(active) as unknown as Record<string, unknown>[];

    for (const entry of withoutPid) {
      delete entry.pid;
    }

    const snapshot = await fetchSessions(config(), deps(withoutPid));

    expect(snapshot.sessions).toHaveLength(active.length);
    expect(snapshot.failures).toEqual([]);
  });
});
