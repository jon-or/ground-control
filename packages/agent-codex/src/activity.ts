import type { ActivitySignal } from '@ground-control/core';
import { planHookInstall } from './hookPlan.js';
import { HOOK_SOURCE, activityDirOf, codexHooksPathOf, hookPathOf } from './hookScript.js';
import { readActivity } from './phase.js';

/**
 * Install hook markers for Codex activity and session discovery (M39, M40). Resolve CODEX_HOME so hooks are
 * written where Codex reads them.
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
