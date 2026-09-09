import type { ActivitySignal } from '@ground-control/core';
import { planHookInstall } from './hookPlan.js';
import { HOOK_SOURCE, activityDirOf, codexHooksPathOf, hookPathOf } from './hookScript.js';
import { readActivity } from './phase.js';

/**
 * Codex's phase signal: a hook script writing one marker per session (`docs/mechanics.md` M40). It carries the
 * roster too, which Claude's does not — Codex has no command that lists its live sessions (M39).
 *
 * The environment is taken here because `CODEX_HOME` moves the file the entries go in, and a signal installed into
 * `~/.codex` on a machine that has moved it is one Codex never reads.
 */
export function makeCodexActivity(env: NodeJS.ProcessEnv = {}): ActivitySignal {
  return {
    plan: planHookInstall,
    settingsPath: (home) => codexHooksPathOf(home, env),
    watchDir: activityDirOf,
    read: readActivity,
    writer: { path: hookPathOf, source: HOOK_SOURCE },
  };
}
