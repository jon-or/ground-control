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

The configured card source selects assigned issues on the project or all assigned open issues. `github.maxPages` (1–10, default 5) bounds the pages of 100 read per refresh; each page is one API request, and GitHub search returns at most 1,000 results. Report excluded and truncated results. Do not imply the displayed set is complete when it is not.

Identify the project by owner and number; the owner setting defaults to the repository owner. Read status from the configured single-select project field, default `Status`. Report a missing or non-single-select field as a diagnostic in both clients; affected cards keep a null status and remain active. Only the built-in Status field records status changes on the issue timeline (M32), so triage receives status-change instructions with that field alone and assignment events with any other. One repository per configuration; multiple repositories and GitHub Enterprise are out of scope.

### R2. Local sessions

Show in-scope sessions from enabled agent adapters, including work unrelated to an assigned issue unless ad-hoc display is disabled. Identify the agent by its official mark where available, otherwise by name. Keep brand colors where the mark has them; monochrome marks follow the theme.

Shared `sessions.includeRepositories`, `excludeRepositories`, `includeDirectories`, and `excludeDirectories` lists default to empty. Empty includes permit all sessions; otherwise include matches combine by union across repository, working directory, and canonical checkout root. Exclusions win. Repository entries normalize supported shorthand, HTTPS, and SSH forms to lowercase host/owner/repository without credentials or `.git`. Unknown identities cannot match repository includes; any repository exclusion hides unknown identities conservatively. Directory entries require absolute paths and match descendants at segment boundaries, preserving POSIX case and ignoring Windows drive/UNC case and separator differences. Symlink aliases are not resolved.

Scope removes excluded session identities, titles, branches, paths, details, history, and derived checkout fields from both clients' snapshots. Assigned GitHub issue cards remain independent of session scope. The hub retains full local evidence for safety; scope is output filtering, not a restriction on all disk reads or a rewrite of existing diagnostic logs.

Exclude:

- The board's own classifier processes.
- Sessions that have never started work: no transcript, no reported activity, and no agent status. A missing transcript alone is insufficient.

With hooks installed and a board visible, target arrival within one second of a session's first prompt and departure within one second of its end event. Polling detects changes without an event, including killed processes and renamed sessions. These targets depend on the agent's signal and successful reads.

### R3. Issue-linked sessions and history

Group matching in-scope live sessions under their issue card. Multiple sessions may work on one issue. Idle and waiting sessions remain live. A known different repository must not match an issue solely by its number.

For an issue card with no live sessions, show one saved session: the matching transcript with the newest modification time. Match using its saved branch, then saved directory name, and the configured issue pattern. Require the checkout's origin repository to match the issue repository. Do not use the checkout's current branch to assign historical work.

A saved row:

- Uses the same one-line layout as a live row, with an outlined state mark and no working animation.
- Resumes on click, subject to R14's checks.
- Shows retained activity when available; otherwise its transcript age.
- Does not affect lane placement or live counts.

History creates no ad-hoc cards. Unknown repository identity, missing metadata, or an unreadable checkout can prevent a historical match. A partial or failed live-roster read suppresses history until inactivity can be established. A history failure does not disable live rows.

`sessions.showHistory` defaults to true. False hides saved rows and prevents stale links from resuming them; it does not claim that history files are no longer read. Apply scope to saved-session working directories and verified checkout roots before exposing their details.

### R4. Ad-hoc work

Group sessions without a confirmed issue by canonical repository and branch. Sessions started in subdirectories join their checkout's card. Separate clones on the same repository and branch share a card; a branch switch produces a different card.

If repository or branch identity is unavailable, use the checkout directory instead. Do not combine unrelated unknown repositories or detached checkouts.

Name the card by repository and branch, falling back to directory. Qualify the repository owner on hover. Show which checkout is used when several qualify. An ad-hoc card exists only while it has live sessions, but its saved lane applies to later work with the same card identity.

`sessions.showAdHoc` defaults to true. False hides these cards without disabling discovery or removing the roster used for safety checks. Apply scope before session-derived remote issue lookups so excluded sessions do not trigger them.

### R5. Card presentation and controls

A card must show its stage, sessions, activity, attention, and relevant ages without opening another view.

| Area | Content |
|---|---|
| Header | Repository, issue number, title, type/status labels, selected pull request, avatar, overflow menu |
| Footer | Command bar (R45) and session rows; visually and accessibly separated from GitHub's fields |
| Session row | State mark, agent mark, truncated name, duration |

The footer remains present when empty. Cards and page use the same base tone; lanes are recessed and footers have a small contrasting tint. Borders distinguish cards when theme backgrounds coincide.

State marks use three meanings: working, waiting for the developer, and idle/unknown as applicable. Filled marks represent live sessions; outlines represent saved sessions. Provide accessible names for information conveyed by color and fill. A row that is itself a control carries those names in its own accessible name, because a name there replaces everything inside it, and states what the row shows: the observed phase, else the word the agent reported, else that there is none. An inert row carries no name of its own and is read from its marks. Only the session responsible for card attention uses the card's attention color; do not recolor or embolden that session's name to repeat the same signal.

Animate the name of a working live session. Respect reduced motion and forced colors. Session names are more prominent than agent marks and durations.

Durations use one unit, rounded down: seconds, minutes, hours, days, or weeks. Update once per second without rereading the machine. A running duration starts at the user's prompt that began the turn and continues through tool calls, subagent results, background-task notifications, and permission prompts; other phases start at the reporting event. For work resumed without a user prompt, use the first observed event. This duration includes waiting within the turn; it is not CPU time. Hover explains the phase, time basis, exact timestamp, and last observation without duplicating the name.

The card itself is not clickable. Titles, chips, and session rows have their own controls and hover feedback. Overflow menus contain secondary actions; hide unavailable items. Reveal card menus on hover, keyboard focus, and devices without hover. Keep current state when rebuilding an open menu.

The board header has one menu for archive visibility, logs, refresh, and Settings. Archive appears first. Check toggle items and mark the menu control while hub logging is enabled.

Both clients draw tooltips rather than native `title` tooltips. Open after 120 ms, close on pointer exit, and support focus except inside menus where automatic focus would obscure other items. Provide descriptions independently of tooltip visibility. Do not repeat text already visible on a chip.

Select the most recently updated open closing pull request; if none is open, select the most recently updated closing pull request of any state. Render its chip with a neutral outline and state-colored glyph. Use accessible text for the state. Selection is limited to the fetched page; see [GitHub query limits](mechanics.md#github-query-cost-and-limits).

`avatar.review` and `avatar.offReview` select whose face a card shows in both clients, one setting per side of the review boundary, so a review card can name who implemented the issue while every other card names who reported it. `avatar.review` takes `pull-request-author`, the default, or `assignee`. `avatar.offReview` takes `assignee`, the default, or `issue-author`; a pull request author is not offered there because the unstarted, plan, and icebox lanes have no pull request to name. Each side falls through to an assignee wherever its person is unavailable, such as a review card with no pull request or a deleted account, and the preferred assignee is the developer's configured identity. Label the role. The review statuses come from the lane mapping, so custom status names need no second list. The overlay replaces GitHub's assignee display only where an author should replace it and an assignee area already exists; otherwise leave GitHub's display intact, which makes `assignee` on either side a no-op for that side in the browser and a visible choice on the editor board.

Issue and pull-request controls resolve their addresses from source data; a guessed issue number is not sufficient to construct a link. What an unmodified click on those controls does is R43.

### R45. Card command bar

The footer's first line is one command bar: the card's lane, what to do about it, and the controls that act on it, in a single row that never wraps.

| Slot | At rest | While the bar is pointed at or focused |
|---|---|---|
| Lane (overlay) | Pictogram, in the lane's colour, on a button edge that opens the lane menu | unchanged |
| Verdict | Triage action, then the dispatched action's state or the triage qualifier | unchanged |
| Tail | Time in the current status, right-aligned | Reread, open checkout, create worktree (R46), run — run on the edge |

The verdict is the only element that shrinks: a long qualifier truncates it rather than moving a control. The tail is one slot painted two ways, so revealing the controls changes no width and the run control lands where the age was, above the session duration below it. Reveal keys on the bar, not the card, so passing over a title arms nothing. Controls stay in the tab order while hidden and appear on keyboard focus; where the device cannot hover, the tail lays the controls out and drops the age.

Each lane has one pictogram and one colour, identical in both clients. The overlay's chip has room for the mark alone and names its lane in its accessible name and tooltip; the editor board's cards already sit in their lane, so its bar has no lane slot and its lane headings take the mark beside their name instead. A card with no issue (R4) has no conversation to open and nothing to read, so it draws no title line; the branch name its sessions work on stands in the verdict slot, and the bar's controls are where every card has them.

The open-checkout and create-worktree controls live in the bar only. Menus carry what the bar does not: the editor board's card menu offers the changes and session starts, and the overlay's lane chip opens a menu only where there is a lane to move to or a session to start.

The bar runs to the footer's own edges with square corners and keeps the card's ground, including any hover or attention tint on it; the session rows under it carry the footer tint, and their band is not drawn at all on a card with no session. Glyphs are drawn on their own even pixel grid inside an even control, because an odd glyph centres on a half pixel and blurs. Nothing in the bar fades by layer opacity: a faded verdict and a pulsing state change colour, since an opacity layer renders the text inside it without subpixel antialiasing.

Hovering the bar hides the age, and hovering is how the reread is reached, so the reread states the age it covers. A control the bar reveals is reachable by keyboard and states what pressing it costs in its accessible description, because its glyph says none of that; a control that only states a condition, such as a refusal, stays reachable and refuses the press rather than removing itself from the page.

Returned states the card rather than its work, so it is a label in the card's own label row under the title rather than a mark in the bar, on both clients. The overlay joins GitHub's field list under the title and falls back to the card header line on a card carrying no field of its own, because GitHub owns and redraws both (mechanics M27). The row leads with the pull request, then the type and the status, so the card most in need of attention states its pull request first.

The run control carries the card's action (R39): it starts an available action, stops a running one, repeats a finished one, and is present but inert for a refusal. Its accessible name and tooltip name the action, because one glyph serves every triage. While an action is dispatched its state displaces the triage qualifier in the verdict, which is the newer fact about the same work.

### R43. Reading a conversation

A card's issue and pull-request controls open that conversation for reading, over the board. Holding Ctrl, or Cmd on macOS, sends the same control to the browser instead. A setting turns reading off, after which those controls always open the browser and the accessible name says so. The card itself stays unclickable (R5).

The panel reads and never writes. It shows the title, state, labels, author, assignees, and milestone, the body, and the whole conversation that followed: comments, review summaries with the state each left, inline review threads, commits, and every state change, in the order they happened. A pull request also shows its branches, draft state, review decision, and combined check state. Draw all of it as GitHub draws its own conversation page (mechanics M57): the title at GitHub's size with the number beside it, the state pill in GitHub's colour with its octicon, the sidebar facts under their small headings, comment boxes with shaded headers, and a timeline whose badge carries GitHub's octicon for each state change, filled where GitHub fills it. Label colours follow GitHub's own arithmetic in both colour schemes. Everything else takes the editor theme, so the page reads as GitHub's inside the editor rather than as a copy of GitHub's palette. Reactions are displayed as counts, a comment the source hid is collapsed behind its reason rather than dropped, and an edited comment is marked without claiming what changed. Task-list checkboxes stay disabled, and there is no comment box, reaction control, or field editor: writing to GitHub remains out of scope. Offer a control that opens the same conversation in the browser, where all of that already works.

Inline review threads hang off the review that opened them, ordered by file then line, each naming the file and the line it hangs off and marked when it is resolved or its diff has moved past it. A thread whose review is not in the timeline is listed after the conversation instead. A resolved thread opens collapsed, since it is settled; every thread heading carries its comment count so a collapsed one still says what it holds, and any thread can be opened or closed.

A run of three or more consecutive state changes folds into one disclosure so it does not bury what people wrote, while still holding every one of them; a shorter run stays inline.

Read the conversation in pages, newest first, so a read that stops early loses its oldest entries and never its latest. Say the conversation is clipped without stating a number: the source's timeline total counts entries its connection does not return, so any count derived from it would be wrong. The same holds for a thread's replies. A page that fails after the first leaves the conversation short rather than failing the read.

The diff itself, its file list, and commit contents are outside this panel: it reads the conversation, and the browser control opens the rest.

The panel is modal: it dims the board behind it, and a click there closes it rather than reaching the board. Nothing outside the panel takes pointer or keyboard while it is open. It is resizable from its own edge by pointer and by keyboard, within bounds that keep both it and the dimmed board legible. Its width is retained across boards and windows.

Bodies are rendered by the source, not by a client markdown parser, so a conversation reads as its author wrote it. A client sanitizes source HTML before it reaches a document, keeping only known elements and attributes and only `http`/`https` addresses. Links inside a conversation are left to the host, which opens an anchor's address in the browser itself; opening them from the client as well opens each link twice.

Conversations are read per request and are not carried in snapshots, which would broadcast every body on every poll. Answer only the client that asked. Report a read failure with its remedy rather than an empty conversation, and distinguish a subject that could not be read from one that does not exist.

The overlay does not offer this: it runs on the page that already renders these conversations (R36), so its cards keep opening GitHub itself.

### R6. Attention

| Condition | Card indication |
|---|---|
| Session's turn ended on an error: a usage or rate limit, an overloaded or failing model service, or a request the service refused | Failed; highest priority |
| Session waiting for permission, an answer, or approval | Needs you |
| Session completed a turn but is still open | Your turn |
| Live session working, with neither attention condition | Dashed working border, no attention tint |
| Agent explicitly reports the session finished | No session attention |

Attention uses the card border, a tint, and the responsible row's state mark. Failed is red, Needs you yellow, Your turn blue, and working a dashed green border. Working borders animate; reduced motion, from the system preference or the editor's `animations` setting, retains a static dashed border. Activity changes do not reorder cards.

A failed row's state mark names the error kind in the agent's own vocabulary and carries the agent's text on hover, which for a limit includes the reset time the agent stated. Claude reports the failure through its `StopFailure` hook; Codex has no such hook, so the board reads the turn's terminal record from its rollout ([mechanics](mechanics.md#turns-that-end-on-an-error) M55). Retries before the failure are not shown as failed: the row stays working until the agent gives up.

Implementation gap: the idle-attention branch does not exclude explicitly finished sessions. A finished session with idle activity can still produce Your turn outside Icebox and Archived. The intended rule is no session attention after an explicit finish.

Retain the last observed activity after a process disappears. Retained waiting still needs the developer; retained failed still shows the failure; retained running becomes Your turn because the process is gone. Retain by session identity, not by card. Age does not clear it. An issue's departure from active membership invalidates observations older than that departure (R9).

Icebox and Archived suppress Failed, Your turn, and the working border. Needs you remains visible in every lane.

## Lanes and membership

### R7. Lanes

Lanes are independent of GitHub project statuses.

| Lane | Purpose |
|---|---|
| Unstarted | Work not begun |
| Plan | Agree what to build |
| Build | Implement or answer changes requested on your work |
| Review | Review a diff or await review of your work |
| Icebox | Work deliberately set aside |
| Archived | Issues outside active board membership; optionally displayed |

Hide an empty Icebox lane except during a drag, when it must be available as a destination. There is no Blocked lane: attention remains on the card in its existing lane. There is no Done lane: the board holds work assigned to the developer, and finished work leaves it through a status outside the membership set (R9).

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

An editor session opens by ID, with the prior conversation available. On hover and keyboard focus, a row replaces its duration with the destination: the Visual Studio Code mark for an editor open or resume, and a terminal glyph for an attach. Use the agent's supported operation and apply these rules:

- Reveal an existing tab in its owning window.
- For Claude in a sidebar, focus the sidebar/window and identify the requested session; opening another surface can duplicate its process.
- When the owning window is known but its surface is not, reveal only if the agent's operation is idempotent. Otherwise focus the window and explain the limitation.
- Attach to a live detached Claude run in a terminal (R39).
- Recheck history before resuming: confirm readable liveness, valid saved data, no conflicting live session on the card, and no pending resume. Use a final fresh roster check and an expiry deadline.

Determine the owning window from process and host records, not from session cwd alone. Explain missing, stale, or not-yet-persisted placement. Do not substitute a newly opened empty window for the owner of an active session.

Historical resumes use the saved directory and a standalone window. Reuse a suitable single-folder window or explicitly open a new one; do not depend on the user's folder-opening preference. Agent-specific history validation remains necessary.

Opening or raising another window obeys `openWindowsForSessions`, enabled by default. A refusal caused by this setting offers to enable it. Do not modify the agent extension's preferred location as a side effect.

Browser and cross-window links use the connected editor's own URI scheme, reported by the extension as `vscode.env.uriScheme` and carried in the snapshot; without a connected editor the stored last value applies, and `vscode` is the default. VS Code stable and Insiders are the supported distributions; a fork works only where it registers its scheme and runs the extension. There is no session-surface preference: an agent API that opened one session in a chosen surface would change the agent's preferred location or create a second session, so existing sessions are revealed where they are.

Check cross-window focus and unexpected session creation. Refuse editor launches when the staged-update check detects a version mismatch; explain the required restart. This protection has a known detection limit recorded in [mechanics](mechanics.md#vs-code-updates-and-window-launches).

Missing extensions, unsupported agents, unavailable sessions, ambiguous windows, and expired requests receive specific refusals.

Enforce current session scope and history-display preferences on open, attach, resume, checkout, and start routes, including after asynchronous refresh or window discovery. Stale controls cannot open excluded work. Refusals must not repeat excluded paths or session identities.

### R18. Prevent accidental duplicate sessions

Do not open a second editor process on a session already held elsewhere. Session identity determines duplication, not the issue or checkout: intentionally starting another session on the same card is allowed (R42).

Use window and surface records before opening. Labels cannot establish identity. Two windows sharing one workspace store remain an ambiguity; fail conservatively when the records cannot resolve it.

Client filtering must not hide conflicts from internal safety checks or make new-session/action starts newly safe. Keep the complete live roster and action ledger for duplicate prevention, settlement, and stop resolution. Tightening scope preserves a minimal stop control for Ground Control-started work without exposing its excluded session details.

### R37. Combined changes

From a card's verified checkout, open one diff showing branch commits and uncommitted changes together, from merge base to disk. Use a checkout R41 resolved: a session directory, an explicit pick, or the issue's worktree (R46). Never guess a directory from an issue number or branch name alone.

If no merge base is available, show uncommitted changes and state that limitation in the title. State truncation and identify the selected checkout when several qualify. Do not change Git configuration or branches to inspect work. Refuse a repository mismatch.

Opening this view adds the repository to the window's Source Control list until reload. This operation is available only in the editor.

### R41. Open or select a checkout

Open an editor window on the card's checkout without starting an agent. Resolve the directory from a session that ran there, otherwise from a folder the developer selected for the card, otherwise from the issue's worktree (R46).

Never infer a checkout merely because its remote matches the issue's repository. Several worktrees can share that remote. A worktree a provisioning run recorded for the card, or a working tree whose branch or directory names the issue, is a different signal and does qualify, ranked below both a session and a pick. The editor's folder picker validates the selected directory against the card's repository and remembers it per card and machine.

Offer only readable directories; skip a deleted session checkout if another qualifying one exists. Preserve saved picks while their cards are absent, but do not offer a pick that no longer validates.

Reuse an existing single-folder window, obey R14's window permission, and explain when the requesting editor already has the checkout open. The overlay can request opening by card ID through a connected editor; it cannot supply a path or choose a folder.

### R44. Resume worktree sessions in the repository window (experimental)

`resumeWorktreesInRepositoryWindow`, off by default and marked experimental in its setting description, resumes a finished Claude session in the window on its repository instead of a window on its worktree, so many worktrees need not mean many windows. Only the window changes: the session still runs in its own worktree, and a resume that cannot guarantee that must not proceed.

Scope is Claude checkouts at `<repository>/.claude/worktrees/<name>`. Any other layout, any other agent, and a window already on the checkout keep the existing route ([mechanics](mechanics.md#claude-session-working-directories) M52). The redirect happens in the window that receives the resume, so it applies to a handed-over resume as well. Verify the resumed session's recorded working directory.

Refuse, naming the cause, rather than resuming a session that would run in the wrong directory or resuming an empty one: an unreadable checkout, no saved transcript for it, a name the redirect cannot express, or a second redirect while one is in progress.

Two limitations are accepted. A repository opened as a saved `.code-workspace` reports that file as its root, so a routed resume does not recognize the window it reached; plain resume has the same shape, and opening the repository as a folder is the supported arrangement. A session the developer sends in another tab of that window during the redirect is recorded against the worktree; the redirect is held for as little as the reveal allows.

### R46. A card's worktree, and the run that makes one

Every card action works in the card's worktree: the directory an unattended agent edits is one the developer or a run made for that issue, never a directory guessed from a session that happened to link. Where the card has none, the action is not refused; a worktree run goes first, and the action follows in the worktree it reports. The developer sets a card's worktree by working in one, or by running the worktree prompt; the board never runs git itself.

**What a worktree is.** A working tree of a clone of the card's repository: the clone's main tree, or any worktree git registers under the clone's shared git directory. It is the card's where a provisioning run reported it and the hub recorded that, else where its branch name, or failing that its directory name, yields the issue number through `branchIssuePattern`. Search the clones the hub already knows — live and saved session directories, remembered picks, recorded worktrees, connected editor window folders — plus any absolute path in `repositoryRoots`; a relative configured path is ignored rather than resolved, because the hub's working directory is not the editor's. Report a worktree only where its directory reads back: a registration outlives the directory it names ([mechanics](mechanics.md#worktree-registrations) M56). Where an issue has several, the recorded one is the card's, else the first by path; its checkout is then not the only one, which R37 states. A recorded worktree that git no longer registers, or that belongs to another repository, is inert. Session scope hides an excluded worktree exactly as it hides an excluded checkout, in both clients.

**The worktree run.** `worktree.prompt` is the developer's prompt for the session that makes a worktree: their own script or slash command, naming the branch, the directory, and whatever setup the repository needs. It runs with the action agent, model, and permission mode, from the clone's main tree, or its git directory where it has none, and it takes `{issue}`, `{repo}`, `{title}`, `{url}`, `{clone}`, and `{resultPath}`. It ends by writing the result file with `outcome` `ready`, `worktree` as the absolute path it made, and `detail`; `halted` with `detail` says why not. The hub records the path only where git registers it as a working tree of a clone of the card's repository and scope admits it; a path that fails either check halts the run with the reason. The prompt chooses the branch name; the hub does not read it. The prompt must be idempotent — a retry after a run that made the worktree and then failed must find it, finish, and report the same path — and must ask nothing when it runs unattended.

**Refusals.** Refuse, naming the setting, rather than guess: no prompt; no clone of the repository the hub knows; more than one, which `repositoryRoots` narrows; a card with no issue to name a branch after; an archived or unassigned card, which is read-only (R9). Each refusal is shown on the worktree control, and on the run control where an action would need the worktree.

**The chain.** An action on a card with no worktree dispatches the worktree run with the action recorded as what follows. When the run reports a worktree, the action starts in it, reading its own fresh context, as the same attempt: one request is one dispatch against the daily limit and one concurrency slot throughout. A run that halts, fails, or is stopped ends the chain; the action is not started, and the card shows the action as done with the run's reason. Retrying an action on a card whose earlier run did make the worktree runs the action alone. While the run is on, the verdict says the worktree is being created and the run control stops it; a worktree run asked for on its own shows on the worktree control, which stops it, and leaves the action offerable. The session the run is, tracked like any dispatched session (R39), starts in the clone rather than the issue's directory, so it appears on an ad-hoc card of the clone rather than on the issue's card.

**The worktree control.** Where the card has an issue and no worktree, one further tail control, between open-checkout and run in both clients, runs the worktree prompt alone, so a developer can provision before starting anything. It states the offer, the refusal, the run in progress, or how the last run ended. Where the worktree is the card's checkout (R41), the open-checkout control opens it and its tooltip says so, naming the branch, or the directory where HEAD is detached; there is no second open control. Both clients state the worktree and offer the run. A page's request is a dispatch, so it is bounded exactly as a page-asked action is (R39): the browser opt-in, a visible project tab, and a positive daily limit.

Implementation limits: a worktree run asked for on its own does not open the worktree when it ends; the open-checkout control does. The run before an action opens nothing either; the action's own session is what runs there. Recorded worktrees are never pruned; a record git no longer registers is ignored, not removed. A worktree session scope hides still exists, so the card offers to make one and the run then halts on the scope check rather than being refused first.

### R42. Start a session

Offer one start item per supported agent on a card with a checkout, except an archived or unassigned card, which is read-only (R9). A start does not provision: a card with no checkout takes a pick (R41) or the worktree control (R46) first. An editor starts in the window that asked. A browser has no window of its own, so the hub starts in a connected editor on that checkout, and requires a visible project tab and no other page-asked start in flight. For another checkout, direct the developer to open it first.

The `newSession.prompt` setting defaults to empty. Substitute `{issue}`, `{repo}`, `{title}`, `{url}`, and `{checkout}`; leave unknown placeholders unchanged. Prefill without submitting. Claude accepts the prompt; Codex's available start command opens a bare session, which its menu item states.

Allow additional sessions on the same card. Prevent repeated starts for the same card and agent during the launch interval. These deliberate starts do not consume automation limits. A start prefills without submitting, so it needs no separate browser opt-in; the window that performs it rechecks its own workspace and agent extension.

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

Use the developer's own submitted reviews, comments, and replies to distinguish initial review from follow-up. Reviews by other people or bots do not establish a prior round for the developer. Ignore draft reviews. Do not use `reviewDecision` as triage evidence; lane arrival uses it separately (R8).

The explanation describes status and responsibility, not technical implementation. Address the developer as “you”; use colleagues' first names, profile-name overrides, or logins as fallback. Do not invent counts from a partial conversation. Other covers waiting with no identified action. The action is visible; the explanation and classification time are on hover. The age beside it is time in the current status (R45).

Mark triage stale when issue/PR evidence changes. Age alone does not invalidate it. Automatically reread only on eligibility or status changes; other changes mark it stale without spending another model call. Triage never moves a card.

Run only while a board is visible or on an explicit client request, with bounded concurrency, timeout, and retry backoff. Stop automatic retries after the retry budget. A failed classification reads as not read, with the reason on hover; show the failure once above the board and retain a retry control. Either client can request classification; the hub applies the same eligibility, concurrency, and cooldown checks whichever asks.

Eligible cards carry one reading control in both clients, whether or not they have been read (R45). It is accessible by keyboard and touch. Off mode removes classification controls while retaining results. Clicking the verdict or age to inspect its explanation must not start classification or spend usage.

Triage defaults to manual requests; `triage.mode` also offers off and automatic. Explicit mode takes precedence over legacy `triage.enabled`; without an explicit mode, preserve explicit legacy true as automatic and false as off. Configurations without an explicit choice default to manual. Existing saved hub configurations retain their legacy mode until replaced by client configuration.

Automatic attempts have a persisted rolling 24-hour limit, default 100 and configurable from 0 to 1000. Reserve before concurrent source reads; count failed and cancelled attempts. An editor's manual requests are independent of this allowance; a browser request reserves against it and requires a visible project tab, because the per-card cooldown bounds one card rather than a caller working through every key. Unreadable or unsavable usage records pause automatic starts. Both clients display mode and limit state. Changing to manual cancels automatic readings; off cancels all readings. Cancellation does not consume per-card retry attempts.

Triage sends issue/PR text, recent comments, identities, review information, and status/assignment history to the configured model service and uses the developer's allowance. Classifier sessions have no tools, MCP servers, developer settings, or saved conversation visible to the board.

Only Claude currently provides classification. Report absent classifier or configured conversation source separately from missing/ineligible cards and disabled mode. Both clients display the missing capability and remove their request controls until it is restored. Do not announce model use or reserve automatic attempts without an available classifier and source. Removing required capability cancels pending readings while preserving prior results and session discovery.

### R39. Merge-upstream action

The only implemented unattended card action merges a PR's base branch into its head. It is disabled by default and requires a developer-supplied prompt. Supply issue, repository, PR, branches, and worktree facts to that prompt; do not define the repository's build, test, push, or commenting policy. `{checkout}` is the worktree the run works in.

`actions.agent` selects `auto`, `claude`, or `codex` independently of session discovery; explicit selection requires that enabled adapter to support dispatch. Auto preserves registry order among enabled dispatchers. `actions.model` selects the coding model, with empty using the CLI default. `triage.model` affects classification only. Older saved configurations inherit `AgentConfig.model` only when the corresponding model field is absent; an explicit empty field clears inheritance. The current editor sends separate model fields, ending accidental classification-model inheritance for actions.

Automatic eligibility comes from triage identifying a requested merge. A manual editor control can run or retry that candidate even when automatic dispatch is disabled; it cannot create a merge candidate on an unrelated card. Before dispatch, reread the PR and apply all safety checks and configured limits. An automatic run on a card with no worktree runs the worktree prompt first (R46), so enabling the action is also consent to provision for it.

Refuse drafts, other people's PRs, closed/merged PRs, disallowed lanes, active work on the card, and stacked PRs whose base is not the repository's default branch. The run works in the card's worktree (R46); a card with none and no worktree prompt is refused, and a manually selected checkout or a session directory that is not the issue's worktree does not authorize unattended edits. If merge is not a candidate action, show neither a merge control nor an irrelevant refusal.

Bound automatic work by:

- Concurrent runs and starts in a rolling 24-hour window.
- One attempt per head commit, except attempts recorded as failed.
- A 30-minute reconsideration interval after an automatic decision.
- No automatic repeat after a successful outcome, even if its push changed the head.
- Durable run records; a failed write prevents further dispatch.

An explicit manual request can bypass automatic eligibility history and cooldowns, but not safety checks, the required prompt, or concurrency limits. A browser request bypasses neither the action's own enablement nor `actions.fromBrowser`. A positive daily limit also applies to manual requests; zero disables automatic starts while allowing manual requests from an editor. A browser request inherits no such exemption, because without a positive limit nothing would bound how many agents a page can dispatch.

Track the dispatched process as an ordinary session, identify it as board-started, and notify the developer on the first dispatch. A detached Claude row attaches in a terminal at its checkout; closing the terminal leaves it running. The overlay can attach through the editor link, and displays and controls action state like the editor board. `actions.fromBrowser` defaults to false and gates every browser start; a browser start also requires a visible project tab, a positive daily limit, and an action the developer left enabled, because an editor click is itself the opt-in for a disabled action and a page's click is not. A browser stop needs no opt-in, because refusing one could strand a run, but it still requires a visible project tab and a card in scope. Hold the first-dispatch notice until an editor can show it.

Read an outcome and explanation from the run's designated result file. Clear the previous file before starting; if that fails, do not dispatch. Missing output means stopped short. This is a session-reported outcome, not independently verified stage completion: it changes no lane or GitHub status.

Stopping a run warns that work in progress may be incomplete. Do not reset a partially merged checkout. Report a failed stop and keep the control available. Automatic repair of failing checks and general conflict resolution are not additional actions.

A browser request repeats what a manual request already permits: it can start an action on a card that already landed, up to the daily limit, and a refused start spends a source read without spending that limit.

Implementation limits: run records are written after dispatch returns, so persistence failure can leave an already started process unrecorded. Concurrent starts can exceed the remaining daily allowance because pending requests do not reserve it. Failed attempts count toward that allowance and can include a process whose ID could not be read. Codex stop authorization is lost on hub restart, even though the action record remains. These gaps require implementation work to meet the intended dispatch and recovery guarantees.

## Setup, permissions, and lifecycle

### R26. First-run setup

Target: show useful work on first run, detect available information, and ask once in place for what cannot be detected. Do not silently display an empty board when configuration is missing.

A fresh install asks three questions when a board first opens: agents to show (detected ones preselected), session hook installation, and triage mode. Until they are answered, every activation path sends the hub a configuration with hooks, triage, and automatic actions off, so no agent settings are written and no model is called, while session discovery and GitHub reads continue; the board shows the unfinished setup and the command that resumes it. Cancelling keeps setup pending. An install with an explicit `agents`, hook, or triage setting, or a hub configuration stored with hooks on by an earlier version, counts as set up and is not asked; the choices are ordinary settings, editable later. The repository defaults to empty, so first run still requires repository configuration; GitHub identity can be detected but must be selected by the developer. Whether the OwnerRez repository should ship as a default remains a product decision.

After setup, activation by a board, command, restored board, or URI installs the chosen activity hooks with backups. Preserve unrelated entries and refuse malformed settings. Merely installing the extension without activating it must not change agent settings.

### R27. Shared defaults and personal settings

Ship team status conventions, lane defaults, project owner, number, and status field, and branch patterns as configurable defaults. Keep personal logins, paths, window permissions, agents, logging, and automation limits in user settings. Settings sent to the shared hub are application-scoped so windows do not disagree.

The repository-default gap is recorded in R26. The distribution of additional team defaults remains open.

### R28. Multiple GitHub identities

Allow several accounts to represent one developer. Require an explicit selection; authentication alone does not establish which account's work to display.

### R29. Checkout layouts

Support a single clone, multiple clones, and worktrees without imposing directory layout. Use configured branch conventions and verified checkout identity.

### R30. Optional agents

Detect optional agents without repeatedly spawning missing tools. Codex detection uses its home directory. Claude is enabled by default without an installation check and can report a missing executable; disable it explicitly on a Codex-only machine. Explicit agent configuration replaces the default set and can supply executable paths.

Codex supports live sessions, saved history, phases, opening threads, and dispatch. It does not classify cards. Refuse unsupported permission modes explicitly.

Session discovery remains enabled independently of hook choices. Codex live discovery depends on hook markers and is reduced when its hooks are disabled; saved history is still read. Removing an agent from the explicit configuration also removes its Ground Control hook entries.

Install and trust only Ground Control's Codex hooks. Obtain hashes and write trust through Codex's own API; do not calculate hashes or rewrite TOML directly. Preserve other hooks and trust entries. If trust cannot be established, explain the failure and manual remedy.

Honor `CLAUDE_CONFIG_DIR` and `CODEX_HOME` consistently for agent configuration, discovery, history, hooks, trust, and owned CLI launches. Require valid absolute roots and persist accepted `agentHomes` so other launch environments cannot silently select another profile. Explicit editor selections take precedence; older clients that omit the field retain accepted roots. Injected CLI/test homes use isolated defaults unless their caller explicitly supplies a test environment.

Support one selected profile per agent. A live profile change requires complete successful live-session evidence no older than two seconds, no live sessions, and no pending classification, dispatch, start, or resume. Refuse uncertain changes with refresh/reopen instructions. Preflight old and new hook settings, remove only owned old entries under the install lock, and durably save the new selection before installing there. Persistence or cleanup failures must remain visible and must not authorize writes to an unrecorded profile. Keep Ground Control state and cached writer paths independent of these roots.

Editor commands cannot override a running third-party extension's profile. Refuse reveal/resume/start when the performing editor's startup profile differs from the accepted one; terminal attach and owned CLI processes can pass an explicit environment. Cross-window execution must reach the target Ground Control resident for profile validation. Resume handovers transfer one expiring reservation using a token bound to the session and target workspace, preserving duplicate prevention.

### R31. Dispatch permissions

Use the least authority under which the unattended job can complete. Pass the chosen mode explicitly. Modes requiring unanswered prompts are not suitable defaults for unattended work.

The global `actions.permissionMode` defaults to Claude's `auto`; bypassing permissions requires a deliberate setting. Codex supports only `plan`, `dontAsk`, and `bypassPermissions`, translating them to its sandbox and approval policy. Validate adapter-declared supported modes before reading action context or dispatching. Reject unknown mode names and refuse unsupported combinations without substituting permissions. Changing settings during a pending context read requires a fresh request.

Triage has no tools or developer settings and offers no broader permission mode.

### R32. Opt-in automation

Unattended code changes start disabled. Enable actions individually, each with its own prompt. Triage is a separately configurable read that costs model usage and sends text off-machine; it defaults to manual requests. Starting a prefilled editor session is a deliberate user action, not unattended automation.

### R33. Limits

The developer sets concurrent and daily limits on dispatched card actions. Do not apply them to sessions started independently or deliberately through R42.

### R34. Settings and reversibility

Expose supported personal settings through normal editor settings and a Settings menu item on the board.

Organize editor settings into GitHub, Board, Sessions, Triage, Actions, and Advanced, in that order. Use short category titles and at most one sentence per description, omitting descriptions where the control is self-explanatory. Keep configuration formats and detailed behavior in linked documentation. Preserve existing setting keys for compatibility; VS Code derives individual titles from those keys. These settings configure the shared hub for both clients. Chrome provides browser-local overlay preferences and a link to shared editor settings, without hub configuration permissions.

`installSessionHooks` globally permits hook installation; `sessionHooks.claude` and `sessionHooks.codex` select hooks for each enabled agent. All default to true. Global false removes Ground Control entries for every registered agent, overriding individual choices. A per-agent false removes only that agent's entries; omitted agents also have their entries removed. Reconcile changes under one filesystem lock, preserving unrelated settings and the existing backup and malformed-file safeguards. Uninstall removes all owned hooks too.

Leave writer files available for sessions that cached the old settings, so they do not fail on every event; those sessions may keep reporting until restarted. Removal-only acknowledgments must not claim installation or request restarts to enable hooks. Acknowledge a hook setting change even when it needs no write. Acknowledge no hook state for a change that reconciled no hooks, including one made while an earlier installation result still stands; refused settings are still reported, and an installation failure remains among the board's failures. Preserve installation age when only entries were removed. Overlay registration is explicitly enabled and can be disabled or removed on uninstall.

`stateDirectory` (machine scope) relocates Ground Control's own state and logs without moving agent homes or the fixed bootstrap directory that Chrome, Claude, and Codex are registered to run from. Changing it moves existing state: record the move first so no hub starts against either directory, stop the hub, copy and verify, commit the pointer, then remove sources. Refuse nested, aliased, file, or non-empty destinations, an unreadable source, and moves while card actions run; a refused or failed move restores the setting, removes only copies the move created, and leaves state in place. Both clients discover the same hub afterwards through the pointer. An interrupted move is cleared on the next activation and reported; copies at the destination are left for the developer. An unset setting on activation adopts the pointer's directory rather than moving state, because settings files are per VS Code profile.

### R35. Shared background process

One hub per machine performs reads and maintains shared board state. Clients report whether a board is visible. Stop polling, activity reads, automatic triage, and automatic action starts when none is visible. Already dispatched processes continue independently. An activated editor remains connected for configuration changes even with its board closed.

Exit after the configured no-client window: `idleExitMinutes`, default 30, clamped by the hub to one minute and one day; a non-numeric value keeps the default. Measure from the last disconnect, cancel on reconnection, and apply a changed value to the wait in progress. Start on demand and remember accepted settings so the browser can use them without an editor running. Resolve the state directory from the bootstrap pointer at every start and connection attempt, and refuse to start while a state move is recorded.

A newly visible board receives cached issues if the previous source read is less than one minute old; otherwise request a read. This is a refresh floor, not a maximum age guarantee. Normal GitHub polling defaults to 300 seconds and session polling to 30 seconds. Manual refresh and relevant settings changes bypass the visibility floor. Display freshness accurately and retry transient failures.

### R36. GitHub overlay

On supported GitHub project pages, add triage and session rows inside matching issue cards, with the same names, phases, durations, attention, and open/attach behavior as the editor board. Preserve GitHub's card controls and drag behavior. Offer local lane moves without changing GitHub status.

Browser-local overlay enablement defaults to true; an empty project allowlist permits all supported project roots and view pages. `filteredToMe`, also browser-local and defaulting on, restricts the overlay to boards whose filter names the developer: it must carry at least one positive assignee qualifier, and every value across them must be `@me` or a known login. Negated qualifiers only narrow a board, so they are read past rather than refused. Known logins are the signed-in login GitHub states on the page plus the assignee logins the hub reports in `owners`, which the extension caches. A board that fails the test receives no snapshot, log, or watch, and its GitHub markup is restored; it keeps the hub connection its project allowlist earns, because a login that is the developer's only by configuration cannot be recognized until the hub says so. The filter comes from GitHub's filter box, which holds a saved view's own filter where the URL holds none; a box the developer is typing in keeps the previous decision until it loses focus. The setting exists because a board filtered to the developer shows the same assignee on every card, which is what makes an author's avatar worth substituting; on an unfiltered board the assignee is still the useful face. It has no editor equivalent, because the board only ever shows the developer's own issues. Animation and assignee-avatar replacement are browser-local preferences too, defaulting on; the editor's `animations` setting is per user. This host difference is intentional: Chrome has no shared settings, and GitHub owns the DOM that replacement alters. Turning replacement off restores GitHub's figure and role on open boards; turning animation off keeps the static working border, state marks, and accessible names, and the system reduced-motion preference applies regardless. Card rows are a fourth browser-local preference, defaulting on, set from the options page as adding rows to issue cards and from the overlay menu as a checked Enable overlay item: with them off the overlay removes its triage and session rows, attention marks, and avatar replacement from GitHub's cards and restores GitHub's own markup, while its menu, log, and header collapse stay. The board still counts as watched and keeps polling, which is what separates it from overlay enablement above, whose own control removes the menu and the hub connection with everything else. It has no editor equivalent, because the board is the editor's whole view. Match owner kind, owner, and project number exactly, ignoring owner case and view selection. Persist preferences in extension-owned durable storage. Invalid or unreadable preferences refuse access until corrected.

Only enabled, allowed, visible project tabs count as watched boards. Ordinary GitHub pages and disabled/disallowed projects receive no snapshots or logs and do not open or retain a hub connection. Hidden allowed project tabs retain their connection and requested logs, but do not enable polling or automatic work. Recompute eligibility and visibility on preference changes, navigation, and reconnect. Immediately restore modified GitHub DOM and stop log subscriptions when eligibility ends, including hidden tabs. Reject stale deliveries from prior page or preference state.

Keep browser snapshots only in memory for the current hub connection. After either the bridge or hub disconnects, wait for a fresh hub snapshot before sending session details to tabs. New or reconnected content must not paint data from an unconfirmed scope. Already displayed data may remain marked stale during a disconnection.

Native-host registration supports Google Chrome and Microsoft Edge, selected by `overlayBrowsers` with Chrome as the default. Enabling registers only the selected browsers and removes Ground Control's registrations for the others; disabling removes the selected browsers' registrations and keeps shared files another registration still needs; uninstall removes every registration Ground Control owns. Neither removes a registration made for another home. Unsupported browsers and platforms are reported as limitations.

Session row accessible names share their phase and liveness words with the editor board and differ only in naming their destination: the overlay says a session opens “in VS Code”, separates that clause with an em dash, and punctuates the name as a sentence, because the reader is not in the editor. Session links can launch VS Code even with no editor client connected. Opening a checkout and starting a session require a connected editor to resolve and perform the request, and the overlay offers a start only for agents such an editor reports. The overlay cannot choose filesystem paths, open combined diffs, or read a card conversation (R43).

Offer a persistent option to collapse GitHub's project title, view tabs, and unsaved-filter controls. Reduce inter-column spacing and retain theme-appropriate dividers. Persist the collapse choice across boards and reloads.

These differences from the editor board are settled, not gaps. The overlay draws footers only inside GitHub's own issue cards, so it has no ad-hoc cards (R4), no selected pull-request chip (R5), no card counts or empty-state text (R10), and no archive count or archive hiding (R9) — GitHub's page states its own membership and counts. It marks a stale read on its menu control rather than in words (R25), because the page has no board header to carry the sentence. Its menus answer no keys, and Escape closes only a tooltip, because GitHub's own keyboard handling owns the card; the editor board answers Escape and arrows on its menus. Its lane chip carries the pictogram alone where the editor board's lane heading has room for the name beside it. It moves lanes from a menu where the editor board drags, and it filters and pins one log panel where the editor uses two output channels: each follows the conventions of its host. Its board menu right-aligns to its control as the editor's menus do, but a lane menu aligns left, because it hangs from a control inside a card with the room to grow to its right. GitHub's pull request is the combined diff (R37), and choosing a filesystem path stays in the editor (R41).

## Accuracy and diagnostics

### R24. State accuracy

Report observed phase and age without inventing state. Reject malformed, mismatched, or excessively future-dated activity. Use the agent's normalized state only when no accepted observation exists. Explicitly distinguish saved activity and session-reported action results from live observations and verified completion.

### R25. Failures and limitations

Give each actionable failure a specific explanation and remedy. Show board-wide failures once, not on every card. Do not add per-card explanations that merely repeat visible state.

Follow the repository-wide [wording rules](../AGENTS.md#wording). Keep shared wording consistent across clients; do not imply completion or automatic recovery without evidence.

A client disconnection does not prove that the hub stopped. A board update time describes its snapshot, not a successful source refresh. Failure messages must not promise session visibility or claim that no process started unless the failure establishes it.

For a transient source failure with cached data, retain that data, mark freshness accurately, and retry silently for one minute. Report initial-load failures and actionable failures immediately. After the grace period, show the transient failure and explain that retry is automatic.

In the overlay, failures use dismissible notices; informational details belong in its menu. Announce newly installed hooks once per client, including how many existing sessions may need restart. Repeat the announcement only after a new install cycle.

### R40. Logs

Provide both client and hub logs. Record client connection and failure history without requiring a viewer. Detailed message logging is off by default.

The hub log floor is configurable from `debug` to `error`; a line under the floor is neither recorded nor streamed, and configuration and source failures still reach both boards through snapshot failures. Hub log rotation size and count and dispatch-output retention are configurable within bounds the hub enforces; rotation and retention only touch `hub.log`, its rotated generations, and `<agent>-dispatch-<id>.log` files. Orphan activity markers and settings backups are safety and recovery state with fixed limits. There is no recording-off switch: the launcher redirects the hub process's stdout and stderr into `hub.log` so crash output is kept, and a switch that left that redirection in place would misdescribe what is recorded.

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
