# Ground Control architecture

Ground Control has one headless hub and two clients: a VS Code board and a Chrome overlay on GitHub Projects. The hub reads work sources and agent state, computes cards, persists shared state, and handles actions. Clients render snapshots and perform operations that require their host application.

[Requirements](prd.md) defines product behavior. [Mechanics](mechanics.md) records external APIs and experiments. [Testing](testing.md) defines verification. Future workflow design is identified explicitly; it is not part of the implemented system.

## Components and dependencies

```text
GitHub source ----\
Claude adapter ---+--> hub --> HTTP + event stream --> VS Code client
Codex adapter ----+      \--> native-messaging bridge --> Chrome overlay
VS Code host -----/
```

The hub runs outside VS Code so the browser can continue without an editor window. It owns lane placement and hook installation to prevent competing clients from writing shared state independently.

| Package | Responsibility | Internal runtime dependencies |
|---|---|---|
| `packages/core` | Adapter contracts, neutral data types, protocol, configuration, shared readers and helpers | None |
| `packages/agent-claude` | Claude roster, history, activity, classification, dispatch and stop | `core` |
| `packages/agent-codex` | Codex marker roster, history, activity, hook trust, dispatch and stop | `core` |
| `packages/host-vscode` | Window and surface discovery, agent placements, open/start plans, combined-diff planning | `core` |
| `packages/github` | Assigned issues, individual issue lookup, conversation and PR reads | `core` |
| `packages/board` | Card merge, membership, lanes, attention, history association, triage decisions | `core` |
| `packages/automation` | Action eligibility, authorization evidence, limits and run-state decisions | `core` |
| `packages/hub` | Composition, polling, watchers, stores, runners, server, client transport and bridge policy | Packages above |
| `apps/hub` | Executable entry point, process launch, native-messaging framing and registration | `core`, `hub` |
| `extensions/ground-control` | VS Code activation, settings, webview, resident operations, bundled hub | `core`, `host-vscode`, `hub`, settings helpers from `board` and `github` |
| `extensions/chrome-github-board` | Worker, content script, DOM rendering, browser state | `core` types; local JavaScript modules |

`packages/*` and `apps/hub` must not import `vscode`. Host API calls stay in the extension; decisions stay in testable package functions. Agent packages must not import another agent or host package. Test-only dependencies are separate from the runtime boundaries above.

The VS Code webview is a classic script. The Chrome client uses JavaScript modules loaded directly, with no build step. Neither imports workspace TypeScript packages at runtime. Duplicated rendering helpers are checked by parity tables.

## Adapter contracts

Registries in [registry.ts](../packages/hub/src/registry.ts) compose the supported targets. Configuration selects them by ID. Unknown IDs produce classified failures; targets omitted from configuration are not read.

### Agent adapters

[AgentAdapter](../packages/core/src/agent.ts) defines session discovery and optional history, activity, classification, dispatch, and stop capabilities. Machine readers and the configured issue pattern are injected. Agent-specific process operations remain with the adapter.

| Capability | Claude | Codex |
|---|---|---|
| Default detection | Enabled by default | Presence of Codex home |
| Live roster | `claude agents --json` | Hook markers plus PID checks |
| History | Parent transcripts under `.claude/projects` | Rollout files and session index |
| Activity | Hook markers | Hook markers |
| Classification | Tool-free print-mode invocation | Not offered |
| Dispatch | `claude --bg` | Detached `codex exec` |
| Stop | Background job short ID | Adapter-owned process identity |

`MachineDeps` combines filesystem readers, home, and the compiled branch pattern. Adapter outputs use neutral `Session` and `HistoricalSession` types. Session identity is agent plus session ID; agent-specific display fields remain in `details`. Shared fields such as `finished`, `checkoutRoot`, repository identity, and `attachId` support decisions that must not depend on arbitrary agent vocabulary.

Live sessions derive their checkout, repository, and branch from an upward Git search. Historical issue matching uses saved metadata, not the current branch. Claude's transcript directory encoding, bounded title reads, and Codex's rollout format are external mechanisms documented in [mechanics](mechanics.md).

Activity has two timestamps:

- `since`: the duration anchor, including the original prompt for an active turn.
- `at`: the event observation timestamp, used to compare retained state with card departure.

An activity signal supplies settings-edit plans, paths, a reader, and optionally a writer script. The hub performs installation and filesystem operations. A missing signal produces no phase; it must not manufacture idle state.

Classification and dispatch have different contracts. Classification suppresses tools, settings, transcripts, and visible session state. Dispatch loads the developer's working context, produces an ordinary session, and must be stoppable. Claude dispatch returns a short ID that the hub resolves against a subsequent roster; it cannot choose the session ID in advance.

The hub selects action adapters through `actions.agent`, retaining registry order for `auto` and requiring explicit selections to be enabled and dispatch-capable. Adapters declare `dispatchPermissions`; the runner checks the requested mode before reading context. Missing declarations and unsupported modes refuse. Codex derives its declarations from its sandbox mapping. A settings change during a pending read prevents dispatch with obsolete authorization.

`triage.model` and `actions.model` are separate neutral strings passed only to their respective adapter operations. Missing fields preserve legacy `AgentConfig.model`; explicit empty strings pass null for the CLI default. The editor no longer adds a classification model to agent discovery configuration. Runtime schemas reject malformed model values and unknown action agent or permission selections.

Codex hook trust is performed asynchronously through `codex app-server`: read entry keys and hashes with `hooks/list`, then write only Ground Control entries through `config/batchWrite`. Normalize hook paths and identify entries by the installed command. Never calculate trust hashes or rewrite `config.toml` as text. Roster reads do not wait for the exchange; later reads expose any failure.

Codex dispatch translates permission modes to sandbox and approval settings. `plan`, `dontAsk`, and `bypassPermissions` are supported; `manual`, `auto`, and `acceptEdits` are refused. Workspace-write dispatch enables network access for jobs that push. The shared default `auto` therefore requires an explicit override for Codex actions. Codex ignores the requested dispatch display name.

[Codex stop authorization](../packages/agent-codex/src/codex.ts) is an in-memory map of threads dispatched by that adapter instance. The spawn PID takes precedence over a roster PID fallback. Persisted action records do not restore this authorization after a hub restart; stopping a previous run returns `stop-unknown` and requires intervention in Codex.

### Host adapters

[HostAdapter](../packages/core/src/host.ts) owns configuration, window discovery, persisted surfaces, and pure operation plans. Optional methods cover checkout opening, new-session starts, direct execution, and release. A plan returns a route or a specific refusal.

VS Code's `PLACEMENTS` table holds agent-in-editor knowledge: extension ID, process name, state keys or resource URI shape, reveal/start/focus commands, prompt support, and reveal idempotence. Agent adapters know nothing about these editor details.

| Agent | Editor identity | Reveal behavior |
|---|---|---|
| Claude | `claudeVSCodePanel`, saved `sessionID` | Existing tab reveals; sidebar is not included in tab deduplication |
| Codex | `chatgpt.conversationEditor`, `openai-codex://route/local/<id>` | Reopening the resource reactivates the tab |

Window discovery combines persisted workspace stores with process ancestry and listening ports. Claude's IDE lock files identify candidate windows. The shared main PID in those files is not a window identity. Codex process discovery uses the same announced-window set, so a window without a Claude announcement may be undiscoverable through this path. Connected clients also provide roots for checkout opening.

All implemented VS Code routes are resident: a connected extension performs them. The headless adapter does not execute editor commands, verify foreground focus, or release tabs. `release` remains unimplemented.

Commands use typed arguments (`text`, `uri`, or `absent`) until they reach the extension, where `vscode.Uri` can be constructed. A string is not interchangeable with a URI argument.

### Work sources

`WorkSource` owns configuration, ordinary item reads, and optional individual-card/context reads. GitHub uses `gh`; it reports source metadata and the accounts used for the read.

| Read result | Hub behavior |
|---|---|
| Items available | Replace that source's cached items |
| Failure with no items | Keep the last successful read and mark staleness |
| No items, failure, or needs | Clear that source's items; it is not configured to supply them |
| Missing identity selection | Return detected accounts as `needs`; do not choose one |

Invalid or removed source configuration clears its cached contribution immediately. Host configuration failures do not make otherwise valid issue data stale. Multiple source results merge into one board; the oldest source read determines issue freshness.

An individual-card lookup can return no card without error when the source does not serve that repository. Do not cache that as proof that an issue does not exist. The GitHub source is configured for a github.com `owner/name`; unrelated repository hosts do not match.

Project identity is owner login plus number in the search qualifier, project-item selection, and timeline status events. The status field name is a GraphQL variable on the assigned and by-number reads; the project's own `field(name:)` lookup tells an absent or non-single-select field from an unset value, and the source reports the first such problem as `fieldProblem` in `WorkItems`, which the hub carries into the snapshot for both clients. Timeline status events are read only for the built-in Status field.

### Agent profiles

`HubConfig.agentHomes` records each adapter's resolved absolute configuration root. `AgentAdapter.storage` declares its environment variable and default directory and rebinds an existing instance. Resolution prefers explicit accepted roots, then the launcher's agent environment, then the user-home default. Adapter operations snapshot their environment; profile changes preserve dispatch ownership, invalidate roster/history generations, and separate Codex trust results by home. Ground Control state, activity writers, and dispatch logs retain their independent legacy location.

The editor submits roots from its startup environment. Production editor/native launchers use the internal `--inherit-agent-env` switch so a cold hub selects those roots before its first read; plain CLI `--home` isolates agent defaults. Stored roots take precedence on browser-only restart. Reject invalid roots rather than falling back. A synchronous profile transition requires a complete successful roster no older than two seconds and no live or pending work. Preflight both hook files under the activity lock, remove only old owned entries while retaining markers/writers, then durably save and apply new roots. Uninstall loads the accepted roots. Keep refusal and write-failure diagnostics visible.

Host lock discovery receives the registry's accepted environment rather than the ambient process environment. Resident checks compare accepted roots with the editor's own profile before invoking agent commands. Terminal attach can explicitly select the accepted root. Cross-window links use the target Ground Control handler; a random, single-use resume token transfers the existing lease only to its recorded target workspace before expiry. The target still rechecks scope, live conflicts, and profile.

Codex activity markers remain in shared state and include a profile root. Readers reject markers from another selected profile. Legacy transcript paths can establish profile identity; ambiguous legacy markers are accepted only for the default home. No simultaneous-profile discovery is implied.

## Reads and snapshot construction

### Scheduling

| Operation | Default or bound |
|---|---|
| Work-source polling | 300 seconds |
| Session polling | 30 seconds |
| Scheduling tick | 5 seconds |
| Sleep detection | Tick more than 20 seconds late |
| Session/read coalescing floor | 1 second |
| Source refresh on becoming visible | Reuse reads younger than 60 seconds |
| Activity batch | 150 ms, fixed from first event |
| Source page timeout | 30 seconds |
| Per-card context page timeout | 20 seconds |
| Zero-client exit | `idleExitMs`, default 30 minutes, clamped 1 minute–24 hours, checked at most once a minute |

Configuration clamps source polling to at least 30 seconds and session polling to at least 2 seconds. These bounds are separate from the hub's read-coalescing and visibility floors.

Polling and activity processing stop when no board is watched. Connection alone is insufficient: an activated editor stays connected for settings even with its board closed. Log subscriptions do not make a board watched.

An in-flight read absorbs redundant requests. Changes it could not have observed queue a follow-up, including activity changes during a roster read and source configuration changes during a source read. Repeated visibility messages do not restart polling timers. Manual refresh and changed settings bypass the 60-second visibility floor, subject to normal coalescing.

A delayed tick after sleep requests both reads. A transient source outage with cached data retries silently for 60 seconds, while freshness remains marked stale. Retry intervals increase with outage duration: 5 seconds for the first 30 seconds, then 15 seconds, 60 seconds after two minutes, and 120 seconds after ten minutes. Initial-load and actionable failures are reported immediately. An already displayed failure remains displayed across a sleep gap.

The activity watcher re-arms after directory loss and handles initially absent paths. It classifies marker changes from existence and prior membership, not the platform event name. Deletion takes precedence within a batch. A known session's phase update reads its marker; roster-relevant changes request a new roster.

### Merge, history, lanes, and attention

`mergeBoard` joins assigned issues and live sessions, resolves ad-hoc identities, and attaches one historical fallback where eligible. Known different repository identities do not join solely by issue number. `assignLanes` applies membership, arrival rules, manual placements, and departure history. Attention is computed separately; a phase change does not move or reorder a card.

`HubConfig.sessionScope` stores shared include/exclude repository and directory lists plus `showHistory` and `showAdHoc`. Older configurations default to empty lists and true display switches. VS Code exposes these as application-scoped `sessions.*` settings; Chrome consumes the same projected state without another local editor for them.

Keep internal board construction separate from client projection. The complete live roster, historical evidence, retained activity, and action ledger remain available to duplicate checks, action settlement, and stop resolution. Client projection removes excluded session details and derived checkout fields while retaining assigned issues and minimal running-action stop state. Scope also gates session-derived remote issue lookups and current open/attach/resume/checkout/start authorization; recheck after asynchronous work to reject stale controls without echoing private values.

Repository rules accept shorthand, HTTPS, and SSH forms and normalize to lowercase host/owner/repository without `.git`; reject credentials and extra URL components. Includes combine by union and exclusions win. Unknown repositories cannot match repository includes and are excluded whenever any repository exclusion exists. Directory rules match cwd or verified checkout roots at segment boundaries, using case-insensitive Windows drive/UNC paths and case-sensitive POSIX paths. Resolve worktree repository identity through the shared git directory; do not claim symlink alias resolution.

History reads follow a complete successful roster read and are serialized with it. Replaced agent/pattern settings invalidate in-flight results. Phase-only marker changes do not scan history. Claude history reads are bounded to 64 KiB at each end of a transcript and cache parsed metadata by path and mtime. Each scan recomputes repository/pattern associations. Incomplete reads report failure rather than asserting no history exists.

Deduplicate saved sessions by `(agent, sessionId)` and newest modification time; exclude active identities. Choose a matching saved session by recency, with stable identity tie-breaks. Stable historical rows remain during successful refreshes; just-ended sessions wait for fresh history. Failed roster reads suppress history.

`status.json` retains observations from live sessions before their markers disappear. An explicit finished state removes any retained observation. Replace an observation when its phase or work interval changes; do not rewrite it on every heartbeat in the same interval. Attach retained state to a matching historical session or to a live session with no current phase. Discard observations older than the card's departure timestamp. Render retained running as Your turn, never as a running process. Prune only after complete roster and history reads establish that the session is absent from both.

Retained state is display evidence only. It is not input for triage or action authorization. An unwatched hub cannot retain events it did not observe.

### Issues outside the assigned set

`issues.json` caches issue metadata so a live session on a closed or unassigned issue can retain its title. Lookup waits until a source has successfully read; an initial empty snapshot is not proof of unassignment.

Known metadata remains usable while being refreshed. Refresh entries older than six hours; keep entries referenced by sessions or touched within 30 days. Limit lookup to three concurrent keys, deduplicate in-flight keys, and delay failed lookups for five minutes. A number a serving source confirms absent may be cached as absent; an unserved repository or failed request may not.

## Persistent state

Two directories exist. The bootstrap directory is fixed at `~/.claude/ground-control` under the user or injected home and holds only what external programs are registered to launch or read first: `state-dir.json`, `hub.js`, the native-messaging wrapper and its Windows manifest, `hook.mjs`, `codex-hook.mjs`, and `relocate.lock`. The state directory holds everything else below and defaults to the bootstrap directory. `resolveStateDir(home)` in core reads the pointer `{ stateDir, migration? }`; a missing or invalid pointer resolves to the bootstrap directory with a reported problem. Hub configuration cannot name the state directory because `config.json` lives inside it. Clients consume state through snapshots rather than editing these stores.

Threading: `home` locates agent defaults, agent settings, and hook writers; `stateDir` reaches stores, discovery, ensure, the logger, runners, activity watch/read, marker pruning, backups, the install lock, and dispatch logs. `MachineReaders` carries both. The hub fingerprint hashes the state directory, so the default fingerprint is unchanged for existing installations. Hook writers embed a shared snippet that follows the pointer at run time; a pointer mid-migration still names the old directory.

| Path | Contents and lifetime |
|---|---|
| `hub.json` | PID, port, token and running-hub record; may survive a forced termination |
| `hub-exit.json` | Recorded orderly exit or startup refusal |
| `hub.js` | Installed runnable bundle, bootstrap directory |
| `state-dir.json` | Pointer to the state directory and any migration in progress, bootstrap directory |
| `config.json` | Last accepted configuration |
| `lanes.json` | Manual placements, archived set, acknowledged returns, departure timestamps |
| `status.json` | Last observed activity by agent and session ID |
| `triage.json` | Results, evidence, trigger, revision and retry state |
| `triage-usage.json` | Automatic attempt timestamps for the rolling 24-hour limit |
| `actions.json` | Runs, retry delays, authorization evidence and daily ledger |
| `checkouts.json` | Explicit checkout picks by card |
| `issues.json` | Cached issue metadata and confirmed missing issues |
| `runs/` | Session-written action outcomes |
| `hub-marks.json` | Installation and announcement state |
| `activity/`, `codex-activity/` | Hook writer markers |
| `hub.log` | Hub diagnostics and process stdout/stderr |
| `<agent>-dispatch-<id>.log[.err]` | Detached dispatch stdout/stderr; Codex uses separate files |

Stores use validated reads and atomic writes where applicable. Configuration is parsed again when loaded from disk. The action runner fails closed if durable state or the previous outcome file cannot be updated safely. Other stores preserve their documented fallback behavior rather than claiming a successful write.

Lane departure is timestamped only on a new archive transition. Manual moves clear returned attention without erasing departure history. Membership-setting changes clear relevant placements and returned marks without restoring invalidated activity. Older lane records without dates are dated conservatively on read.

Hook settings are a separate write boundary: preserve unrelated groups and entries, back up first, and use in-place writes where Windows readers prevent rename. Under one filesystem lock, reconcile every registered adapter: install when the agent is configured, global `installActivity` is true, and its `sessionHooks` entry is not false; otherwise remove only owned entries. The optional map defaults to `{}` for saved configurations from older clients. VS Code supplies application-scoped `sessionHooks.claude` and `sessionHooks.codex`, both true by default; `installSessionHooks` supplies the authoritative global switch. Uninstall removes all owned entries regardless of configuration.

Removing hooks empties marker files without deleting the directory. Leave writer scripts for sessions that cached their paths, refreshing a retained writer whose content changed so those sessions follow the state pointer; they may continue writing until restarted. Codex live discovery depends on these markers and is reduced without hooks, while saved history remains readable. Codex's adapter continues to manage trust through its API; reconciliation never edits trust TOML. Installation results report both added and removed entries so mixed or removal-only changes receive accurate acknowledgments. Removal-only changes preserve the previous installation timestamp.

Retain five settings backups per agent. Best-effort cleanup removes markers older than 30 days, temporary files older than 60 seconds, and dispatch output older than seven days. File age is a cleanup heuristic, not proof that a process ended.

## Triage and automation

### Triage

`packages/board` interprets status and assignment timelines, derives actions from deterministic evidence, constructs prompts, and decides result freshness. `packages/hub` schedules reads and classification, persists results, and enforces budgets.

New configurations default to manual triage. Normalize legacy enabled to automatic/off when mode is absent; explicit mode wins. The editor distinguishes an unset legacy key from an explicit choice before sending configuration. Snapshot triage state supplies mode, request capability, and an informational message to both clients; Chrome cannot send classification requests.

The hub passes configured, accepted source IDs to the triage runner. Classification requires an enabled adapter with `classify` and an accepted source with `readContext`; registered but omitted/refused sources cannot provide it. Derive missing capability on every status read and distinguish it from missing/ineligible cards in manual refusals. Loss of capability cancels pending reads. No model-use announcement or usage reservation precedes capability resolution.

The runner reserves automatic attempts synchronously in `triage-usage.json` before source reads, default 100 per rolling 24 hours. Failed and cancelled attempts count; manual requests do not. Preserve future timestamps after clock rollback. Reject automatic starts if the record is corrupt or cannot be written; repair the record and restart the hub to clear a failed-write latch. Reading results and retry state cannot reset the allowance. Off aborts all readings, while manual aborts only automatic readings; check cancellation before invoking the classifier after an asynchronous source read.

Two values have different purposes:

- Evidence includes issue timestamp/status and selected PR number, state, timestamp, head commit, and failing-check state. Changes mark a result stale. Check rollup is reduced to red-or-not to avoid invalidating results during every build.
- Trigger tracks status changes and membership eligibility. These make automatic classification due. Age alone does neither.

`reviewDecision` is absent from triage evidence and prompts because it can lag the team's status-based handover. Arrival lane rules still use it.

Consecutive timeline changes by one identified actor within one minute form an instruction, dated at its first event. Ignore project-addition events with no previous status. Status and assignment changes can occur separately, so current status, previous status, and latest instruction time remain separate values.

Where deterministic rules fix an action, send that action to the classifier and request the explanation. Otherwise request both. Default to two concurrent classifications with a 180-second fetch/classification budget; configuration permits 1–8 and 10–300 seconds. Restrict background classification to watched boards. Manual retriage is editor-only with a 30-second per-card cooldown. Failure retries wait 1, 2, 5, and 30 minutes, then stop after the fifth failure. Stored results carry a triage revision so a decision-rule change can invalidate incompatible readings.

### Actions

`packages/automation` decides whether a candidate may run. `ActionRunner` handles fresh context, dispatch, session tracking, stop, and persistence. The implemented action is `merge-upstream`; mergeability is not fetched to invent requests.

The card must already have a merge-upstream candidate; a manual request cannot choose a different action. Fresh PR data supplies head commit, branches, ownership, and state for authorization. Only a session-derived checkout qualifies; an explicit checkout pick is insufficient for unattended work. The runner selects the first configured dispatch-capable adapter in registry order, currently Claude before Codex, rather than the card's previous agent. Both registered dispatch adapters also implement stop; the runner assumes this pairing when selecting by dispatch capability.

Concurrency counts tracked runs as well as dispatches in progress. Defaults are one concurrent run, ten dispatch attempts per rolling 24 hours, and 30 minutes for a dispatched session to appear on the roster. Configuration permits concurrency 1–4, daily limit 0–50, and appearance timeout 1 minute–4 hours. The appearance timeout does not limit the duration of a visible running session.

Automatic attempts are bounded by head commit, outcome, and a 30-minute retry delay. A recorded success blocks automatic repeats after its own push. Failed dispatches can retry and still count toward the daily ledger. Manual requests bypass automatic history but retain safety checks, concurrency limits, and positive daily limits. A zero daily limit disables automatic starts while allowing manual requests.

[ActionRunner](../packages/hub/src/actions.ts) writes run state and the ledger after dispatch returns. A write failure stops later dispatches but cannot undo an already started process. The daily check does not reserve capacity for pending dispatches, so concurrent requests can exceed the remaining daily allowance. A dispatch failure can also follow process creation when its ID is unreadable; `failed` is not proof that no process started. These are implementation limits, not durable admission guarantees.

Before dispatch, remove the previous result file. Read completion from the new file after the run settles. A missing report is stopped short. Treat the result as session-reported, not independent verification, and change no lane or source status. Keep active runs even when their cards disappear so stop remains available.

## Editor operations

### Reveal, attach, and resume

Live-session opening rechecks identity and plans from host records. Claude tabs reveal by ID; sidebar and unknown-surface routes focus and explain. Codex's idempotent resource reveal can operate with a known window but no readable sidebar identity.

Detached Claude sessions use `attachId` and a terminal running the configured executable with `['attach', id]`. They do not enter the normal surface plan. The browser uses `/attach?session=<id>`; the extension resolves the ID against its snapshot or a fresh projected roster, then checks shared authorization and current application scope before creating the terminal.

Historical opening refreshes roster/history and calls `canResume`. A now-active session takes the live route; another active session on the card refuses a stale historical click. Reserve resumes across clients before asynchronous discovery. A request retains ownership of its reservation; stale lookups cannot consume or delete a newer one. Routes have a 30-second firing deadline inside a 60-second reservation. Before executing, the resident checks the deadline, local scope/history preferences, and authoritative shared authorization after asynchronous reads or focus changes. `sessionCheck` returns only allowed/target-active/card-active booleans derived from the full roster; an empty projected roster cannot authorize a resume. Landing checks allow the expected newly resumed process.

Cross-window routes raise a known target, check focus where needed, and then invoke Ground Control's handover URI for target profile validation. Handover requests cannot route onward to a third window. Unexpected session creation is checked against the roster captured for the request, not against arbitrary later activity.

The resident launches its own `out/cli.js` through `Code.exe` in Node mode, with argument arrays and a sanitized environment. It checks the staged-update marker before launching. This check reduces duplicate-instance risk but does not detect every possible update state; see [mechanics](mechanics.md#vs-code-updates-and-window-launches).

### Checkout opening and new sessions

`checkoutFor` chooses a readable session checkout, then a valid explicit pick. It never chooses by repository match alone. `setCheckout` accepts an absolute folder from the editor picker and validates repository identity.

`planCheckout` reuses a live single-folder window or requests a new one. Browser requests can be performed by a connected editor on that root or another compatible editor; no connected performer yields a specific refusal. Include client hello roots in window discovery so windows running no agent are considered.

`planStart` requires the requesting window to be on the checkout. The hub fills `newSession.prompt` from card facts; clients cannot supply arbitrary prompts. `PLACEMENTS.start` determines the command and whether it accepts a prompt. Hold a 10-second lease by card and agent because no session ID exists yet. There is no outcome acknowledgement; the lease expires. Route keys distinguish checkout opens from starts and distinguish agents.

### Combined changes

The extension reads Git status and opens the editor. `changesPlan` in `host-vscode` folds merge-base-to-HEAD, index, and working-tree changes into one row per final file. It follows renames, not copies. `repositoryRefusal` verifies that VS Code returned the intended root before any diff is shown.

Refresh status after `git.openRepository`. Derive a merge base without `getBranchBase`, which writes Git configuration. Explicitly report unavailable base data and truncation. The multi-diff editor is editor-only and adds the repository to Source Control for the window's lifetime.

## Protocol and transport

The authoritative message types are in [protocol.ts](../packages/core/src/protocol.ts). Snapshots replace client state; there are no incremental patches. The protocol has an integer version and rejects incompatible clients.

| Client message | Purpose | Browser bridge |
|---|---|---|
| `hello` | Identity, host, workspace root, resident routes, visibility | Constructed by bridge |
| `configure` | Validated application settings | Refused |
| `watching`, `refresh` | Visibility and refresh | Allowed |
| `move` | Card key and valid lane | Allowed |
| `open` | Session ID, extension readiness, optional handover flag | Use editor URI instead |
| `retriage` | Explicit card classification | Refused |
| `runAction`, `stopAction` | Dispatch or stop a card action | Refused |
| `openCheckout` | Open a card's resolved checkout | Allowed |
| `setCheckout` | Validate and save a selected folder | Refused |
| `startSession` | Agent and card; root/prompt resolved by hub | Refused |
| `watchLog` | Subscribe or unsubscribe | Allowed |

Hub messages are `snapshot`, `changed`, `perform`, `notice`, and `log`. The bridge adds `trouble` for connection failures. `BoardMessage` types the extension-to-webview contract. The webview sends `ready` after script startup; the panel responds with current display state.

On reconnect, restate configuration and log subscription after `hello`. Never queue stale copies of these messages. Broadcast accepted/refused configuration before waiting for the resulting read, so a read floor cannot leave an obsolete error visible.

| HTTP route | Purpose |
|---|---|
| `GET /hub` | Identity, protocol, home fingerprint, optional nonce proof |
| `GET /snapshot` | Current snapshot |
| `GET /roster` | Fresh projected roster for visible session resolution and landing diagnostics |
| `GET /session-check?sessionId=<id>` | Current session authorization and full-roster conflict booleans, without private session details |
| `GET /events?client=<id>` | SSE stream, with 20-second heartbeat |
| `POST /actions?client=<id>` | Typed client action |
| `POST /shutdown` | Authenticated shutdown |

Bind to `127.0.0.1` on an ephemeral port. A client reads the discovery record, probes with a fresh nonce, and verifies the hub's HMAC before sending its token. Check home fingerprint and protocol too. File existence is not liveness. Actions require an open stream for the same client ID.

Reject `Origin` headers, incorrect `Host`, non-origin-form targets, non-JSON POSTs, bodies over 64 kB, and more than eight event streams. Record request-boundary refusals in the hub log, without reflecting sensitive details to the requester.

HTTP readers consume bytes. Do not call `setEncoding` on responses: the measured Node inspector path can throw on string chunks. Decode complete bodies or use `StringDecoder` for incremental streams.

### Native messaging

Chrome starts a per-user registered wrapper that runs the hub bundle in native-messaging mode. The bridge discovers/starts the hub and connects as a client with no host or resident routes. Its message allowlist is the browser boundary; the loopback server does not independently assign lesser privileges to that token-bearing client.

Frames contain a four-byte length and JSON body. Reassemble partial stdin chunks and reject claimed lengths above one megabyte. Keep wrapper stdout exclusively for frames. Redact refused-request origins from log messages before forwarding to Chrome.

Registration supports Google Chrome and Microsoft Edge from a per-browser table of documented locations (M53): a per-user Windows registry key each, and per-user manifest directories on macOS and Linux. `groundControl.overlayBrowsers` selects the set; enabling registers the selection and removes Ground Control's registrations for deselected browsers; disabling removes the selected registrations and keeps the launcher and shared manifest while another owned registration remains; uninstall selects every browser and removes everything it owns. On Windows all browsers share the one manifest in the bootstrap directory; elsewhere each browser directory receives its own copy. Registrations are per user while wrapper and manifest are per home, so removal touches a registry value or manifest file only when it names this home's manifest or wrapper; anything else is reported and left in place. Other platforms are refused by name. The wrapper names the stable home bundle, not a versioned extension directory.

### Relocation

The VS Code `groundControl.stateDirectory` setting (machine scope) drives `relocateState` in the hub package; the hub does not read the setting. Order: refuse an unusable pointer, an unreadable source, or running card actions in `actions.json`; validate the target (absolute with dot segments collapsed, not nested either way after resolving links through the nearest existing ancestor, not a file, empty apart from launch artifacts and transient `hub.json`, `hub-exit.json`, `install.lock`, `*.tmp`); take `relocate.lock`, reporting busy to a second window, and renew it per copied entry; write the pointer with `migration { to, startedAt }` while still naming the old directory; stop the recorded hub and wait until nothing answers; copy every other entry with exclusive creation, failing on any entry that appeared meanwhile, and verify hashes; commit the pointer, or delete it for the bootstrap directory; remove the moved sources and report leftovers. Failure before or at commit removes only the copies this move created and restores the previous pointer. `serveHub` refuses while a migration younger than `MIGRATION_STALE_MS` is recorded or the pointer is invalid, writes the reason to `hub-exit.json`, and rechecks the pointer after binding so a move recorded during startup is not crossed. Markers written by hook events between copy and source removal are lost until the session's next event; detached dispatch processes keep their original log handles and report paths, which is why running actions block a move. The extension suspends its client during the move so its restart budget is not spent on refused starts, then resumes; ensure resolves the pointer on every attempt, so other clients follow it. On activation with the setting unset, the extension writes the pointer's directory into the setting instead of moving; only a changed setting moves state. On activation, `recoverRelocation` clears a migration marker when the lock is free and reports the destination that may hold copies.

## Hub lifecycle

On activation, copy the bundled hub to the stable bootstrap path when newer; equal versions compare bytes. Do not overwrite a newer bundle with an older one. Compare bundle mtime to the running hub record to replace an older running copy. Stop using the record that was probed, not a later reread that may belong to a replacement. A client with no restart budget must not stop a hub it cannot replace.

Single-instance ownership uses exclusive record creation after probing an existing record. Port allocation alone cannot establish exclusivity because each process binds an ephemeral port. A losing process closes and exits. Only the process whose PID still owns the record removes it.

A newer protocol client may stop an authenticated older hub and start the newer bundle. An older client neither stops nor replaces a newer hub; it reports incompatibility. Keep `/hub` discovery fields backward-compatible so identity remains distinguishable from an unrelated listener.

VS Code starts its own executable with `ELECTRON_RUN_AS_NODE`, detached, hidden, and unreferenced. Redirect stdout/stderr to `hub.log`. Sanitize `ELECTRON_*`, `VSCODE_*`, and `NODE_OPTIONS` before child CLI execution.

Connection retries double from one to 30 seconds. Limit consecutive failed starts to one per minute and three per five minutes; a successful connection resets the budget. Different failure modes identify absent records, silent ports, foreign listeners, wrong homes, failed token proofs, and protocol mismatches. Retry a quiet short probe with a longer deadline before treating it as unreachable.

Use authenticated shutdown or `ground-control-hub --stop` for orderly exit. Forced termination on Windows does not run cleanup. Uninstall stops the hub and removes hooks, registration, and bundle while retaining writer compatibility for already running sessions.

The installed VSIX contains its own hub bundle. A repository build alone does not update it. Build, package, reinstall, and inspect the installed bundle when delivering executable changes; the developer chooses when to reload.

## Client rendering and diagnostics

The VS Code panel owns display preferences such as archive visibility. Persist the standing archive choice in `globalState`; a temporarily empty archive does not overwrite it. The webview reports its rendered DOM through `drew`. If no report arrives within ten seconds of opening, display a script-start failure. Extension exports are read-only `snapshot`, `drew`, and `logs` accessors used by integration tests.

The overlay separates DOM rendering (`overlay.js`), snapshot state (`state.js`), browser policy (`preferences.js`), and Chrome/observer wiring (`content.js`, `worker.js`). Inject across github.com to handle soft navigation; only render on enabled, allowed project roots and view pages. The options page stores `{enabled, projects}` in `chrome.storage.local`; defaults are enabled and an empty allowlist. Shared hub settings remain in VS Code, reached through its supported settings URI.

Content and worker load validated preferences before allowing access; newer storage changes take precedence over delayed initial reads. Content ports report pathname, eligibility, document visibility, and page generation independently of animation frames. The worker independently checks policy, updates all memberships before reconciling watching, and delivers only to eligible ports. Hidden allowed project tabs may keep requested logs streaming. Losing eligibility immediately clears page state, stylesheet, and DOM changes and unsubscribes logs. The last eligible tab leaving or closing disconnects the native port. Reconnects restate current state.

Retain unchanged card footers in a `WeakMap` keyed by GitHub's card element and content signature. Replaced nodes rebuild. Disarm the observer while painting and appending logs. Duration updates modify existing text nodes; delayed image failures hide nodes instead of repeatedly removing/recreating them. View switches, scroll, resize, and detached anchors must not leave menus or tooltips incorrectly positioned.

Keep the latest browser snapshot only in worker memory for the current hub connection; do not persist snapshots in browser storage. After either the bridge or hub disconnects, clear that snapshot and wait for fresh hub data before tabs receive any replay. A connection alone cannot confirm current session scope. New or reconnected content waits for current state instead of painting data from a prior connection. An already displayed snapshot may remain marked stale while disconnected. Check current page eligibility before delivery and ignore callbacks from replaced native ports. Restate watching and logging when the worker reopens the native port. An invalidated extension context (`chrome.runtime.id` absent) stops observers/timers and requests a tab reload instead of retrying forever.

The hub writes timestamped, leveled, optionally scoped logs. Persistent failures are deduplicated by subject and kind. Default `info` retains connection, source, action, and failure diagnostics; `debug` adds frequent details. Keep non-parsing stdout/stderr lines as raw output, associated with the preceding timestamp.

Read and stream `hub.log` only while subscribed. Opening sends a disk tail; drop a partial first line. VS Code uses a `LogOutputChannel` for its own messages and a plain output channel for already timestamped hub lines. Streaming state is explicit because VS Code exposes no output-channel visibility event.

The browser combines browser and hub lines in one in-memory sidebar. Its worker aggregates subscribers: first viewer subscribes, last viewer unsubscribes; additional viewers receive the buffered history. Reconnects announce repeated backfill. Closing the last viewer drops hub history, since reopening requests a fresh tail. Outside click closes unless pinned. Creating the sidebar must precede the subscription response.

## Data boundaries

Board persistence is local, but normal operation includes remote GitHub reads and model-backed classification. Triage sends card conversation and identity data to the model service. Dispatched agents run locally with the configured permissions and may contact model services, repositories, and other tools permitted by their settings. Do not describe dispatch as having no external data flow.

Snapshots include private issue text and in-scope session names, paths, branches, and identities. Session scope is an output and authorization boundary, not an operating-system read restriction: safety checks retain internal roster data, and display switches do not imply that all history reads stop. Scope does not rewrite or delete existing diagnostic files. Logs may contain additional operational details and arbitrary process output. The overlay inserts these into github.com, where page scripts can read the DOM. Only refused-request origins receive the specific browser redaction; other log contents are not guaranteed public.

Any process running as the developer can read the hub record and token. Authentication protects against other users and web-origin requests, not against processes already running with the developer's authority. Windows file modes are not a substitute for that distinction.

## Future workflow integration

Future workflow integration uses a work source that reads durable per-item workflow state. That state controls automated stage movement, including transitions from manually placed lanes; GitHub status remains an input. Stage completion must be validated from runner-produced evidence.

Stop-and-take-over requires a resident extension operation that identifies and releases the exact session surface. Automatic resume must retain developer input, prevent concurrent writers, and reconcile tabs restored by VS Code. A successful probe using mutable tab labels is insufficient as a production identity mechanism.

Steering, queue recovery, usage-limit scheduling, structured review output, and test-evidence validation have experimental evidence in [mechanics](mechanics.md#workflow-and-recovery-experiments). They are implementation options and constraints, not registered capabilities or settled permission policies.

Adding an agent requires an adapter, registry entry, tests, and any desired host placement support. Adding a host requires a host adapter and, where necessary, resident execution. Adding a work source requires its adapter and an explicit decision about how its data affects cards. Optional methods must represent real capabilities; do not add no-op implementations.
