# Testing discipline

The factory's central rule is that a station advances on evidence, not on a claim (`vision.md` — "Evidence not claims"; `prd.md` R23 — "Nothing advances on an agent's word alone"). This repo holds itself to the same rule. A commit is green because a runner said so, never because a person or an agent said so.

## The gate

```
npm run verify          # typecheck + test + coverage thresholds
```

`verify` is the whole contract. It runs on a `pre-commit` hook installed by `npm install` (the `prepare` script points `core.hooksPath` at `.githooks/`), and it is the only definition of "the tree is good". Nothing else counts — not a passing F5, not a screenshot, not an agent reporting success.

`verify` is the machine half of the gate. The other half is the subagent review a feature gets before it is committed (`claude.md` — Development Methodology), which judges what a runner cannot: whether the change matches the PRD, whether it broke a neighboring behavior, whether the tests it added can fail. Neither half substitutes for the other. A reviewed change that does not pass `verify` is not committed; a green change nobody reviewed is not done.

Bypassing it is `git commit --no-verify`, which is legitimate exactly twice: a work-in-progress commit on a branch nobody else reads, and a commit that only touches Markdown. Anything else that needs the bypass is a broken gate, and the fix is the gate.

## What earns a test

Write the test when the code has a way to be wrong that a type cannot catch:

- **Parsing and mapping external data.** Every GraphQL response shape, every field that can be null, every truncation boundary.
- **Failure classification.** A missing binary, an expired login, and a malformed response must produce three different, named outcomes. Each one gets a test that asserts the name.
- **Query construction.** The string sent to GitHub decides what appears on the board. Assert the string.
- **Deduplication, paging, and ordering.** Anywhere two inputs collapse into one output.
- **Anything a reviewer got wrong once.** A finding that survives verification becomes a test in the same commit as its fix.

Do not write the test for: pass-through property bags, a config reader that returns what the settings API gave it, or the shape of an argument parser.

## Rules

**No network in tests.** Every test runs offline, against fixtures in `packages/*/test/fixtures/`. A test that hits GitHub is not a test — it fails on a plane, it fails in CI without a token, and it changes its answer when someone reassigns an issue.

**Fixtures are recorded, not invented.** Capture a real response with `gh api graphql`, save it verbatim, and trim it only by deleting whole nodes. A hand-written fixture tests the fixture author's belief about the API, which is the thing most likely to be wrong. Record the command that produced each fixture in the fixtures directory's own `README.md` so it can be refreshed. A test may null a scalar the GraphQL schema declares nullable when the live API will not serve that shape on demand — derive it in the test and say so there, rather than saving a derived shape as a fixture.

**The webview protocol is typed on both sides.** The message the extension host posts and the message the webview parses are one contract, and the two halves live in different languages and different processes — the drift is silent, and it renders an empty board rather than throwing. So the webview's test payloads are built from the extension's own exported message type, not hand-written object literals: a field renamed in `src/` then fails `npm run typecheck` in `test/`. This is not the fixture rule above. The payload is ours, not an external API's, and recording it would freeze a shape we control.

**Assert the refusal, not just the success.** For every rule, the valuable test is the one proving the bad input is rejected. A test suite that only walks the happy path tells you the code runs, not that it is correct.

**A test that cannot fail is a bug.** Before writing an assertion, know what change to the source would break it. The same applies to the fakes: a stub that repeats its last recorded answer forever hides an over-paging bug from every test that uses it, so asking a fake for something it was not given is a failure. `expect(count).toBeGreaterThanOrEqual(n)` against data where the two are always equal proves nothing — that mistake was already caught once in review here.

**Coverage is a floor, not a goal.** Each package sets its own threshold in its `vitest.config.ts`; `packages/github` is held at 85% lines and branches, and a new package opts in the same way. An extension opts in with `coverage.include` pointing at its `media/**/*.js`, leaving out the `src/` vitest cannot reach — a floor computed over unreachable files is a number that means nothing. The number exists to make an untested new module fail loudly; it is not evidence that the tested code is correct.

## The three layers

Each layer has one thing that covers it. Know which layer you are changing before you decide what evidence you owe.

**The webview — `extensions/*/media/*.js`.** Plain DOM JavaScript that imports nothing from `vscode`, so vitest reaches it under jsdom with a stubbed `acquireVsCodeApi()`. Rendering, notices, empty states, staleness, and every message the extension host can send are asserted there, under the typed-payload rule above. An extension with a webview and no test directory is a gap to close, not a layer that cannot be covered.

**The extension host — `extensions/*/src/*.ts`.** Imports `vscode`, so vitest cannot reach it. Covered by a manual pass in the Extension Development Host (F5), and by keeping the layer thin: anything holding a decision belongs in a `packages/*` module that vitest can reach. A `src/` file growing branches is the signal to move them out, not the signal to reach for a heavier runner.

**Packaging.** `vsce package --no-dependencies` must succeed before a change lands, because F5 resolves workspace dependencies that the packaged `.vsix` does not — a green F5 is not evidence the extension installs.

Driving the whole VS Code window — Playwright over Electron, or a WebDriver harness — is not automated here and is not planned. It buys the seam between the host and the webview, which the typed protocol rule already covers, and pays for it in selectors that break on VS Code's release cadence rather than on ours.
