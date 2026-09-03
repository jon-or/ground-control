import type { ActivitySignal } from '@ground-control/core';
import { planHookInstall } from './hookPlan.js';
import { HOOK_SOURCE, activityDirOf, claudeSettingsPathOf, hookPathOf } from './hookScript.js';
import { readActivity } from './phase.js';

/** Claude's phase signal: a hook script writing one marker per session under the activity directory (`docs/mechanics.md` §20). */
export const claudeActivity: ActivitySignal = {
  plan: planHookInstall,
  settingsPath: claudeSettingsPathOf,
  watchDir: activityDirOf,
  read: readActivity,
  writer: { path: hookPathOf, source: HOOK_SOURCE },
};
