import { makeClaudeAdapter } from '@ground-control/agent-claude';
import { DEFAULT_BOARD_STATUSES, DEFAULT_STATUS_LANES } from '@ground-control/board';
import type { LaneId } from '@ground-control/board';
import type { AgentAdapter, AgentConfig, HostAdapter, ReadFailure } from '@ground-control/core';
import { makeVscodeHost } from '@ground-control/host-vscode';

/**
 * Every target the board knows how to reach. This is the composition root: `core` names no adapter, so adding one is
 * an entry here and a configuration id, and nothing in the loop, the merge or any client changes.
 */
export interface Registries {
  agents: readonly AgentAdapter[];
  hosts: readonly HostAdapter[];
}

export function makeRegistries(): Registries {
  return { agents: [makeClaudeAdapter()], hosts: [makeVscodeHost()] };
}

/** What the hub polls with, and what a client's own settings merge over. */
export interface HubConfig {
  agents: AgentConfig[];
  branchIssuePattern: string;
  hosts: Record<string, unknown>;
  boardStatuses: string[];
  statusLanes: Record<string, LaneId>;
  refreshIntervalMs: number;
  sessionIntervalMs: number;
  installActivity: boolean;
}

/** The team's convention, so it ships as a default rather than as something a new developer has to set (R27). */
const BRANCH_ISSUE_PATTERN = '^(\\d+)-';

/** A network round trip, so it polls slowly; a session read spawns a CLI, so it polls quickly (mechanics §2). */
const REFRESH_INTERVAL_MS = 300_000;
const SESSION_INTERVAL_MS = 30_000;

/**
 * What the hub polls with before any client has said anything, built from the adapters themselves plus the shipped
 * statuses and lanes. R30 is what makes this the adapters' business rather than a list here: an agent that is not
 * the developer's primary one ships off, so its absence never nags. A hub the browser started alone runs on this.
 */
export function defaultConfig(registries: Registries = makeRegistries()): HubConfig {
  return {
    agents: registries.agents
      .filter((agent) => agent.defaultEnabled)
      .map((agent) => ({ id: agent.id, path: agent.defaultPath })),
    branchIssuePattern: BRANCH_ISSUE_PATTERN,
    hosts: Object.fromEntries(registries.hosts.map((host) => [host.id, {}])),
    boardStatuses: [...DEFAULT_BOARD_STATUSES],
    statusLanes: { ...DEFAULT_STATUS_LANES },
    refreshIntervalMs: REFRESH_INTERVAL_MS,
    sessionIntervalMs: SESSION_INTERVAL_MS,
    installActivity: true,
  };
}

/**
 * Applies the host entries in a configuration, and names every id the registry does not carry. An unknown id is a
 * failure on the board rather than a silent omission (R25) — a developer who mistyped one otherwise sees a host
 * that simply never reaches anything.
 */
export function configureHosts(registries: Registries, hosts: Record<string, unknown>): ReadFailure[] {
  return Object.entries(hosts).flatMap(([id, raw]) => {
    const host = registries.hosts.find((candidate) => candidate.id === id);

    if (!host) {
      return [
        {
          subject: id,
          kind: 'unknown-host',
          message: `The board does not know how to reach into "${id}".`,
          remedy: 'Remove it from groundControl.hosts, or check the spelling.',
        },
      ];
    }

    const failure = host.configure(raw);

    return failure ? [failure] : [];
  });
}
