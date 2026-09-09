# Mechanisms and experiments

This document records experiments and source inspections relevant to Ground Control. Some support implemented features; others establish options or constraints for future work. A successful experiment is not a claim that the product implements it. Product scope is in the [requirements](prd.md), and current use is described in [architecture](architecture.md).

Record IDs retain the experiment identifiers M1–M51, including M3b and M3c, independently of topic order. Dates and versions belong to the evidence, not to this document's editing date. The baseline for undated early records is 2026-09-01 with the installed Claude CLI and `anthropic.claude-code` 2.1.252. An exact CLI version was not recorded for every experiment.

Code references use these M IDs rather than the former numbered sections. A record grouped under a topic keeps its original ID. Source inspections of Ground Control distinguish current implementation from the external experiment; they do not re-verify the measured CLI or editor version.

Evidence is identified as runtime observation, historical-file analysis, or source inspection. Inferences and remaining questions are stated separately. Undocumented formats, command signatures, hooks, UI markup, and timing are **version-fragile**; recheck the relevant record after upgrading its dependency. Performance figures describe this machine and sample, not guarantees.

## Claude Code

### Claude roster and session identity

**Record M2. Runtime, 2026-09-01. Used by live-session discovery.**

`claude agents --json` lists interactive and background sessions across checkouts without a TTY. Recorded fields included the following (path and display name generalized):

```json
{"pid":65380,"id":"9d937cb5","cwd":"d:\\work\\repo","kind":"background",
 "startedAt":1788284040892,"sessionId":"9d937cb5-933e-45de-8514-e1bff6e447ba",
 "name":"dispatch-probe","status":"busy","state":"working"}
```

`--all` includes stopped/exited sessions; `--cwd <path>` filters by directory. Three reads returned 17 sessions and 3,450 bytes in 218, 217, and 212 ms. This cost supports a slower roster poll with hooks for activity changes.

Interactive entries often omit short ID, `status`, and `state`. Background entries have additional lifecycle words; M33 below records that completed background entries can remain on the ordinary roster. Thus roster membership is the discovery source, but must be interpreted with agent lifecycle fields. It is not universally proof of an active process doing work.

### Claude transcripts and titles

**Records M3 and M3b. Runtime/files, 2026-09-01–02. Used by metadata readers.**

Transcripts are buffered: two subagents were running before their parent transcript contained the launch call. A live transcript's last write was more than nine hours old. Neither a write timestamp nor a missing recent entry establishes liveness.

```text
~/.claude/projects/<project-slug>/<session-id>.jsonl
~/.claude/projects/<project-slug>/<session-id>/subagents/agent-<id>.jsonl
~/.claude/projects/<project-slug>/<session-id>/subagents/agent-<id>.meta.json
```

The project slug replaces each non-alphanumeric path character with `-`, without collapsing runs. A probe containing space, `_`, `+`, and `~` confirmed each replacement. Preserve directory casing from the actual listing: recorded cwd drive-letter case can differ from the directory originally created. NTFS can conceal a faulty case-sensitive lookup.

Transcripts were created at the first user turn, not process startup. Four of 15 live sessions had none and were unprompted editor tabs. Resumed sessions write the original transcript, whose mtime may predate the new process. `.claude/session-env/<id>` exists before prompting and cannot distinguish these cases. Product filtering therefore requires absence of transcript, activity, and agent status together.

The CLI's `name` is often a directory-derived label, not the session title. Transcript title records are:

```json
{"type":"ai-title","aiTitle":"automatic title","sessionId":"..."}
{"type":"custom-title","customTitle":"manual title","sessionId":"..."}
```

Prefer the last manual title over the last automatic title. Across 486 transcripts, automatic titles could follow manual titles; choosing the last record of either kind would overwrite the manual choice. Three of nine live transcripts had no title, including one 1.7 MB file.

Of six live transcripts with titles, five had a title within the final 32 kB; the sixth was 2.2 MB from the end. The live reader's 64 kB tail is intentionally incomplete and falls back to `name`. Tolerate an incomplete first line and check a title record's session ID.

Evidence and reproduction: [Claude fixtures](../packages/agent-claude/test/fixtures/), their recorder, and `transcripts.test.ts`. The unusual-character path was a separate probe, not a surviving machine fixture.

### Claude historical discovery

**Record M3c. Files/runtime, 2026-09-05. Used by history and resume.**

A metadata probe found 108 project entries and 558 top-level UUID transcripts. Parent records contained `sessionId`, `cwd`, `gitBranch`, and `type`; `isSidechain` identified sidechain records. Nested subagent files were outside the scan.

Reading the first and last 64 KiB found 557 usable sessions, 232 with both an issue link and repository identity. Initial scan: 1,080 ms. Cached scan: 73 ms. Metadata outside those bounds remains unavailable. Match saved branches/directories and verified origin repositories; use the live roster independently to establish inactivity.

The inspected SDK 0.3.261 `listSessions()` returned no sessions from an empty `CLAUDE_CONFIG_DIR` in 72 ms including import. It had no per-call home argument and converted some discovery failures into empty results. Injected readers avoid process-global configuration and preserve failure classification.

An integration probe rendered/clicked a saved row, sent its ID, and invoked `claude-vscode.primaryEditor.open`. The command handler was a surrogate: it established wiring, not actual Claude transcript loading. It also refused unreadable liveness, an already-active session, and an expired route. A direct `Code.exe <appRoot>/out/cli.js --version` call succeeded in Node mode without a shell.

Reproduction assets include `history-records.json` and `record-history.mjs` under the Claude fixtures. Actual transcript loading was exercised in the opening and takeover experiments below.

### Claude activity hooks

**Record M20. Source inspection and runtime, 2026-09-02, CLI 2.1.258. Used by activity tracking.**

The inspected schemas defined 33 events:

```text
PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Notification,
UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, Stop, StopFailure,
SubagentStart, SubagentStop, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch,
PermissionRequest, PermissionDenied, Setup, TeammateIdle, TaskCreated, TaskCompleted,
Elicitation, ElicitationResult, ConfigChange, WorktreeCreate, WorktreeRemove,
InstructionsLoaded, CwdChanged, FileChanged, DirectoryAdded, MessageDisplay
```

Common fields are `session_id`, `transcript_path`, and `cwd`; optional fields include `prompt_id`, `permission_mode`, `agent_id`, and `agent_type`. Use `agent_id`, not `agent_type`, to identify subagent-originated events. Recorded subagent hooks carried the parent's session ID, so treating them as parent activity would clear legitimate parent waiting state.

| Signal | Observed or inspected meaning |
|---|---|
| `PostToolBatch` | Once after the entire batch resolves, before the next model request; cheaper than a hook per tool |
| `SessionStart.source` | `startup`, `resume`, `clear`, `compact`, `fork`; compact can occur mid-turn |
| `Stop.background_tasks` | Distinguishes a completed turn from waiting for background work |
| `SessionEnd.reason` | `clear`, `resume`, `logout`, `prompt_input_exit`, `other` |
| `Notification` | Includes completion, idle reminders, authentication, and permission/input requests; not uniformly waiting |
| `PermissionDenied` | Human denial; a settings deny rule instead produced PreToolUse and PostToolBatch |

Notification types found in the binary were `permission_prompt`, `worker_permission_prompt`, `agent_needs_input`, `idle_prompt`, `agent_completed`, `elicitation_complete`, `elicitation_response`, `auth_success`, `push_notification`, and `computer_use_exit`.

Matchers inspect different fields:

| Events | Matcher input |
|---|---|
| Five tool/permission events | `tool_name` |
| Notification | `notification_type` |
| SessionStart / SessionEnd | `source` / `reason` |
| SubagentStop | `agent_type` |
| Stop, PostToolBatch, UserPromptSubmit | No matcher input; matcher ignored |

Source inspection found comma-separated alternation only for the five tool events. Other events accept `|`; commas fall through to a regex that typically matches none of the intended values. Pipe alternation is the portable choice across this event set. End-to-end matching on every event was not separately measured.

Hooks accept direct execution through `command` plus `args`, or shell execution when `args` is absent. Other fields include `async`, timeout in seconds, `statusMessage`, `once`, `if`, `shell`, and `asyncRewake`. `async: true` is specified as nonblocking; stdin delivery across every asynchronous event remains a verification item.

The recorded board install used ten events: SessionStart, UserPromptSubmit, PostToolBatch, PermissionRequest, PermissionDenied, PreToolUse for `AskUserQuestion|ExitPlanMode`, Elicitation, selected Notification types, Stop, and SessionEnd. Entries ran the stable home `hook.mjs` through `node`, with argument array, `async: true`, and timeout 5 seconds. Subagent events are ignored.

The marker retains event fields plus a turn anchor:

```json
{"v":1,"sessionId":"...","event":"PermissionRequest","at":1788358738179,
 "turnAt":1788358701004,"cwd":"d:/x","notificationType":null,"source":null,
 "toolName":"Bash","reason":null,"backgroundTasks":0}
```

`at` is the hook writer's timestamp, not a source-provided event sequence. `turnAt` begins at UserPromptSubmit, survives events within the turn, and clears at completion or a new non-compact session start. Work resumed without a prompt uses its first event. Phase mapping belongs in `phase.ts`; the writer only records event data and maintains the turn anchor.

Asynchronous writers can arrive out of order. Comparing marker timestamps limits delayed writes but cannot recover source order when an earlier event starts its hook later. No payload sequence/timestamp was found. Turn-start and turn-end races can temporarily retain or clear the wrong anchor. A 60-second future tolerance bounds clock-step behavior; it does not solve event ordering.

SessionStart establishes existence, not idle activity; compact is the exception because it occurs during work. Missing events do not turn running into idle. A killed process emits no SessionEnd.

The writer must exit 0 and emit no stdout, including on malformed input or filesystem failure. On these hooks, exit 2 can deny/block work and stdout can be interpreted as a decision or injected content.

An absolute `createFileSystemWatcher` outside the workspace was exercised in a development host: deleting a session marker removed its card. The recorded first-prompt/end path took roughly a third of a second; other events were not separately timed. This is evidence for the signal, not the current hub watcher implementation. Re-arming and directory-retention decisions are covered under filesystem observations below.

### Claude background dispatch and attach

**Records M1 and M33. Runtime/source, 2026-09-01 and 2026-09-05–08; later probes CLI 2.1.261. Used by actions.**

```text
claude --bg --permission-mode <mode> -n <name> <prompt>
stdout: backgrounded · 46af2ac8 · <name>
stderr: Starting background service…
```

The eight-character ID is a prefix of `sessionId` on the next roster read. `--bg` warns and ignores `--session-id`; the caller cannot select the new ID. Parse stdout separately from startup diagnostics. The printed format is undocumented.

A leading slash in the prompt invokes a command/skill. An unknown slash command still starts an idle session, writing warnings without a user turn. Successful dispatch is not successful work. Git Bash rewrote `/gc-nonexistent-probe hello` into a Git-install path; pass arguments without shell/MSYS rewriting. The CLI runner refuses batch shims rather than silently adding a shell.

Permission probes requested Write and Bash in a scratch repository:

| Mode | Result |
|---|---|
| `manual` | Waited for permission |
| `acceptEdits` | Bash still required permission |
| `dontAsk` | Bash denied |
| `auto` | Hash, Git status and Git push commands ran without a prompt |
| `bypassPermissions` | Same operations ran with permission checks bypassed |
| `plan` | Not probed in this experiment |

Bare `--bg` recorded mode `auto`. These results justify the action default for the measured job, not a guarantee that every tool will run under `auto`.

Background `Write`/`Edit` in the main checkout was blocked by `worktree.bgIsolation`, including under bypassPermissions. A linked worktree was accepted. Passing `--settings '{"worktree":{"bgIsolation":"none"}}'` allowed writes in the main checkout without creating a worktree. Bash was not blocked by this guard. Source inspection found restrictive repository/managed values can override `none`; that merge behavior was not reproduced in the scratch repository.

Open a live background job with `claude attach <short-id>` in a TTY. Leaving the attachment keeps the job running. `claude logs` returns ANSI terminal frames, not structured events; one recorded result was 94.5 kB. `attach` and `logs` reject interactive sessions, whether given short or full IDs.

A live background session refused `-p --resume`, directing the caller to attach or stop first. An editor resume hit the same refusal. This differs from resuming a stopped background job and from print-mode concurrent-writer experiments.

`status` is `idle|busy|waiting`; waiting can include `waitingFor`. `state` is `working|blocked|done|stopped`; blocked derives from reply/approval needs. A one-turn probe reported done, while a run ending with a choice reported blocked. Completed entries can remain on the ordinary roster; interpret lifecycle data explicitly.

`claude stop <short-id>` printed `stopped <id>` and removed the entry. Do not use `claude rm` to stop work: its help permits deleting the associated worktree. Other available job commands include `respawn`, whose recovery semantics remain unmeasured.

### Claude print mode and streaming

**Record M10. Runtime, baseline 2026-09-01. Experiment for detailed activity and workflow control.**

`-p --output-format stream-json --verbose` produced incremental NDJSON: initialization, hook events, assistant/user records, tool use/results, thinking, rate-limit events, background-task events, and final results. It wrote a normal transcript. `--bg` did not provide the same stream.

| Capability | Background job | Print-mode stream |
|---|---|---|
| Roster entry | Yes | Yes |
| Short ID and background status | Yes | No |
| CLI `stop` / `attach` | Yes | No; process termination required |
| Structured live output | No | Yes |
| Structured final result | Not through this background path | Yes |
| Resume after stop | Background or editor route | Print-mode resume retained ID and stream |

A seven-step probe with two 20-second waits emitted tool start/result records at the expected times. Pending tool-use IDs without results identified current work; `input.description` supplied a readable label. Sampling was every two seconds, so subsecond stream latency was not measured. Forty-five read samples while the writer held the file open produced no locking or partial-line failures.

A resumed print-mode session stayed alive 120 seconds waiting for two asynchronous subagents before emitting its final result. Print-mode resume did not restore the old subagent queue in M14's experiment; the parent launched replacements instead.

The print-mode path can support detailed activity in future workflow execution. Its process control, queue recovery, and duplicate-writer risks differ from the background dispatch currently used by card actions. No choice of future workflow execution mode is implied here.

### Tool-free classification

**Record M31. Runtime, 2026-09-05; exact installed CLI version not recorded in this study. Used by triage.**

Run in the hub directory, with prompt text on stdin:

```text
claude -p --output-format json --json-schema <schema>
  --no-session-persistence --setting-sources "" --session-id <uuid>
  --strict-mcp-config --tools "" --system-prompt <classifier>
  --model claude-sonnet-5
```

Across four probes, 2,001 transcript files and 1,046 session-env entries remained unchanged, with no classifier marker. The process still appeared on the CLI roster without transcript, phase, or status, allowing the adapter's normal unprompted filter to exclude it. Model text belongs on stdin because Windows command lines are limited to 32,767 characters. `--tools` is variadic; follow its empty value with another flag.

The JSON result exposed parsed `structured_output`, with equivalent JSON text in `result`.

| Haiku invocation sample | Input tokens | Wall time | Recorded list-price estimate |
|---|---:|---:|---:|
| Restricted, default instructions/tools | 55,175 | 11.8 s | $0.064 |
| No tools, explicit system prompt | 2,243 | 5.2 s | $0.005 |
| Also no settings, stdin and isolated cwd | 1,007 | 3.1 s | $0.003 |

These are historical estimates, not current pricing. Ten real-card Haiku runs took 18.8–102 seconds. Seven Sonnet runs took 2.5, 4.0, 5.1, 5.8, 7.3, 7.4, and 23.8 seconds; six comparable Haiku runs took 37.4–84 seconds. The developer judged all seven Sonnet classifications correct and one of six Haiku results wrong. This is a small local sample, not a quality benchmark.

GitHub context reads took 357–604 ms. The recorded total budget was 180 seconds for fetch plus classification. Full model names avoid changes in alias resolution; `haiku` resolved locally but was not among the aliases named by that help output.

An inline `... on User { name }` fragment on GitHub's `Actor` fields returned profile names without extra requests; bots lacked that field. Login is the fallback.

## Codex

### Codex roster and history

**Records M39 and M42. Runtime/files, 2026-09-07, CLI 0.153.0 on Windows 11. Used by discovery.**

No tested command supplied a machine-wide live roster:

- `codex agents` required `--remote` on Windows and had no JSON mode.
- `app-server daemon` lifecycle commands were Unix-only.
- `app-server proxy` failed without the daemon control socket.
- A separate stdio app-server's `thread/loaded/list` was empty while editor threads ran.
- `thread/list` returned saved threads as `notLoaded`, including threads active in another server.

App-server initialization used `clientInfo`, experimental capabilities, then an `initialized` notification. The server exposed `turn/start`, `turn/steer`, `turn/interrupt`, resume/fork/archive, hook queries, and approval requests. These apply to threads that server owns; protocol availability does not provide cross-server control.

`thread/list` provided richer history metadata but required a process and handshake. The implemented reader uses files:

```text
<codex-home>/sessions/YYYY/MM/DD/rollout-<iso>-<session-id>.jsonl
<codex-home>/session_index.jsonl
```

The first rollout `session_meta` record included ID, timestamp, cwd, originator, CLI version, source, and Git commit/branch/repository URL. It measured 8–78 kB because instructions were inline; two of 15 records exceeded 50 kB. An insufficient head-read bound must produce a failure rather than silently discard the thread.

The index contained `{id, thread_name, updated_at}` only for named threads: five entries against twenty rollouts. It is a title source, not a roster. Cwd is inside the rollout, not encoded as a project-directory slug. Codex home follows `CODEX_HOME`, otherwise `.codex` under the user's home.

### Codex hook payloads and process identity

**Record M40. Runtime, 2026-09-07, CLI 0.153.0. Used by activity and roster.**

Twelve events were listed: preToolUse, permissionRequest, postToolUse, preCompact, postCompact, sessionStart, sessionEnd, userPromptSubmit, subagentStart, subagentStop, stop, interrupt. Config keys and payload event names are PascalCase; `hooks/list` reports camelCase.

Common payload fields were `session_id`, `transcript_path`, `cwd`, and `hook_event_name`. Most events added model and permission mode; turn events could include `turn_id`. Event-specific fields included source, prompt, tool name/input/ID, tool response, stop state, last assistant message, and end reason.

An approval produced PreToolUse, PermissionRequest, then PostToolUse after the decision. App-server status concurrently reported `waitingOnApproval`. Observed permission-mode strings were `default` for on-request and `bypassPermissions` for the bypass flag.

No hook payload or environment variable supplied the Codex PID. The command ran through PowerShell, making Codex the writer's grandparent. PowerShell 7's parent-property access cost about 20 ms; CIM cost about 250 ms per hop and also worked on 5.1. The writer caches the discovered PID and only retries discovery on marker-creating lifecycle/prompt events, not every tool event.

Concurrent SessionStart and UserPromptSubmit writers collided during rename. A bounded roughly 200 ms retry and temporary-file cleanup handle this collision. A force-killed app-server left its marker and emitted no end event. Marker presence therefore requires a PID liveness check.

PID reuse remains a limitation: an old marker may match a reused PID until swept. Process creation time could strengthen identity but was not implemented in this reader.

### Codex hook trust

**Record M41. Runtime/source, 2026-09-07–08, CLI 0.153.0 and 0.153.4. Used by installation.**

New hooks were inert until trusted. `hooks/list` reported `key`, `command`, `currentHash`, `trustStatus`, and source path. Trust statuses were managed, untrusted, trusted, and modified. Changing the command invalidated trust.

The trust key contains the hook file, snake-case event, group index, and entry index. Seventeen attempted external hash constructions failed to reproduce an existing trusted hash. Use Codex's returned `currentHash`.

The measured supported exchange was initialize, `hooks/list`, then `config/batchWrite`:

```json
{"keyPath":"hooks.state","mergeStrategy":"upsert",
 "value":{"<hook-key>":{"trusted_hash":"<currentHash>"}}}
```

Upsert preserved existing trust. A 96-line config gained 36 lines without other changes; re-listing reported trusted and a real exec produced prompt/stop hooks. Codex wrote TOML itself. Results were grouped by working directory and used canonical platform path spellings; normalize paths when comparing entries.

Hooks also fired for the VS Code extension's bundled app-server, using the same thread IDs as the index. SessionEnd and Interrupt timeout values were capped at 3 seconds. SessionEnd reported async false, so its work must remain short. Codex takes a shell command string, not Claude's `args` array.

After a real session, `hooks.json` bytes and mtime were unchanged. Extra fields from `hooks/list` were a resolved view, not additions persisted to the file. Ground Control trusts only its own installed commands and leaves other entries unchanged.

### Codex editor resources and windows

**Records M43, M44, M47. Source/runtime, 2026-09-07–08; VS Code 1.136.1, extension 26.901.22334, CLI 0.153.4 for later probes. Used by session opening.**

```js
vscode.commands.executeCommand(
  'vscode.open', vscode.Uri.parse(`openai-codex://route/local/${threadId}`));
```

Thread tabs use `chatgpt.conversationEditor`, not the bundle's generic `chatgpt.panelView`. The resource scheme is `openai-codex`, authority `route`, with `/local/<id>` or `/remote/<id>`. A second open reactivated the same tab. A thread also opened in a window outside its saved cwd.

`vscode.open` resolved and a resource tab appeared even with the extension absent. Verify the expected custom editor view type; a URI-shaped tab alone is insufficient.

In `memento/workbench.parts.editor`, the entry used outer ID `workbench.editors.webviewEditor`; its parsed value contained `providedId`/`viewType: chatgpt.conversationEditor` and a marshalled `editorResource`. Read `editorResource.path`, not `fsPath` or percent-encoded `external`. The tab persisted 47 seconds after reveal, consistent with VS Code's storage cycle.

Sidebar IDs are `chatgpt.sidebarView` and `chatgpt.sidebarSecondaryView`. Their state did not record a thread ID; the measured secondary state was `{}`. Container state only recorded visibility/collapse. The extension exported no API. Direct `vscode://openai.chatgpt/local/<id>` and `/c/<id>` calls remained pending for more than ten minutes without a tab or error.

A window's extension host spawned `codex.exe ... app-server`. The marker PID could be joined to that host's announced listening port. A measured sidebar thread had no editor memento at all but was located by process ancestry. Candidate windows still depended on Claude's IDE lock announcements. Opening a currently displayed sidebar thread as a resource was not independently remeasured; tab idempotence alone does not prove the sidebar transition.

The undocumented router at `\\.\pipe\codex-ipc` (POSIX path `.codex/ipc/ipc.sock`) used uint32LE-length-prefixed JSON. Initialization supplied `clientType` and returned `clientId`. `thread-owner-discovery` sometimes identified a loaded thread, but on a later day returned `no-client-found` for every tested thread, including editor-held ones. It is not a reliable machine roster or general landing guarantee.

`ide-context` matched workspace roots by prefix; parent-folder windows could answer a child-root request and the fastest reply won. Unsolicited stream/client status broadcasts also occurred. Connected probes must answer `client-discovery-request` with `{canHandle:false}` or delay other untargeted requests for ten seconds. These router observations remain useful for future integration, but do not replace the current process join.

### Starting Claude and Codex editor sessions

**Record M51, with M44's runtime start probe. Source inspection 2026-09-08: Claude extension 2.1.263 and Codex extension 26.901.22334. Used by new-session starts.**

Claude `claude-vscode.primaryEditor.open(undefined, prompt)` creates a panel and passes an initial prompt. The webview creates a fresh session, puts the prompt in the input box, and does not submit. With a caller-provided unknown ID, the panel can bind to that ID while the webview creates a different one. The caller therefore cannot identify a future session by inventing its ID.

The new Claude cwd is `realpathSync(workspaceFolders[0] ?? homedir())`. Target-window choice determines checkout; a multi-root workspace uses its first folder.

Codex `chatgpt.newCodexPanel` takes no arguments and opens `openai-codex://route/extension/panel/new` with `vscode.openWith`. `chatgpt.newChat` concerns the sidebar. Only a chat-session item provider was registered, not a content provider, so `workbench.action.chat.openSessionWithPrompt.openai-codex` was not a usable seeded-start path in the inspected bundle.

The experimental `chatgpt.implementTodo({fileName,cwd,line,comment})` did start a real thread at the supplied cwd and auto-submit, with a model response in its rollout. It wraps the prompt in a fixed implement-and-remove-comment instruction and selects the sidebar. That does not satisfy the product's unsent, editable prompt requirement, but remains a measured alternative for other work.

### Codex dispatch network access

**Record M46. Runtime, 2026-09-07, CLI 0.153.4 on Windows 11. Used by dispatch configuration.**

In `codex exec --sandbox workspace-write -c approval_policy="never"`, a Node TCP connect to `api.github.com:443` failed EACCES. The same connect took 11 ms outside the sandbox. Adding the following override allowed it:

```text
-c sandbox_workspace_write.network_access=true
```

Workspace-write dispatch requires that override for pushes and registry access. Plan/read-only dispatch does not enable it. Bypass mode has network because it disables the sandbox.

The `codex sandbox` helper ignored this configuration override in the probe and continued to fail EACCES. It is not a substitute for testing the actual `codex exec` path.

**Ground Control source inspection, 2026-09-09:** dispatch uses `codex exec --json` and reads `thread.started` from a stdout file. It does not apply the requested display name. Stop requires the thread to be in the adapter instance's in-memory dispatch map, then uses its spawn PID or a roster PID fallback. A hub restart loses this authorization. The external PID observation does not establish restart-safe stop support in the product.

## VS Code

### Claude editor commands and surfaces

**Records M5, M6, M7. Runtime/source, 2026-09-01–03; command signature reinspected 2026-09-08 in extension 2.1.263. Used by opening plans.**

```text
claude-vscode.editor.open(sessionId?, initialPrompt?, viewColumn?, newSessionGroupId?, fullEditor?)
claude-vscode.primaryEditor.open(sessionId?, prompt?)
```

`editor.open` writes `claudeCode.preferredLocation = panel` unless its fifth argument is set, before checking for an existing tab. `primaryEditor.open` calls the same panel creation with fullEditor true and the active column, avoiding that preference write. The product uses it.

The per-extension-host `sessionPanels` map reveals an existing tab before transcript lookup. On a match it drops a supplied prompt and tells the developer to enter it manually. Otherwise an initial prompt prefills without submitting. The direct command does not perform the URI handler's session-ID validation; callers must validate.

The panel's cwd comes from the window's first workspace folder. A saved session from another worktree did not open through the local command in the early probe. Through a URI, unresolved IDs instead produced new sessions in the focused window. A session that enters a worktree can retain its original editor window while reporting the new cwd.

Claude's sidebar is not in `sessionPanels`. Opening its session as an editor tab produced two PIDs for one session ID. Another sidebar session whose transcript had moved to a worktree produced a new session in the window's original directory. Surface identity, not cwd alone, determines safe reveal behavior.

There was no session-addressed sidebar reveal. `sidebar.open` takes no arguments and also changes preferred location. Focus the registered view directly through `claudeVSCodeSidebarSecondary.focus` or `claudeVSCodeSidebar.focus`; only the applicable view command exists.

Tab titles start as `Claude Code` and change asynchronously through the webview. They can also be renamed manually. A title is not session identity. Source inspection predicts that an existing editor tab can reveal after its transcript moves because map lookup precedes transcript lookup; that specific moved-tab case was not measured.

`claude-vscode.window.open` was inspected as creating a new panel and then moving it to a new window. `newConversation` sends a message to an existing panel. Their broader runtime behavior, and `reopenClosedSession`, remain uncharacterized.

The official URI `vscode://anthropic.claude-code/open?session=<id>` calls primaryEditor.open. Four fires in the 2.1.258 probe showed focus-based routing: three produced a new session in the wrong window; the one immediately following `code <target-folder>` resumed the intended saved session. Routing did not locate the window by session ID. Focus can change between raise and URI delivery.

### Window stores and process attribution

**Records M21 and M22. Runtime/source, 2026-09-03, VS Code 1.135.0 and Claude extension 2.1.258/2.1.259. Used by host discovery.**

| Location | Data |
|---|---|
| `User/workspaceStorage/<hash>/workspace.json` | Folder URI or saved workspace URI |
| `state.vscdb`, table `ItemTable` | Serialized key/value state |
| `memento/workbench.parts.editor` | Editor grid with nested JSON tab values |
| Claude tab `providedId: claudeVSCodePanel` | `state` JSON containing `sessionID` |
| `memento/webviewView.claudeVSCodeSidebarSecondary` | Nested webview state and session ID |
| `memento/webviewView.claudeVSCodeSidebar` | Alternative sidebar on older host configurations |

The secondary sidebar was exercised; the alternative key was inspected but not present in a fixture. Read the live SQLite database from a copy. The measured extension runtime had Node 24.18.1/Electron 42.8.1 and `node:sqlite` available.

Persistence is delayed and incomplete. The source's 60-second idle-scheduled flush measured 62.7 seconds; the SQLite writer's 100 ms delay is a separate interval. No read-only flush API was found. Of 13 live sessions, seven had surface records. Superseded sidebar sessions and missing panel IDs can remain live with no recorded surface. A closed window leaves its store behind. Two windows on the same folder share the same store hash, so last writer wins.

Reading 216 stores cold cost 250 ms. An mtime-cached scan of 207 stores, none changed, cost 27 ms. These keys are undocumented and must not be treated as a complete roster.

Claude IDE locks live under the configured Claude home at `ide/<port>.lock`:

```json
{"pid":29212,"workspaceFolders":["d:\\work\\repo"],"ideName":"Visual Studio Code",
 "transport":"ws","runningInWindows":true,"authToken":"<token>"}
```

On Windows, lock PID is the shared main Code process. Attribute a session through:

```text
session ID -> live session PID -> parent extension-host PID
announced IDE port -> listening PID -> lock's workspace folders
```

Four hosts mapped one-to-one in the probe. Query listeners by lock port, not arbitrary ports belonging to the PID, because extension hosts also have inspector ports. Parse `netstat` by foreign-address shape and final PID; localized state text can shift columns.

`netstat -ano` cost 24 ms; `Get-NetTCPConnection` cost 627 ms. The PowerShell/CIM parent table cost 650 ms, so cache it outside the click path and refresh inexpensive listener liveness on click. PowerShell 5.1 needs `ConvertTo-Json -InputObject @(...)`, not `-AsArray`.

Remaining limits:

- PID reuse is narrowed, not eliminated. CreationDate versus registry procStart could strengthen it; a four-tick difference was observed, suggesting a tolerance rather than exact equality.
- Unsaved workspace paths are not equivalent to saved `.code-workspace` files. A generated `workspace.json` opens as a file; use an actual folder where appropriate.
- Integrated terminal sessions can have `CLAUDE_CODE_SSE_PORT`; extension-spawned sessions did not.
- A future shared agent-host process would invalidate the per-window parent assumption. Shared-host behavior was read from upstream source, not exercised in the installed runtime.

The announced port is a WebSocket MCP server authenticated by the `x-claude-code-ide-authorization` header using the lock's authToken. Recorded tools included openFile, openDiff, close_tab, closeAllDiffTabs, diagnostics, workspace/selection reads, document operations, and executeCode. `openFile` acted in the addressed window. `getOpenEditors` returned text editors only, not Claude webviews. Whether `close_tab` can release a Claude panel and whether openFile raises foreground focus remain unmeasured.

**Do not complete an authenticated handshake merely to check liveness.** Source inspection showed a new authenticated connection evicts the prior client. TCP-only connect/close and unauthorized upgrades did not evict; an authenticated upgrade did. Use listener inspection for production discovery. The extension exports no API exposing its tab map.

### Window targeting and browser links

**Records M8, M26, M29, M45. Runtime/source, 2026-09-01–09; later Windows probes VS Code 1.136.1. Used by resident routes, with limits below.**

An extension host's `executeCommand` executes in its own window. The [seize probe](../extensions/seize-probe/) registered its folder and PID and watched a per-window inbox. A request opened a second Claude tab in the addressed window. One earlier reveal was ambiguous because a Claude tab already existed.

With the probe normally installed, a new-window launch registered in 3.2 seconds and a subsequent session open created a Claude tab and live process in the correct worktree. Development-host launches took 14–25 seconds. These are different startup environments.

Command resolution alone did not prove rendering. Count matching view types for a new tab and check active focus for a reveal; neither count nor label independently proves session attribution. Serialize probes relying on global tab counts, since concurrent opens can mask a failure.

A detached, hidden child launched from the extension's Code.exe in Node mode remained alive three seconds after the editor exited. Five bundled hub starts produced a readable record in 60–64 ms. The same headless child launched a window in about 1.1 seconds, but could not bring an existing target window to the foreground within the following four seconds. It could only request attention. CLI exit success is not proof of focus.

On Windows, `vscode://` is registered per user at `HKCU\Software\Classes\vscode\shell\open\command`. An integration run left the downloaded test build registered. A shell launch returned in 53 ms and that build was not running four seconds later; whether the URI was forwarded to the normal install was not observed. Browser-originated foreground activation remains an end-to-end verification item.

The shell/CLI environment matters: direct `Code.exe --open-url` in the tested launch context was rejected, while the `code` shim accepted it. Current resident code uses Code's `out/cli.js` in Node mode rather than relying on that shell shim. Quote full URIs when a shell is involved; `&` otherwise separates arguments/commands.

Inside a real extension host, a `vscode.open` URI reached `registerUriHandler`; valid session syntax reached the hub and was refused as unknown, malformed syntax stopped at the handler. `onUri` must be declared for activation.

Ground Control's cross-window handover URI is:

```text
vscode://groundcontrol.ground-control/open?session=<id>&agent=<agent>&hop=1
```

The receiving handler passes through normal hub validation and refuses onward routing. This behavior was tested with an unknown ID. Delivery immediately after raising a window is inferred from the official Claude-URI experiment; it was not separately measured for this URI. Carrying the agent avoids guessing from a snapshot the receiving window may not have.

`/attach?session=<id>` is a separate local terminal operation without agent or hop parameters. On 2026-09-09, a real-host probe created a terminal with `shellPath: 'claude'`, `shellArgs: ['attach', '<short-id>']`, and the checkout cwd. Creation options and processId confirmed the command shape. `shellPath` does not perform a PATHEXT lookup for a `.cmd` shim; configured executable paths must account for that.

### VS Code updates and window launches

**Record M49. Source inspection and runtime, 2026-09-08, stable Windows installation during a 1.136.1 → 1.136.2 update. Used by launch refusal.**

VS Code's main-instance pipe name includes both the user-data-path hash and product version:

```text
\\.\pipe\<sha256(userDataPath)[0:8]>-<version>-main-sock
```

A different-version launch can miss the running instance and start another main process. With the same user data and window restoration enabled, that can reopen all existing windows. The reported symptom was six windows becoming twelve.

The Windows versioned updater stages files under a commit-prefix directory, writes `updating_version`, and prepares `new_Code.exe`/`new_code.cmd`. Observed running build: commit prefix `a44adf7f53`, version 1.136.1. Staged build: `88e44fa0e0`, version 1.136.2. A `new_Code.exe --version` probe waited 31 seconds for the updater mutex and refused launch while the update was active.

`cli.js` spawns `process.execPath`, not the executable corresponding to its own appRoot. It deletes `ELECTRON_RUN_AS_NODE` but otherwise inherits environment. Extension-host variables such as `VSCODE_NLS_CONFIG`, `VSCODE_CODE_CACHE_PATH`, and `VSCODE_ESM_ENTRYPOINT` can therefore refer to a different build. Sanitize them and compare the launch target with the running appRoot/update marker.

The CLI launches detached with ignored stdio and exits 0, so the exit status cannot distinguish correct reuse from a second main process.

**Unobserved edge case:** source inspection indicates the update marker is removed while applying the package, with old-version garbage collection deferred. An older window might remain open after the marker disappears while its executable resolves to a newer build. The current marker-based refusal does not prove safety in every such state. Do not describe it as a complete version-mismatch detector.

### VS Code Git and combined diffs

**Record M30. Source/runtime, 2026-09-05, VS Code 1.136.1. Used by combined changes.**

No tested built-in command combined branch commits and uncommitted work. `diffBetween*` builds a revision range; working-tree/index views cover separate groups. The caller must combine merge-base-to-HEAD, index, and disk changes.

`_workbench.openMultiDiffEditor` accepts `{multiDiffSourceUri,title,resources,reveal}`. Each resource has original/modified URIs, with a missing side undefined. Explicit resources override source resolution, so the source URI can be an identity only. These are private APIs.

The editor appends its own resource count to the title. Four resources produced a four-file title but only one `TabInputTextMultiDiff.textDiffs` entry: the API omitted one-sided additions/deletions. Use that field only for what it reports.

Revision resources use a `git:` URI with query `JSON.stringify({path: uri.fsPath, ref})`; disk resources use `file:`. A Change's `originalUri` differs for copies as well as renames, so follow it only for actual rename statuses.

Inspected status values:

```text
0 INDEX_MODIFIED, 1 INDEX_ADDED, 2 INDEX_DELETED, 3 INDEX_RENAMED, 4 INDEX_COPIED,
5 MODIFIED, 6 DELETED, 7 UNTRACKED, 8 IGNORED, 9 INTENT_TO_ADD, 10 INTENT_TO_RENAME,
11 TYPE_CHANGED, 12 ADDED_BY_US, 13 ADDED_BY_THEM, 14 DELETED_BY_US,
15 DELETED_BY_THEM, 16 BOTH_ADDED, 17 BOTH_DELETED, 18 BOTH_MODIFIED
```

An edit staged then deleted on disk appeared in both index and working-tree groups. Preserve the three ranges in order; reducing to one status loses the final file state. `git.untrackedChanges` places untracked files in workingTreeChanges under mixed, untrackedChanges under separate, and neither under hidden.

`git.openRepository` takes a path string. It makes the repository visible in Source Control for the window's lifetime, without a matching private cleanup operation. Immediately after opening, status groups were empty; three seconds later the untracked file appeared. `await repository.status()` provided deterministic readiness.

Repository-aware commands resolve their first argument by longest root prefix. On a miss, a window with exactly one repository silently supplies that repository. Verify `rootUri` before operating, or a failed worktree open can show the main clone under the wrong card title.

`getBranchBase` takes a branch name, returns a branch rather than a merge-base commit, and writes `branch.<name>.vscode-merge-base`. Use `getMergeBase('HEAD', ref)` with the origin default ref and explicit main/master fallbacks when inspecting without writes.

The Source Control Graph's repository picker takes no argument. Opening a multi-diff does not select its repository in the graph. Focus commands exist for SCM, history, and repositories; history focus silently no-ops when unavailable. `git.detectWorktrees` was false by default, with a detection limit of 50.

Evidence: [changes.test.cjs](../extensions/ground-control/test-integration/changes.test.cjs) and the inspected built-in Git/workbench bundles.

### Settings editor and output channels

**Records M50 and M34. Source/runtime, 2026-09-06–08; VS Code 1.136.2 for settings, `@types/vscode` 1.134.0 for channels. Used by configuration and logs.**

The settings editor rendered a grid for uniform object maps of primitive/enum values using additionalProperties or patternProperties. Fixed properties with mixed types instead produced an Edit in settings.json link. Expose editable leaves as flat registered settings when needed.

Dots in setting IDs form a value tree when read through `WorkspaceConfiguration.get`; a parent read can collect registered leaf values even when the parent is not registered. `update` requires a registered key. Integration tests must perform the write to establish that a UI settings path exists.

`OutputChannel` exposes write, show/hide, and dispose methods but no visibility property or event. `LogOutputChannel` adds level and severity methods, not visibility tracking. Hub-log subscription must therefore use explicit state.

`show(true)` preserves focus. Hiding an output channel's surrounding panel was not measured and is unnecessary for stopping subscription. Writers are specified to log only at the configured level; whether suppressed lines can later be recovered was not established. Keep important connection history at info and frequent wire detail at debug.

### Webview theme signals

**Record M36. Source inspection, 2026-09-07, VS Code 1.136.1. Used by presentation.**

The preload sets one of `vscode-light`, `vscode-dark`, `vscode-high-contrast`, and `vscode-high-contrast-light` on body, alongside reduced-motion/screen-reader classes. `prefers-color-scheme` follows OS settings and can disagree with the editor theme.

A 3% black mix over white produced about 1.07:1 contrast, but the same ratio over `#1f1f1f` only 1.01:1. The recorded lane design therefore used different light/dark ratios, 3% and 30%, with border-based separation in high contrast. These measurements explain a theme-dependent treatment; exact stylesheet values are not a testing contract.

## Windows, Node, and files

### Directory deletion and file watching

**Records M23 and M24, with M20's settings write. Runtime, 2026-09-02–03, Windows 11 and Node 24.14.0. Used by hooks and watcher.**

A deleted activity directory remained in its parent's listing while access, ACL reads, Win32 opening, and recursive mkdir failed with access-denied/EPERM. This is consistent with deletion pending while another process holds a handle; the actual holder was not established. Reproducing with only fs.watch did not retain the directory. Retain the directory and remove marker files individually when disabling activity.

Renaming over Claude's settings file failed transiently with EPERM while sessions were active, then succeeded later. Back up and write the settings in place; treat a sharing failure as retryable rather than assuming malformed content. Writer scripts and markers can use temp/rename with their documented fallback/retry behavior.

`fs.watch` observations:

| File operation | Recorded events |
|---|---|
| Create | rename, change |
| Rewrite | change, change |
| Temp file then replacement rename | Five events across temp and target |
| Unlink | rename |

Interpret existence and previously known membership, not event names or counts. A write immediately followed by unlink could already be absent when the first event arrived. With 40 ms between them, create and delete were both observed. Within one batch, deletion must override an earlier update.

Watching an absent directory threw ENOENT. Removing the watched directory ended its watcher. Re-arm after loss and retry initially absent paths even though normal hook removal retains the directory. macOS/Linux event coalescing was not measured.

### Detached processes and termination

**Records M25 and M26. Runtime, 2026-09-03–04, Windows 11, Node 24.14.0 and VS Code 1.136.1. Used by hub lifecycle and tests.**

A detached console-less child installed signal and exit handlers, then received:

| Request | Result |
|---|---|
| Node SIGTERM / SIGINT | Immediate termination; no handler or exit callback |
| Node SIGBREAK | ENOSYS; process unchanged |
| `taskkill /PID` without force | Refusal; process unchanged |

Orderly shutdown requires the hub's authenticated HTTP endpoint, not a Windows signal. A force-killed hub can leave discovery state and no recorded exit reason. Five unbundled starts wrote a readable record in 85–96 ms; bundled results were 60–64 ms in M26.

Every console child of a detached parent needs its own hidden-window option. A `cmd /c ping` child allocated a visible console; the same child with `windowsHide: true` did not. This option is not inherited, including by fixture grandchildren. Direct Node spawning of `.cmd` failed; command-processor and browser-native-host launches have different behavior.

### HTTP decoding and the Node inspector

**Record M28. Logs and source inspection, 2026-09-04, VS Code 1.136.1 on Windows with Node 24 instrumentation. Used by HTTP transport.**

An extension host repeatedly logged `TypeError: Missing dataLength in event` in `node:internal/inspector/network_http` and eventually aborted with code 134. The inspected listener reads `chunk.byteLength`. Calling `response.setEncoding('utf8')` supplied strings, whose byteLength is undefined, to that other listener. The request itself could still succeed.

Keep response chunks as bytes and decode complete bodies or feed a StringDecoder for incremental reads. This preserves split UTF-8 characters without changing what the inspector receives. A connected inspector frontend, not necessarily a launched debug session, is sufficient for exposure. The transport test checks that setEncoding is not called on responses. A future Node change may fix the instrumentation, but it must be verified rather than assumed.

## GitHub and the browser overlay

### GitHub project statuses and timeline

**Records M17 and M32. API observations, 2026-09-01 and 2026-09-05, OwnerRez project 3. Used by membership, lanes and triage.**

The project had 17 statuses:

| Status | Recorded meaning |
|---|---|
| 🆕 New | No description |
| 🧊 On Ice | Valid, with no intention to change |
| 📋 Backlog | Deferred work |
| 📥 Product Backlog | Product review backlog |
| 🎯 Product Review | Product-lead feedback needed |
| 🔖 Planned | Roadmapped or tasked |
| 📋 Automation To Do | Next automation work |
| 🤖 Automation | Automation underway |
| 🎨 Design Assigned | Figma or markup design assigned |
| 📱 In Design | Design underway |
| 🎁 Assigned | Assigned to developers |
| 👀 Tasking Review | Engineering tasking awaits review |
| ⚒️ Dev | In progress or waiting on developer |
| 🔍 Dev Review | Awaiting developer review |
| 👟 Ready For Testing | Tester assignment or deployment pending |
| 🏃 Testing | Testing underway |
| 🚀 Releasable | Closed and ready for release |

Status names above are exact; meanings summarize the recorded descriptions. Assigned, Dev, and Dev Review form the default active membership set. Observed handovers also used assignment and status changes without updating the PR review decision. Do not equate the team's workflow with GitHub reviewDecision alone.

Re-read exact status names/descriptions with:

```graphql
query {
  organization(login: "ownerrez") {
    projectV2(number: 3) {
      field(name: "Status") {
        ... on ProjectV2SingleSelectField { options { name description } }
      }
    }
  }
}
```

Issue timeline `PROJECT_V2_ITEM_STATUS_CHANGED_EVENT` supplied createdAt, actor, previous/current status, project number, and wasAutomated, alongside assignment/unassignment events. Filter events to the configured project.

Project-addition events had empty previousStatus and `wasAutomated: false`, despite an automation actor, on three sampled issues. That flag alone does not identify human handover. One handover comprised assignment, unassignment, and a status change within six seconds. Another assignment arrived 2 hours 35 minutes after a status change by someone else. Current status and latest instruction timestamp are separate inputs.

`ProjectV2ItemFieldSingleSelectValue.updatedAt` matched the status-change time and did not change on the later assignment in the sample. This lets ordinary polling detect a status trigger without fetching a per-card timeline. The behavior was checked on three issues, not all project mutations.

### GitHub query cost and limits

**Record M48. API measurements, 2026-09-08, 13 assigned issues and 31 open PRs. Used by polling and triage freshness.**

Measured GraphQL cost with `rateLimit { cost }`:

| Closing-PR selection | Cost |
|---|---:|
| `first:100`, ordinary card fields | 3 |
| Also latest commit OID and check rollup, `first:100` | 103 |
| Same nested fields, `first:10` | 13 |
| Same nested fields, `first:5` | 8 |

The shipped query fetches five closing references. At a 300-second poll, cost 8 is 96 points/hour against the recorded 5,000/hour allowance. Wall time was 1,019 ms before and 1,167 ms with the rollup. Requested page sizes affect cost even when few results return. The measured maximum was one closing PR per issue; nine of thirteen issues had none.

Ordering of `closedByPullRequestsReferences` was not established. Sorting the fetched five by updatedAt cannot guarantee the globally newest PR when more than five exist. Preserve this limit in claims about selection.

PR comments, pushes, and failing checks did not change issue.updatedAt. Use PR updatedAt, head OID, and check rollup for triage freshness. `reviewDecision` was populated on 31 of 32 PRs in a related read but could remain REVIEW_REQUIRED after the team's status-based approval. It remains useful for arrival rules, not as a complete record of team review progress.

### GitHub board DOM and extension lifecycle

**Record M27. Runtime/DOM, 2026-09-04–08, Chromium 151.0.7922.34, Playwright 1.62.1 on Windows 11. Used by overlay.**

Recorded pages were GitHub's public roadmap (`github` project 4247, view 21) and a public Node.js board (project 14) for assignees.

| Selector | Purpose |
|---|---|
| `#project-items-region` | Board columns |
| `[data-board-column]` | Column and name |
| `[data-board-card-id]` | Project item and drag handle |
| Issue link inside a card | Repository/issue association |
| `[data-component="AvatarStack"]` | Assignee display |
| `[role="region"][aria-label="View filters"]` | Filter toolbar |
| `[role="navigation"][aria-label="Project"]` | Project title area |
| `nav[aria-label="Select view"]` | View tabs |

CSS-module class names carried build hashes. Use structural attributes for lookup. The visible card box was the drag handle's first child; placing a footer directly on the drag handle put it below the border. Header/view wrappers must be hidden as a whole to avoid empty space. Unsaved-filter Save/Discard wrappers were identified from their controls because no stable wrapper selector was found.

The assignee stack and screen-reader caption share a figure. Hiding only the image left the old assignee announcement. CDP accessibility inspection confirmed that hiding the original figure's content removed caption/image/focus targets, while the replacement author image remained accessible. An empty figure needed presentation role. Do not add an avatar if the view omitted the assignee area.

At 25 cards, scrolling preserved nodes and an injected child. Larger-board virtualization was not measured. Switching views replaced card nodes: held nodes became disconnected and custom content/attributes disappeared. Retain footers by original node and signature, and rebuild for replaced nodes.

Three unchanged-footer redraws produced 11 mutation records and replaced four subtrees. A failing-avatar handler removing its image caused 182 paints in three seconds. Changing existing attributes instead avoided the observer's childList trigger. Setting textContent produced a childList mutation for each age every second; nodeValue updates used characterData, which the observer did not watch. Disarm observation around owned DOM mutations as an additional guard.

Headless Playwright loaded an unpacked extension, ran its content script/module, and exposed the MV3 worker within about one second. Tests served fixture HTML at a matching github.com URL. Native-host behavior was separately demonstrated under Chromium registration: Chrome launched a `.cmd` wrapper that Node refused to spawn directly. The bridge started an isolated hub and returned a snapshot; a missing bundle produced a failure with log path.

An idle worker remained responsive for three minutes, but the 15-second `worker.evaluate` probes themselves counted as activity. The experiment does not prove an open port prevents worker suspension. Use reconnects and alarms rather than relying on that observation as a keep-alive guarantee.

After `chrome.runtime.reload`, old content scripts remained in their tabs, calls threw Extension context invalidated, and `chrome.runtime.id` became undefined. Stop their observers and timers and request a page reload. A merely stopped worker requires reconnect instead. The product keeps the latest snapshot in session storage and can reopen its native port on a one-minute alarm.

### Tooltip behavior and accessibility

**Record M35. Runtime/DOM/accessibility, 2026-09-07, Chromium 151.0.7922.34. Used by both clients.**

GitHub's Primer TooltipV2 used a popover node next to each anchor. Recorded values:

| Property | Value |
|---|---|
| Text | 12px, weight 400, line-height 19.5px |
| Box | 4px 8px padding, 6px radius, no border/shadow/arrow |
| Width | max-content, maximum 250px, wrapping |
| Placement | Centered, 4px gap, above or below |
| Timing | 120 ms delay, 0.1-second opacity fade |
| Colors | Emphasis background and on-emphasis foreground |

The clients use a shared tooltip element per document rather than GitHub's node-per-anchor popover mechanism. The editor uses theme hover colors/border/shadow. Native `title` and SVG title tooltips are excluded from client-owned content to avoid duplicate system tooltips.

Measured card ancestors had no transform, filter, or paint containment that would constrain the fixed tooltip. Recheck that condition after GitHub layout changes.

Measured implementation constraints:

- Cancel a pending tooltip when its anchor is left before the delay.
- Ignore pointer movement between children inside one anchor.
- Check anchor connectivity before opening and after repaint.
- Clamp placement on both axes even after flipping below.
- Avoid adding/removing tooltip nodes or replacing text children while the scan observer is armed.

`aria-description` was exposed on both a nonfocusable span and a button. `aria-describedby` overrode it when both existed. Keep accessible descriptions on the anchor rather than waiting for delayed tooltip display. Avoid duplicating an existing aria-label with identical description text.

The implemented tooltip is not hoverable: pointer-events none means a magnifier user cannot move onto wrapped tooltip text. Retain this accessibility limitation; copying GitHub's behavior does not establish compliance with every tooltip requirement.

### GitHub theme, labels, and layout

**Records M37 and M38, with M27 layout. Runtime/DOM, 2026-09-07, public roadmap in both color schemes. Used as presentation reference.**

Theme state is on the document element: `data-color-mode`, `data-light-theme`, and `data-dark-theme`. Explicit light/dark overrides the OS; auto follows prefers-color-scheme.

| Token | Light | Dark |
|---|---|---|
| `--fgColor-default` | #1f2328 | #f0f6fc |
| `--fgColor-muted` | #59636e | #9198a1 |
| `--fgColor-success` | #1a7f37 | #3fb950 |
| `--fgColor-attention` | #9a6700 | #d29922 |
| `--borderColor-default` | #d1d9e0 | #3d444d |
| `--bgColor-default` | #ffffff | #0d1117 |

A session name mixed 55% default text over muted, approximately #394047 light/#c5ccd3 dark, close to the recorded VS Code Light/Dark Modern foregrounds. Attention outlines use foreground tokens rather than emphasis background tokens.

Labels measured 20px high, 14px text at weight 400, 18.2px line height, 1px 8px padding, pill radius. Light labels used opaque color with black text and transparent border; dark labels used full-strength label text, 18% fill, and 30% border. The editor uses the tint recipe in both schemes rather than assuming all theme colors support black text.

Other recorded values: 4px label gap, 8px below title, 12px horizontal card inset, 12px issue number, 14px GitHub title. Columns measured 350px wide with 1px borders and 8px right margins. A -1px margin joined dividers without doubling borders. Gradient background strips preserved rounded corners where border-image did not. These are dated UI observations, not stable GitHub API contracts or stylesheet assertions.

## Workflow and recovery experiments

The experiments below support future coordinated development workflows. They are retained even where there is no product implementation. References to prototype state files or tools identify evidence, not supported commands or required architecture.

### Stopping and taking over a session

**Records M4, M9–M11. Runtime, baseline 2026-09-01. Experimental.**

Stopping a background parent killed its in-process subagents and their shell children. Two 150-second wait probes left preserved subagent transcripts, with Exit code 137 for the interrupted tool. No live orphan processes remained. A resumed parent recognized stopped subagents without results. Automatic recovery depended on the later resume path, covered in M14 below.

Force-killing the print-mode parent left no terminal tool result or error marker; its subagent transcripts ended. Recovery cannot rely on the explicit interruption record produced by `claude stop`.

The takeover sequence was exercised as stop/kill, open in the target editor, developer input, close the tab, then resume. A stopped session resumed with bare `claude --bg --resume <id>` using its original ID and saved options. Adding permission/name options could instead produce a copied session. Parse the CLI's explicit copy notice; do not infer identity from the requested ID.

A Claude tab holds a session process. Background resume while it remained open produced a copy; after closing it, the original resumed. Print-mode resume while a tab held the same session succeeded without warning and created concurrent transcript writers.

Transcript records contain parentUuid links. In the concurrent test, shell and editor turns became sibling branches. A later resume followed the shell branch and could not recall the developer's marker from the editor branch. The data still existed but was absent from the resumed conversation. One writer per session is a prerequisite for safe takeover, and duplicate-parent children are a useful validation signal to investigate before resuming workflow execution.

The open editor tab did not reload the externally appended turn and continued displaying its earlier conversation state.

A clean round trip without concurrent writers preserved the developer's marker; 43 transcript entries showed no fork. Visual inspection showed the original conversation in the resumed tab, and both the live roster and an in-tab pwd confirmed the worktree cwd. Closing mid-turn killed the tool and left an incomplete turn; a resumed agent in the probe recognized that interruption.

### Tab release and automatic resume

**Record M11. Runtime/prototype, baseline 2026-09-01. Experimental.**

`tabGroups.onDidChangeTabs` fired on closure. The probe observed the event after 3 ms and successfully resumed the original background session on its first attempt after about 4.1 seconds. A manual close behaved the same, taking 4.18 seconds to resume.

The prototype mapped newly observed tab labels to session IDs and persisted that map under `.factory/seized.json`. Its label-based identity is not suitable for production: labels begin generic, can be renamed, and drift across resume. Keep the event/timing result, but require a stronger association before building automatic hand-back.

The probe retried up to six times, 1.5 seconds apart, stopping any copied session before retrying. Only first-attempt success was observed in the cited run. That does not prove retries safely cover all still-releasing or live-tab cases. Measure release readiness and identity directly before adopting the loop.

Reopening a window restored prior Claude tabs and started live processes for them. A coordinator must reconcile restored tabs rather than assuming a previously released session remains unheld. A programmatic release must not race an independent auto-resume triggered by the same close event.

### Subagent recovery

**Record M14. Runtime and transcript reconstruction, baseline 2026-09-01. Experimental.**

Two background subagents were killed before writing proof files. Bare `--bg --resume`, with no recovery prompt, restored the original agent IDs: metadata count stayed two, the first proof appeared around 105 seconds, and both around 135 seconds. The interrupted 100-second wait restarted; elapsed tool execution was not resumed mid-call.

An added prompt telling the parent to redispatch created two extra agents, duplicating the work. In a separate print-mode resume test, the original agents stayed stopped and the parent spontaneously launched two new agents after a generic Continue prompt. Thus queue behavior differs across the measured paths; this limited sample is not a guarantee for every version or interruption.

Recovery data was reconstructable from three files:

| File | Evidence |
|---|---|
| Parent transcript | Agent tool-use input, including verbatim prompt and type |
| `subagents/agent-<id>.meta.json` | toolUseId, agent type, description, spawn depth |
| Subagent transcript | Progress, tool results, terminal failure and completion |

Match async notifications by task-id/agent ID, not an assumed tool-use-id inside every notification. Distinguish a launch acknowledgement from a delivered report. Synchronous completion can be a later matching tool_result; asynchronous completion needs positive completed status for the agent. A stopped notification is interruption evidence. Missing completion while the parent is working can mean work is pending.

Use only terminal errors to explain failure; an earlier transient error may have recovered. The prototype incorrectly reported recovered agents as orphaned when these distinctions were absent.

For a future recovery policy, observe runtime queue restoration before redispatching. The tool output suggested SendMessage could continue an existing agent, but a dead agent was absent from ListAgents after print-mode resume; restoration of a specific dead agent through SendMessage was not established. Reconstruct and redispatch only when continuation is unavailable and outstanding work is confirmed.

Direct recovery should target depth-one children, letting parents manage nested work. A progress digest can prevent repeated side effects, but is not an idempotence guarantee. Checkpointed output allows completed subtasks to be skipped more reliably than conversational reconstruction.

### Usage limits and transient model failures

**Record M15. Historical-file analysis, baseline 2026-09-01. Future recovery input; not an induced rate-limit test.**

Across 1,675 transcripts, 177 `isApiErrorMessage: true` entries had these broad classes:

| Class | Count |
|---|---:|
| Session limit with reset time/timezone | 143 |
| API 529 overloaded | 28 |
| Connection lost mid-response | 4 |
| ECONNRESET or 522 timeout | 2 |

The error was an assistant text message, often the final transcript line. It did not reliably provide an explicit parked/retry state. A stopped process or ended transcript therefore cannot establish successful work.

Limit messages contained a clock time and IANA timezone, for example `resets 11:30am (America/New_York)`, without a date. A future scheduler must interpret the next occurrence relative to the observation date. Retry transient failures under a bounded backoff; wait for the reset for an exhausted allowance. Do not count an externally blocked stage as active work.

Automatic scheduled recovery was not established by this historical scan. The resume experiments show candidate operations, not end-to-end limit recovery. The CLI exit-code distinction between limit stop and success remains unmeasured. Incomplete-response errors also require checking interrupted work before any stage advance.

### Evidence enforcement and test output

**Records M12 and M16. Runtime, baseline 2026-09-01. Experimental stage-completion validation.**

A PreToolUse Bash hook exiting 2 blocked the command and supplied its stderr to the model. It was installed through a session-specific settings file. An adversarial probe identified possible bypasses—fabricating evidence, editing the hook, or changing command syntax—but the model declined them. That refusal is model behavior, not enforcement. Validate evidence in the operation that advances the stage; use the hook as an additional check.

A .NET 8 xUnit project produced TRX counters through `dotnet test --logger trx`. A filter matching no tests exited 0 with outcome Completed and executed 0. Exit status and outcome alone are insufficient. The recorded validation condition was:

```text
outcome == "Completed"
failed + error + timeout + aborted == 0
executed > 0
```

TRX reports test counts, not assertion counts. The full no-build run reported total 4,117, executed/passed 4,114, three skipped, zero failed, and 36 seconds wall time. List-tests returned 4,067 names, so names and executed test cases must not be assumed identical.

For that project the full suite was affordable and avoided a filter-based zero-test pass. Skip policy requires comparing total and executed; the condition above alone does not enforce a skip baseline. Exact ResultSummary values on a failing run and error/aborted counters on crashes were not measured. This experiment informs future validation; it does not define Ground Control's npm checks.

### Structured Codex review

**Record M13. Runtime, baseline 2026-09-01, CLI 0.147.0. Experimental.**

```text
codex exec --sandbox read-only --skip-git-repo-check
  --output-schema findings.schema.json -o evidence/findings-codex.json <prompt>
```

On one 481-line real diff, the final file conformed to the schema, including required fields and severity enum, and contained one substantive high-severity finding. The run used 79,199 tokens and approximately six minutes. This proves the structured-output path worked once, not review reproducibility or recall.

The run loaded user MCP configuration and emitted repeated model-cache errors while still completing. Read the result file rather than parsing noisy diagnostics. Isolating configuration was proposed to improve cost/reproducibility; the suggested `--ignore-user-config` flag was not verified by this experiment and must not be treated as an established invocation. Three comparable runs remain a useful quality check before adopting automated multi-model review.

### Direct session messages

**Record M18. Source/runtime, 2026-09-02, Claude CLI 2.1.257/2.1.258. Experimental redirection.**

Local session registry files at `~/.claude/sessions/<pid>.json` contained `messagingSocketPath`; the adjacent `<pid>.<sha256>.key` contained peerToken. Windows used `\\.\pipe\LOCAL\cc-msg-<id>`. Both editor and background sessions accepted the same protocol. A bare Node process could connect without running another Claude session.

Write two newline-delimited JSON frames:

```json
{"type":"auth","token":"<peerToken>"}
{"type":"user","message":{"role":"user","content":"<correction>"}}
```

Authentication was required; malformed/unauthenticated first frames and incomplete-handshake timeouts closed the connection. Message content must be nonempty. Optional fields included priority, msg_id, session_id, from, from_mode, and file_attachments. A session_id mismatch was rejected, providing a check against a recycled process address.

Transport was subsecond, but processing waited for the current tool call. A message sent 24 seconds into a foreground loop with priority now was acted on only after the loop completed, roughly 90 seconds after it began. Idle targets responded within ten seconds. Priority affected inbox ordering, not interruption.

| Target configuration | Observed result |
|---|---|
| bypassPermissions, default inbound policy | Unattested message held for human approval |
| bypassPermissions with crossSessionInbound accept | Delivered without a prompt |
| acceptEdits, default policy | Delivered without a prompt |

`crossSessionInbound` supported accept, hold, and refuse; managed/repository policy could tighten it. These observations do not authorize the board to loosen inbound policy or assume an independently started session accepts messages.

The model received the message as a peer instruction, explicitly not the human user's approval. It cannot approve a pending permission request or grant escalation. Redirection must remain distinct from approval and from stopping a running tool.

Control messages included rename, notify_when_idle, and peer_message_status. A child of a session received `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`, using a childToken distinct from peerToken. These are undocumented capabilities to recheck before adoption.

## Remaining verification and design work

**Record M19 consolidates open experimental questions.** Resolved observations belong in their topic sections above. Product choices belong in [PRD open decisions](prd.md#open-product-decisions).

| Question | Evidence still needed |
|---|---|
| Recovery across interruption/resume modes | Repeated background versus print-mode queue tests; reliable identification of still-running and completed children |
| Continuing a dead subagent | A successful specific-ID continuation, or an explicit unsupported result |
| Live-tab release readiness | Close during an active turn; measure release delay and duplicate prevention without relying on labels |
| Background respawn semantics and retention | Determine whether respawn continues work and how stopped jobs can be reclaimed without deleting worktrees |
| Usage-limit outcome | Exit status and complete scheduled resume at an actual reset |
| TRX failure/crash cases | Actual outcome strings, error/aborted counters, and skip policy |
| Automated reviewer reliability | Repeated runs on one diff under verified isolated configuration |
| Checkout provisioning | End-to-end creation of a worktree and local IIS site in an isolated experiment |
| Project write-back | A controlled status write through the future workflow implementation |
| Hooks in already-running sessions | Establish whether settings changes are adopted without restart |
| Hook ordering and async delivery | Source event sequencing, exact matcher behavior per event, and payload delivery on async entries |
| Cross-window browser navigation | Packaged extension, actual foreground browser, and verified URI arrival/focus after scheme-registration changes |
| Editor update edge cases | Launch version after the staging marker has disappeared while old windows remain open |
| Codex sidebar/resource transition | Reveal while the thread is actively displayed in the sidebar; verify identity and process effects |
| Alternative host surfaces | Claude close_tab webview support, openFile foreground behavior, additional start/restore commands |
| Large GitHub boards | Virtualization/recycling beyond the measured 25-card column |

A failed renderer-driving experiment is also retained: on 2026-09-03 with VS Code 1.136.1, remote-debugging-port produced no reachable endpoint over twenty seconds, and Playwright's Electron launcher failed waiting for an inspector line. These attempts did not establish a reusable external pixel driver. They do not rule out another configuration or future version.
