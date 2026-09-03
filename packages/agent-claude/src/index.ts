export { CLAUDE_AGENT_ID, CLAUDE_DISPLAY_NAME, makeClaudeAdapter } from './claude.js';
export { claudeActivity } from './activity.js';
export { readActivity, rosterIsStale, unreportedSessions } from './phase.js';
export { backupsToDelete, hookNotice, lockIsStale, markerIsOrphaned, planHookInstall } from './hookPlan.js';
export { HOOK_SOURCE, activityDirOf, claudeSettingsPathOf, hookPathOf } from './hookScript.js';
