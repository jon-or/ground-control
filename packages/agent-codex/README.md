# @ground-control/agent-codex

Codex discovery, history, activity, hook trust, dispatch, and stop support. Implements `AgentAdapter` and `ActivitySignal` from `@ground-control/core`; does not import `vscode`.

## Discovery and hooks

No usable Windows live-roster API was found in the recorded experiments. `listSessions` reads hook markers under `~/.claude/ground-control/codex-activity` and checks their PIDs. Process termination may leave markers behind, and PID reuse remains a limitation. See [mechanics M39–M42](../../docs/mechanics.md#codex).

The hook writer finds the Codex ancestor PID when creating a marker. Only session-start and prompt events create markers; other events update existing ones. This prevents a delayed Stop event from restoring a marker removed by SessionEnd. `turn_id` identifies the running interval.

Hook entries live in Codex's home, respecting `CODEX_HOME`. Marker files remain under Ground Control's directory. Installation preserves unrelated entries. The adapter automatically requests trust for its installed writer through `hooks/list` and `config/batchWrite`, using Codex-provided hashes. It reports failures and never computes hashes or rewrites TOML directly.

History comes from rollout metadata and the session index. `canResume` checks that the rollout exists. VS Code resource identity and window placement belong to `packages/host-vscode`, not this adapter.

## Dispatch

`dispatch` starts detached `codex exec --json`, writes stdout/stderr to separate files, and reads the thread ID from `thread.started`. It ignores the requested display name. The process can outlive the hub.

`plan`, `dontAsk`, and `bypassPermissions` have explicit sandbox/approval mappings. `manual`, `auto`, and `acceptEdits` are refused. Workspace-write dispatch enables network access. See [mechanics M46](../../docs/mechanics.md#codex-dispatch-network-access).

`stopDispatch` authorizes only threads dispatched by this adapter instance, then uses the spawned PID or a roster PID fallback. The authorization map is not persisted. A hub restart therefore prevents stopping prior runs through this adapter, even if the hub retains their action records.

The adapter does not implement classification. Classifier experiments are not registered capabilities.

## Fixtures

[Fixture instructions](test/fixtures/README.md) describe the recorded hook events and scrubbing procedure. Use an isolated Codex home and the supplied recorders. The dates and versions in mechanics describe the experiments, not a guarantee about later CLI releases.
