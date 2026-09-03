import type { ActivitySignal } from '@ground-control/core';
import { planHookInstall } from './hookPlan.js';
import { activityDirOf } from './hookScript.js';
import { readActivity } from './phase.js';

/** Claude's phase signal: a hook script writing one marker per session under the activity directory (`docs/mechanics.md` §20). */
export const claudeActivity: ActivitySignal = {
  plan: planHookInstall,
  watchDir: activityDirOf,
  read: readActivity,
};
