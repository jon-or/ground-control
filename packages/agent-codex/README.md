# @ground-control/agent-codex

The Codex agent adapter: live sessions from the hook markers, saved threads from `~/.codex/sessions`, and the activity hook. Must not import `vscode`. The seams it implements are `@ground-control/core`'s `AgentAdapter` and `ActivitySignal`.

Everything here is measured in `docs/mechanics.md` §39–§43, against `codex-cli 0.153.0` on Windows. Re-measure after a Codex upgrade: the app-server protocol is behind `[experimental]`, and the hook payload is not a documented contract.

## What makes this adapter different from Claude's

**The markers are the roster.** Codex has no `claude agents --json`. `codex agents` needs `--remote` on Windows, the shared app-server daemon is Unix-only, and a second `codex app-server` reports another process's live threads as `notLoaded` — so there is nothing to ask. `listSessions` lists `~/.claude/ground-control/codex-activity`, which is the same directory the activity hook writes into.

**The pid is the liveness.** A marker outlives the process that wrote it: a killed Codex fires no `SessionEnd`. So the writer walks from its own process up to Codex's — through the shell Codex spawned it with, using `Get-CimInstance` because `(Get-Process).Parent` is PowerShell 7's — and copies the pid onto every later marker. The walk runs before the marker is read and replaced rather than between them, and only on an event that may create a marker, because a walk costs a process spawn and a spawn between the read and the write is a window for losing another event. `readRoster` reports a session only when that pid is alive, and says so when a marker has no pid to test. A pid is not an identity: reuse can make a dead session read as live until the hub's marker sweep runs.

**A thread is opened by its id, not its directory.** The host reveals one with `vscode.open` on `openai-codex://route/local/<id>` — the call Codex's own extension makes on itself. It is idempotent, and a thread whose rollout records one checkout opens in a window rooted at another, which is why `canResume` asks whether Codex still holds the rollout rather than whether the saved directory is still there.

**Only a start or a prompt creates a marker.** Every other event updates one. `Stop` is asynchronous and `SessionEnd` is synchronous, so a `Stop` still in flight when the session ended would otherwise put a card back that nothing ever clears — and a start that lands in the same millisecond as the first prompt must not overwrite it, because a start claims no phase and the card would spend its first turn without one.

**The turn is named.** Every hook event inside a turn carries `turn_id`, so the stretch a running card counts is bounded by evidence: a turn id the marker has not seen starts the count. There is no rule about which events open and close one.

**The install is not finished when the file is written.** Codex hashes each hook command and runs only entries a developer has trusted; a freshly written entry reports `untrusted` and does not fire. The plan writes the entries, and the developer accepts them in Codex. Writing the hash into `config.toml` ourselves would work and is deliberately not done — trusting a hook on the developer's behalf is their decision, not the board's. Codex leaves the file byte-identical afterwards, so the install converges on its second run rather than rewriting the file and re-arming that prompt.

**`CODEX_HOME` moves the file.** The adapter factory takes the environment, so a developer who has moved their Codex home gets the entries in the file Codex actually reads. The markers do not move with it: they are the board's own, under `~/.claude/ground-control/codex-activity`.

## Starting work

`dispatch` spawns `codex exec --json` detached, with its output going to a file under the board's own directory rather than to a pipe — a pipe nobody drains blocks the child at about 64 kB, and the run has to outlive the hub that started it. The thread id comes off the `thread.started` line the CLI prints before the first turn, so the answer takes about a second rather than the length of the work.

Three of the board's permission modes translate, and three are refused. `plan`, `dontAsk` and `bypassPermissions` map onto a sandbox and an approval policy; `manual`, `auto` and `acceptEdits` are refused outright, because `codex exec` has nobody to ask — an approval it raises is denied, so the run would start, fail its first tool, and report work it never did (R15, R31).

`stopDispatch` signals the process the thread's own marker names. Codex has no `claude stop`, and the roster refreshes that pid on every read, so a hub that restarted can still stop a run it did not start.

## What it does not do

No `classify`. `codex exec --json --output-schema --ephemeral` would be a cleaner classifier than Claude's — `--ephemeral` writes no session file, so it cannot reach the board by accident — but it is not wired.

## The fixtures

`test/fixtures/hook-payloads.json` is one real session's seven events, recorded by installing a probe hook in an isolated `CODEX_HOME` and driving a session through `codex app-server` with an approval in it. To re-record: install a hook per event whose command writes its stdin to a file, write the `trusted_hash` for each entry that `hooks/list` reports, then run a session that reads a file and writes one.
