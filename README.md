# Ground Control

A personal board for assigned GitHub issues and local Claude Code and Codex sessions, available in VS Code and as a Chrome overlay on GitHub Projects.

## Features

- Group live and saved sessions by issue or checkout, with observed phases, durations, and attention indicators.
- Organize work in local lanes shared across clients. Moving a card does not change its GitHub status.
- Reveal or resume sessions, attach to Claude background jobs, open checkouts, and inspect combined changes in VS Code.
- Start an editor session at a card's checkout. Claude accepts an unsent prompt; Codex opens a bare session.
- See on a card whether it has a worktree for its issue, and run your own worktree prompt to make one — on its own, or before a card action that needs it.
- Classify the next action from issue and pull-request context on request; automatic triage requires opt-in.
- Run a requested merge-upstream action using your prompt, in the card's worktree. Automatic dispatch is disabled by default; [R39](docs/prd.md#r39-merge-upstream-action) describes checks and implementation limits.

Working lanes are Unstarted, Plan, Build, Review, and Icebox. Archived contains work outside the configured membership set. [Arrival rules](docs/prd.md#r8-arrival-and-manual-placement) determine placement until you move a card.

Automated takeover, resuming after tab closure or usage limits, and coordinated development stages remain [future requirements](docs/prd.md#future-workflow-requirements).

## Install and configure

To build from source, install Node >= 20 and VS Code. GitHub reads require an authenticated [gh CLI](https://cli.github.com). Configure the agent CLIs you use; Claude is enabled by default, and Codex is detected from its home directory.

Run from the repository root:

```bash
npm install
npm run build
npm run package --workspace ground-control
code --install-extension extensions/ground-control/ground-control-0.0.0.vsix --force
```

1. Run **Ground Control: Open Board** in VS Code. On a fresh install the board asks three questions once: which agents to show, whether to install session hooks, and the triage mode. Until they are answered, sessions are still discovered and GitHub is read, but no hook is written, no model is called, and no automatic action runs, and the board says so. Cancel keeps the questions for the next board; **Ground Control: Run Setup** asks them again at any time.
2. Set `groundControl.github.repo`; its default is empty.
3. Select your GitHub identities when prompted, or set `groundControl.github.logins`.
4. Review the project, status, branch-pattern, and agent settings. Team conventions have configurable defaults; explicit agent settings can disable Claude or select executable paths.

An install that already holds an explicit `agents`, hook, or triage setting, or a hub configuration stored with hooks on by an earlier version, is treated as set up and is not asked. Activation through a command, restored board, or URI starts the client; hooks install with backups only after setup, and the global and per-agent hook switches record the choice. Installation alone does not activate it. Ground Control trusts its own Codex hooks through Codex's API and preserves unrelated entries.

For the browser overlay, run **Ground Control: Enable GitHub Overlay** in VS Code, then load `extensions/chrome-github-board` unpacked at `chrome://extensions` or `edge://extensions`. `groundControl.overlayBrowsers` selects Google Chrome, Microsoft Edge, or both; the default is Chrome. **Ground Control: Disable GitHub Overlay** removes every registration Ground Control made. See the [overlay guide](extensions/chrome-github-board/README.md).

The overlay displays card/session state and supports local lane moves, session links, checkout opening, classification requests, logs, and reading a card's pull request in a side panel. Session links open the connected editor in its own URI scheme, so VS Code stable and Insiders each receive their own links; without a connected editor the last reported scheme applies, and `vscode` is the default. Selecting paths and opening combined diffs require VS Code. Opening a checkout and starting a session require a connected editor to perform them.

Use **Settings** in its menu, or **Extension options** in Chrome, to remove the overlay from this browser or restrict it to listed GitHub projects. That is **Enable overlay** on the options page, and it takes the menu and the hub connection with it; the menu's own **Enable overlay** only adds or removes the rows the overlay puts on cards. It defaults to enabled; an empty project list allows all supported project pages. Preferences persist in this browser and apply to open tabs immediately. Disabled or disallowed pages receive no overlay UI, snapshots, or logs and do not keep hub work active through this client.

## Settings

VS Code groups settings under **GitHub**, **Board**, **Sessions**, **Triage**, **Actions**, and **Advanced**, in that order; existing `groundControl.*` keys also work in `settings.json`.
These application settings configure the shared hub for both clients; Chrome has no separate editor for them.

### GitHub settings

`github.repo` names one github.com repository. `cardSource` selects assigned issues on the project or every open assigned issue. `github.projectNumber` and `github.projectOwner` identify the project; an empty owner uses the repository owner, and the same number under another owner is a different project. `github.statusField` names the single-select project field read as card status, default `Status`. A project without that field, or with a field of another type, shows a notice in both clients, and its cards stay on the board without a status. Only the built-in `Status` field records changes on the issue timeline, so triage sees status moves with that field alone; other fields supply the current value, color, and change time. `github.linkedAccounts` shows one account's activity as another's: each key is a username to hide and its value the username to show instead, with that account's profile name and avatar, on card avatars, assignees, pull-request authors, the conversation panel, and the triage prompt — `{ "my-bot": "me" }` makes a bot's work read as yours; the face still says `(as my-bot)` on hover, and each substituted name in the editor's conversation panel says `as my-bot`. A key that is in `github.logins` makes its value count as you, so the bot's pull requests stay yours; keep the bot in `github.logins`, or its cards are not read. Linking a bot to a colleague makes the colleague count as you too, which the hub log warns about. In Chrome the swap applies to the card avatar the overlay draws; GitHub's own assignee stack and conversation page keep the recorded account. This replaces `triage.names`, which is not migrated: delete the old key. `github.maxPages` (1–10, default 5) is how many pages of up to 100 assigned issues each refresh reads; every page is one GitHub API request, and when more issues match than were read both boards say so with the counts. A value outside the bound is refused with a visible failure rather than clamped. GitHub search returns at most 1,000 results, which is why ten pages is the ceiling. Multiple repositories and GitHub Enterprise are not supported.

### Board settings

`boardStatuses` selects active project statuses; all others archive the card. Editing the list clears Returned marks and archived placements, including cards newly archived by the edit.

`avatar.review` and `avatar.offReview` choose whose face a card shows in both clients, one for statuses mapped to the Review lane and one for every other status. `avatar.review` takes `pull-request-author` (default), naming who implemented the issue, or `assignee`. `avatar.offReview` takes `assignee` (default) or `issue-author`, naming who reported it. Either side shows the assignee, preferring your configured identity, wherever the chosen person is unavailable, such as a review card with no pull request or a deleted account. These replace the earlier single `avatar` setting, which is not migrated: set the side you want and delete the old key. Choosing `assignee` for a side leaves GitHub's own assignee display alone in Chrome, so that side changes only the editor board.

`animations` (default true) animates working borders, running session names, and tooltips on the editor board; off keeps the static dashed working border, state marks, and accessible names. The system reduced-motion preference disables animation regardless. In Chrome the same choice, whether the overlay adds its rows to issue cards at all (default on, and the checked **Enable overlay** item in the overlay menu), whether the overlay replaces GitHub's assignee avatars with the pull request author in review, and whether it runs only on boards filtered to your issues (default on), live in the overlay menu's **Settings**, because Chrome has no shared settings and GitHub owns the DOM being restored.

`readConversations` opens an issue or pull request in a reading panel on the board instead of the browser. It applies to VS Code only: the Chrome overlay opens a card's pull request in a GitHub-style side panel over the board, with no setting, and leaves the issue to GitHub's own panel. Both panels there are sized from their left edge, and the pull request panel pins beside the board as GitHub's issue panel does. `pairConversations` (off by default) opens a card's pull request beside its issue instead, the issue on the left, each side scrolling on its own; the pair is wider, keeps a width of its own, floats only, and the issue control still opens the issue alone. The overlay has the same choice on its options page. Ctrl-click, or Cmd-click on macOS, opens the browser either way. Drag the panel's left edge to size it, or focus it and use the arrow keys; the width is kept for the next conversation you open. It shows the whole conversation in order: comments, reviews and their inline threads, commits, and state changes, with reactions and hidden comments. Review threads name their file and line, and resolved ones start collapsed; long runs of state changes fold into one row. A long conversation is read newest first, so what a clipped one leaves out is its oldest part. The panel reads only: use **Open on GitHub** to comment or edit, or to read the diff.

`custody.stages` lists project statuses in workflow order with the function that owns each (`intake`, `dev`, `product`, `qa`, `release`) and the days a hold there counts as a stall; `custody.bots` names the logins whose moves are automation, and any login ending in `[bot]` is one. Clicking a card's issue number opens a custody popup with three tabs — Health, Time, and Route — over the issue's custody bar: how it moved, who held it, where the time went, and whether it is stuck. Both clients draw the same words; the tab you were on last opens first. See [R47](docs/prd.md#r47-custody-where-an-issue-has-been).

`statusLanes` maps project statuses to initial lanes and informs triage. A `build` mapping takes precedence over your open PR; your open PR takes precedence over other mappings. Manual placement persists until the card leaves your active work and returns. See [arrival rules](docs/prd.md#r8-arrival-and-manual-placement).

### Session settings

An empty `agents` object enables Claude and detects Codex from its home directory. An explicit map replaces that selection, so include every agent you want, for example `{"claude": "claude", "codex": "codex"}`; values may also be executable paths. Omitted agents are not read, and their Ground Control hook entries are removed.

`installSessionHooks` is the global switch. `sessionHooks.claude` and `sessionHooks.codex` choose hooks independently for enabled agents; all three default to true. Global false removes every agent's Ground Control entries regardless of individual choices. Per-agent false removes only that agent's entries; enabling it again reinstalls them. These settings affect the shared hub and both boards.

Hook changes preserve unrelated agent settings, hooks, and Codex trust entries, with backups before writes and refusal for malformed settings. Writer scripts remain for sessions that cached their paths, so existing sessions may keep reporting until restarted. Codex live discovery depends on hook markers and is reduced with its hooks off; saved history remains available. Disabling hooks does not disable session discovery.

`newSession.prompt` prefills Claude's composer without submitting. It accepts `{issue}`, `{repo}`, `{title}`, `{url}`, and `{checkout}`; unknown placeholders remain unchanged. Empty prompts and new Codex sessions start without a prompt.

`branchIssuePattern` reads the issue number from a branch or directory name. Its first capture group must be the digits. It links both sessions and worktrees.

### Worktree settings

A card's worktree is a working tree of a clone of its repository: the one a worktree run reported, or one whose branch or directory names the issue. The board finds them in the clones it already knows — clones you have open in an editor, have run a session in, or have picked as a card's folder — and in any absolute path listed in `repositoryRoots`; relative and blank entries are ignored. Every card action runs in the card's worktree.

`worktree.prompt` is your prompt for the session that makes one. It runs with the action agent, model, and permission mode, from the clone's main tree, and accepts `{issue}`, `{repo}`, `{title}`, `{url}`, `{clone}`, and `{resultPath}`. A card action on a card with no worktree runs it first and then the action in the worktree it reports, as one attempt against the daily limit; the create-worktree control in the card's bar runs it alone. The session must write JSON to `{resultPath}` with `outcome` `ready`, `worktree` as the absolute path it made, and `detail`, or `halted` with `detail`, for example:

```json
{"outcome": "ready", "worktree": "D:/git/repo.worktrees/17198-channel-mapping", "detail": "Branched from origin/master and built."}
```

The board records the path only where git registers it as a working tree of a clone of the card's repository; the prompt chooses the branch name. Write the prompt to be idempotent — a retry after a run that made the worktree and then failed must find it and report the same path — and to ask nothing, since it runs unattended. An empty prompt refuses both the control and any action on a card with no worktree. Exactly one known clone of the card's repository is required.

### Agent storage

Set `CLAUDE_CONFIG_DIR` or `CODEX_HOME` before starting VS Code to select a custom agent profile. Both require absolute paths without surrounding whitespace. POSIX paths containing literal backslashes are unsupported. Invalid values are reported rather than replaced with defaults. Unset values use `~/.claude` and `~/.codex`. These existing agent variables control discovery, history, hooks, trust, and Ground Control's CLI launches. They do not move Ground Control's own state.

The hub saves accepted roots in `agentHomes` so Chrome startup and uninstall use the same locations even with a different environment. Opening the editor board submits that editor's profile selection. One shared hub supports one selected profile per agent. To change it, finish active agent work, refresh the board, and reopen it; changes require a successful roster read within two seconds and no pending work. Hook cleanup or settings-save failures leave the previous selection active and report a remedy.

Agent editor extensions inherit their profiles at startup. Reveal, resume, and new-session commands refuse a mismatched editor profile; restart VS Code with matching environment variables. Cross-window session links pass through Ground Control in the target window for this check. Terminal attach and hub CLI dispatch pass the accepted profile explicitly.

New Codex activity markers identify their profile. Older markers can prove it through a transcript path; ambiguous legacy markers are used only with the default Codex home. Sessions using cached old hooks may need restarting for custom-profile discovery. Owned hooks in prior recorded homes are removed during a profile change; unrelated settings and cached hook writers are preserved.

### Session scope

`sessions.includeRepositories`, `sessions.excludeRepositories`, `sessions.includeDirectories`, and `sessions.excludeDirectories` default to empty lists. Empty includes allow all sessions; otherwise a repository or directory include must match. Exclusions always win. These shared settings apply to both boards without filtering assigned GitHub issues.

Repository rules accept `owner/repo`, `host/owner/repo`, HTTPS URLs, `ssh://git@host/owner/repo`, and `git@host:owner/repo`. They normalize to lowercase `host/owner/repo`, without `.git`. Passwords, HTTPS usernames, queries, fragments, and extra path components are rejected. Unknown repository identities cannot match repository includes; any repository exclusion hides unknown identities, even if a directory include matches.

Directory rules require absolute paths and include descendants at directory boundaries. They match the session's working directory and canonical checkout root, including worktrees. Windows drive and UNC paths ignore case and separator differences; POSIX paths preserve case. Symlink aliases are not resolved.

`sessions.showHistory` and `sessions.showAdHoc` default to true. Turning them off hides saved session rows or cards without confirmed issues. Scope filters client snapshots and opening routes; it does not stop all underlying roster/history reads or erase existing logs. The hub retains complete live-session evidence to prevent duplicate work and keeps stop controls for work it started, with excluded session details removed.

Chrome keeps snapshots in memory for the current hub connection and waits for fresh data after either the bridge or hub disconnects. A disconnected tab may retain its already displayed snapshot, marked stale, until the hub confirms current state.

### Triage settings

`triage.mode` defaults to `manual`: use **Read this card** in VS Code for an unread assigned issue, or its retry/reread control. `off` disables all classification controls and requests while retaining previous results. `automatic` reads eligible cards while a board is visible. Chrome offers the same reading and reread controls beside each result.

Classification currently requires enabled Claude and a configured conversation source. Both boards explain missing capability; a Codex-only setup can still discover sessions. Missing capability does not start model work or consume the automatic allowance.

An explicit `triage.mode` overrides legacy `triage.enabled`. Without an explicit mode, an explicitly saved legacy `true` selects automatic and `false` selects off; an unset legacy key selects manual. Existing saved hub configurations with `enabled` but no mode retain their legacy choice until an editor supplies its settings.

`triage.dailyLimit` defaults to 100 automatic attempts per rolling 24 hours (0–1000). Attempts are reserved before source reads and include failures and cancellations; zero pauses automatic starts. The count survives hub restarts. Manual requests do not use this allowance but retain concurrency and cooldown limits. Unreadable or unsavable usage records pause automatic starts until repaired and the hub restarted.

Switching to manual cancels automatic readings; switching off cancels all readings. Cancelled attempts remain charged to the daily allowance but do not consume per-card retries. Classification sends issue/PR context to the model and uses your allowance.

### Action settings

Setting `actions.merge-upstream.prompt` enables the manual merge control on eligible cards, even with automatic merging disabled. The agent runs in the card's worktree and may push changes; a card with no worktree gets one from `worktree.prompt` first. Automatic starts also require `actions.merge-upstream.enabled`.

`actions.agent` chooses `auto`, `claude`, or `codex`; auto preserves registry order, Claude before Codex, among enabled agents that can dispatch. An explicit selection must also be enabled in `agents`. Both agents can remain available for discovery while card actions use one of them.

`actions.model` selects the coding model; empty uses that CLI's default. `triage.model` affects classification only. Saved hub configurations from older clients inherit each agent's legacy `model` only while the corresponding new model field is absent; an explicit empty field clears that inheritance. The current VS Code client sends both fields, so upgrades stop using the classification model for actions unless it is also set in `actions.model`.

Merge prompts accept `{issue}`, `{repo}`, `{pr}`, `{branch}`, `{base}`, `{checkout}` (the worktree), and `{resultPath}`. A prompt beginning with `/` invokes a slash command. The session must write JSON to `{resultPath}` with `outcome` (`pushed` or `halted`), `detail`, and optionally `auditPath`, for example:

```json
{"outcome": "pushed", "detail": "Merged the base branch and pushed.", "auditPath": "merge-audit.md"}
```

The board reports `pushed` as Merged and missing output as stopped short; it does not independently verify the merge on GitHub. Stacked PRs, and cards with no worktree and no worktree prompt, are refused. See [merge action requirements](docs/prd.md#r39-merge-upstream-action).

`actions.permissionMode` defaults to Claude's `auto`. Claude's `manual` and `acceptEdits` modes can wait for approval in unattended runs; `dontAsk` denies operations needing approval, `plan` cannot write, and `bypassPermissions` disables permission checks. Codex supports only `plan`, `dontAsk`, and `bypassPermissions`. Unsupported agent/mode combinations refuse before reading card context or dispatching; unknown modes reject configuration. Ground Control never substitutes broader permissions.

A positive `actions.dailyLimit` applies to both automatic and manual starts over a rolling 24 hours; zero disables automatic starts but permits manual starts from an editor. `actions.fromBrowser` defaults to off; turning it on lets the GitHub overlay start a card action or a worktree run; either also needs a visible project tab and a positive `actions.dailyLimit`, and an action must be enabled. Stopping a run needs no setting. `actions.resultMinutes` limits the wait for a dispatched session to appear, not the duration of its work.

### Settings this guide does not cover

Every setting is described in the Settings editor under Ground Control. The ones with no paragraph here are `refreshIntervalSeconds` and `sessionRefreshSeconds` (poll intervals), `openWindowsForSessions` and the experimental `resumeWorktreesInRepositoryWindow` (which window a session opens in), `triage.concurrency` and `triage.timeoutSeconds`, `actions.concurrency`, `github.ghPath`, and the `hosts` and `sources` objects.

## Background process and logs

One hub serves both clients. It can continue serving Chrome after VS Code closes, stops polling when no board is visible, and exits after `idleExitMinutes` (Advanced, default 30, clamped to 1–1440 by the hub) without connected clients. An activated editor stays connected even with its board closed, so the window starts when the last editor or browser disconnects; a reconnection cancels it, and a changed value applies to a wait already in progress at the next check, which runs at most once a minute. Browser-started hubs use the stored value. Dispatched agent sessions are separate processes and are not stopped by hub exit.

State and logs are stored under `~/.claude/ground-control/` unless moved with `stateDirectory`. **Logs** on the editor board and **Ground Control: Toggle Hub Log** toggle hub-log streaming. **Ground Control: Show Board Log** opens extension diagnostics. Chrome's **Show log** opens a sidebar with browser and hub lines.

`logLevel` (`debug`, `info`, `warn`, `error`; default `info`) is the lowest level the hub records to `hub.log` and streams to viewers; `warn` and above drop lifecycle lines, while configuration and source failures still reach both boards as notices. `logs.rotateMegabytes` (1–100, default 1) and `logs.keep` (0–20, default 2) rotate `hub.log`; 0 truncates it in place, and lowering the count deletes the generations above it. `logs.dispatchRetentionDays` (1–365, default 7) deletes dispatched agents' `<agent>-dispatch-<id>.log` files after that age. The hub clamps every value and only ever touches those file names. Recording cannot be turned off: the launcher redirects the hub process's own output into `hub.log` so crash output survives, and the floor and rotation bound what is kept. Orphan activity markers (30 days) and settings backups (5 kept) are recovery state with fixed limits.

After building, `npm run hub` runs a foreground hub against your real home; the next activation of an installed extension replaces it. For development use `node apps/hub/dist/main.js --home=<path>` with a scratch home, which gets its own bootstrap and state directories, discovery record, and agent defaults, and add `--stop` with the same `--home` to end it. To point an editor at that hub, start the extension development host with `USERPROFILE`, `HOME`, `CLAUDE_CONFIG_DIR`, and `CODEX_HOME` under the same scratch home and `VSCODE_PORTABLE` set to a scratch directory, the way the integration harness does. The browser overlay cannot be isolated this way, because its native-host registration is per user; see [development hubs](docs/architecture.md#development-hubs).

### State directory

`groundControl.overlayBrowsers` (Advanced, machine scope) lists the browsers **Enable GitHub Overlay** registers: `chrome`, `edge`, or both. Enabling again with a different list registers the new selection and removes registrations Ground Control made for deselected browsers. **Disable GitHub Overlay** removes the selected browsers' registrations and keeps the launcher while a deselected browser still uses it; uninstall removes them all. Registrations are per user; the launcher and manifest are per home, so removal only touches registrations that name this home's files. On Windows, Edge also reads Chrome's registration when it has none of its own; on macOS and Linux each browser needs its own entry. Other browsers and platforms are reported as unsupported rather than guessed.

`groundControl.stateDirectory` (Advanced, machine scope, not synced) moves the hub's state and logs to an absolute directory; empty keeps `~/.claude/ground-control`. The bootstrap directory stays at `~/.claude/ground-control`: it keeps `state-dir.json` pointing at the state directory, the hub bundle, the browser launcher and its Windows manifest, and the hook writer scripts, which Chrome, Claude, and Codex are registered to run. Hook writers read the pointer on each event, so moving needs no hook reinstall, and existing installations change nothing until the setting is set.

Changing the setting moves the state immediately: the pointer records the move, the running hub is stopped, every state entry is copied and verified, the pointer is committed, and only then are the sources removed. The destination must be absolute, must not be inside the current directory or contain it (links are resolved), and must be empty apart from launch artifacts. A move is refused while a card action is running, because that agent was told to report into the current directory. A refused or failed move leaves the state where it was, removes only the copies the move created, and restores the setting. Hubs refuse to start while a move younger than 10 minutes is recorded or while the pointer is unreadable; the next activation clears a move that did not finish and reports it, leaving any copied files for you to remove. Activity markers written by agent sessions during the few seconds of a move can be lost until that session's next event, and detached Codex dispatch logs keep writing to their original files. Other clients, including Chrome, follow the pointer on their next connection attempt and may wait for their retry budget after the move. Clearing the setting moves the state back and deletes the pointer. A VS Code profile whose settings omit the key adopts the pointer's directory into its settings on activation instead of moving anything, so profiles cannot move the state back and forth.

## Data handling

Persistent board state is local. Triage sends issue/PR context to model services and uses your allowance. Dispatched agents use your configured tools and permissions and may make external requests. The overlay inserts private card data and logs into github.com, where page scripts can read its DOM. See [data boundaries](docs/architecture.md#data-boundaries).

## Development and documentation

`npm run verify` builds, typechecks, and runs tests with coverage. `npm run verify:full` adds real VS Code integration tests. Contributor rules and commands are in [AGENTS.md](AGENTS.md).

The installed extension contains its own hub bundle. After executable changes, build, package, and reinstall before reloading VS Code. A repository build alone does not update the installed VSIX.

| Document | Purpose |
|---|---|
| [PRD](docs/prd.md) | Requirements, current behavior, implementation gaps, and future scope |
| [Architecture](docs/architecture.md) | Components, dependencies, state, and protocols |
| [Mechanics](docs/mechanics.md) | Dated experiments and source inspections, including unused mechanisms |
| [Testing](docs/testing.md) | Verification, fixtures, isolation, and test layers |
