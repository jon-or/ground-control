# Ground Control

A VS Code extension: one board for the GitHub issues you own and the Claude Code sessions running on your machine.

## Planning Artifacts

Source-of-truth planning docs live in [docs/](docs/). Read the relevant one before making decisions it covers:

| Document | When to consult | What gets written back to it |
| --- | --- | --- |
| [prd.md](docs/prd.md) | User-facing requirements (R-numbers), scope, audience | Every decision made about a feature — what it does, what it refuses, what is out of scope |
| [vision.md](docs/vision.md) | Where it is going — the factory model, station/gate/evidence stance | The results of brainstorming and higher-level thinking we do together |
| [mechanics.md](docs/mechanics.md) | Verified mechanisms — CLI flags, session files, extension APIs, with the date each was measured | Any mechanism that changed, and anything newly measured, with the date it was measured |
| [testing.md](docs/testing.md) | The gate every commit passes, what earns a test, fixture rules | Testing guidance that emerged from implementation — a layer that turned out testable, a class of bug tests missed |

If a request touches requirements, scope, or a mechanism, open the matching doc first — don't guess from code alone. `mechanics.md` records only what was measured on this machine; anything marked **version-fragile** is re-verified after a Claude Code or VS Code extension upgrade.

### Keeping them current

The docs are updated as part of the work that changed them, in the same commit — not in a documentation pass afterwards.

**Rework in place; never append.** A decision that supersedes an earlier one replaces the paragraph that held it.

**No transitional language.** The doc describes the system as it is now. Never "this used to read the CLI directly, and now goes through a provider", never "as of the sessions work", never a changelog entry. Git holds the history; the doc holds the present.

**Write the decision, not the discussion.** What we settled on and the constraint that decided it. Options considered and discarded stay out.

## Development Methodology

- Plan first. Read the PRD, vision, mechanics, and existing code, then write a plan that includes how you will verify the change — before coding.
- All new functionality is verified by tests. `docs/testing.md` is the contract; it decides what earns a test and what does not.
- After developing a feature, use subagents to review it. Where appropriate, run several from different angles (spec adherence, regression, correctness, UX).
- Manually exercise UI-visible changes in the Extension Development Host (F5) before calling them done.
- One commit per story or task. Commit when a self-contained task is complete, reviewed, verified, and accepted by the user.
- When a commit fixes a GitHub issue, put a closing reference on the first line (`fix(board): summary (fixes #123)`).
- Once assigned work, continue until all tasks are complete or you hit a blocker. Raise to the user if you need credentials, clarification, better requirements, a deviation from the PRD, or you cannot adequately verify the change.

## Testing

The full rules are in [docs/testing.md](docs/testing.md). The short version:

- **`npm run verify` is the only definition of "the tree is good"** — typecheck + tests + coverage thresholds. A `pre-commit` hook runs it. Not a passing F5, not a screenshot, not an agent reporting success.
- `--no-verify` is legitimate exactly twice: a WIP commit on a branch nobody else reads, and a docs-only commit.
- **No network in tests.** Fixtures in `packages/*/test/fixtures/`, recorded from real responses with `gh api graphql`, trimmed only by deleting whole nodes.
- **Assert the refusal, not just the success.** A test that cannot fail is a bug — know what source change would break an assertion before you write it.
- **Know which layer you are changing.** A webview script (`media/*.js`) imports nothing from `vscode`, so it belongs in vitest under jsdom. An `extensions/*/src/` file does import it and cannot be reached, which is why decisions belong in a `packages/*` module instead. Packaging gets the hard requirement that `vsce package --no-dependencies` succeeds — F5 resolves workspace dependencies the packaged `.vsix` does not.

## Code Quality

- Follow best practices for TypeScript, Node, and the VS Code extension API.
- Don't reinvent the wheel. Prefer existing tools; research before starting a significant build of something that likely exists.
- Refactor as you go. If a feature reveals that existing code should change, change it — don't layer on top of bad foundations.
- Delete dead code. No commented-out blocks, unused imports, or stale variables.
- Prefer simple, direct solutions. Three clear lines beat a premature abstraction.
- No AI slop: no boilerplate comments, no redundant docstrings, no filler error messages.
- No transitional comments. Comments describe current behavior, concisely, and only where the behavior is genuinely non-obvious.

## Tech Stack

- **TypeScript 5.9**, strict, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. ES2022, `nodenext` modules, project references (`tsc -b`).
- **npm workspaces**, Node >= 20.
- **vitest** + `@vitest/coverage-v8`, per-package `vitest.config.ts` with its own coverage floor.
- **zod** parses every external payload.
- **esbuild** bundles the extension; **@vscode/vsce** packages it.
- External data comes from two CLIs: **`gh`** for GitHub, **`claude`** for sessions.

## Repo Structure

| Directory | Purpose |
| --- | --- |
| `packages/github` | GitHub reads via the `gh` CLI. **Must not import `vscode`.** |
| `packages/sessions` | Claude Code session reads via the `claude` CLI. **Must not import `vscode`.** |
| `packages/board` | Merges assigned issues and live sessions into board cards. **Must not import `vscode`.** |
| `extensions/ground-control` | The extension — activation, config, webview board panel. Imports `vscode`. |
| `extensions/seize-probe` | Probe extension that proves window-scoped command targeting for `docs/mechanics.md`. Not a workspace, not shipped. |

That boundary is what makes the logic testable in vitest: a module importing `vscode` can only be verified by hand, so decisions belong in a `packages/*` module and the extension stays thin.

## Essential Commands

```bash
npm run verify      # typecheck + test + coverage — the gate
npm run build       # tsc -b across packages, esbuild for the extension
npm run watch       # incremental build for F5
npm test            # vitest across workspaces
npm run typecheck   # tsc -b plus each package's test tsconfig
```

Package the extension from `extensions/ground-control`:

```bash
npm run package     # vsce package --no-dependencies --allow-missing-repository
```

## Running It

F5 from the repo root launches the Extension Development Host (`.vscode/launch.json`). The board opens via the **Ground Control: Open Board** command.
