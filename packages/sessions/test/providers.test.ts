import { describe, expect, it } from 'vitest';
import { fetchSessions } from '../src/sessions.js';
import { providers } from '../src/providers.js';
import { CLAUDE_AGENT_ID } from '../src/providers/claude.js';
import { config, gitReads, listRecordedDirs, recordedMtimes, transcripts } from './helpers.js';

const machine = { readText: gitReads(), mtime: recordedMtimes, listDir: listRecordedDirs, home: transcripts.home };

describe('the provider registry', () => {
  it('knows Claude Code', () => {
    expect(providers().find((p) => p.id === CLAUDE_AGENT_ID)?.defaultPath).toBe('claude');
  });

  it('gives every registered provider a distinct id and a default command', () => {
    const registered = providers();

    expect(registered.length).toBe(1);
    expect(new Set(registered.map((p) => p.id)).size).toBe(registered.length);
    expect(registered.every((p) => p.id.length > 0 && p.defaultPath.length > 0)).toBe(true);
  });

  it('has Claude Code on by default, so the primary agent needs no setup (R26)', () => {
    expect(providers().find((p) => p.id === CLAUDE_AGENT_ID)?.defaultEnabled).toBe(true);
  });
});

describe('the wiring a caller gets with no test seam', () => {
  it('reaches the registry, and the registered provider its own real transport', async () => {
    // The one test that spawns: it proves fetchSessions finds the registered provider and that the provider's
    // default transport runs, by pointing it at a path nothing can answer to.
    const snapshot = await fetchSessions(
      config({ agents: [{ id: CLAUDE_AGENT_ID, path: 'no-such-cli-anywhere-on-this-machine' }] }),
      machine,
    );

    expect(snapshot.sessions).toEqual([]);
    expect(snapshot.failures).toHaveLength(1);
    expect(snapshot.failures[0]).toMatchObject({ agent: CLAUDE_AGENT_ID, kind: 'agent-missing' });
  });

  it('reports an id the registry does not carry', async () => {
    const snapshot = await fetchSessions(config({ agents: [{ id: 'gemini', path: 'gemini' }] }), machine);

    expect(snapshot.failures[0]).toMatchObject({ agent: 'gemini', kind: 'unknown-agent' });
  });

  it('builds its own machine readers when handed none, and stamps the read time', async () => {
    const before = Date.now();
    const snapshot = await fetchSessions(config({ agents: [] }));

    expect(Date.parse(snapshot.fetchedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(snapshot.fetchedAt)).toBeLessThanOrEqual(Date.now());
  });
});
