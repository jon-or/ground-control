import { describe, expect, it } from 'vitest';
import { fetchSessions } from '@ground-control/core';
import { CLAUDE_AGENT_ID, CLAUDE_DISPLAY_NAME, makeClaudeAdapter } from '../src/claude.js';
import { claudeActivity } from '../src/activity.js';
import { config, recordedReaders } from './helpers.js';

describe('the Claude adapter', () => {
  const adapter = makeClaudeAdapter();

  it('names itself and its command', () => {
    expect(adapter.id).toBe(CLAUDE_AGENT_ID);
    expect(adapter.displayName).toBe(CLAUDE_DISPLAY_NAME);
    expect(adapter.defaultPath).toBe('claude');
  });

  it('is on by default, so the primary agent needs no setup (R26)', () => {
    expect(adapter.defaultEnabled).toBe(true);
  });

  it('offers its hook-written markers as the phase signal', () => {
    expect(adapter.activity).toBe(claudeActivity);
    expect(claudeActivity.watchDir('/nowhere/home')).toBe('/nowhere/home/.claude/ground-control/activity');
  });

  it('runs its own real transport when handed none', async () => {
    // The one test that spawns: it points the default transport at a path nothing can answer to.
    const snapshot = await fetchSessions(
      config({ agents: [{ id: CLAUDE_AGENT_ID, path: 'no-such-cli-anywhere-on-this-machine' }] }),
      [adapter],
      recordedReaders(),
    );

    expect(snapshot.sessions).toEqual([]);
    expect(snapshot.failures).toHaveLength(1);
    expect(snapshot.failures[0]).toMatchObject({ subject: CLAUDE_AGENT_ID, kind: 'agent-missing' });
  });
});
