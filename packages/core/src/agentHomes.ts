import { z } from 'zod';
import { posix, win32 } from 'node:path';
import type { AgentAdapter } from './agent.js';
import type { ReadFailure } from './types.js';

/** Agent roots are absolute paths, without shell expansion or launcher-relative interpretation. */
export const agentHomeSchema = z.string().refine((root) =>
  root.length > 0 && root.trim() === root && !/[\u0000-\u001f\u007f]/.test(root) && !/^[/\\]{2}[?.][/\\]/.test(root) &&
  !(/^\/(?!\/)/.test(root) && root.includes('\\')) &&
  (/^[A-Za-z]:[\\/]/.test(root) || /^\/(?!\/)/.test(root) || /^[/\\]{2}[^/\\]+[/\\][^/\\]+/.test(root)),
{ message: 'must be an absolute agent home without surrounding whitespace or control characters' })
  .transform((root) => {
    const value = /^[A-Za-z]:[\\/]|^[/\\]{2}/.test(root) ? win32.normalize(root).replace(/\\/g, '/') : posix.normalize(root);
    return value === '/' || /^[A-Za-z]:\/$/.test(value) ? value : value.replace(/\/+$/, '');
  });

/** Resolve explicit roots before the launcher's environment and agent defaults. Never fall back after invalid input. */
export function resolveAgentHomes(
  agents: readonly Pick<AgentAdapter, 'id' | 'storage'>[],
  configured: Readonly<Record<string, string>> | undefined,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): { homes: Record<string, string> } | { failure: ReadFailure } {
  const homes: Record<string, string> = {};
  for (const id of Object.keys(configured ?? {})) {
    if (!agents.some((agent) => agent.id === id && agent.storage)) {
      return { failure: { subject: id, kind: 'bad-config', message: `agentHomes contains unsupported agent "${id}".`, remedy: 'Remove the unsupported agent home.' } };
    }
  }
  for (const agent of agents) {
    if (!agent.storage) continue;
    const raw = configured?.[agent.id] ?? env[agent.storage.environment] ?? `${home.replace(/[\\/]+$/, '')}/${agent.storage.defaultDirectory}`;
    const parsed = agentHomeSchema.safeParse(raw);
    if (!parsed.success) {
      return { failure: { subject: agent.id, kind: 'bad-config', message: `agentHomes.${agent.id} (${agent.storage.environment}) must be an absolute path without surrounding whitespace or control characters.`, remedy: 'Correct the agent environment variable and reopen the board.' } };
    }
    homes[agent.id] = parsed.data;
  }
  return { homes };
}
