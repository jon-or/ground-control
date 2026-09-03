import { describe, expect, it } from 'vitest';
import { fetchSessions } from '@ground-control/core';
import type { AgentAdapter, MachineReaders, SessionsConfig } from '@ground-control/core';
import type { AgentEntry } from '../src/claude.js';
import { HOOK_MARKER_VERSION } from '../src/hookScript.js';
import { claudeWith, config, expectedTitle, failingRunner, fixture, recordedReaders, runnerOf, transcripts } from './helpers.js';

const active = fixture('agents-active') as AgentEntry[];
const all = fixture('agents-all') as (AgentEntry & { state?: string })[];

/** The recorded sessions that have been prompted — the ones the board reports, in the order the CLI listed them. */
const prompted = active.filter((entry) =>
  transcripts.entries.some((t) => t.sessionId === entry.sessionId && t.writtenAt !== null),
);

/** The index in the CLI's response of the nth session the board reports, for a test that has to damage one. */
const promptedIndex = (n: number): number => active.indexOf(prompted[n]!);

interface Deps {
  run: ReturnType<typeof runnerOf>;
  agents: readonly AgentAdapter[];
  readers: MachineReaders;
}

function deps(response: unknown = active): Deps {
  const run = runnerOf(response);

  return { run, agents: claudeWith(run), readers: recordedReaders() };
}

/** The adapter read the way the hub reads it, so a row here is the same `Session` a card is built from. */
const read = (cfg: SessionsConfig, d: Deps) => fetchSessions(cfg, d.agents, d.readers);

describe('the recording these tests rest on', () => {
  it('covers a session that reported a status and sessions that reported none', () => {
    expect(active.filter((e) => e.status !== undefined).length).toBeGreaterThan(0);
    expect(active.filter((e) => e.status === undefined).length).toBeGreaterThan(0);
  });

  it('covers sessions with a transcript and sessions with none', () => {
    expect(transcripts.entries.filter((e) => e.writtenAt !== null).length).toBeGreaterThan(0);
    expect(transcripts.entries.filter((e) => e.writtenAt === null).length).toBeGreaterThan(0);
    expect(prompted.length).toBeLessThan(active.length);
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

describe('the Claude adapter', () => {
  it('asks the configured CLI for active sessions only, never --all', async () => {
    const d = deps();
    await read(config(), d);

    expect(d.run.calls).toEqual([['claude', ['agents', '--json']]]);
  });

  it('honours a configured path over the adapter default', async () => {
    const d = deps();
    await read(config({ agents: [{ id: 'claude', path: 'C:/tools/claude.exe' }] }), d);

    expect(d.run.calls[0]?.[0]).toBe('C:/tools/claude.exe');
  });

  it('falls back to the adapter default when the configured path is empty', async () => {
    const d = deps();
    await read(config({ agents: [{ id: 'claude', path: '' }] }), d);

    expect(d.run.calls[0]?.[0]).toBe('claude');
  });

  it('returns every prompted session the CLI listed, in the order it listed them', async () => {
    const snapshot = await read(config(), deps());

    expect(snapshot.sessions.map((s) => s.sessionId)).toEqual(prompted.map((e) => e.sessionId));
    expect(snapshot.failures).toEqual([]);
  });

  it('keeps a background session the CLI reports a state for, whose transcript it cannot find', async () => {
    const { sessions } = await read(config(), deps(all));
    const working = all.find((e) => e.state !== undefined)!;

    expect(transcripts.entries.some((t) => t.sessionId === working.sessionId && t.writtenAt !== null)).toBe(false);
    expect(sessions.map((s) => s.sessionId)).toContain(working.sessionId);
  });

  it('omits a listed session that has never been prompted, and calls it no failure', async () => {
    const snapshot = await read(config(), deps());
    const idle = active.filter((entry) => !prompted.includes(entry));

    expect(idle.length).toBeGreaterThan(0);
    expect(snapshot.sessions.map((s) => s.sessionId)).not.toContain(idle[0]?.sessionId);
    expect(snapshot.failures).toEqual([]);
  });

  it('keeps a session with no transcript that the hooks have reported activity for', async () => {
    const idle = active.find((entry) => !prompted.includes(entry))!;
    const marker = JSON.stringify({
      v: HOOK_MARKER_VERSION,
      sessionId: idle.sessionId,
      event: 'UserPromptSubmit',
      at: Date.now(),
      turnAt: Date.now(),
      notificationType: null,
      source: null,
      toolName: null,
      reason: null,
      backgroundTasks: 0,
    });
    const d = deps();
    const snapshot = await read(config(), {
      ...d,
      readers: {
        ...d.readers,
        readText: (path) => (path.endsWith(`${idle.sessionId}.json`) ? marker : d.readers.readText(path)),
      },
    });

    expect(snapshot.sessions.map((s) => s.sessionId)).toContain(idle.sessionId);
  });

  it('stamps every session with the agent that reported it', async () => {
    const snapshot = await read(config(), deps());

    expect(snapshot.sessions.every((s) => s.agent === 'claude')).toBe(true);
  });

  it('reports status, state, and the short id exactly where the CLI supplied them', async () => {
    const { sessions } = await read(config(), deps());

    for (const [i, entry] of prompted.entries()) {
      expect(sessions[i]?.details.status).toBe(entry.status);
      expect(sessions[i]?.details.state).toBe(entry.state);
      expect(sessions[i]?.details.shortId).toBe(entry.id);
      expect(sessions[i]?.details.name).toBe(entry.name);
      expect(sessions[i]?.cwd).toBe(entry.cwd);
      expect(sessions[i]?.startedAt).toBe(entry.startedAt);
      expect(sessions[i]?.details.kind).toBe(entry.kind);
    }
  });

  it('reports a short id and a state where a background session carries them', async () => {
    const { sessions } = await read(config(), deps(all));
    const background = all.find((e) => e.id !== undefined && e.state !== undefined)!;
    const mapped = sessions.find((s) => s.sessionId === background.sessionId);

    expect(mapped?.details.shortId).toBe(background.id);
    expect(mapped?.details.state).toBe(background.state);
  });

  /**
   * The one field the lane rules read that no other agent may have to fake. `--all` is the only response that carries
   * a finished session, so the mapping is proved against it and against the active list, which carries none.
   */
  it('calls a session finished only where the CLI said so in its own words', async () => {
    const { sessions } = await read(config(), deps(all));
    const ended = new Set(all.filter((e) => e.state === 'done' || e.state === 'stopped').map((e) => e.sessionId));

    expect(ended.size).toBeGreaterThan(0);
    expect(sessions.filter((s) => s.finished).map((s) => s.sessionId).sort()).toEqual([...ended].sort());
  });

  it('calls nothing finished on a list of live sessions, however each of them reports', async () => {
    const { sessions } = await read(config(), deps());

    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => !s.finished)).toBe(true);
  });

  /** `idle` is an interactive session with nobody typing, not an ended one — R24 forbids reading a finish into it. */
  it('does not read an idle status as a finish', async () => {
    const idling = structuredClone(all);
    const entry = idling.find((e) => e.state !== undefined)!;
    entry.state = 'idle';

    const { sessions } = await read(config(), deps(idling));

    expect(sessions.find((s) => s.sessionId === entry.sessionId)?.finished).toBe(false);
  });

  it('links a worktree session by the branch its checkout is on', async () => {
    const { sessions } = await read(config(), deps());

    expect(sessions.find((s) => s.branch === '18941-inbox-badge-overwrites-a-manual-edit')?.issueNumber).toBe(18941);
  });

  it('leaves a session on a branch with no issue number unlinked', async () => {
    const { sessions } = await read(config(), deps());

    expect(sessions.find((s) => s.branch === 'main')?.issueNumber).toBeNull();
    expect(sessions.find((s) => s.branch === 'team/worker-1')?.issueNumber).toBeNull();
  });

  it('carries each session its own recorded transcript write time', async () => {
    const { sessions } = await read(config(), deps());

    for (const entry of transcripts.entries.filter((e) => e.writtenAt !== null)) {
      expect(sessions.find((s) => s.sessionId === entry.sessionId)?.transcriptWrittenAt).toBe(entry.writtenAt);
    }
  });

  it('carries each session its own recorded title, and none where the transcript held none', async () => {
    const { sessions } = await read(config(), deps());

    const reported = transcripts.entries.filter((e) => e.writtenAt !== null);

    expect(reported.filter((e) => e.titles.length > 0).length).toBeGreaterThan(0);
    expect(reported.filter((e) => e.titles.length === 0).length).toBeGreaterThan(0);

    for (const entry of reported) {
      expect(sessions.find((s) => s.sessionId === entry.sessionId)?.title).toBe(expectedTitle(entry));
    }
  });

  it('reports no title for a session whose transcript is there but unreadable', async () => {
    const d = deps();
    const { sessions } = await read(config(), { ...d, readers: { ...d.readers, readTail: () => null } });

    expect(sessions.every((s) => s.title === null)).toBe(true);
  });

  it('keeps a session whose kind the board has never seen', async () => {
    const unknown = structuredClone(active);
    unknown[promptedIndex(0)]!.kind = 'something-new';

    const snapshot = await read(config(), deps(unknown));

    expect(snapshot.sessions[0]?.details.kind).toBe('something-new');
  });

  it('keeps a session with no display name', async () => {
    const unnamed = structuredClone(active);
    delete unnamed[promptedIndex(0)]!.name;

    const snapshot = await read(config(), deps(unnamed));

    expect(snapshot.sessions[0]?.details).not.toHaveProperty('name');
  });

  it('says why nothing linked when the pattern is unusable, rather than linking silently', async () => {
    const snapshot = await read(config({ branchIssuePattern: '^(\\d+' }), deps());

    expect(snapshot.patternError).toContain('groundControl.branchIssuePattern');
    expect(snapshot.patternError).toContain('not a valid regular expression');
    expect(snapshot.sessions.every((s) => s.issueNumber === null)).toBe(true);
    expect(snapshot.sessions.some((s) => s.branch !== null)).toBe(true);
  });

  it('says why nothing linked when the pattern captures nothing', async () => {
    const snapshot = await read(config({ branchIssuePattern: '^\\d+-' }), deps());

    expect(snapshot.patternError).toContain('no capturing group');
    expect(snapshot.sessions.every((s) => s.issueNumber === null)).toBe(true);
  });

  it('reports an empty machine as no sessions and no failures', async () => {
    const snapshot = await read(config(), deps([]));

    expect(snapshot.sessions).toEqual([]);
    expect(snapshot.failures).toEqual([]);
    expect(snapshot.patternError).toBeNull();
  });

  it('reports a missing CLI as a failure with its own remedy, and no sessions', async () => {
    const snapshot = await read(config(), { ...deps(), agents: claudeWith(failingRunner('missing', 'spawn ENOENT')) });

    expect(snapshot.sessions).toEqual([]);
    expect(snapshot.failures[0]).toMatchObject({ subject: 'claude', kind: 'agent-missing' });
    expect(snapshot.failures[0]?.message).toContain('"claude"');
    expect(snapshot.failures[0]?.remedy).toContain('groundControl.agents');
    expect(snapshot.failures[0]?.remedy).toContain('"claude"');
  });

  it('carries through what the CLI printed when the call failed', async () => {
    const snapshot = await read(config(), { ...deps(), agents: claudeWith(failingRunner('failed', 'unknown command')) });

    expect(snapshot.failures[0]).toMatchObject({ subject: 'claude', kind: 'agent-failed' });
    expect(snapshot.failures[0]?.message).toContain('unknown command');
    expect(snapshot.failures[0]?.remedy).toContain('groundControl.agents');
  });

  it('tells a shim apart from an absent CLI, and says what to point the setting at', async () => {
    const detail = 'C:/npm/claude.cmd is a batch shim, which cannot be run directly';
    const snapshot = await read(config(), {
      ...deps(),
      agents: claudeWith(failingRunner('not-executable', detail)),
    });

    expect(snapshot.sessions).toEqual([]);
    expect(snapshot.failures[0]).toMatchObject({ subject: 'claude', kind: 'agent-missing' });
    expect(snapshot.failures[0]?.message).toContain(detail);
    expect(snapshot.failures[0]?.remedy).toContain('the executable the shim wraps');
  });

  it('reports output that is not JSON as a bad response', async () => {
    const snapshot = await read(config(), { ...deps(), agents: claudeWith(failingRunner('unparsable', 'not json')) });

    expect(snapshot.failures[0]).toMatchObject({ subject: 'claude', kind: 'bad-response' });
  });

  it('refuses a response that is not a list of sessions', async () => {
    const snapshot = await read(config(), deps({ sessions: [] }));

    expect(snapshot.failures[0]?.kind).toBe('bad-response');
    expect(snapshot.sessions).toEqual([]);
  });

  it('counts more than one unreadable entry in the plural', async () => {
    const broken = structuredClone(active) as unknown as Record<string, unknown>[];
    delete broken[promptedIndex(0)]!.sessionId;
    delete broken[promptedIndex(1)]!.cwd;

    const snapshot = await read(config(), deps(broken));

    expect(snapshot.sessions).toHaveLength(prompted.length - 2);
    expect(snapshot.failures[0]?.message).toContain('2 sessions the board could not read');
    expect(snapshot.failures[0]?.message).toContain('sessionId');
    expect(snapshot.failures[0]?.message).not.toContain('cwd');
  });

  it('keeps every readable session when one entry is not, and says how many it dropped', async () => {
    const broken = structuredClone(active) as unknown as Record<string, unknown>[];
    delete broken[promptedIndex(0)]!.sessionId;

    const snapshot = await read(config(), deps(broken));

    expect(snapshot.sessions).toHaveLength(prompted.length - 1);
    expect(snapshot.failures[0]?.message).toContain('1 session the board could not read');
    expect(snapshot.failures[0]?.message).toContain('sessionId');
  });

  it('ignores a field it never reads, so a CLI dropping one does not empty the board', async () => {
    const withoutPid = structuredClone(active) as unknown as Record<string, unknown>[];

    for (const entry of withoutPid) {
      delete entry.pid;
    }

    const snapshot = await read(config(), deps(withoutPid));

    expect(snapshot.sessions).toHaveLength(prompted.length);
    expect(snapshot.failures).toEqual([]);
  });
});
