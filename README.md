# Ground Control

A personal board for assigned GitHub issues and local Claude Code and Codex sessions, available in VS Code and as a Chrome overlay on GitHub Projects.

## Features

- Group live and saved sessions by issue or checkout, with observed phases, durations, and attention indicators.
- Organize work in local lanes shared across clients. Moving a card does not change its GitHub status.
- Reveal or resume sessions, attach to Claude background jobs, open checkouts, and inspect combined changes in VS Code.
- Start an editor session at a card's checkout. Claude accepts an unsent prompt; Codex opens a bare session.
- Classify the next action from issue and pull-request context on request; automatic triage requires opt-in.
- Run a requested merge-upstream action using your prompt. Automatic dispatch is disabled by default; [R39](docs/prd.md#r39-merge-upstream-action) describes checks and implementation limits.

Working lanes are Unstarted, Plan, Build, Review, Done, and Icebox. Archived contains work outside the configured membership set. [Arrival rules](docs/prd.md#r8-arrival-and-manual-placement) determine placement until you move a card.

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

1. Run **Ground Control: Open Board** in VS Code.
2. Set `groundControl.github.repo`; its default is empty.
3. Select your GitHub identities when prompted, or set `groundControl.github.logins`.
4. Review the project, status, branch-pattern, and agent settings. Team conventions have configurable defaults; explicit agent settings can disable Claude or select executable paths.

Activation through a command, restored board, or URI starts the client and installs selected activity hooks with backups; the global and per-agent hook switches currently default to true. Configure them before activation to prevent installation; a first-run installation prompt is not yet implemented. Installation alone does not activate it. Ground Control trusts its own Codex hooks through Codex's API and preserves unrelated entries.

For the browser overlay, run **Ground Control: Enable GitHub Overlay** in VS Code, then load `extensions/chrome-github-board` unpacked at `chrome://extensions` or `edge://extensions`. `groundControl.overlayBrowsers` selects Google Chrome, Microsoft Edge, or both; the default is Chrome. **Ground Control: Disable GitHub Overlay** removes every registration Ground Control made. See the [overlay guide](extensions/chrome-github-board/README.md).

The overlay displays card/session state and supports local lane moves, session links, checkout opening, and logs. Starting or stopping work, requesting classification, selecting paths, and opening combined diffs require VS Code. Checkout opening requires a connected editor.

Use **Overlay settings** in its menu, or **Extension options** in Chrome, to disable the overlay or restrict it to listed GitHub projects. It defaults to enabled; an empty project list allows all supported project pages. Preferences persist in this browser and apply to open tabs immediately. Disabled or disallowed pages receive no overlay UI, snapshots, or logs and do not keep hub work active through this client.

## Settings

VS Code groups settings under **GitHub**, **Board**, **Sessions**, **Triage**, **Actions**, and **Advanced**, in that order; existing `groundControl.*` keys also work in `settings.json`.
These application settings configure the shared hub for both clients; Chrome has no separate editor for them.

### GitHub settings

`github.repo` names one github.com repository. `cardSource` selects assigned issues on the project or every open assigned issue. `github.projectNumber` and `github.projectOwner` identify the project; an empty owner uses the repository owner, and the same number under another owner is a different project. `github.statusField` names the single-select project field read as card status, default `Status`. A project without that field, or with a field of another type, shows a notice in both clients, and its cards stay on the board without a status. Only the built-in `Status` field records changes on the issue timeline, so triage sees status moves with that field alone; other fields supply the current value, color, and change time. `github.maxPages` (1–10, default 5) is how many pages of up to 100 assigned issues each refresh reads; every page is one GitHub API request, and when more issues match than were read both boards say so with the counts. A value outside the bound is refused with a visible failure rather than clamped. GitHub search returns at most 1,000 results, which is why ten pages is the ceiling. Multiple repositories and GitHub Enterprise are not supported.

### Board settings

`boardStatuses` selects active project statuses; all others archive the card. Editing the list clears Returned marks and archived placements, including cards newly archived by the edit.

`statusLanes` maps project statuses to initial lanes and informs triage. A `build` mapping takes precedence over your open PR; your open PR takes precedence over other mappings. Manual placement persists until the card leaves your active work and returns. See [arrival rules](docs/prd.md#r8-arrival-and-manual-placement).

### Session settings

An empty `agents` object enables Claude and detects Codex from its home directory. An explicit map replaces that selection, so include every agent you want, for example `{"claude": "claude", "codex": "codex"}`; values may also be executable paths. Omitted agents are not read, and their Ground Control hook entries are removed.

`installSessionHooks` is the global switch. `sessionHooks.claude` and `sessionHooks.codex` choose hooks independently for enabled agents; all three default to true. Global false removes every agent's Ground Control entries regardless of individual choices. Per-agent false removes only that agent's entries; enabling it again reinstalls them. These settings affect the shared hub and both boards.

Hook changes preserve unrelated agent settings, hooks, and Codex trust entries, with backups before writes and refusal for malformed settings. Writer scripts remain for sessions that cached their paths, so existing sessions may keep reporting until restarted. Codex live discovery depends on hook markers and is reduced with its hooks off; saved history remains available. Disabling hooks does not disable session discovery.

`newSession.prompt` prefills Claude's composer without submitting. It accepts `{issue}`, `{repo}`, `{title}`, `{url}`, and `{checkout}`; unknown placeholders remain unchanged. Empty prompts and new Codex sessions start without a prompt.

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

`triage.mode` defaults to `manual`: use **Read this card** in VS Code for an unread assigned issue, or its retry/reread control. `off` disables all classification controls and requests while retaining previous results. `automatic` reads eligible cards while a board is visible. Chrome displays triage state and results but cannot request classification.

Classification currently requires enabled Claude and a configured conversation source. Both boards explain missing capability; a Codex-only setup can still discover sessions. Missing capability does not start model work or consume the automatic allowance.

An explicit `triage.mode` overrides legacy `triage.enabled`. Without an explicit mode, an explicitly saved legacy `true` selects automatic and `false` selects off; an unset legacy key selects manual. Existing saved hub configurations with `enabled` but no mode retain their legacy choice until an editor supplies its settings.

`triage.dailyLimit` defaults to 100 automatic attempts per rolling 24 hours (0–1000). Attempts are reserved before source reads and include failures and cancellations; zero pauses automatic starts. The count survives hub restarts. Manual requests do not use this allowance but retain concurrency and cooldown limits. Unreadable or unsavable usage records pause automatic starts until repaired and the hub restarted.

Switching to manual cancels automatic readings; switching off cancels all readings. Cancelled attempts remain charged to the daily allowance but do not consume per-card retries. Classification sends issue/PR context to the model and uses your allowance.

### Action settings

Setting `actions.merge-upstream.prompt` enables the manual merge control on eligible cards, even with automatic merging disabled. The agent runs in the card's observed checkout and may push changes. Automatic starts also require `actions.merge-upstream.enabled`.

`actions.agent` chooses `auto`, `claude`, or `codex`; auto preserves registry order, Claude before Codex, among enabled agents that can dispatch. An explicit selection must also be enabled in `agents`. Both agents can remain available for discovery while card actions use one of them.

`actions.model` selects the coding model; empty uses that CLI's default. `triage.model` affects classification only. Saved hub configurations from older clients inherit each agent's legacy `model` only while the corresponding new model field is absent; an explicit empty field clears that inheritance. The current VS Code client sends both fields, so upgrades stop using the classification model for actions unless it is also set in `actions.model`.

Merge prompts accept `{issue}`, `{repo}`, `{pr}`, `{branch}`, `{base}`, `{checkout}`, and `{resultPath}`. A prompt beginning with `/` invokes a slash command. The session must write JSON to `{resultPath}` with `outcome` (`pushed` or `halted`), `detail`, and optionally `auditPath`, for example:

```json
{"outcome": "pushed", "detail": "Merged the base branch and pushed.", "auditPath": "merge-audit.md"}
```

The board reports `pushed` as Merged and missing output as stopped short; it does not independently verify the merge on GitHub. Stacked PRs and cards without a session-derived checkout are refused. See [merge action requirements](docs/prd.md#r39-merge-upstream-action).

`actions.permissionMode` defaults to Claude's `auto`. Claude's `manual` and `acceptEdits` modes can wait for approval in unattended runs; `dontAsk` denies operations needing approval, `plan` cannot write, and `bypassPermissions` disables permission checks. Codex supports only `plan`, `dontAsk`, and `bypassPermissions`. Unsupported agent/mode combinations refuse before reading card context or dispatching; unknown modes reject configuration. Ground Control never substitutes broader permissions.

A positive `actions.dailyLimit` applies to both automatic and manual starts over a rolling 24 hours; zero disables automatic starts but permits manual starts. `actions.resultMinutes` limits the wait for a dispatched session to appear, not the duration of its work.

## Background process and logs

One hub serves both clients. It can continue serving Chrome after VS Code closes, stops polling when no board is visible, and exits after `idleExitMinutes` (Advanced, default 30, clamped to 1–1440 by the hub) without connected clients. An activated editor stays connected even with its board closed, so the window starts when the last editor or browser disconnects; a reconnection cancels it, and a changed value applies to a wait already in progress at the next check, which runs at most once a minute. Browser-started hubs use the stored value. Dispatched agent sessions are separate processes and are not stopped by hub exit.

State and logs are stored under `~/.claude/ground-control/` unless moved with `stateDirectory`. **Logs** on the editor board and **Ground Control: Toggle Hub Log** toggle hub-log streaming. **Ground Control: Show Board Log** opens extension diagnostics. Chrome's **Show log** opens a sidebar with browser and hub lines.

`logLevel` (`debug`, `info`, `warn`, `error`; default `info`) is the lowest level the hub records to `hub.log` and streams to viewers; `warn` and above drop lifecycle lines, while configuration and source failures still reach both boards as notices. `logs.rotateMegabytes` (1–100, default 1) and `logs.keep` (0–20, default 2) rotate `hub.log`; 0 truncates it in place, and lowering the count deletes the generations above it. `logs.dispatchRetentionDays` (1–365, default 7) deletes dispatched agents' `<agent>-dispatch-<id>.log` files after that age. The hub clamps every value and only ever touches those file names. Recording cannot be turned off: the launcher redirects the hub process's own output into `hub.log` so crash output survives, and the floor and rotation bound what is kept. Orphan activity markers (30 days) and settings backups (5 kept) are recovery state with fixed limits.

After building, `npm run hub` runs a foreground hub against your real home. Use `node apps/hub/dist/main.js --home=<path>` for an isolated home, and add `--stop` to request shutdown for that home. An installed extension can replace an older foreground hub on activation.

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
