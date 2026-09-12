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
| `extensions/chrome-github-board` | Worker, content script, DOM rendering, pull request panel, browser state | `core` types; local JavaScript modules |

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

An activity signal supplies settings-edit plans, paths, a reader, and optionally a writer script. The hub performs installation and filesystem operations. A missing signal produces no phase; it must not manufacture idle state. Phases are running, waiting, idle, and failed; a failed activity carries the error kind and message. Claude's failed phase comes from its `StopFailure` marker. Codex's comes from the rollout: a running marker with a turn ID makes the reader tail the transcript for that turn's `task_complete` or `turn_aborted` record, which the hub's session poll picks up because rollout writes do not touch the marker.

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

The VS Code host settings carry `uriScheme` from `vscode.env.uriScheme`; the hub puts it in every snapshot as `editor.uriScheme`, the overlay writes session links with it, and cross-window handovers use the running editor's scheme. Stored settings keep the last value for browser-started hubs.

Sources receive a `BoardPolicy` when configured: the review statuses derived from `statusLanes` and the `avatar` policy. The GitHub source selects the card avatar from it, so both clients show the same person and avatars agree with lane arrival. The source also owns linked accounts (R28): `configure` normalizes `linkedAccounts` into lowercase alias-to-target links and warns about the entries it drops; the profiles of the targets live in one cache beside the accepted configuration, filled by `PROFILE_QUERY` through a read every entry point (`read`, `readCard`, `readDetail`, `readContext`) awaits and shares while in flight, fresh for 24 hours and retried an hour after a failure, which keeps the last profile; transient, credential, and missing-CLI failures leave the cache alone. Link warnings are logged once per change of the settings, not on every client resend, and a read with no logins returns before any profile is spent. `accounts.ts` resolves each actor the card, detail, and context readers map, so `IssueCard`, `ItemDetail`, and `TriageContext` leave the package already substituted, with `aliasOf` carrying the recorded login and `owners` and `TriageContext.logins` resolved and deduplicated. Nothing downstream knows a link exists. Project identity is owner login plus number in the search qualifier, project-item selection, and timeline status events. The status field name is a GraphQL variable on the assigned and by-number reads; the project's own `field(name:)` lookup tells an absent or non-single-select field from an unset value, and the source reports the first such problem as `fieldProblem` in `WorkItems`, which the hub carries into the snapshot for both clients. Timeline status events are read only for the built-in Status field.

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

History reads follow a complete successful roster read and are serialized with it. Replaced agent/pattern settings invalidate in-flight results. Phase-only marker changes do not scan history. Claude history reads are bounded to 64 KiB at each end of a transcript and cache parsed metadata by path and mtime. Each scan recomputes repository/pattern associations. A saved Claude session's `cwd` is the last `relocated` record's directory, else the launch record's: where Claude resumes, and whose slug names the project directory holding the transcript. Later record cwds follow the shell and are ignored; `branch` still takes the last `gitBranch`, so a session that only `cd`'d into a worktree links to that branch's issue while resuming in the repository ([mechanics](mechanics.md#claude-historical-discovery) M3c). Incomplete reads report failure rather than asserting no history exists.

Deduplicate saved sessions by `(agent, sessionId)` and newest modification time; exclude active identities. Choose a matching saved session by recency, with stable identity tie-breaks. Stable historical rows remain during successful refreshes; just-ended sessions wait for fresh history. Failed roster reads suppress history.

`status.json` retains observations from live sessions before their markers disappear. An explicit finished state removes any retained observation. Replace an observation when its phase or work interval changes; do not rewrite it on every heartbeat in the same interval. Attach retained state to a matching historical session or to a live session with no current phase. Discard observations older than the card's departure timestamp. Render retained running as Your turn, never as a running process; retained waiting and failed keep their phase and error. Prune only after complete roster and history reads establish that the session is absent from both.

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
| `worktrees.json` | The worktree each provisioning run reported, by card (R46) |
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

### Reading one conversation

`readDetail` names a card key and a subject; the hub resolves the card from its own snapshot, so a client never names a repository or an address. `WorkSource.readDetail` returns null for a card the source does not serve, distinct from a subject it serves and cannot find. The GitHub source reads `bodyHTML` and one `timelineItems` connection, so no client parses markdown and no client orders the conversation. Answers reach the requesting client alone and are neither cached nor broadcast: a body is large, changes independently of its card, and is wanted only while someone is reading it.

One `timelineItems` list carries comments, review summaries, commits, and state changes together, so the panel never merges collections or sorts by timestamp. `ItemDetail.events` keeps that order. A comment or review becomes a `DetailPost` with its body, reactions, and hidden reason; everything else becomes a `DetailNote` whose one-line `summary` the source composes, because the wording is a product decision rather than a client one, and whose `icon` names the badge GitHub draws for that event, so a client draws the octicon without parsing the words. Issues and pull requests request different `itemTypes` against different unions, so the shared event selections are one string spread into both.

A pull-request read also returns `reviewThreads`, which an issue read omits. Each thread hangs off the review its first comment belongs to; the rest are sorted by file then line and listed after the conversation, since the panel does not show the diff they hang off.

Both connections page backwards — `last`/`before`, newest page first — so a read that stops early drops the oldest entries and never the latest. Follow-up pages go in their own documents, so a second timeline page never refetches the threads; `DETAIL_EVENTS_QUERY` carries the event fragments and `DETAIL_THREADS_QUERY` only `who` and `reacted`, because a document must spread every fragment it defines. `moreEvents`, `moreThreads`, and a thread's `moreComments` all come from `pageInfo.hasPreviousPage`. No count is reported, for the reason recorded in [M54](mechanics.md#conversation-timeline-reads). A page that fails after the first leaves the conversation short and clipped rather than failing the read. Paging stops at 20 event pages and 5 thread pages, but the hub's 60-second read budget usually stops a long read first.

The webview sanitizes source HTML before it reaches the document, keeping an element and attribute allowlist and only `http`/`https` addresses. Class names are filtered by value, because the board's own class names position and style chrome that conversation markup could otherwise wear. Conversation images come from GitHub's user-content hosts and its attachment and asset hosts, which the board's `img-src` policy names.

The panel is modal: a scrim dims the board, and everything outside the panel is `inert` while it is open, because `aria-modal` tells assistive technology that nothing outside exists. The VS Code panel owns whether conversations are read on the board (`groundControl.readConversations`), whether a pull request opens beside its issue (`groundControl.pairConversations`), and the dragged widths of the single panel and the pair, sending all of it to the webview as `reading`. The widths are `globalState` mementos, as archive visibility is, one per mode, and `setDetailWidth` says which it sizes; a setting change reaches an open board without a reload. The webview holds one open conversation as a card key and a list of subjects, one state per subject, so a pair is two `readDetail` requests answered separately and drawn as two `.detail-scroll` regions in one `#detail` aside marked `data-paired`, each region its own container so the title and control rules read its width rather than the panel's.

## Triage and automation

### Triage

`packages/board` interprets status and assignment timelines, derives actions from deterministic evidence, constructs prompts, and decides result freshness. `packages/hub` schedules reads and classification, persists results, and enforces budgets.

New configurations default to manual triage. Normalize legacy enabled to automatic/off when mode is absent; explicit mode wins. The editor distinguishes an unset legacy key from an explicit choice before sending configuration. Snapshot triage state supplies mode, request capability, and an informational message to both clients. Either can request a classification; the hub validates the card and rate-limits the request, because the browser boundary decides who may ask, not whether the request is sound.

The hub passes configured, accepted source IDs to the triage runner. Classification requires an enabled adapter with `classify` and an accepted source with `readContext`; registered but omitted/refused sources cannot provide it. Derive missing capability on every status read and distinguish it from missing/ineligible cards in manual refusals. Loss of capability cancels pending reads. No model-use announcement or usage reservation precedes capability resolution.

The runner reserves automatic attempts synchronously in `triage-usage.json` before source reads, default 100 per rolling 24 hours. Failed and cancelled attempts count; manual requests do not. Preserve future timestamps after clock rollback. Reject automatic starts if the record is corrupt or cannot be written; repair the record and restart the hub to clear a failed-write latch. Reading results and retry state cannot reset the allowance. Off aborts all readings, while manual aborts only automatic readings; check cancellation before invoking the classifier after an asynchronous source read.

Two values have different purposes:

- Evidence includes issue timestamp/status and selected PR number, state, timestamp, head commit, and failing-check state. Changes mark a result stale. Check rollup is reduced to red-or-not to avoid invalidating results during every build.
- Trigger tracks status changes and membership eligibility. These make automatic classification due. Age alone does neither.

`reviewDecision` is absent from triage evidence and prompts because it can lag the team's status-based handover. Arrival lane rules still use it.

Consecutive timeline changes by one identified actor within one minute form an instruction, dated at its first event. Ignore project-addition events with no previous status. Status and assignment changes can occur separately, so current status, previous status, and latest instruction time remain separate values.

Where deterministic rules fix an action, send that action to the classifier and request the explanation. Otherwise request both. Default to two concurrent classifications with a 180-second fetch/classification budget; configuration permits 1–8 and 10–300 seconds. Restrict background classification to watched boards. Manual retriage has a 30-second per-card cooldown. A browser request also requires a watching client and reserves against the daily allowance, because the per-card cooldown bounds one card rather than a caller working through every key. Failure retries wait 1, 2, 5, and 30 minutes, then stop after the fifth failure. Stored results carry a triage revision so a decision-rule change can invalidate incompatible readings.

### Actions

`packages/automation` decides whether a candidate may run. `ActionRunner` handles fresh context, dispatch, session tracking, stop, and persistence. The implemented action is `merge-upstream`; mergeability is not fetched to invent requests.

The card must already have a merge-upstream candidate; a manual request cannot choose a different action. Fresh PR data supplies head commit, branches, ownership, and state for authorization. The run works in the card's worktree (R46); `planAction` states the PR facts and the runner supplies the directory, so a card with no worktree passes the PR checks and then provisions rather than being refused. The runner selects the first configured dispatch-capable adapter in registry order, currently Claude before Codex, rather than the card's previous agent. Both registered dispatch adapters also implement stop; the runner assumes this pairing when selecting by dispatch capability.

**Worktree runs.** `CREATE_WORKTREE` is a `DispatchedAction`, not a triage action: `ActionRun.action` takes it, and `ActionRun.next` names the action it precedes, or nothing for one asked for alone. `#dispatchWorktree` fills `worktree.prompt` with `worktreePromptValues` and dispatches it from the clone `cloneFor` picks out of `ActionDeps.clones()` — the hub's `clonesOf` over `#worktreeScan` roots — refusing where there is no clone or more than one. `#settle` routes a `create-worktree` run to `#settledWorktree`, which reads the same result file, requires `ready` with `worktree`, and calls `ActionDeps.linkWorktree`; the hub's `#linkWorktree` normalizes the path, checks scope, indexes the reported directory as a root itself so a clone never seen before still registers, requires the entry's repository to be the card's, and writes `worktrees.json`. A linked run with `next` re-enters `#run` as a chained request, which `withDispatch` does not count again; `alreadyRun` ignores worktree runs, which carry no PR evidence. `cardActionOf` shows a chained worktree run as its `next` action running at `stage: 'worktree'`, and one that ended short of the action as that action done; a linked run, or one with no `next`, never reaches `card.action`. `worktreeCreationOf` gives the worktree control its state, and `decorate` puts it on `card.creation` only for a card with an issue, no worktree, and not read-only. The worktree session starts in the clone, so it links to an ad-hoc card of the clone, not the issue's card; `#settle` finds it by short id like any dispatched session.

Concurrency counts tracked runs as well as dispatches in progress. Defaults are one concurrent run, ten dispatch attempts per rolling 24 hours, and 30 minutes for a dispatched session to appear on the roster. Configuration permits concurrency 1–4, daily limit 0–50, and appearance timeout 1 minute–4 hours. The appearance timeout does not limit the duration of a visible running session.

Automatic attempts are bounded by head commit, outcome, and a 30-minute retry delay. A recorded success blocks automatic repeats after its own push. Failed dispatches can retry and still count toward the daily ledger. Manual requests bypass automatic history but retain safety checks, concurrency limits, and positive daily limits. A zero daily limit disables automatic starts while allowing manual requests.

[ActionRunner](../packages/hub/src/actions.ts) writes run state and the ledger after dispatch returns. A write failure stops later dispatches but cannot undo an already started process. The daily check does not reserve capacity for pending dispatches, so concurrent requests can exceed the remaining daily allowance. A dispatch failure can also follow process creation when its ID is unreadable; `failed` is not proof that no process started. These are implementation limits, not durable admission guarantees.

Before dispatch, remove the previous result file. Read completion from the new file after the run settles. A missing report is stopped short. Treat the result as session-reported, not independent verification, and change no lane or source status. Keep active runs even when their cards disappear so stop remains available.

## Editor operations

### Reveal, attach, and resume

Live-session opening rechecks identity and plans from host records. Claude tabs reveal by ID; sidebar and unknown-surface routes focus and explain. Codex's idempotent resource reveal can operate with a known window but no readable sidebar identity.

Detached Claude sessions use `attachId` and a terminal running the configured executable with `['attach', id]`. They do not enter the normal surface plan. The browser uses `/attach?session=<id>`; the extension resolves the ID against its snapshot or a fresh projected roster, then checks shared authorization and current application scope before creating the terminal.

Historical opening refreshes roster/history and calls `canResume`. A now-active session takes the live route; another active session on the card refuses a stale historical click. Reserve resumes across clients before asynchronous discovery. A request retains ownership of its reservation; stale lookups cannot consume or delete a newer one. Routes have a 30-second firing deadline inside a 60-second reservation; a roster read that lists the session live ends the reservation early, so a session closed after a roster read saw it live can be reopened at once. Before executing, the resident checks the deadline, local scope/history preferences, and authoritative shared authorization after asynchronous reads or focus changes. `sessionCheck` returns only allowed/target-active/card-active booleans derived from the full roster; an empty projected roster cannot authorize a resume. Landing checks allow the expected newly resumed process.

Session links name the agent as well as the session. A window a link activates can have no snapshot, and resolving the agent without one assumes Claude and reports the wrong extension's readiness. The snapshot wins where it carries the session; the link is the fallback, and its value is shape-checked before use. Attach links carry no agent: the terminal route resolves one from the roster.

Cross-window routes raise a known target, check focus where needed, and then invoke Ground Control's handover URI for target profile validation. Handover requests cannot route onward to a third window. Unexpected session creation is checked against the roster captured for the request, not against arbitrary later activity.

A redirected resume (R44) splits across three components. `host-vscode` decides eligibility in `repositoryWindowFor` and puts `worktree` on the route, which is the directory the session must run in and what landing checks compare against; `worktreePointer` returns the environment or a refusal. The resident owns the mutable part: it assigns those variables to the extension host it shares with the Claude extension, reveals, holds past the tab, and restores, under a module-level flag admitting one redirect at a time. `runCode` drops the project-directory variable while that flag is set, so a launched window inherits nothing.

The window that receives the handover is the one that redirects, so a redirected resume depends on the reservation transfer above rather than on any route of its own.

The resident launches its own `out/cli.js` through `Code.exe` in Node mode, with argument arrays and a sanitized environment. It checks the staged-update marker before launching. This check reduces duplicate-instance risk but does not detect every possible update state; see [mechanics](mechanics.md#vs-code-updates-and-window-launches).

### Checkout opening and new sessions

`checkoutFor` chooses a readable session checkout, then a valid explicit pick, then the issue's worktree. It never chooses by repository match alone. `setCheckout` accepts an absolute folder from the editor picker and validates repository identity.

`clonesOf` in `core` resolves the distinct clones a set of directories belong to; `worktreesOf` lists one clone's main tree and its registrations under the shared git directory; `worktreeIndex` keys every working tree by `dirKey` and, through `branchIssuePattern`, by repository and issue number; `worktreeFor` picks one card's entry, preferring the root `worktrees.json` records for the card when the index still holds it in the card's repository. `withCheckouts` builds the index once per lane computation behind the same read cache the checkout pass uses, and puts `worktree` on the card independently of `checkout`. The hub assembles the clones to search in `#worktreeScan` from session checkout roots, historical session directories, remembered picks, recorded worktrees, connected client workspace roots, and `repositoryRoots`; it holds no repository list of its own. Scope strips `worktree` alongside `checkout`. Git metadata is read from disk; the project runs no git process.

`planCheckout` reuses a live single-folder window or requests a new one. Browser requests can be performed by a connected editor on that root or another compatible editor; no connected performer yields a specific refusal. Include client hello roots in window discovery so windows running no agent are considered.

`planStart` requires the performing window to be on the checkout. An editor performs its own start; a browser has no window, so the hub picks one the way `planCheckout` does and plans against that window’s root, and the performing window rechecks its folder and its agent extension because a page states neither. The hub fills `newSession.prompt` from card facts; clients cannot supply arbitrary prompts. `PLACEMENTS.start` determines the command and whether it accepts a prompt. Hold a 10-second lease by card and agent because no session ID exists yet, and hold page-asked starts to one at a time: the per-card lease bounds one card, not a loop over every card and agent. `Snapshot.startable` reports what a connected editor can start, so a browser is offered nothing while none is connected, and browser clients are resent when that changes. There is no outcome acknowledgement; the lease expires. Route keys distinguish checkout opens from starts and distinguish agents.

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
| `retriage` | Explicit card classification | Allowed, metered and watching-gated |
| `runAction`, `stopAction` | Dispatch or stop a card action | Allowed; a start needs `actions.fromBrowser` |
| `openCheckout` | Open a card's resolved checkout | Allowed |
| `createWorktree` | Run the worktree prompt for the card alone (R46) | Allowed; needs `actions.fromBrowser`, like a start |
| `setCheckout` | Validate and save a selected folder | Refused |
| `startSession` | Agent and card; root, prompt, and window resolved by hub | Allowed, watching-gated |
| `watchLog` | Subscribe or unsubscribe | Allowed |
| `readDetail` | Read one card's conversation for display | Refused |

Hub messages are `snapshot`, `changed`, `perform`, `notice`, `log`, and `detail`. The bridge adds `trouble` for connection failures. `BoardMessage` types the extension-to-webview contract. The webview sends `ready` after script startup; the panel responds with current display state.

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

### Development hubs

Discovery identity is the home directory: the bootstrap directory, the `state-dir.json` pointer, `hub.json`, and the hub fingerprint all derive from it, and every client reads `os.homedir()`. A hub started for another home is therefore invisible to the installed extension and the browser bridge, and they cannot replace it. `groundControl.stateDirectory` does not isolate: it moves the state a home's clients share, and discovery still follows that home's pointer.

The isolated workflow needs no production setting:

- Hub alone: `node apps/hub/dist/main.js --home=<isolated home>` starts a hub with its own bootstrap and state directories and agent defaults under that home; `--inherit-agent-env` is the only way it reaches the launcher's real agent profiles. `--stop` with the same `--home` ends it. `npm run hub` targets the real home and is replaced by the next installed-extension activation, which is the behavior to avoid.
- Editor: launch the extension development host with `USERPROFILE` and `HOME` set to the isolated home and `VSCODE_PORTABLE` set to a scratch directory, as [.vscode-test.mjs](../extensions/ground-control/.vscode-test.mjs) does. The portable directory keeps the test build from taking over the `vscode://` registration (M49); the home makes the extension write its bundle, hooks, and state under the isolated home and connect to the isolated hub. Set `CLAUDE_CONFIG_DIR` and `CODEX_HOME` under the same home so hook installation and history reads touch no real agent profile.
- Browser: native-host registration is per user, so a browser always reaches the real home's bridge. The only isolated browser is the headless Playwright copy without `nativeMessaging` used by the Chrome integration tests; there is no isolated interactive browser path.
- Protocol mismatches need no new handling: a development hub answers only clients of its own home, and installed clients keep their version checks and replacement rules against the real hub.

A blanket setting that leaves incompatible installed clients on an old hub is not part of this; contributors who want a long-lived development hub use a separate home.

## Client rendering and diagnostics

The VS Code panel owns display preferences such as archive visibility. Persist the standing archive choice in `globalState`; a temporarily empty archive does not overwrite it. The webview reports its rendered DOM through `drew`. If no report arrives within ten seconds of opening, display a script-start failure. Extension exports are read-only `snapshot`, `drew`, and `logs` accessors used by integration tests.

The overlay separates DOM rendering (`overlay.js`), the pull request panel (`panel.js`), snapshot state (`state.js`), browser policy (`preferences.js`), and Chrome/observer wiring (`content.js`, `worker.js`). Inject across github.com to handle soft navigation; only render on enabled, allowed project roots and view pages. The options page stores `{enabled, projects, animations, replaceAvatars, filteredToMe}` in `chrome.storage.local`; defaults are enabled, an empty allowlist, and the remaining toggles on, and a stored object without the later keys keeps those defaults. `filteredToMe` joins the allowlist as an eligibility condition rather than a presentation one, read from the single input in GitHub's filter toolbar; the worker caches the hub's `Snapshot.owners` under `logins` in the same area, and content follows that key the way it follows preferences. `paint` receives the presentation: animation off sets `data-gc-motion="reduced"` on the document root for the stylesheet's reduced-motion rules, and replacement off rebuilds cards whose assignee stack was replaced so GitHub's figure returns. The editor board mirrors `groundControl.animations` as `body[data-motion="reduced"]` from a `presentation` message. Shared hub settings remain in VS Code, reached through its supported settings URI.

Content and worker load validated preferences before allowing access; newer storage changes take precedence over delayed initial reads. Content ports report pathname, eligibility, document visibility, and page generation independently of animation frames. The worker independently checks policy, updates all memberships before reconciling watching, and delivers only to eligible ports. Hidden allowed project tabs may keep requested logs streaming. Losing eligibility immediately clears page state, stylesheet, and DOM changes and unsubscribes logs. The last eligible tab leaving or closing disconnects the native port. Reconnects restate current state.

Both clients draw the command bar (R45) from their own copy of the lane pictogram table, because neither can import the other's module at runtime; their suites pin the geometry literally. The overlay writes the returned label into GitHub's card header rather than its own footer, and removes a stale one on every paint, because that node belongs to GitHub and is redrawn independently.

The pull request panel (R43) is `panel.js`: `paint` starts a capture-phase click listener on the document that takes a plain primary click on any `/pull/<n>` link inside a card, and `clear` removes it and the panel. The panel is one `#gc-panel` dialog appended to `body`, with the backdrop and sheet GitHub's own panel has (M58), and an `iframe` named `gc-pull-panel` on the pull request address. GitHub answers every page with `X-Frame-Options: deny` and `frame-ancestors 'none'`, so `rules.json` is a static `declarativeNetRequest` rule that removes `x-frame-options` and `content-security-policy` from a response that is a `sub_frame`, or an `xmlhttprequest` since logged-in GitHub's service worker fetches issue pages for a frame that way (M58), initiated by `github.com`, and addressed at `/<owner>/<repo>/pull/<n>` or `/<owner>/<repo>/issues/<n>` or a page under either; the manifest carries the `declarativeNetRequest` permission and a `github.com` host permission for it. The rule is what admits the page, so the panel treats a frame Chrome refuses, whose `contentDocument` is null, as a refusal and says so with a link. The frame is same-origin, so on each `load` the parent reads the page's `h1` for the dialog name, appends a stylesheet that hides the site header, repository header, and footer and puts it back if the page's head drops it, closes on Escape pressed in the page, and sends any link off this pull request to a new tab, since a frame on any other address would be refused. The parent's handlers read the frame's nodes by method rather than `instanceof`, and the head observer is the frame's own `MutationObserver`, because the frame's nodes belong to another realm. While the panel floats every other child of `body` is `inert`, and each control acts only on its own panel, since a closed one stays in the page through its 200ms slide out. Pinned (`data-pinned`), the root narrows to the panel's width at the right, the backdrop is hidden, `aria-modal` is false, nothing is inert, and the page's `main` (or `body` where there is none) takes a right margin of the panel's width so the board reflows beside it. Widths are a `--gc-panel-width` variable on the root; the grip is a `role=separator` button on the sheet's left edge that drags with pointer capture and steps 40px on arrow keys, as the editor board's is, within 360px to 95% of the window floating, 720px to 95% for a pair, and 256px to the window less 300px docked. With the `pairConversations` preference on, `watchPulls` reads the card's first `/issues/<n>` link and `openPanel` marks the root `data-paired`, puts a `.gc-panel-frames` row in the sheet holding an `iframe` named `gc-issue-panel` on the issue and the pull request frame after it, each loaded through the same `framed` path that dresses the page, closes on Escape, and sends links off that page to a tab, offers no pin, never stores the pin choice, sizes from `ground-control:pair-width`, and keeps the bar as a floating strip of controls alone at the sheet's top right, which the pull request page's sticky header still takes when stuck. The pin choice and the docked width are GitHub's own `localStorage` keys, `projects.sidePanelPinned` and `projects.sidePanelWidth`, which GitHub's issue panel reads when it opens, so the two panels share one pin state and one docked width; the floating width is `ground-control:panel-width`, since GitHub keeps none. `dressIssuePanel` also closes the pull request panel, without moving focus, when GitHub's issue panel opens in either form, and lifts the pinned pane's inline `--pane-max-width` cap to the docked maximum so the shared width fits, on every paint, since Primer rewrites the cap on resize and its own drag handle still clamps to it; `openPanel` closes an open pinned pane through its own Close control after taking its width, so a click on a pull request beside a pinned issue reads as the one pane changing content. The pane it closed keeps its name until GitHub finishes, so the panel remembers that name and gives way only to a pane named otherwise, once a paint has found the old one gone. `dressIssuePanel`, run on every paint, gives GitHub's own floating issue panel the same grip: it finds the dialog by its `Side panel` name and the sheet by the inline `--side-panel-width` variable GitHub sizes it with, writes the shared floating width into that variable, and rewrites it whenever GitHub redraws the sheet without it; the grip stands on the dialog, fixed at the sheet's edge, and follows the sheet through a `ResizeObserver`, because the sheet scrolls. The panel's own insertion and removal are mutations the board observer sees, so each open and close costs one repaint, which does not touch the panel. Nothing is cached: reopening loads the page again.

Retain unchanged card footers in a `WeakMap` keyed by GitHub's card element and content signature. Replaced nodes rebuild. Disarm the observer while painting and appending logs. Duration updates modify existing text nodes; delayed image failures hide nodes instead of repeatedly removing/recreating them. View switches, scroll, resize, and detached anchors must not leave menus or tooltips incorrectly positioned.

Keep the latest browser snapshot only in worker memory for the current hub connection; do not persist snapshots in browser storage. After either the bridge or hub disconnects, clear that snapshot and wait for fresh hub data before tabs receive any replay. A connection alone cannot confirm current session scope. New or reconnected content waits for current state instead of painting data from a prior connection. An already displayed snapshot may remain marked stale while disconnected. Check current page eligibility before delivery and ignore callbacks from replaced native ports. Restate watching and logging when the worker reopens the native port. An invalidated extension context (`chrome.runtime.id` absent) stops observers/timers and requests a tab reload instead of retrying forever.

The hub writes lines as `<ISO timestamp> [<level>] [<scope>] <message>`, with the scope omitted for process-wide lines. Both brackets match the editor `log` grammar so levels are colored in the output channel and in `hub.log` itself. Persistent failures are deduplicated by subject and kind. Default `info` retains connection, source, action, and failure diagnostics; `debug` adds frequent details; `warn` and `error` drop lifecycle lines. Keep non-parsing stdout/stderr lines as raw output, associated with the preceding timestamp. `HubConfig.logs` carries rotation size and count and dispatch-output retention; the file sink reads the limits on each write and the hub sweeps dispatch output with the current retention each time settings are applied, so changes apply to the running hub. A count lowered later deletes the generations above it; zero truncates hub.log in place because the launcher holds it open as the hub's stdout. Process stdout and stderr are redirected into the same file by the launcher, so recording cannot be switched off.

Read and stream `hub.log` only while subscribed. Opening sends a disk tail; drop a partial first line. VS Code uses a `LogOutputChannel` for its own messages and a plain output channel with the `log` language for already timestamped hub lines. Streaming state is explicit because VS Code exposes no output-channel visibility event.

The browser combines browser and hub lines in one in-memory sidebar. Its worker aggregates subscribers: first viewer subscribes, last viewer unsubscribes; additional viewers receive the buffered history. Reconnects announce repeated backfill. Closing the last viewer drops hub history, since reopening requests a fresh tail. Outside click closes unless pinned. Creating the sidebar must precede the subscription response.

## Data boundaries

Board persistence is local, but normal operation includes remote GitHub reads and model-backed classification. Triage sends card conversation and identity data to the model service. Dispatched agents run locally with the configured permissions and may contact model services, repositories, and other tools permitted by their settings. Do not describe dispatch as having no external data flow.

The browser channel can start a classification and a card action. A classification sends card conversation and identity data to the model service and spends the developer's allowance; a card action runs an agent that modifies a checkout. Both require a watching client. Classifications from the browser are metered against the daily allowance; card actions need `actions.fromBrowser`, a positive daily limit, and an enabled action. Stopping needs no opt-in, so a page script can interrupt any running action and leave a partially merged checkout; it is bounded only by the watching and scope checks. The editor's own manual requests keep their exemptions, and the editor's stop stays unconditional so a scope change cannot strand a run. The overlay's controls sit in github.com's DOM, so a page script can dispatch a click at one: these hub gates, not the click handler, are what bound the result.

The pull request panel's header rule removes a framed pull request page's whole `Content-Security-Policy`, because Chrome removes a header and not one directive of it. The framed page then runs without its script and connection restrictions for that one document. The rule reaches only a page framed by a github.com page, only under `/pull/`, and never a page another site embeds or a top-level navigation; the page keeps its own cookies, session, and same-origin rules, so what the frame can do is what the tab could. No data leaves the browser that the tab would not send.

Snapshots include private issue text and in-scope session names, paths, branches, and identities. Session scope is an output and authorization boundary, not an operating-system read restriction: safety checks retain internal roster data, and display switches do not imply that all history reads stop. Scope does not rewrite or delete existing diagnostic files. Logs may contain additional operational details and arbitrary process output. The overlay inserts these into github.com, where page scripts can read the DOM. Only refused-request origins receive the specific browser redaction; other log contents are not guaranteed public.

Any process running as the developer can read the hub record and token. Authentication protects against other users and web-origin requests, not against processes already running with the developer's authority. Windows file modes are not a substitute for that distinction.

## Future workflow integration

Future workflow integration uses a work source that reads durable per-item workflow state. That state controls automated stage movement, including transitions from manually placed lanes; GitHub status remains an input. Stage completion must be validated from runner-produced evidence.

Stop-and-take-over requires a resident extension operation that identifies and releases the exact session surface. Automatic resume must retain developer input, prevent concurrent writers, and reconcile tabs restored by VS Code. A successful probe using mutable tab labels is insufficient as a production identity mechanism.

Steering, queue recovery, usage-limit scheduling, structured review output, and test-evidence validation have experimental evidence in [mechanics](mechanics.md#workflow-and-recovery-experiments). They are implementation options and constraints, not registered capabilities or settled permission policies.

Adding an agent requires an adapter, registry entry, tests, and any desired host placement support. Adding a host requires a host adapter and, where necessary, resident execution. Adding a work source requires its adapter and an explicit decision about how its data affects cards. Optional methods must represent real capabilities; do not add no-op implementations.
