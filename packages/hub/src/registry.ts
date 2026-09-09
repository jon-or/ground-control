import { homedir } from 'node:os';
import { makeClaudeAdapter } from '@ground-control/agent-claude';
import { killOnMachine, makeCodexAdapter, makeMachineStarter, makeTrustOnMachine, pidAliveOnMachine } from '@ground-control/agent-codex';
import { DEFAULT_BOARD_STATUSES, DEFAULT_STATUS_LANES } from '@ground-control/board';
import { DEFAULT_ACTIONS, DEFAULT_NEW_SESSION, DEFAULT_TRIAGE } from '@ground-control/core';
import type { AgentAdapter, HostAdapter, HubConfig, Logger, MachineReaders, ReadFailure, WorkSource } from '@ground-control/core';
import { makeGithubSource } from '@ground-control/github';
import { makeVscodeHost } from '@ground-control/host-vscode';

/**
 * Every target the board knows how to reach. This is the composition root: `core` names no adapter, so adding one is
 * an entry here and a configuration id, and nothing in the loop, the merge or any client changes.
 */
export interface Registries {
  agents: readonly AgentAdapter[];
  hosts: readonly HostAdapter[];
  sources: readonly WorkSource[];
}

export function makeRegistries(log?: Logger, home: string = homedir()): Registries {
  const codex = makeCodexAdapter({
    alive: pidAliveOnMachine,
    env: process.env,
    // The hub's own home, not the machine's: a dispatch under `--home` must not write a run's transcript, prompt
    // and all, into the home of the board the developer is actually using.
    start: makeMachineStarter(home),
    kill: killOnMachine,
    // The hub's home again, for the same reason: a trust written under `--home` must not reach the developer's own
    // Codex, and `CODEX_HOME` is what decides which `config.toml` the exchange writes.
    trust: makeTrustOnMachine(),
  });

  return { agents: [makeClaudeAdapter(), codex], hosts: [makeVscodeHost()], sources: [makeGithubSource(log ? { log } : {})] };
}

/** The team's convention, so it ships as a default rather than as something a new developer has to set (R27). */
const BRANCH_ISSUE_PATTERN = '^(\\d+)-';

/** A network round trip, so it polls slowly; a session read spawns a CLI, so it polls quickly (mechanics M2). */
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
    // Named with nothing in them: a source no client has configured says what it is missing, which is what a hub
    // the browser started alone has to do — silence there reads as a board with no work on it (R25).
    sources: Object.fromEntries(registries.sources.map((source) => [source.id, {}])),
    boardStatuses: [...DEFAULT_BOARD_STATUSES],
    statusLanes: { ...DEFAULT_STATUS_LANES },
    refreshIntervalMs: REFRESH_INTERVAL_MS,
    sessionIntervalMs: SESSION_INTERVAL_MS,
    installActivity: true,
    logLevel: 'info',
    triage: { ...DEFAULT_TRIAGE },
    // Nothing on, and no prompt: the board shows and intervenes, and does not start work until asked to (R32).
    actions: { ...DEFAULT_ACTIONS, actions: {} },
    newSession: { ...DEFAULT_NEW_SESSION },
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
          message: `Unsupported host: "${id}".`,
          remedy: 'Remove it from groundControl.hosts, or check the spelling.',
        },
      ];
    }

    const failure = host.configure(raw);

    return failure ? [failure] : [];
  });
}

/**
 * Applies the source entries in a configuration, and names every id the registry does not carry. A source is read
 * only once it has taken a configuration, so a refused entry is a named failure and no read at all — never a read
 * made with whatever the last client set.
 */
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
