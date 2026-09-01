# Testing discipline

The factory's central rule is that a station advances on evidence, not on a claim (`vision.md` — "Evidence not claims"; `prd.md` R23 — "Nothing advances on an agent's word alone"). This repo holds itself to the same rule. A commit is green because a runner said so, never because a person or an agent said so.

## The gate

```
npm run verify          # typecheck + test + coverage thresholds
```

`verify` is the whole contract. It runs on a `pre-commit` hook installed by `npm install` (the `prepare` script points `core.hooksPath` at `.githooks/`), and it is the only definition of "the tree is good". Nothing else counts — not a passing F5, not a screenshot, not an agent reporting success.

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

**Fixtures are recorded, not invented.** Capture a real response with `gh api graphql`, save it verbatim, and trim it only by deleting whole nodes. A hand-written fixture tests the fixture author's belief about the API, which is the thing most likely to be wrong. Record the command that produced each fixture in a sibling `.cmd` file so it can be refreshed.

**Assert the refusal, not just the success.** For every rule, the valuable test is the one proving the bad input is rejected. A test suite that only walks the happy path tells you the code runs, not that it is correct.

**A test that cannot fail is a bug.** Before writing an assertion, know what change to the source would break it. `expect(count).toBeGreaterThanOrEqual(n)` against data where the two are always equal proves nothing — that mistake was already caught once in review here.

**Coverage is a floor, not a goal.** `packages/*` is held at 85% lines and branches. The number exists to make an untested new module fail loudly; it is not evidence that the tested code is correct.

## What is not unit-testable, and what covers it instead

The extension host, the webview, and `vsce package` cannot be reached from vitest. They are covered by a written manual pass in `docs/task0.md` § Verification, run before each of the five commits lands, plus one hard requirement: **`vsce package --no-dependencies` must succeed**, because F5 resolves workspace dependencies that the packaged `.vsix` does not.
