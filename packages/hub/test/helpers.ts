import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActivityPlan, ActivitySignal, AgentAdapter } from '@ground-control/core';

/**
 * A home of the hub's own, never the developer's. Every module here writes into `~/.claude/ground-control`, and a
 * test that reached the real one would delete a running board's lane placements.
 */
export function tempHome(): { home: string; dispose: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'gc-hub-'));

  return { home, dispose: () => rmSync(home, { recursive: true, force: true }) };
}

export interface FakeSignal extends ActivitySignal {
  /** What `plan` was handed, so a test can prove the settings text reached the adapter rather than being assumed. */
  planned: { settingsText: string | null; wanted: 'install' | 'remove' }[];
}

/**
 * An activity signal with no agent behind it. The install is generic — it does the file system and the lock, and
 * every decision is the adapter's — so a fake is what proves that rather than Claude's own hook merge.
 */
export function fakeSignal(plan: ActivityPlan | ((wanted: 'install' | 'remove') => ActivityPlan)): FakeSignal {
  const planned: FakeSignal['planned'] = [];

  return {
    planned,
    plan({ settingsText, wanted }) {
      planned.push({ settingsText, wanted });

      return typeof plan === 'function' ? plan(wanted) : plan;
    },
    settingsPath: (home) => `${home}/.fake/settings.json`,
    watchDir: (home) => `${home}/.claude/ground-control/activity-fake`,
    read: () => null,
    writer: { path: (home) => `${home}/.claude/ground-control/fake-writer.mjs`, source: 'the writer\n' },
  };
}

export function fakeAgent(id: string, activity?: ActivitySignal): AgentAdapter {
  return {
    id,
    displayName: id,
    defaultPath: `${id}-cli`,
    defaultEnabled: true,
    ...(activity ? { activity } : {}),
    async listSessions() {
      return { sessions: [], failure: null };
    },
  };
}
