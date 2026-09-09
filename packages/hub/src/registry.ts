import { homedir } from 'node:os';
import { makeClaudeAdapter } from '@ground-control/agent-claude';
import { killOnMachine, makeCodexAdapter, makeMachineStarter, makeTrustOnMachine, pidAliveOnMachine } from '@ground-control/agent-codex';
import { DEFAULT_BOARD_STATUSES, DEFAULT_STATUS_LANES } from '@ground-control/board';
import { DEFAULT_ACTIONS, DEFAULT_NEW_SESSION, DEFAULT_TRIAGE } from '@ground-control/core';
import type { AgentAdapter, HostAdapter, HubConfig, Logger, MachineReaders, ReadFailure, WorkSource } from '@ground-control/core';
import { makeGithubSource } from '@ground-control/github';
import { makeVscodeHost } from '@ground-control/host-vscode';

/** Compose adapters here; core depends only on neutral contracts. */
export interface Registries {
  agents: readonly AgentAdapter[];
  hosts: readonly HostAdapter[];
  sources: readonly WorkSource[];
}

export function makeRegistries(log?: Logger, home: string = homedir()): Registries {
  const codex = makeCodexAdapter({
    alive: pidAliveOnMachine,
    env: process.env,
    // Use the injected home so --home dispatches do not write transcripts to the developer's active home.
    start: makeMachineStarter(home),
    kill: killOnMachine,
    // Use the injected CODEX_HOME so --home trust changes do not affect the developer's active config.toml.
    trust: makeTrustOnMachine(),
  });

  return { agents: [makeClaudeAdapter(), codex], hosts: [makeVscodeHost()], sources: [makeGithubSource(log ? { log } : {})] };
}

/** Default issue-number convention (R27). */
const BRANCH_ISSUE_PATTERN = '^(\\d+)-';

/** Poll network sources less frequently than local session CLIs (M2). */
const REFRESH_INTERVAL_MS = 300_000;
const SESSION_INTERVAL_MS = 30_000;

/**
 * Build pre-client defaults from adapter detection and shared board settings, using the injected home. Claude
 * is enabled by default; Codex requires its home directory. Adapter defaults do not prove executable
 * availability.
 */
export function defaultConfig(registries: Registries, readers: MachineReaders): HubConfig {
  return {
    agents: registries.agents
      .filter((agent) => agent.enabledByDefault(readers))
      .map((agent) => ({ id: agent.id, path: agent.defaultPath })),
    branchIssuePattern: BRANCH_ISSUE_PATTERN,
    hosts: Object.fromEntries(registries.hosts.map((host) => [host.id, {}])),
    // Create unconfigured sources so browser-only startup reports missing settings (R25).
    sources: Object.fromEntries(registries.sources.map((source) => [source.id, {}])),
    boardStatuses: [...DEFAULT_BOARD_STATUSES],
    statusLanes: { ...DEFAULT_STATUS_LANES },
    refreshIntervalMs: REFRESH_INTERVAL_MS,
    sessionIntervalMs: SESSION_INTERVAL_MS,
    installActivity: true,
    logLevel: 'info',
    triage: { ...DEFAULT_TRIAGE },
    // Disable automatic actions until configured (R32).
    actions: { ...DEFAULT_ACTIONS, actions: {} },
    newSession: { ...DEFAULT_NEW_SESSION },
  };
}

/** Configure hosts and report unknown IDs (R25). */
export function configureHosts(registries: Registries, hosts: Record<string, unknown>): ReadFailure[] {
  return Object.entries(hosts).flatMap(([id, raw]) => {
    const host = registries.hosts.find((candidate) => candidate.id === id);

    if (!host) {
      return [
        {
          subject: id,
          kind: 'unknown-host',
          message: `Unsupported host: "${id}".`,
          remedy: 'Remove it from groundControl.hosts, or check the spelling.',
        },
      ];
    }

    const failure = host.configure(raw);

    return failure ? [failure] : [];
  });
}

/** Configure sources and report unknown IDs. Rejected settings disable reads instead of retaining prior client settings. */
export function configureSources(registries: Registries, sources: Record<string, unknown>): ReadFailure[] {
  return Object.entries(sources).flatMap(([id, raw]) => {
    const source = registries.sources.find((candidate) => candidate.id === id);

    if (!source) {
      return [
        {
          subject: id,
          kind: 'unknown-source',
          message: `Unsupported work source: "${id}".`,
          remedy: 'Remove it from groundControl.sources, or check the spelling.',
        },
      ];
    }

    const failure = source.configure(raw);

    return failure ? [failure] : [];
  });
}
