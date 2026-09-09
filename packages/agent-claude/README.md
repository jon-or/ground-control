# @ground-control/agent-claude

Claude Code discovery, history, activity, classification, background dispatch, and stop support. Implements `AgentAdapter` and `ActivitySignal` from `@ground-control/core`; does not import `vscode`.

## Sessions and activity

`claude agents --json` supplies roster identity and liveness. Transcript readers supply titles and historical metadata; transcript modification time does not establish activity. `startedAt` uses epoch milliseconds. Claude-specific fields remain in `Session.details`; shared fields include explicit `finished` and background `attachId`.

Hooks write raw events under `~/.claude/ground-control/activity/`. `phaseOf` maps them to observed phases. Unknown, mismatched, or invalid marker data produces no phase. Subagent payloads are excluded because their events use the parent's session ID and could overwrite its attention state.

`HOOK_SOURCE` contains the standalone writer script. `planHookInstall` computes settings changes; the hub handles locks, backups, and writes. Tests spawn the writer and separately verify settings merges.

## Classification and dispatch

Classification suppresses settings, tools, MCP servers, and session persistence. Background dispatch loads the developer's context, passes explicit permissions, and returns the CLI-assigned short ID. The hub resolves that ID against the roster. Background runs can attach in a terminal and be stopped; automated takeover remains future work.

See [Claude mechanics](../../docs/mechanics.md#claude-code) for dated evidence and [fixtures](test/fixtures/README.md) for recordings.

## Adding an agent

1. Implement `AgentAdapter` in its own package with `id`, `displayName`, `defaultPath`, `enabledByDefault(readers)`, and `listSessions(path, deps)`.
2. Inject machine/transport dependencies. `MachineDeps` does not impose a CLI transport or liveness mechanism.
3. Add supported optional capabilities: history, resume validation, activity, classification, dispatch, and stop. Omit unavailable capabilities.
4. Register it in `packages/hub`, and add editor placement support if needed.
5. Record real external fixtures and test the adapter independently.

`enabledByDefault` is a method, not a boolean setting. Claude returns true; Codex checks for its home directory. Explicit agent configuration replaces the default set. See [adapter contracts](../../docs/architecture.md#adapter-contracts).
