import type { AgentAdapter, AgentReading } from './agent.js';
import { compilePattern } from './link.js';
import type { MachineReaders } from './machine.js';
import type { SessionsConfig, SessionsSnapshot } from './types.js';

/**
 * Every live session across every configured agent CLI, read concurrently. Always a snapshot: one CLI being absent
 * must not hide another's sessions, which is R2's "no session is invisible" on a machine running several agents.
 */
export async function fetchSessions(
  cfg: SessionsConfig,
  adapters: readonly AgentAdapter[],
  readers: MachineReaders,
): Promise<SessionsSnapshot> {
  const { pattern, error } = compilePattern(cfg.branchIssuePattern);
  const deps = { ...readers, pattern };

  const reads = cfg.agents.map((agent): Promise<AgentReading> => {
    const adapter = adapters.find((candidate) => candidate.id === agent.id);

    if (!adapter) {
      return Promise.resolve({
        sessions: [],
        failure: {
          subject: agent.id,
          kind: 'unknown-agent',
          message: `The board does not know how to read sessions from "${agent.id}".`,
          remedy: 'Remove it from the configured agents, or check the spelling.',
        },
      });
    }

    return adapter.listSessions(agent.path || adapter.defaultPath, deps);
  });

  const settled = await Promise.all(reads);

  return {
    sessions: settled.flatMap((reading) => reading.sessions),
    failures: settled.flatMap((reading) => (reading.failure ? [reading.failure] : [])),
    patternError: error === null ? null : `groundControl.branchIssuePattern ${error}`,
    fetchedAt: new Date().toISOString(),
  };
}
