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

For Chrome, run **Ground Control: Enable GitHub Overlay** in VS Code, then load `extensions/chrome-github-board` unpacked at `chrome://extensions`. **Ground Control: Disable GitHub Overlay** removes the native-host registration. See the [overlay guide](extensions/chrome-github-board/README.md).

The overlay displays card/session state and supports local lane moves, session links, checkout opening, and logs. Starting or stopping work, requesting classification, selecting paths, and opening combined diffs require VS Code. Checkout opening requires a connected editor.

## Settings

VS Code groups settings under **GitHub**, **Board**, **Sessions**, **Triage**, **Actions**, and **Advanced**, in that order; existing `groundControl.*` keys also work in `settings.json`.
These application settings configure the shared hub for both clients; Chrome has no separate editor for them.

### Board settings

`boardStatuses` selects active project statuses; all others archive the card. Editing the list clears Returned marks and archived placements, including cards newly archived by the edit.

`statusLanes` maps project statuses to initial lanes and informs triage. A `build` mapping takes precedence over your open PR; your open PR takes precedence over other mappings. Manual placement persists until the card leaves your active work and returns. See [arrival rules](docs/prd.md#r8-arrival-and-manual-placement).

### Session settings

An empty `agents` object enables Claude and detects Codex from its home directory. An explicit map replaces that selection, so include every agent you want, for example `{"claude": "claude", "codex": "codex"}`; values may also be executable paths. Omitted agents are not read, and their Ground Control hook entries are removed.

`installSessionHooks` is the global switch. `sessionHooks.claude` and `sessionHooks.codex` choose hooks independently for enabled agents; all three default to true. Global false removes every agent's Ground Control entries regardless of individual choices. Per-agent false removes only that agent's entries; enabling it again reinstalls them. These settings affect the shared hub and both boards.

Hook changes preserve unrelated agent settings, hooks, and Codex trust entries, with backups before writes and refusal for malformed settings. Writer scripts remain for sessions that cached their paths, so existing sessions may keep reporting until restarted. Codex live discovery depends on hook markers and is reduced with its hooks off; saved history remains available. Disabling hooks does not disable session discovery.

`newSession.prompt` prefills Claude's composer without submitting. It accepts `{issue}`, `{repo}`, `{title}`, `{url}`, and `{checkout}`; unknown placeholders remain unchanged. Empty prompts and new Codex sessions start without a prompt.

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

One hub serves both clients. It can continue serving Chrome after VS Code closes, stops polling when no board is visible, and exits after 30 minutes without connected clients.

State and logs are stored under `~/.claude/ground-control/`. **Logs** on the editor board and **Ground Control: Toggle Hub Log** toggle hub-log streaming. **Ground Control: Show Board Log** opens extension diagnostics. Chrome's **Show log** opens a sidebar with browser and hub lines.

After building, `npm run hub` runs a foreground hub against your real home. Use `node apps/hub/dist/main.js --home=<path>` for an isolated home, and add `--stop` to request shutdown for that home. An installed extension can replace an older foreground hub on activation.

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
