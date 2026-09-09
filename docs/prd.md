# Ground Control requirements

Ground Control is a personal board for assigned GitHub issues and local Claude Code and Codex sessions. A VS Code extension and an optional GitHub project overlay share one background process.

This document defines product behavior and future requirements. [Architecture](architecture.md) describes the implementation; [mechanics](mechanics.md) records experiments, including mechanisms not used by the product; [testing](testing.md) defines verification.

## Audience and scope

The audience is any OwnerRez developer using their own machine. Support one clone with branch switching, multiple clones, and multiple worktrees. Do not require multiple editor windows, a second agent, or continuous agent use.

In scope: assigned issues, local sessions, inspecting work, opening checkouts and sessions, and explicitly enabled automation. Team conventions belong in configurable defaults. Personal accounts, paths, permissions, and limits belong in user settings.

Out of scope: other people's work as a separate workload, remote sessions, team reporting, and unrequested GitHub writes. Sessions on an issue no longer assigned to the developer remain inspectable as described in R9.

Future development may add coordinated workflow stages, verified stage completion, interruption, and recovery. Those requirements are listed separately below; experiments demonstrating their feasibility do not establish product support.

## Cards and sessions

### R1. Assigned issues

Show one card per assigned issue, with repository, number, title, and type. Treat all configured GitHub accounts as the developer's identity.

The configured card source selects assigned issues on the project or all assigned open issues. Report excluded and truncated results. Do not imply the displayed set is complete when it is not.

### R2. Local sessions

Show sessions from enabled agent adapters, including work unrelated to an assigned issue. Identify the agent by its official mark where available, otherwise by name. Keep brand colors where the mark has them; monochrome marks follow the theme.

Exclude:

- The board's own classifier processes.
- Sessions that have never started work: no transcript, no reported activity, and no agent status. A missing transcript alone is insufficient.

With hooks installed and a board visible, target arrival within one second of a session's first prompt and departure within one second of its end event. Polling detects changes without an event, including killed processes and renamed sessions. These targets depend on the agent's signal and successful reads.

### R3. Issue-linked sessions and history

Group matching live sessions under their issue card. Multiple sessions may work on one issue. Idle and waiting sessions remain live.

For an issue card with no live sessions, show one saved session: the matching transcript with the newest modification time. Match using its saved branch, then saved directory name, and the configured issue pattern. Require the checkout's origin repository to match the issue repository. Do not use the checkout's current branch to assign historical work.

A saved row:

- Uses the same one-line layout as a live row, with an outlined state mark and no working animation.
- Resumes on click, subject to R14's checks.
- Shows retained activity when available; otherwise its transcript age.
- Does not affect lane placement or live counts.

History creates no ad-hoc cards. Unknown repository identity, missing metadata, or an unreadable checkout can prevent a historical match. A partial or failed live-roster read suppresses history until inactivity can be established. A history failure does not disable live rows.

### R4. Ad-hoc work

Group sessions without a confirmed issue by canonical repository and branch. Sessions started in subdirectories join their checkout's card. Separate clones on the same repository and branch share a card; a branch switch produces a different card.

If repository or branch identity is unavailable, use the checkout directory instead. Do not combine unrelated unknown repositories or detached checkouts.

Name the card by repository and branch, falling back to directory. Qualify the repository owner on hover. Show which checkout is used when several qualify. An ad-hoc card exists only while it has live sessions, but its saved lane applies to later work with the same card identity.

### R5. Card presentation and controls

A card must show its stage, sessions, activity, attention, and relevant ages without opening another view.

| Area | Content |
|---|---|
| Header | Repository, issue number, title, type/status labels, selected pull request, avatar, overflow menu |
| Footer | Triage result and session rows; visually and accessibly separated from GitHub's fields |
| Session row | State mark, agent mark, truncated name, duration |

The footer remains present when empty. Cards and page use the same base tone; lanes are recessed and footers have a small contrasting tint. Borders distinguish cards when theme backgrounds coincide.

State marks use three meanings: working, waiting for the developer, and idle/unknown as applicable. Filled marks represent live sessions; outlines represent saved sessions. Provide accessible names for information conveyed by color and fill. Only the session responsible for card attention uses the card's attention color; do not recolor or embolden that session's name to repeat the same signal.

Animate the name of a working live session. Respect reduced motion and forced colors. Session names are more prominent than agent marks and durations.

Durations use one unit, rounded down: seconds, minutes, hours, days, or weeks. Update once per second without rereading the machine. A running duration starts at the prompt that began the turn; other phases start at the reporting event. For work resumed without a prompt, use the first observed event. This duration includes waiting within the turn; it is not CPU time. Hover explains the phase, time basis, exact timestamp, and last observation without duplicating the name.

The card itself is not clickable. Titles, chips, and session rows have their own controls and hover feedback. Overflow menus contain secondary actions; hide unavailable items. Reveal card menus on hover, keyboard focus, and devices without hover. Keep current state when rebuilding an open menu.

The board header has one menu for archive visibility, logs, refresh, and Settings. Archive appears first. Check toggle items and mark the menu control while hub logging is enabled.

Both clients draw tooltips rather than native `title` tooltips. Open after 120 ms, close on pointer exit, and support focus except inside menus where automatic focus would obscure other items. Provide descriptions independently of tooltip visibility. Do not repeat text already visible on a chip.

Select the most recently updated open closing pull request; if none is open, select the most recently updated closing pull request of any state. Render its chip with a neutral outline and state-colored glyph. Use accessible text for the state. Selection is limited to the fetched page; see [GitHub query limits](mechanics.md#github-query-cost-and-limits).

For a status ending in `Dev Review`, show the selected pull request's author. Otherwise show an assignee, preferring the developer's configured identity. Label the role. This status-name rule is independent of lane mapping. The overlay replaces GitHub's assignee display only where an author should replace it and an assignee area already exists; otherwise leave GitHub's display intact.

Issue and pull-request controls open URLs resolved from source data. A guessed issue number is not sufficient to construct a link.

### R6. Attention

| Condition | Card indication |
|---|---|
| Session waiting for permission, an answer, or approval | Needs you; highest priority |
| Session completed a turn but is still open | Your turn |
| Live session working, with neither attention condition | Dashed working border, no attention tint |
| Agent explicitly reports the session finished | No session attention |

Attention uses the card border, a tint, and the responsible row's state mark. Working borders animate; reduced motion retains a static dashed border. Activity changes do not reorder cards.

Implementation gap: the idle-attention branch does not exclude explicitly finished sessions. A finished session with idle activity can still produce Your turn outside Done, Icebox, and Archived. The intended rule is no session attention after an explicit finish.

Retain the last observed activity after a process disappears. Retained waiting still needs the developer; retained running becomes Your turn because the process is gone. Retain by session identity, not by card. Age does not clear it. An issue's departure from active membership invalidates observations older than that departure (R9).

Done, Icebox, and Archived suppress Your turn and the working border. Needs you remains visible in every lane.

## Lanes and membership

### R7. Lanes

Lanes are independent of GitHub project statuses.

| Lane | Purpose |
|---|---|
| Unstarted | Work not begun |
| Plan | Agree what to build |
| Build | Implement or answer changes requested on your work |
| Review | Review a diff or await review of your work |
| Done | Confirm completion |
| Icebox | Work deliberately set aside |
| Archived | Issues outside active board membership; optionally displayed |

Hide empty Done and Icebox lanes except during a drag, when they must be available as destinations. There is no Blocked lane: attention remains on the card in its existing lane.

### R8. Arrival and manual placement

A card has exactly one lane. Before manual placement, derive its lane from configured status mappings and the developer's own open pull request.

| Evidence | Arrival |
|---|---|
| Status mapped to Build | Build, regardless of review decision |
| Own open PR is a draft or has changes requested | Build |
| Own open non-draft PR, without changes requested | Review |
| No qualifying own open PR | Configured status lane, otherwise Unstarted |
| Ad-hoc work | Build |

Closed, merged, and other people's PRs do not override the status. Defaults map Assigned to Unstarted, Dev to Build, and Dev Review to Review.

Dragging or Alt+arrow on a focused card sets its lane. Persist that choice across clients, refreshes, and restarts. Status, PR, and session changes do not override it. R9 defines the departure exception. Future workflow state controls automated stage movement and may move a manually placed card.

### R9. Archive, departure, and return

The membership status setting determines which assigned issues remain active. Other statuses archive the issue. Show an archive count and an optional Archived lane through the header menu. Hide the menu item when the archive is empty; remove an empty displayed lane without erasing the user's standing preference to show it.

On a genuine departure, clear manual placement and record a departure timestamp. If the card returns, derive its lane again, mark it returned, and sort it first in that lane. A manual move acknowledges the return. Record departure once per transition, not on every refresh.

Retained session activity is valid only if observed after the card's recorded departure. Clearing a returned mark does not clear this timestamp.

Changing the membership setting clears returned marks and placements on already archived cards. Narrowing membership also clears placement for newly archived cards. Do not erase historical departure timestamps or discard triage solely because the setting changed. This prevents a settings edit from presenting false returns or restoring invalidated activity.

There are two different rules for live sessions:

- An assigned issue in an excluded status remains active while it has a live session. Keep its lane and display its status.
- An issue absent from the assigned read can still appear because a live session names it. Resolve its real metadata from the cache or source and archive it, even while the session remains live. Distinguish closed, unassigned, and otherwise absent issues accurately.

Archived issues outside the assigned set retain inspection and checkout opening, but offer no triage, card action, or new-session start. Do not show triage from their previous assignment. Needs you remains visible in Archived.

If the source cannot establish the issue at all, use an ad-hoc card. Do not treat the initial absence of a source response as an empty assigned set.

### R10. Counts

Show a card count per lane. Do not hide or refuse developer-started sessions to enforce work-in-progress limits. Limits apply to board-dispatched work (R33).

## Inspecting and opening work

### R11. Current activity and names

Show the latest observed phase and update it as events arrive. Name sessions by the last manual title, then automatic title, then agent-provided name and other fallbacks. A directory-derived CLI name must not override an available title.

Detailed live descriptions of individual tool calls remain a future requirement. The implemented activity view reports phases and their durations; streaming experiments in [mechanics](mechanics.md#claude-print-mode-and-streaming) demonstrate a possible source for finer detail.

### R12. Non-interrupting inspection

Viewing state must not stop or alter a session. Tracking must avoid connections that evict an agent's existing editor integration.

### R13. Long-running activity

Show the phase and its duration without converting running to idle merely because no event arrived. A long command may legitimately be silent. Hover identifies the last observed event; do not claim automatic stuck-session detection.

### R14. Open or resume a session

An editor session opens by ID, with the prior conversation available. Use the agent's supported operation and apply these rules:

- Reveal an existing tab in its owning window.
- For Claude in a sidebar, focus the sidebar/window and identify the requested session; opening another surface can duplicate its process.
- When the owning window is known but its surface is not, reveal only if the agent's operation is idempotent. Otherwise focus the window and explain the limitation.
- Attach to a live detached Claude run in a terminal (R39).
- Recheck history before resuming: confirm readable liveness, valid saved data, no conflicting live session on the card, and no pending resume. Use a final fresh roster check and an expiry deadline.

Determine the owning window from process and host records, not from session cwd alone. Explain missing, stale, or not-yet-persisted placement. Do not substitute a newly opened empty window for the owner of an active session.

Historical resumes use the saved directory and a standalone window. Reuse a suitable single-folder window or explicitly open a new one; do not depend on the user's folder-opening preference. Agent-specific history validation remains necessary.

Opening or raising another window obeys `openWindowsForSessions`, enabled by default. A refusal caused by this setting offers to enable it. Do not modify the agent extension's preferred location as a side effect.

Check cross-window focus and unexpected session creation. Refuse editor launches when the staged-update check detects a version mismatch; explain the required restart. This protection has a known detection limit recorded in [mechanics](mechanics.md#vs-code-updates-and-window-launches).

Missing extensions, unsupported agents, unavailable sessions, ambiguous windows, and expired requests receive specific refusals.

### R18. Prevent accidental duplicate sessions

Do not open a second editor process on a session already held elsewhere. Session identity determines duplication, not the issue or checkout: intentionally starting another session on the same card is allowed (R42).

Use window and surface records before opening. Labels cannot establish identity. Two windows sharing one workspace store remain an ambiguity; fail conservatively when the records cannot resolve it.

### R37. Combined changes

From a card's verified checkout, open one diff showing branch commits and uncommitted changes together, from merge base to disk. Use a session-derived or explicitly selected checkout (R41); do not guess from an issue number or branch name.

If no merge base is available, show uncommitted changes and state that limitation in the title. State truncation and identify the selected checkout when several qualify. Do not change Git configuration or branches to inspect work. Refuse a repository mismatch.

Opening this view adds the repository to the window's Source Control list until reload. This operation is available only in the editor.

### R41. Open or select a checkout

Open an editor window on the card's checkout without starting an agent. Resolve the directory from a session that ran there, otherwise from a folder the developer selected for the card.

Never infer a checkout merely because its remote matches the issue's repository. Several worktrees can share that remote. The editor's folder picker validates the selected directory against the card's repository and remembers it per card and machine.

Offer only readable directories; skip a deleted session checkout if another qualifying one exists. Preserve saved picks while their cards are absent, but do not offer a pick that no longer validates.

Reuse an existing single-folder window, obey R14's window permission, and explain when the requesting editor already has the checkout open. The overlay can request opening by card ID through a connected editor; it cannot supply a path or choose a folder.

### R42. Start a session

Offer one start item per supported agent on a card with a checkout. Start in the requesting window only. For another checkout, direct the developer to open it first.

The `newSession.prompt` setting defaults to empty. Substitute `{issue}`, `{repo}`, `{title}`, `{url}`, and `{checkout}`; leave unknown placeholders unchanged. Prefill without submitting. Claude accepts the prompt; Codex's available start command opens a bare session, which its menu item states.

Allow additional sessions on the same card. Prevent repeated starts for the same card and agent during the launch interval. These deliberate starts do not consume automation limits. The overlay cannot start sessions.

## Triage and card actions

### R38. Triage

Classify a newly eligible card, a returned card, or a card whose status changed. Show one action and a short explanation. Actions include Develop, questions, QA failure, review, answer review, fix checks, merge upstream, and Other.

Determine the action from status and PR facts where possible; ask the model for the explanation. When those facts do not settle the action, ask the model to choose it too. Do not correct the action after generating a contradictory explanation.

| Input | Rule |
|---|---|
| Status mapped to Review | Review, except an own open PR requires further interpretation |
| Status mapped to Unstarted | Develop |
| Status mapped to Build, or unmapped | Inspect PR facts and conversation |
| Failing checks | Deterministic evidence, subject to status precedence |
| Merge upstream | Requires a written request or a deliberate action; never infer from mergeability |

Read status and assignment events alongside comments. Consecutive changes by the same identified person, no more than one minute apart, form one instruction dated at its first event. Different people or anonymous actors do not combine. Comments before the latest instruction are background. Adding the issue to a project is not an instruction.

Use submitted reviews and relevant comments to distinguish initial review from follow-up. Ignore draft reviews. Without a known PR author, submitted reviews alone cannot establish a prior round; developer comments and replies remain evidence. Do not use `reviewDecision` as triage evidence; lane arrival uses it separately (R8).

The explanation describes status and responsibility, not technical implementation. Address the developer as “you”; use colleagues' first names, profile-name overrides, or logins as fallback. Do not invent counts from a partial conversation. Other covers waiting with no identified action. The label is visible; the explanation and classification time are on hover. The label's adjacent age is time in the current status.

Mark triage stale when issue/PR evidence changes. Age alone does not invalidate it. Automatically reread only on eligibility or status changes; other changes mark it stale without spending another model call. Triage never moves a card.

Run only while a board is visible or on an explicit editor request, with bounded concurrency, timeout, and retry backoff. Stop automatic retries after the retry budget. A failed classification leaves no result label; show the failure once above the board and retain a retry control. The overlay displays results but cannot request classification.

Completed triage has a separate reread control, accessible by keyboard and touch. Clicking the label or age to inspect its explanation must not start classification or spend usage.

Triage is enabled by default and sends issue/PR text, recent comments, identities, review information, and status/assignment history to the configured model service. It uses the developer's usage allowance. Provide a setting to disable it. Classifier sessions have no tools, MCP servers, developer settings, or saved conversation visible to the board.

### R39. Merge-upstream action

The only implemented unattended card action merges a PR's base branch into its head. It is disabled by default and requires a developer-supplied prompt. Supply issue, repository, PR, branches, and checkout facts to that prompt; do not define the repository's build, test, push, or commenting policy.

Automatic eligibility comes from triage identifying a requested merge. A manual editor control can run or retry that candidate even when automatic dispatch is disabled; it cannot create a merge candidate on an unrelated card. Before dispatch, reread the PR and apply all safety checks and configured limits.

Refuse drafts, other people's PRs, closed/merged PRs, disallowed lanes, active work on the card, missing session-derived checkouts, and stacked PRs whose base is not the repository's default branch. A manually selected checkout alone cannot authorize unattended edits. If merge is not a candidate action, show neither a merge control nor an irrelevant refusal.

Bound automatic work by:

- Concurrent runs and starts in a rolling 24-hour window.
- One attempt per head commit, except attempts recorded as failed.
- A 30-minute reconsideration interval after an automatic decision.
- No automatic repeat after a successful outcome, even if its push changed the head.
- Durable run records; a failed write prevents further dispatch.

An explicit manual request can bypass automatic eligibility history and cooldowns, but not safety checks, the required prompt, or concurrency limits. A positive daily limit also applies to manual requests; zero disables automatic starts while allowing manual requests.

Track the dispatched process as an ordinary session, identify it as board-started, and notify the developer on the first dispatch. A detached Claude row attaches in a terminal at its checkout; closing the terminal leaves it running. The overlay can attach through the editor link but cannot start or stop work, and does not display action outcomes.

Read an outcome and explanation from the run's designated result file. Clear the previous file before starting; if that fails, do not dispatch. Missing output means stopped short. This is a session-reported outcome, not independently verified stage completion: it changes no lane or GitHub status.

Stopping a run warns that work in progress may be incomplete. Do not reset a partially merged checkout. Report a failed stop and keep the control available. Automatic repair of failing checks and general conflict resolution are not additional actions.

Implementation limits: run records are written after dispatch returns, so persistence failure can leave an already started process unrecorded. Concurrent starts can exceed the remaining daily allowance because pending requests do not reserve it. Failed attempts count toward that allowance and can include a process whose ID could not be read. Codex stop authorization is lost on hub restart, even though the action record remains. These gaps require implementation work to meet the intended dispatch and recovery guarantees.

## Setup, permissions, and lifecycle

### R26. First-run setup

Target: show useful work on first run, detect available information, and ask once in place for what cannot be detected. Do not silently display an empty board when configuration is missing.

Implementation gap: the repository defaults to empty, so first run still requires repository configuration. GitHub identity can be detected but must be selected by the developer. Whether the OwnerRez repository should ship as a default remains a product decision.

On activation by a board, command, restored board, or URI, install enabled activity hooks with backups. Preserve unrelated entries and refuse malformed settings. Merely installing the extension without activating it must not change agent settings.

### R27. Shared defaults and personal settings

Ship team status conventions, lane defaults, project selection, and branch patterns as configurable defaults. Keep personal logins, paths, window permissions, agents, logging, and automation limits in user settings. Settings sent to the shared hub are application-scoped so windows do not disagree.

The repository-default gap is recorded in R26. The distribution of additional team defaults remains open.

### R28. Multiple GitHub identities

Allow several accounts to represent one developer. Require an explicit selection; authentication alone does not establish which account's work to display.

### R29. Checkout layouts

Support a single clone, multiple clones, and worktrees without imposing directory layout. Use configured branch conventions and verified checkout identity.

### R30. Optional agents

Detect optional agents without repeatedly spawning missing tools. Codex detection uses its home directory. Claude is enabled by default without an installation check and can report a missing executable; disable it explicitly on a Codex-only machine. Explicit agent configuration replaces the default set and can supply executable paths.

Codex supports live sessions, saved history, phases, opening threads, and dispatch. It does not classify cards. Refuse unsupported permission modes explicitly.

Install and trust only Ground Control's Codex hooks. Obtain hashes and write trust through Codex's own API; do not calculate hashes or rewrite TOML directly. Preserve other hooks and trust entries. If trust cannot be established, explain the failure and manual remedy.

### R31. Dispatch permissions

Use the least authority under which the unattended job can complete. Pass the chosen mode explicitly. Modes requiring unanswered prompts are not suitable defaults for unattended work.

Claude defaults to `auto`; bypassing permissions requires a deliberate setting. Codex translates supported modes to its own sandbox and approval policy and refuses unsupported ones. A global default accepted by Claude is not necessarily accepted by Codex.

Triage has no tools or developer settings and offers no broader permission mode.

### R32. Opt-in automation

Unattended code changes start disabled. Enable actions individually, each with its own prompt. Triage is a separately configurable read that costs model usage and sends text off-machine; it is enabled by default. Starting a prefilled editor session is a deliberate user action, not unattended automation.

### R33. Limits

The developer sets concurrent and daily limits on dispatched card actions. Do not apply them to sessions started independently or deliberately through R42.

### R34. Settings and reversibility

Expose supported personal settings through normal editor settings and a Settings menu item on the board.

Disabling hooks removes Ground Control entries immediately. Uninstall removes hooks too. Leave the inert writer file available for sessions that cached the old settings, so they do not fail on every event. Overlay registration is explicitly enabled and can be disabled or removed on uninstall.

### R35. Shared background process

One hub per machine performs reads and maintains shared board state. Clients report whether a board is visible. Stop polling, activity reads, automatic triage, and automatic action starts when none is visible. Already dispatched processes continue independently. An activated editor remains connected for configuration changes even with its board closed.

Exit after 30 minutes with no connected clients. Start on demand and remember accepted settings so the browser can use them without an editor running.

A newly visible board receives cached issues if the previous source read is less than one minute old; otherwise request a read. This is a refresh floor, not a maximum age guarantee. Normal GitHub polling defaults to 300 seconds and session polling to 30 seconds. Manual refresh and relevant settings changes bypass the visibility floor. Display freshness accurately and retry transient failures.

### R36. GitHub overlay

On supported GitHub project pages, add triage and session rows inside matching issue cards, with the same names, phases, durations, attention, and open/attach behavior as the editor board. Preserve GitHub's card controls and drag behavior. Offer local lane moves without changing GitHub status.

Session links can launch VS Code even with no editor client connected. Checkout opening requires a connected editor to resolve and perform the request. The overlay cannot choose filesystem paths, start sessions/actions, stop actions, request triage, or open combined diffs.

Offer a persistent option to collapse GitHub's project title, view tabs, and unsaved-filter controls. Reduce inter-column spacing and retain theme-appropriate dividers. Persist the collapse choice across boards and reloads.

## Accuracy and diagnostics

### R24. State accuracy

Report observed phase and age without inventing state. Reject malformed, mismatched, or excessively future-dated activity. Use the agent's normalized state only when no accepted observation exists. Explicitly distinguish saved activity and session-reported action results from live observations and verified completion.

### R25. Failures and limitations

Give each actionable failure a specific explanation and remedy. Show board-wide failures once, not on every card. Do not add per-card explanations that merely repeat visible state.

For a transient source failure with cached data, retain that data, mark freshness accurately, and retry silently for one minute. Report initial-load failures and actionable failures immediately. After the grace period, show the transient failure and explain that retry is automatic.

In the overlay, failures use dismissible notices; informational details belong in its menu. Announce newly installed hooks once per client, including how many existing sessions may need restart. Repeat the announcement only after a new install cycle.

### R40. Logs

Provide both client and hub logs. Record client connection and failure history without requiring a viewer. Detailed message logging is off by default.

Subscribe to hub logs only on request, starting with recent history. Subscription is independent of board visibility and must survive reconnects. Show its state in a control available even after the board closes; stopping streaming retains displayed lines.

The overlay log closes on outside click unless pinned. Filters are reversible. Redact refused-request origins before sending hub logs to the browser. Other displayed log contents may include private work data readable by scripts on the host page; do not describe them as public or local-only.

## Future workflow requirements

These requirements are retained goals, not implemented capabilities. Relevant experiments remain in [mechanics](mechanics.md#workflow-and-recovery-experiments).

| ID | Requirement | Constraint |
|---|---|---|
| R15 | Stop an automated session and take over in an editor | Explain interruption cost, including in-flight subagents, before stopping; offer inspection or redirection where possible |
| R16 | Prefill a likely response when taking over | Do not auto-submit; distinguish this from the generic new-session prompt in R42 |
| R17 | Resume automated work after the developer closes the takeover tab | Confirm release, preserve session identity and developer input, and prevent duplicate writers |
| R19 | Redirect work without stopping it | Retain editable working notes as an intended interaction; direct message injection is an experimental alternative requiring a product decision |
| R20 | Resume after a usage limit resets | Display the reason and expected resume time; do not count such waiting as active automated work |
| R22 | Recover interrupted work | Resume outstanding work or explicitly report what could not be recovered |
| R23 | Require evidence before stage completion | Validate runner-produced artifacts; an agent's success report alone cannot advance a stage |

### R21. Bounded retries

Implemented: transient source failures and failed triage/dispatch starts retry under their respective limits. Future: extend bounded retries to interrupted workflow stages. Escalate persistent failures to the developer rather than retrying indefinitely.

## Open product decisions

- First-run repository default and distribution of additional team configuration (R26–R27).
- Which coordinated stages should be implemented.
- Whether finer tool-level activity is needed beyond the current phase view (R11).
- Redirection through notes, direct messages, or both (R19).
- Manual issue linking when branch and directory conventions cannot establish a match.
- A read-only evaluation mode before installing hooks or enabling model-backed triage.
- Further automation candidates. Fixing failing checks requires its own scope and refusal rules; general merge-queue conflict resolution is outside this team's current scope. Unattended overnight operation is not a committed goal.

## Success criteria

- A developer can identify active work and sessions needing attention from one board.
- Closing an editor does not erase unresolved session attention the board observed.
- Opening work uses the correct session and checkout without accidental duplication.
- Failures and partial reads are visible without repeated noise.
- Another developer can adopt the board without reproducing one person's machine layout.
- Future takeover and recovery preserve developer input and verify completion before advancing work.
