import { homedir } from 'node:os';
import { agentHomeSchema, join, resolveAgentHomes, scopeDirectory } from '@ground-control/core';
import { registries } from './registry.js';

/** Preserve invalid environment values so hub configuration validation can report them. */
export function editorAgentHomes(): Record<string, string> {
  return Object.fromEntries(registries.agents.flatMap((agent) => {
    const storage = agent.storage;
    if (!storage) return [];
    return [[agent.id, process.env[storage.environment] ?? join(homedir(), storage.defaultDirectory)]];
  }));
}

function selectedHome(agentId: string): { environment: string; home: string; defaultHome: string } | null {
  const agent = registries.agents.find((candidate) => candidate.id === agentId);
  if (!agent?.storage) return null;
  const resolved = resolveAgentHomes([agent], {}, homedir(), process.env);
  if ('failure' in resolved || !resolved.homes[agentId]) return null;
  return {
    environment: agent.storage.environment,
    home: resolved.homes[agentId],
    defaultHome: join(homedir(), agent.storage.defaultDirectory),
  };
}

/** Agent editor commands use the profile inherited when their extension started. */
export function editorProfileRefusal(agentId: string, acceptedHome?: string): string | null {
  const selected = selectedHome(agentId);
  if (!selected) return `The ${agentId} storage directory is invalid. Check its environment variable and restart VS Code.`;
  const accepted = scopeDirectory(acceptedHome ?? selected.defaultHome);
  if (accepted !== null && accepted === scopeDirectory(selected.home)) return null;
  return `Restart VS Code with ${selected.environment} matching the hub's accepted profile, then reopen the board.`;
}

/** Terminals can select a profile explicitly without changing the editor's environment. */
export function attachEnvironment(agentId: string, acceptedHome?: string): Record<string, string> | null {
  const storage = registries.agents.find((candidate) => candidate.id === agentId)?.storage;
  if (!storage) return null;
  const home = agentHomeSchema.safeParse(acceptedHome ?? join(homedir(), storage.defaultDirectory));
  return home.success ? { [storage.environment]: home.data } : null;
}
