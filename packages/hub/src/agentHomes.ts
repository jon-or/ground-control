import { existsSync, mkdirSync, statSync } from 'node:fs';
import { groundControlDirOf, resolveAgentHomes } from '@ground-control/core';
import type { ReadFailure } from '@ground-control/core';
import { syncActivity, uninstallActivity } from './activityInstall.js';
import type { ActivityState } from './activityInstall.js';
import { read, releaseLock, takeLock } from './fs.js';
import { installLockPathOf } from './paths.js';
import { configureAgentHomes, makeRegistries } from './registry.js';
import type { Registries } from './registry.js';
import { makeSettingsStore } from './settings.js';

/** Remove prior owned hooks before accepting a new profile. Retain markers and cached writer scripts. */
export function acceptAgentHomes(
  registries: Registries,
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
  home: string,
  save: () => void,
  enabled?: ReadonlySet<string>,
): ReadFailure | null {
  const changed = registries.agents.filter((agent) => before[agent.id] !== after[agent.id] && agent.storage);
  const lock = installLockPathOf(home);
  let held = false;
  try {
    for (const root of Object.values(after)) {
      if (existsSync(root) && !statSync(root).isDirectory()) throw new Error('Agent home is not a directory.');
    }
    if (changed.length > 0) {
      mkdirSync(groundControlDirOf(home), { recursive: true });
      held = takeLock(lock);
      if (!held) return { subject: 'config', kind: 'agent-home-busy', message: 'Agent profiles could not change while activity settings are locked.', remedy: 'Wait, then reopen the board.' };
      // Check both profiles before the first removal. A destination refusal must retain the old profile.
      for (const roots of [before, after]) {
        configureAgentHomes(registries, roots);
        for (const agent of changed) {
          const root = roots[agent.id];
          if (root && existsSync(root) && !statSync(root).isDirectory()) throw new Error('Agent home is not a directory.');
          if (!agent.activity) continue;
          const path = agent.activity.settingsPath(home);
          const settingsText = read(path);
          if (settingsText === null && existsSync(path)) throw new Error('Agent settings cannot be read.');
          const wanted = roots === before || enabled?.has(agent.id) === false ? 'remove' : 'install';
          const plan = agent.activity.plan({ settingsText, home, wanted });
          if (plan.kind === 'refuse') {
            configureAgentHomes(registries, before);
            return { subject: agent.id, kind: 'activity-refused', message: plan.reason, remedy: plan.remedy };
          }
        }
      }
      configureAgentHomes(registries, before);
      const removed = syncActivity(changed, 'remove', home, false, undefined, { lockHeld: true, preserveMarkers: true });
      if (removed.failure) return removed.failure;
    }
    save();
    configureAgentHomes(registries, after);
    return null;
  } catch {
    configureAgentHomes(registries, before);
    return { subject: 'config', kind: 'agent-home-save-failed', message: 'Agent profiles were not changed because their settings could not be saved.', remedy: 'Check write access to the Ground Control settings directory, then reopen the board.' };
  } finally {
    if (held) releaseLock(lock);
  }
}

/** Uninstall from recorded profiles, even when the uninstaller has a different environment. */
export function uninstallAgentActivity(home: string, env?: NodeJS.ProcessEnv): ActivityState {
  const registries = makeRegistries(undefined, home, env);
  const stored = makeSettingsStore(home).read();
  const refused = (failure: ReadFailure): ActivityState => ({ wanted: 'remove', plan: 'refuse', added: 0, failure });
  if (stored && 'failure' in stored) return refused(stored.failure);
  const configured = stored?.config.agentHomes;
  const resolved = resolveAgentHomes(registries.agents, configured, home, registries.agentEnvironment ?? {});
  if ('failure' in resolved) return refused(resolved.failure);
  const legacy = configured === undefined ? acceptAgentHomes(registries, defaultAgentHomes(registries, home), resolved.homes, home, () => {}, new Set()) : null;
  if (legacy) return refused(legacy);
  configureAgentHomes(registries, resolved.homes);
  return uninstallActivity(registries.agents, home);
}

/** Legacy releases only recorded user home. Resolve their default roots for owned-hook cleanup. */
export function defaultAgentHomes(registries: Registries, home: string): Record<string, string> {
  const resolved = resolveAgentHomes(registries.agents, undefined, home, {});
  if ('failure' in resolved) throw new Error(resolved.failure.message);
  return resolved.homes;
}
