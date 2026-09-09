# Ground Control

A personal board for assigned GitHub issues and local Claude Code and Codex sessions, available in VS Code and as a Chrome overlay on GitHub Projects.

## Features

- Group live and saved sessions by issue or checkout, with observed phases, durations, and attention indicators.
- Organize work in local lanes shared across clients. Moving a card does not change its GitHub status.
- Reveal or resume sessions, attach to Claude background jobs, open checkouts, and inspect combined changes in VS Code.
- Start an editor session at a card's checkout. Claude accepts an unsent prompt; Codex opens a bare session.
- Classify the next action from issue and pull-request context. Triage is enabled by default and can be disabled.
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

Activation through a command, restored board, or URI starts the client and installs enabled activity hooks with backups. Installation alone does not activate it. Ground Control trusts its own Codex hooks through Codex's API and preserves unrelated entries.

For Chrome, run **Ground Control: Enable GitHub Overlay** in VS Code, then load `extensions/chrome-github-board` unpacked at `chrome://extensions`. **Ground Control: Disable GitHub Overlay** removes the native-host registration. See the [overlay guide](extensions/chrome-github-board/README.md).

The overlay displays card/session state and supports local lane moves, session links, checkout opening, and logs. Starting or stopping work, requesting classification, selecting paths, and opening combined diffs require VS Code. Checkout opening requires a connected editor.

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
