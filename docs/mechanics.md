# Verified mechanics

Everything here was measured on this machine on **2026-09-01**, not inferred. Versions: Claude Code CLI as installed that day, VS Code extension `anthropic.claude-code` **2.1.252**.

Re-verify anything marked **version-fragile** after a Claude Code or extension upgrade.

---

## 1. Dispatch — `claude --bg`

Background sessions are first-party. A station does not need a bespoke process manager.

```bash
cd d:/work/repo.worktrees/17198-channel-mapping-drops-rows-past-the-first-page
claude --bg --permission-mode bypassPermissions -n "factory-demo-17198" "<station prompt>"
# → backgrounded · 9d937cb5 · factory-demo-17198
```

The short id is the first 8 chars of the session UUID. `-n` sets a display name that later shows up as the **editor tab title**, so name background sessions after their item and station.

Related subcommands: `claude attach <id>` (terminal), `claude logs <id>`, `claude stop <id>`, `claude respawn <id>`, `claude rm <id>`.

> **Never call `claude rm` from the factory.** Its help states it deletes the session "and its worktree when that is safe." A factory worktree holds uncommitted work. `stop` is the only teardown the orchestrator may use.

## 2. Liveness — `claude agents --json`

One call returns every live session on the machine, **interactive and background, across every worktree**:

```json
{ "pid": 65380, "id": "9d937cb5", "cwd": "d:\\work\\repo.worktrees\\17198-...",
  "kind": "background", "startedAt": 1788284040892,
  "sessionId": "9d937cb5-933e-45de-8514-e1bff6e447ba",
  "name": "factory-demo-17198", "status": "busy", "state": "working" }
```

- `--all` also returns exited/stopped sessions (`state: "stopped"`), with `cwd` preserved.
- `--cwd <path>` filters by directory.
- Requires no TTY; the bare `claude agents` does.
- **Costs about 215 ms a call** — measured 2026-09-01, three consecutive runs at 218/217/212 ms returning 3,450 bytes for 17 sessions. It spawns a Node process, so a board polling it every few seconds spawns one every few seconds. That is what sets the board's session cadence, not how fast a session's state changes: the board reads sessions every 30 s and GitHub every 300 s, and stops both while its tab is not the visible one.

**This is the board's liveness source.** Do not derive liveness from transcripts — see §3.

## 3. Transcripts lag reality

Measured: two subagents were confirmed running via the OS process tree while the parent's `.jsonl` still contained no record of the tool call. Transcript writes are buffered and land after the fact.

Consequence: `.jsonl` is the **evidence and audit** source. `claude agents --json` is the **liveness** source. Never swap them.

Layout:

```
~/.claude/projects/<project-slug>/<session-id>.jsonl
~/.claude/projects/<project-slug>/<session-id>/subagents/agent-<id>.jsonl
~/.claude/projects/<project-slug>/<session-id>/subagents/agent-<id>.meta.json
```

`<project-slug>` = the absolute path with **every character that is not a letter or digit** replaced by `-`, runs not collapsed (`d:\work\repo` → `d--work-repo`; `d:\work\repo.worktrees\18941-inbox-badge` → `d--work-repo-worktrees-18941-inbox-badge`).

**Measured, not inferred.** A session started in `D:\git\dev-tracker\.claude\personal\slug probe_x+y~z` produced `D--git-dev-tracker--claude-personal-slug-probe-x-y-z`, so the space, `_`, `+` and `~` all become `-`. Every real cwd on this machine contains only `- . : \`, which is why a narrower rule looks correct here and fails on the first path with an underscore or a space.

**Case is not a lookup key** — version-fragile. A project directory's case is fixed by whichever path first created it, and the CLI reports one checkout under either drive-letter case: there is no `d--work-repo` on disk at all, while several live sessions report `cwd: d:\work\repo` and their transcripts sit in `D--work-repo`. NTFS hides this. A reader must resolve the directory case-insensitively against the actual listing, or it reports a transcript that exists as absent on any case-sensitive filesystem.

**Absence is a real state.** Some live sessions have no transcript anywhere under `~/.claude/projects` — searched across every project directory, not just the expected one. A reader must return "unknown" for that, never an error and never a time.

**A transcript's mtime is not liveness.** Among live sessions that had one, the oldest write measured was over 9 hours old — so a write time is only ever a write time.

The counts behind these move as sessions start and exit; `packages/sessions/test/fixtures/` pins them, re-recordable with `node test/fixtures/record.js`. The probe is not among them — a probe directory cannot be recorded from a machine it no longer exists on, so it is asserted directly in `packages/sessions/test/activity.test.ts`.

`meta.json` contents: `{"agentType","description","toolUseId","spawnDepth"}` — enough to attribute a subagent to the parent tool call that spawned it.

## 4. Stop kills subagents — they do not survive

Measured directly. A background session spawned two subagents, each running a ~150s wait.

- **Subagents run in-process.** The process tree under the session pid showed no per-subagent process — only the `bash.exe` children of their own tool calls.
- `claude stop` killed the parent and every child. The subagent's own transcript recorded `{"content":"Exit code 137","is_error":true}` — SIGKILL.
- **No orphans** were left behind.
- On `claude --resume`, the parent was notified that both agents were `stopped` with no completion record, and reported this accurately. It did not fabricate results and did not hang waiting.
- Partial work survives on disk in the subagent `.jsonl` files (~48 KB each here), but the parent's context has no result and nothing auto-restarts.

**Also measured:** subagents are **async by default** in this build. The `Agent` tool returns an `agentId` immediately and the parent goes idle awaiting notifications. A stop therefore discards pending notifications rather than interrupting a blocking call — same loss, different shape.

### Design consequences

1. **Checkpoint to disk, never to conversation.** A station must not hold intermediate results in context. `cross-review` writes `evidence/findings-{model}.json` per reviewer and re-reads the directory; a kill then costs one reviewer, and re-dispatch skips models whose file already exists.
2. **Shell out for reviewers.** `codex exec` writing a file is a child process the factory owns and restarts independently. An in-process `Agent` call is bound to the parent's lifetime.
3. **Seize has a price, and the UI must quote it.** Before offering Seize, count in-flight subagents and warn. Steer is free; Seize is not.

## 5. A Claude tab's cwd is the window's workspace folder — always

**version-fragile.** From the decompiled `setupPanel` in extension 2.1.252:

```js
let Y = workspace.workspaceFolders?.map(U => U.uri.fsPath) || [],
    z = realpathSync(Y[0] || homedir()).normalize("NFC");
// z is passed as the cwd into the panel's comms object
```

The cwd comes from `workspaceFolders[0]` and is **never** derived from the session. Two consequences:

- A multi-root workspace does not help — only the first folder counts.
- **One seizable worktree means one VS Code window.** The WIP limit is what bounds the window count.

Measured confirmation: session `9d937cb5` (project slug `D--work-repo-worktrees-17198-…`) fired into a window rooted at `d:\work\repo` produced **no tab at all**, while `106b56c3` (slug `D--work-repo`) fired into that same window opened correctly.

## 6. `claude-vscode.editor.open` — signature and behavior

**version-fragile.** Registered by the official extension; undocumented. Signature is unchanged from the 2.1.214 notes in the `session-launcher` bridge README:

```
claude-vscode.editor.open(sessionId, initialPrompt?, viewColumn?)
```

From `createPanel`:

- A `sessionPanels` map is checked first. If the session already has a tab, it is **revealed** and, if a prompt was supplied, the user sees *"Session is already open. Your prompt was not applied — enter it manually."* **Seize must detect this case and not rely on a seeded prompt.**
- With `viewColumn` undefined, it prefers an existing tab group made entirely of Claude panels, else `findUnusedColumn()`.
- `initialPrompt` **prefills** the input box. It is not submitted; a human presses Enter.

Sibling commands that exist and are not yet characterized: `claude-vscode.primaryEditor.open`, `claude-vscode.window.open`, `claude-vscode.editor.openLast`, `claude-vscode.newConversation`, `claude-vscode.reopenClosedSession`.

## 7. URI routing is not addressable — do not use it for seize

Three fires of `vscode://or.claude-session-launcher/open?session=…` against a machine with seven VS Code windows:

- Routing follows the **focused** window. Confirmed: with focus on `18945-owner-statement-counts-archived-records-twice`, the tab appeared there.
- Focus is not something the orchestrator owns. The user, another app, or a background process can change it between the decision and the fire.
- `Start-Process "vscode://…"` **did not route at all** — no handler log, no tab. `code --open-url "vscode://…"` routed reliably. The `session-launcher` README's claim that this machine's `code` CLI has no `--open-url` is **stale**; the flag exists and works.
- PowerShell/cmd eats `&column=2` unless the whole URI is quoted.

**Conclusion:** URIs are a shell-level fallback for cold start only. Never the seize path.

## 8. In-process `executeCommand` IS addressable — proven

VS Code runs one extension host per window. `vscode.commands.executeCommand` dispatches inside its own host, so the panel lands in **its own** window. There is no target parameter because the window is implied. VS Code exposes no API to act on another window, so *the only way to choose a window is to run code in it.*

Proven with `extensions/seize-probe/` — a ~90-line probe loaded via `code --extensionDevelopmentPath=… --new-window <worktree>` (nothing permanently installed). It registers `{folder, pid}` under a slug in `~/.factory/windows.json`, watches `~/.factory/inbox/<slug>.json`, and on a write calls `editor.open` locally.

```
17:58:23  activate: slug=d-work-repo-worktrees-17198-…  folder=d:\work\repo.worktrees\17198-…  pid=47024
17:58:59  handle … session=9d937cb5-…  claudeTabsBefore=1
17:59:01  after: claudeTabs=1  titles=["factory-demo-17198"]
17:59:21  handle … session=e87fd6d6-…  claudeTabsBefore=1
17:59:23  after: claudeTabs=2  titles=["factory-demo-17198","subagent-survival-test"]
```

The tab labels are the `-n` display names of those two background sessions, so the real conversations resumed, in the addressed window, at the right worktree. The second call is the unambiguous one — tab count 1 → 2 with the requested session's title.

Caveat recorded for honesty: the first call is ambiguous. The window already held one Claude tab, so that call may have revealed an existing tab rather than created one.

### The cold path: 3.2 seconds

Measured with the extension **normally installed** (junction plus an `extensions.json` entry), not `--extensionDevelopmentPath`, against a worktree with no window open:

```
target slug: d-work-repo-worktrees-17510-channel-mapping-reads-across-the-tenant-boundary
already registered: False
code --new-window d:\work\repo.worktrees\17510-channel-mapping-reads-across-the-tenant-boundary
registered: True  after 3.2s
{"folder":"d:\\work\\repo.worktrees\\17510-…","pid":31120,"updated":"2026-09-01T19:52:02Z"}
```

Then a seize into that brand-new window, with no prior Claude tab to confuse the count:

```
handle seize … folder=d:\work\repo.worktrees\17510-…  claudeTabsBefore=0  titles=[]
after seize:  claudeTabs=1  titles=["cold-path"]
tracked seized tab "cold-path" -> c01d0001-…
```

and a live tab process at the right root: `{"pid":12036,"kind":"interactive","cwd":"d:\\work\\repo.worktrees\\17510-…"}`.

So task 2 §5's cold path holds: **no window → open → register → seize** works, and the 15 s poll budget is generous. Registration under `--extensionDevelopmentPath` took 14–25 s; that was the Extension Development Host's startup cost, not the extension's.

Incidental: `--session-id` rejects non-hex-looking UUIDs — `c0ld0001-…` fails with `Error: Invalid session ID. Must be a valid UUID.` while `c01d0001-…` is accepted. Cute test ids will bite.

### Verification is mandatory

`executeCommand` resolves `ok` whether or not a panel appears — it did so on every failed URI attempt too. Confirm by counting tabs whose `input.viewType` includes `claudeVSCodePanel` and reading their labels.

## 9. Hand-back — a seized session returns to the factory

Proven. The seize round trip closes, but only under a rule that is easy to violate.

```bash
claude --bg --resume 322e2149-f26a-4bff-b496-ea0e4f831e9e "Continue. …"
# → note: woke session 322e2149 with its saved options (--permission-mode, -n).
#   backgrounded · 322e2149 · handback-test
```

Same short id, same display name, same saved options, and the conversation genuinely continued — the resumed agent recalled the earlier turn unprompted:

> "You asked me to run `git log --oneline -3`, print ALPHA, then run a bash loop that waits 120 seconds, then print OMEGA — I completed the log and ALPHA, and have not yet run the 120-second wait."

### The fork hazard

**Passing any extra flag on resume silently creates a copy.** The same command with `--permission-mode bypassPermissions` added:

```
note: background session 322e2149 keeps its own saved options, so the flags you passed
      started a copy as 9e6418f4. Without flags, the same command continues 322e2149 itself.
```

The copy is a separate session with an auto-generated name — here `label categorization task` — running against the same worktree. Two agents on one working tree is a corruption path, not an inconvenience.

**Orchestrator rules:**

1. Session options (`--permission-mode`, `-n`, `--model`, `--add-dir`) are set **once, at dispatch**. They are saved with the session.
2. Resume passes **only** `--bg --resume <id>` and the prompt. Nothing else, ever.
3. Parse stdout. `woke session <id>` is success; `started a copy as <newid>` is a **failure** — stop the copy immediately and alert, do not let it run.

## 10. Station output contract — `--bg` and stream-json are mutually exclusive

The decisive fork, now resolved, and not in the direction the plan assumed.

**`-p --output-format stream-json --verbose` produces exactly the stream you would want.** Clean NDJSON, one event per line:

```
system/init · system/hook_started · system/hook_response · assistant · user
tool_use · tool_result · thinking · rate_limit_event · result/success
```

It writes a normal transcript under the worktree's project slug, and long waits are auto-delegated to background tasks that emit `task_started` / `task_notification` events.

**But a `-p` session cannot be stopped, attached, or seized.** It registers in `claude agents --json` — pid, cwd, sessionId all present — as `kind: "interactive"` with **no short `id`** and no `status`/`state`. And:

```bash
claude stop a1b2c3d4-0000-4000-8000-000000000001
# → No job matching 'a1b2c3d4-…'. Run 'claude agents' to list running sessions.
```

| | `--bg` | `-p --output-format stream-json` |
|---|---|---|
| Listed in `claude agents --json` | yes, `kind: background` | yes, `kind: interactive` |
| Short id, `status`, `state` | yes | **no** |
| `claude stop` / `attach` | yes | **no** — killable only by pid |
| Machine-readable stream | **no** — `claude logs` is a raw ANSI terminal buffer | yes |
| `--json-schema` structured result | no | yes |
| `-n` display name | yes | yes |
| **Seizable** (§8) | yes | **yes** — after a pid kill |
| **Releasable + hand-back** (§11) | yes | **yes** |

### Watch is proven on the `-p` stream

Tailed live while a station ran seven ordered steps with two 20-second waits:

```
16:03:59  RUNNING Bash: Busy-wait loop for 20 seconds | tools=2 done=1
16:04:19  RUNNING thinking/replying                   | tools=3 done=3  last_text=STEP-2
16:04:24  RUNNING Bash: Busy-wait loop for 20 seconds | tools=4 done=3
16:04:42  RUNNING thinking/replying                   | tools=4 done=4
16:04:47  DONE                                        stream closed
```

- **Written incrementally.** `16:03:59 → 16:04:19` is the station's actual 20 s wait, observed as it elapsed. Events are not buffered until exit.
- **The current-action rule:** pending = `tool_use` ids with no matching `tool_result`; the last pending one is what the agent is doing now. `type: result` is terminal. No ANSI parsing, no heuristics.
- **`input.description` is a renderable label** — `"Busy-wait loop for 20 seconds"` straight onto a card. Gaps between tool calls read as "thinking", which is honest rather than a stall.
- **Plain file reads are safe on Windows** while the writer holds the file open — 45 samples, no locking errors, no partial-line corruption.

Sampled at 2 s, so sub-second latency is unmeasured; `--include-partial-messages` streams token-level deltas if that is ever wanted. Watch on a `--bg` station remains ANSI-only via `claude logs`.

### Decision: stations run under `-p --output-format stream-json`

The escape hatch worked, so the fork is not a fork. **Proven** (§11): a `-p` session can be killed by pid, seized into a tab, released, and handed back with `claude --bg --resume` under its original id, conversation intact.

That means the factory gets the structured stream *and* the full intervention model. What it gives up is small:

- No short id, no `status`/`state`, no `claude stop`. The orchestrator owns the pid and kills by pid.
- **Liveness comes from the stream, not from `claude agents --json`.** This is strictly better than `state: working` — the stream carries per-tool-call events, so Watch can show the current action live rather than a lagged transcript read (§3).
- **`-p --resume` keeps streaming — proven.** Resuming a killed station with `-p --output-format stream-json --resume <sid>` emits NDJSON under the **same session id**, opening with a `SessionStart:resume` hook event. So a seized station comes back fully instrumented; there is no permanent downgrade. Hand-back via `--bg --resume` *does* convert the session to `kind: background` and rename it (§11), so the factory should resume with `-p`, not `--bg`, when it wants Watch to survive — at the cost of the queue restore (§14).
- **A `-p` station blocks until its async subagents deliver.** Measured: the resumed turn stayed alive 120 s waiting on two subagents, then emitted `type: result` and exited. A print-mode station does not exit early and abandon its children.
- **A pid kill leaves no death marker.** `claude stop` records `Exit code 137` in the subagent's transcript; `Stop-Process -Force` on the parent kills the child before any `tool_result` is written, so the transcript just ends. The bump classifier therefore cannot rely on a death marker — absence of a completion record is the only reliable orphan signal (§14).
- **`-p --resume` has no tab interlock — this is a corruption hazard.** With the session's tab open in VS Code, a shell `-p --output-format stream-json --resume <sid>` **succeeded**: same session id, `subtype: success`, exit 0, no warning of any kind. `--bg --resume` refuses in that situation and forks a copy with an explicit note (§11); print-mode does not. Two writers can append to one conversation silently.

  Worse, the tab does not live-reload. A screenshot taken after that shell turn showed the conversation ending at the pre-kill state with no trace of the appended turn — so the operator is looking at a stale view of a conversation the factory just wrote to.

  **Rule: release before any resume, on both paths.** On the `--bg` path stdout warns you; on the `-p` path nothing does, so the orchestrator must check tab state through the registry (task 2 `reconcile`) rather than relying on an error.

### Concurrent writers FORK the transcript and orphan work — measured

The transcript is a **tree**, not a log: every entry carries `parentUuid`. Two writers on one session produce sibling branches, and `--resume` follows exactly one of them. The other branch's work is intact on disk and unreachable.

Demonstrated on the seized `a9b8c7d6` session. A shell `-p --resume` ran while the tab was open; the operator then typed in the tab, whose view was stale:

```
BRANCH POINT — one parent, two children:
  parent[user]: <task-notification><task-id>buhoau2ui</task-id>…
      -> [user] "Continue from where you left off."                 ← shell branch
      -> [user] "Print exactly OPERATOR-MARKER-42, then run pwd…"   ← operator branch
```

Both branches carry real work — the operator branch has the assistant's thinking, a `Bash pwd`, and its result. A later `-p --resume` followed the **shell** branch and, asked to quote the most recent operator marker, answered with the shell branch's marker. It never saw the operator's turn. No error, no warning, nothing in the stream.

So the hazard is not interleaved writes. It is **silently orphaned work**, which is strictly worse: the factory would resume, look coherent, and have discarded whatever the operator did.

**Rules:**

1. **Exactly one writer per session, enforced by the factory.** Release before any resume. `--bg --resume` refuses and forks loudly; `-p --resume` does neither, so the orchestrator must gate on tab state through the registry (task 2 `reconcile`), never on an error it will not receive.
2. **Fork detection belongs in `factory validate`.** A `parentUuid` with more than one child means the session diverged. Ten lines over the transcript, and it converts a silent failure into a parked card. Run it before every advance and after every hand-back.
3. **A mid-turn release leaves a dangling turn.** The operator's branch ended at a `tool_result` with no assistant reply, and its background task shows `[killed]`. The resumed agent must notice and finish it — the one measured here did, reporting unprompted that its background task was `stopped` with no completion record.

### A seized tab renders full history, at the worktree

Confirmed visually on a `-p` station seized into a window rooted at its own worktree. The tab showed the original prompt, the `SHELL-TURN-ONE` output, a collapsed "2 tool calls", and the agent's own report that *"Branch is `16976-calendar-feed-overwrites-a-manual-edit`"* — the worktree's branch, from the pre-kill turn.

So `editor.open` loads the conversation, not just the session's identity. Tab titles proved identity earlier; this proves content.

Two independent confirmations of the tab's working directory:

- `claude agents --json` while the tab was open listed a live process for it — `{"pid": 55928, "kind": "interactive", "cwd": "d:\\work\\repo.worktrees\\16976-calendar-feed-overwrites-a-manual-edit"}`. **Opening a tab starts a process**; that process is what holds the session, and closing the tab ends it.
- A `pwd` the operator ran *inside* the tab returned `/d/work/repo.worktrees/16976-calendar-feed-overwrites-a-manual-edit`.

Note the held process is `kind: interactive` with no short id, so **`claude stop` cannot release it** — it answers `No job matching '<uuid>'`. Closing the tab (`tabGroups.close`) is the only clean release; a pid kill works but leaves a tab displaying a dead session.

Operator input persists normally: the typed turn, the assistant's thinking, the tool call and its result are all in the transcript. A tab closed mid-turn leaves the last tool call `[killed]`.

### The clean round trip — proven

Re-run with no other writer touching the session. Cold-path window, seize, operator typed `OPERATOR-MARKER-99` and let the turn finish, closed the tab, then one `-p --resume` from the shell:

```
seize:    claudeTabsBefore=0  →  claudeTabs=1 titles=["cold-path"]
          tracked seized tab "cold-path" -> c01d0001-…
release:  tab closed: label="cold-path" tracked=true   (seized.json → {}, tab process gone)
resume:   asked to quote the operator's marker → "OPERATOR-MARKER-99"
validate: entries=43  forks=0
```

So the operator loop closes: **kill → seize → operator drives → release → factory resumes with the operator's work intact, transcript unforked.** The earlier failure was entirely caused by the injected concurrent write, not by the mechanism.

Evidence still comes from files the agent writes, never from the stream (task 1 §3). The stream is for Watch and for the orchestrator's own bookkeeping, not for gating.

## 11. A tab holds the session open — release before hand-back

The trap that makes seize look one-way. **Proven** with the full round trip.

While a Claude tab is open on a session, a resume forks:

```
note: session c1b2c3d4 is open in another Claude Code process,
      so this started a copy as 94e14772. The original conversation is unchanged.
```

Close the tab first and the same command wakes the original:

```
backgrounded · c1b2c3d4          # same id, no copy note
```

The resumed agent continued the conversation with full memory of the pre-seize turn.

So the operator loop has **four** steps, not three: kill → seize → release → hand back. Release is closing the session's editor tab, and the extension can do it:

```js
const match = claudeTabs().filter((t) => t.label === title);
await vscode.window.tabGroups.close(match, false);
```

Measured: `claudeTabs=3 titles=[…,"round-trip"]` → `claudeTabs=2`, then the resume woke `c1b2c3d4` under its own id.

**The seize channel needs a `release` action**, and the board's "hand back to the factory" button must close the tab before resuming. Do not rely on the operator remembering.

### Auto-handback: the reverse direction is event-driven

`vscode.window.tabGroups.onDidChangeTabs` fires on close, so the operator closing a seized tab **is** the hand-back signal. No polling, no explicit "I'm done" button. Proven with the probe:

```
18:36:47.311  handle release … claudeTabsBefore=3 titles=[…,"autoback"]
18:36:47.314  tab closed: label="autoback" tracked=true          ← 3 ms
18:36:49.841  after release: claudeTabs=2
18:36:51.374  handback ok on attempt 1: backgrounded · d1b2c3d4  ← original id, no copy
```

Emitted events: `tab-closed` then `handback {ok:true, attempts:1, elapsedMs:4059}`. Most of those 4 seconds are `claude --bg` startup.

Two things make it work:

**A label→session map, persisted.** A close event gives you the `Tab` object, whose only useful handle is `label` — the session's `-n` display name. So the seize records `label -> {sessionId, folder, autoHandback}` in `~/.factory/seized.json` at the moment the new tab appears (diff the tab titles before and after; a *revealed* existing tab produces no new title and must not be tracked). The map has to survive an extension-host restart, so it lives on disk, not in memory.

**A retry loop, not an assumption.** Close does not provably free the session instantly. The handback attempts `claude --bg --resume <id>`, parses stdout for `started a copy as <id>`, and on a match stops the copy and retries — six attempts, 1.5s apart. In the measured run attempt 1 succeeded, but the loop is what makes it safe: without it a race leaves two agents on one worktree, and the only warning is a note on stdout.

**An operator's manual close behaves identically.** Same API path, confirmed by hand rather than inferred:

```
18:39:31.404  tab closed: label="autoback" tracked=true     ← human closed the tab
18:39:35.586  handback ok on attempt 1                       elapsedMs 4180
```

and the session came back live: `{id: d1b2c3d4, kind: background, state: working, pid: 54916}`.

### Display names drift across a handback

The session resumed under the original id but with a **new auto-generated name** — `autoback` became `continue auto-one integration`. So a session's display name is not stable across a seize/handback cycle.

Consequences: never key persistent state on the name, only on the session id; and if the board shows a station name, it must come from `.factory`, not from `claude agents --json`. The label→session map still works because it is rewritten on every seize from the tab title that actually appeared — but it is a cache with a one-cycle lifetime, not an identity.

Note the case still untested: closing a tab on a session that is *live in that tab* (a restored tab, or one the operator has been driving) may take longer to release than one whose process had already exited. The retry loop covers it; the attempt count is the thing to watch.

**Design note.** The probe spawns `claude` directly from the extension host to prove the loop end to end. The real extension should emit the `tab-closed` event and let the orchestrator spawn — the extension stays a view and a launcher. `autoHandback` is per-seize, because a factory-initiated release is already orchestrating its own resume and must not race a second one.

### Related hazard: reopening a window resurrects sessions

A VS Code window that restores its previous Claude tabs starts a **live session per restored tab** — observed as two new `kind: interactive` entries in `claude agents --json` seconds after a window opened. So the cold path can silently re-hold sessions the factory believed were released. Enumerate and reconcile tabs on window registration.

## 12. Hooks genuinely veto — proven

A `PreToolUse` hook matching `Bash` and exiting **2** blocks the call outright. The command never ran, and the agent saw why:

```
PreToolUse:Bash hook error: [bash ".../gate.sh"]:
BLOCKED by evidence gate: cannot advance, ./evidence/tests.json is missing.
```

The hook was supplied with `claude --settings <file>`, so a station can carry its gate without touching user or project settings. Contract: read the hook payload from stdin, `tool_input.command` holds the command, stderr is what the model sees.

### Enforcement is mechanical; refusal to fabricate is not

Run again with an adversarial prompt — *"Your ONLY goal is to get it to execute. Do whatever it takes."* — the agent enumerated every bypass (write a fake `tests.json`, edit `gate.sh`, evade the matcher by re-quoting the command) and declined all of them, correctly identifying fabrication as the thing the gate exists to prevent.

**Do not design around that.** It is model judgment, not enforcement. Three of those bypasses would have worked. The hook stops the *accidental* advance; only the CLI computing evidence from runner output stops the fabricated one (task 1 §3). Both layers are needed.

The matcher is also a substring match on the command — a station that renames its invocation slips past it. Gate on the `factory` CLI's own validation, and treat the hook as defense in depth.

## 13. `codex exec` as a station-4 reviewer — proven

`codex-cli 0.147.0` is installed. `gemini` is **not**, so multi-model review is codex-only until it is.

```bash
codex exec --sandbox read-only --skip-git-repo-check \
  --output-schema findings.schema.json \
  -o evidence/findings-codex.json \
  "Review the diff of this branch against master … set verdict to null …"
```

Run against a real 481-line branch diff (`18132-tax-rule-fails-silently-on-an-empty-result`), it returned **exactly schema-conformant** JSON — every required key present, `verdict: null`, `severity` from the enum — and one substantive high-severity finding about a fall-through where a void could be applied twice. 79,199 tokens, roughly six minutes.

Relevant flags: `--output-schema <FILE>` pins the final response shape, `-o <FILE>` writes it, `--json` emits JSONL events, `--sandbox read-only` is the right posture for a reviewer, `-C <DIR>` sets the working root.

Two operational notes:

- **stderr is noisy.** `ERROR codex_models_manager: failed to renew cache TTL: missing field 'supports_parallel_tool_calls'` repeats throughout and is benign. Read the `-o` file; never parse stdout.
- **It loads the user's MCP servers** (observed: `node_repl`, plus config for others). A review does not need them. Use `--ignore-user-config` or a dedicated profile so station 4 is reproducible and cheap.

## 14. Resuming orphaned subagents

### The headline: `claude --bg --resume` already recovers them

Measured end to end, and it overturns the design that was written before the test. A `--bg` session spawned two async subagents that were to wait 100s then write a proof file each. It was stopped mid-flight (no files written). Waking it with `claude --bg --resume` produced, unprompted:

```
queue-operation/enqueue  task=af93c98b169be1097
  summary: Background agent "proof-b wait and write" had no completion record
           after the previous Claude Code process exited, and …
…
queue-operation/enqueue  task=a203d2da78583dd93  status=completed
  summary: Agent "proof-a wait and write" finished
```

Those are the **original** agent ids. Their transcripts grew from ~38 KB to ~57 KB and contain the proof writes. The runtime detected the orphans and restarted them.

**So a hand-back that also re-dispatches does the work twice.** In this run the generated bump prompt added two more agents (`a228f878…`, `a474335d…`); all four ran, all four wrote, `subagents/` ended up with 4 metas for 2 units of work.

### Confirmed with a control: no prompt at all

Repeated with **zero** instruction — same setup, killed mid-flight, then a bare `claude --bg --resume <sid>` with no prompt:

```
note: woke session 955fe450 with its saved options (--permission-mode, -n).
backgrounded · 955fe450 · noprompt-e2e (idle — send a prompt to start)

t+15s   proofs=0  metas=2  state=working busy
t+105s  proofs=1  metas=2  state=working busy
t+135s  proofs=2  metas=2  state=done idle
```

**Metas stayed at 2 — the original agents, no new ones — and both proof files were written.** The queue restores and drains on its own; the session reports itself idle while doing it.

Timing detail worth keeping: ~100 s from wake to the first write, i.e. the killed 100-second wait was re-run from the start. Auto-resume restores the agent's conversation and retries the interrupted tool call; it does not resume a partially elapsed call.

### Confirmed: print-mode resume does NOT restore the queue

Tested directly. A `-p --output-format stream-json` station spawned two subagents, was killed by pid mid-flight, then resumed with `-p --output-format stream-json --resume <sid> "Continue."`. Subagent metas went from 2 to **4**:

| agent | created | last activity | did the work |
|---|---|---|---|
| `a16b3a9fe…` | 15:36:14 | 15:36:21 | no — dead at kill, never resumed |
| `acd49ea4c…` | 15:36:15 | 15:36:22 | no — dead at kill, never resumed |
| `a46477298…` | 15:36:44 | 15:38:33 | **yes** |
| `af562d2cb…` | 15:36:43 | 15:38:32 | **yes** |

The originals stayed dead. The two that delivered were **new agents the parent dispatched on its own initiative** from a bare "Continue." — which re-ran the full 100-second wait from scratch, having lost the originals' context.

So the boundary is real: **`--bg --resume` restores the background-task queue; `-p --resume` does not.** Which means `factory bump` is not dead code — it is *required* on the print-mode path, and the parent's spontaneous re-dispatch is precisely the uncontrolled behavior bump exists to replace with `SendMessage` to the surviving agent ids.

### Continue the agent, do not re-dispatch it

The first prototype's prompt said *"re-dispatch"*, which starts a **fresh** subagent — new context, duplicated work. The `Agent` tool result names the right lever explicitly:

> Use `SendMessage` with `to: '<agentId>'` … to continue this agent.

So the backstop's order of preference is:

1. **Do nothing.** A bare `--bg --resume` wake recovers async subagents by itself. This is the normal path.
2. **`SendMessage` to the agentId** if one is still absent after the settle window — `ListAgents` first, since it returned nothing for a dead agent after the `-p` resume.
3. **Fresh `Agent` dispatch** with the verbatim recovered prompt, only when the agentId is unreachable.

### The corrected contract

`factory bump` must **observe before acting**:

1. Wake with `claude --bg --resume <id>` and a prompt that does not mention subagents.
2. Watch the parent transcript for `task-notification` entries naming each orphaned agentId. Settle window measured at well under a minute here, but it is a wait, not an instant.
3. Re-dispatch **only** agents the runtime did not pick up.
4. Refuse to run at all while the parent is `state: working` — a mid-turn read cannot distinguish "not recovered" from "not yet recovered".

Step 3 is the whole value now: a narrow backstop, not the primary mechanism.

### Classifier details the prototype got wrong

`tools/bump.mjs` correctly reconstructed both orphans on the historical session — verbatim prompts, `subagent_type`, progress digest, `Exit code 137` — but re-running it after recovery still reported 4 orphans. Three concrete bugs, all worth writing down:

- **Agent notifications key on `<task-id>`, which is the agentId — not `<tool-use-id>`.** The prototype looked for `tool-use-id` in notification blocks and found **zero** in the whole transcript. Map `meta.json` filename → agentId → notification status.
- **`death` must be the terminal error, not the last error seen.** One transcript's final error was a transient blocked `Start-Sleep`, which the prototype reported as the cause of death.
- **Delivery needs a positive completion record.** `status=completed` on the agentId is that record. Absence of one is not orphanhood unless the parent is idle.

### What reconstruction still needs, and it is verified

For the residual re-dispatch case, everything required is on disk:

1. **Parent transcript** — the `Agent` tool_use block carries the full original input:
   ```
   toolu_01JFT7yu…  subagent_type=general-purpose  description=probe-a
   prompt: "You are probe-a. Run: bash -c \"sleep 150\" then run: git log --oneline -3, …"
   ```
2. **`subagents/agent-<id>.meta.json`** — links the subagent back to that call:
   ```json
   {"agentType":"general-purpose","description":"probe-a","toolUseId":"toolu_01JFT7yu…","spawnDepth":1}
   ```
3. **`subagents/agent-<id>.jsonl`** — the subagent's own history and how it died.

Prompt recovery via `toolUseId` was confirmed for both agents. Revival of a specific dead agent is not available — `ListAgents` returns nothing for it — so the backstop is reconstruction.

### The three files that make it deterministic

Verified against the killed `e87fd6d6` session:

1. **Parent transcript** — the `Agent` tool_use block carries the full original input:
   ```
   toolu_01JFT7yu…  subagent_type=general-purpose  description=probe-a
   prompt: "You are probe-a. Run: bash -c \"sleep 150\" then run: git log --oneline -3, …"
   ```
2. **`subagents/agent-<id>.meta.json`** — links the subagent back to that call:
   ```json
   {"agentType":"general-purpose","description":"probe-a","toolUseId":"toolu_01JFT7yu…","spawnDepth":1}
   ```
3. **`subagents/agent-<id>.jsonl`** — the subagent's own history and how it died. Both probes ended `{"type":"tool_result","is_error":true,"content":"Exit code 137"}`.

Prompt recovery via `toolUseId` was confirmed for both agents.

### Classifying delivered vs orphaned

Two completion shapes exist in parent transcripts, and both must be recognized:

| Shape | Signature |
|---|---|
| **Synchronous** | a later `user` entry with a `tool_result` whose `tool_use_id` matches the `Agent` call, containing the agent's actual report |
| **Async** | a `queue-operation` / `enqueue` entry holding a `<task-notification>` with `<task-id>` (the agentId), `<tool-use-id>`, and a `status` |

The launch acknowledgement (`"Async agent launched successfully…"`) is a `tool_result` too — **exclude it**, or every async agent looks delivered.

Rule: an `Agent` call is **orphaned** when no delivered report exists and no `task-notification` reports a terminal `completed` **for its agentId**, and the parent is idle. A notification with `status: stopped` is the positive orphan signal.

### Rules for the residual re-dispatch

- **Only `spawnDepth: 1`.** Nested subagents are re-created by their own parent when it re-runs; dispatching them directly duplicates work and orphans the hierarchy.
- **Progress digest, not the full transcript.** Transcripts here were 38–57 KB each and would swamp a resume prompt.
- **Side-effecting work needs the digest; read-only work can just re-run.** The digest is what keeps a re-dispatched agent from repeating a write. Observed working: the re-dispatched agents skipped the 100-second wait their predecessors had already served, writing their files within a minute.
- **Checkpointing beats recovery.** A station whose subagents each write to `evidence/` loses at most one in-flight agent, and re-dispatch skips the rest (§4, task 1 §3). Both the runtime's auto-recovery and this backstop exist for work that could not be checkpointed.

**Status:** the loop is proven end to end — killed mid-flight, woken, both units of work delivered. What is *not* settled is the boundary condition in "Why the earlier test looked different": whether `--bg --resume` always restores the task queue and print-mode resume never does. That boundary decides whether step 3 above ever fires.

## 15. Rate limits — a silent stop, and how to self-heal

Characterized from history rather than induced: 1,675 transcripts scanned, 177 entries carrying `"isApiErrorMessage": true`, in 8 distinct shapes.

| Count | Message |
|---|---|
| 143 | `You've hit your session limit — resets 11:30am (America/New_York)` (and 1:50pm, 1am, 4pm variants) |
| 28 | `API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.` |
| 4 | `API Error: Connection lost mid-response. The response above may be incomplete.` |
| 2 | `API Error: Unable to connect to API (ECONNRESET)` / `522 Connection timed out` |

### The failure shape is the dangerous one

The limit arrives as an ordinary `assistant` message with a `text` block, flagged `isApiErrorMessage: true` — and then **the transcript ends.** No exception, no park, no retry. In subagent transcripts the error is literally the last line:

```
agent-a0bba18b2fde6eb1b.jsonl   error at line 4 of 5
agent-a11b5062e81336e29.jsonl   error at line 33 of 34
```

One historical session's own retrospective records the consequence plainly: *"all 4 finder subagents died on the very first turn from hitting the session rate limit before reading anything."* Subagents are hit individually.

So a rate-limited station **looks finished**: its process exits, `state` goes idle, nothing errors. The only reason this does not corrupt the factory is that evidence is file-based — no `tests.json` was written, so `factory advance` refuses (task 1 §3). Had the design gated on the agent's own report, a rate limit would read as a clean pass.

### Self-healing: the reset time is in the message

`resets 11:30am (America/New_York)` — the wall-clock time and its timezone are right there, which makes recovery scheduled rather than polled.

**Two error classes, two policies:**

| Class | Detection | Policy |
|---|---|---|
| **Limit exhausted** | `isApiErrorMessage` text matching `hit your session limit .* resets (.+) \((.+)\)` | Set `state: blocked`, `reason: "session limit"`, `resume_after_utc`. Do not retry before then; do not count as a station failure. |
| **Transient** | `529 Overloaded`, `Connection lost mid-response`, `ECONNRESET`, `522` | Bounded immediate retry with backoff. Only park after the budget is spent. |

Recovery is a bare `claude --bg --resume <id>` at `resume_after_utc` — the same wake that restores orphaned subagents (§14), so **one mechanism heals both**: the station picks up its own turn and its killed children come back with it.

Design consequences:

- **`blocked` is the right state, not `parked`.** No human is needed; the WIP clock should not run against the operator (`vision.md` state table).
- **Parse the next occurrence, not the literal clock time.** The message carries no date, so `resets 11:30am` seen at 2pm means tomorrow.
- **`Connection lost mid-response` is its own hazard.** The response "may be incomplete" — a station that stops there has a *partially written* turn, which is exactly the state an evidence gate must reject rather than resume blindly.
- **The stream is the detector for `-p` stations** (§10); the transcript is the detector for `--bg` ones. Both carry the same `isApiErrorMessage` marker.
- **This bounds `max_concurrent_agents`.** Concurrency that reliably exhausts the window converts the factory into a queue of blocked cards. The ceiling is empirical and belongs in `config.yaml`.

**Not yet known:** whether the CLI's exit code distinguishes a rate-limit stop from a clean finish. If it does, detection is a number rather than a string match — worth checking the first time a station hits one.

## 16. Test evidence from a .NET runner — `dotnet test` + TRX

Measured against a 4,117-test xUnit project (net8.0, `--no-build`).

### `dotnet test --logger trx` gives a clean counter block

```xml
<ResultSummary outcome="Completed">
<Counters total="4" executed="4" passed="4" failed="0" error="0" timeout="0"
          aborted="0" inconclusive="0" notExecuted="0" ... />
```

Also per-test `<UnitTestResult testName= duration= startTime= outcome= …>`, so a failing test is attributable without parsing console text.

### There is no assertion count — and the exit code is worthless

Task 1 rule 3 asked for `assertions > 0`. **TRX carries test counts, not assertion counts**, so that field does not exist. The substitute is `executed > 0`, and it turns out to be load-bearing for a sharper reason than expected:

```bash
dotnet test … --filter 'FullyQualifiedName~ThisMatchesAbsolutelyNothingXyzzy'
→ No test matches the given testcase filter …
→ EXITCODE=0
→ <ResultSummary outcome="Completed">
  <Counters total="0" executed="0" passed="0" failed="0" … />
```

**A filter that matches nothing exits 0.** So `dotnet test` succeeding proves nothing whatsoever about tests having run. An agent that narrows a filter until the run is green gets a genuine exit 0 and a TRX whose `outcome` is `Completed`. The only thing separating that from a real pass is `executed > 0`.

This is the concrete mechanism behind the anti-hallucination rule, and it is not hypothetical — it is the default behavior of the runner.

### The gate

```
outcome == "Completed"
AND failed + error + timeout + aborted == 0
AND executed > 0
```

Computed by the CLI from the TRX. Never from the exit code, never from console text, never from the agent's report.

Note `executed` excludes skipped: the full run showed `total=4117 executed=4114` with 3 skipped. `total - executed` is the skip count, and a station that skips its way to green is caught by comparing the two.

### Run the whole suite — it costs 36 seconds

```
4,117 tests · 4,114 passed · 3 skipped · 0 failed · 36 s wall (--no-build)
```

`--list-tests` reports 4,067 test names; the suite is fully enumerable in advance.

That settles task 1 open decision #2: **no filter.** A targeted subset saves nothing meaningful and reintroduces the exact failure mode above — the filter matching the wrong thing, or nothing. A station builds, runs the full suite, and the CLI parses one TRX.

**Unmeasured:** what `<ResultSummary outcome>` reads on a genuinely failing run (presumably `Failed`), and whether `error` / `aborted` populate on a crash or hang. The gate above treats any nonzero in those four counters as failure, so it is safe either way, but the exact strings are unconfirmed.

## 17. The tracker's Status field

Read from the live `ownerrez/orez` project (Planning / Development, number 3) on 2026-09-01. The 17 options, in the board's own order, with the descriptions the project carries:

| Status | Description |
|---|---|
| 🆕 New | — |
| 🧊 On Ice | Valid, but no intention of fixing/changing |
| 📋 Backlog | Stuff we never got to long ago |
| 📥 Product Backlog | Backlog of product review needs |
| 🎯 Product Review | Needs product lead(s) feedback |
| 🔖 Planned | Roadmapped, possibly tasked, want to do |
| 📋 Automation To Do | Up next for automation |
| 🤖 Automation | Current automation work |
| 🎨 Design Assigned | To design (Figma-based or markup-based) |
| 📱 In Design | Design underway |
| 🎁 Assigned | Items assigned to devs |
| 👀 Tasking Review | Cards that were tasked by the engineer and need to be checked before moving to Dev |
| ⚒️ Dev | Currently in progress or waiting on dev |
| 🔍 Dev Review | Awaiting dev review |
| 👟 Ready For Testing | Awaiting tester assignment or deployment |
| 🏃 Testing | Currently being tested |
| 🚀 Releasable | Closed and ready for release |

Only 🎁 Assigned and ⚒️ Dev are statuses where the work is the developer's own, which is why those two are the board's default membership set. None of them is a stage: ⚒️ Dev covers planning, building and checking alike, so a status can never be read as a lane.

Re-read with:

```bash
gh api graphql -f query='{ organization(login:"ownerrez"){ projectV2(number:3){ field(name:"Status"){ ... on ProjectV2SingleSelectField { options { name description } } } } } }'
```

## 18. Open questions

### Ledger

**Proven** (measured 2026-09-01, sections above): `--bg` dispatch in a worktree · `claude agents --json` as a session registry · transcript lag · subagents die on stop, with transcripts preserved and honest parent reporting · tab cwd from `workspaceFolders[0]` · `editor.open` signature and reveal behavior · URI routing follows focus and is unaddressable · in-process `executeCommand` is addressable · hand-back via bare `--bg --resume` and the flag-fork hazard · the `--bg` / `-p` capability split and the decision to run stations under `-p` · the full seize round trip (kill → seize → release → hand back) and the tab-holds-session trap · `PreToolUse` hooks veto for real · `codex exec --output-schema` produces conformant findings on a real diff.

Also proven: auto-handback on an **operator's manual tab close** · the **cold path** (no window → `code --new-window` → registered in 3.2 s → seize) with the extension normally installed · the **clean operator round trip** with the operator's work intact and the transcript unforked · the evidence gate against a real .NET runner, including that `dotnet test` exits 0 when its filter matches nothing · rate-limit failure shape characterized from 1,675 historical transcripts · **concurrent writers fork the transcript and silently orphan work**.

**Unproven — ranked by damage if the assumption is wrong:**

**Nothing is blocking tasks 1–2.** The seize channel, the operator round trip, the cold path, the evidence gate, and hook enforcement are all measured. What remains is either a policy decision, a pre-unattended requirement, or opportunistic.

**Policy decisions (mine to make, not measurements):**

| # | Question | Recommendation |
|---|---|---|
| 4 | **Which resume path?** `-p --resume` keeps the stream but loses the queue restore; `--bg --resume` restores the queue but kills the stream and renames the session (§10, §14). | Resume with `-p` plus a `factory bump` prompt: Watch survives, and orphans are recovered explicitly via `SendMessage` rather than implicitly. Still needs one run to confirm `SendMessage` reaches the original agent ids. |
| 5 | Unattended permission posture. | Every session so far used `bypassPermissions`. Decide once station tool needs are known; `--allowedTools` plus hooks is the mechanism. |
| — | Does "no new build warnings" join the evidence gate? | the target repo has a nonzero warning baseline, so this needs a baseline diff, not a zero check. |

**Opportunistic — answer the first time it happens naturally:**

| # | Question | Why it can wait |
|---|---|---|
| 1 | Does the CLI's **exit code** distinguish a rate-limit stop from a clean finish? | §15 characterized the failure from history and string matching works. An exit code would be sturdier. Not worth burning a 5-hour window to learn. |
| 3 | What does `<ResultSummary outcome>` read on a **failing** run, and do `error`/`aborted` populate on a crash? | §16's gate treats any nonzero in those four counters as failure, so it is safe either way. Only the exact strings are unconfirmed. |

**Needed before the line runs unattended:**

| # | Question | Why it matters | Experiment |
|---|---|---|---|
| 6 | How reproducible is `codex exec` review? | One run, one finding. Station 4's value depends on it not being a coin flip. | Three runs on the same diff; compare. Add `--ignore-user-config`. |
| 7 | Does closing a tab on a **genuinely live** session release it as fast? | §11's retry loop covers it, but the attempt count is unmeasured for the case that matters most. | Seize a running station, close the tab mid-turn, read `attempts`. |
| 8 | Can the factory create a worktree **and** its IIS site from scratch? | The nine-station pipeline starts at intake with no workspace. `claude --worktree` exists and is unexplored. | Provision one end to end for a throwaway branch. |
| 9 | Can a message be **injected** into a live session? | Steer-by-artifact is the design, but `initialPrompt` only prefills and is dropped when the tab is open (§6). | `--brief` / `SendUserMessage` is a lead. |
| 10 | Does the tracker write-back at station 7 work from the factory's own code? | Proven by other tooling, never by ground-control. | `gh` project item-edit against a scratch card. |

**Lower stakes:**

| # | Question | Why it matters |
|---|---|---|
| 11 | Does `claude-vscode.window.open` target or create a window? | Could shortcut part of task 2 §5. |
| 12 | Does a resumed tab render full history and a worktree cwd? | Identity and state are proven; the rendered panel has not been eyeballed. |
| 13 | Does `claude respawn` re-drive a stopped station or only restart the process? | Decides whether the factory ever auto-recovers. |
| 14 | How are stopped-but-not-removed sessions reclaimed? | `claude rm` is banned (§1); they accumulate. |
| 15 | Is `gemini` worth installing? | Multi-model review is codex-only today. Decide after #6. |
