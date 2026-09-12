# Testing

Use automated checks for behavior and integration, and visual inspection for presentation. A passing test suite does not replace review against the [requirements](prd.md).

## Required checks

| Change | Verification |
|---|---|
| Executable code | `npm run verify` |
| VS Code host wiring or UI-visible behavior | Also `npm run test:integration` in a real VS Code |
| Extension packaging | `vsce package --no-dependencies` must succeed |
| Markdown only | Review accuracy, links, and cross-document consistency; no executable tests required |
| Comments and documentation references only | Also compare parsed source and embedded scripts/styles to confirm unchanged behavior; preserve JSDoc types and compiler/linter directives |

`npm run verify` builds, typechecks, and runs workspace tests with coverage thresholds. Build first: spawn tests execute generated bundles and must not use stale output. `npm run verify:full` adds the integration suite.

`npm install` installs the pre-commit hook through `core.hooksPath` and installs the Chrome test browser. Bypass the hook only for a docs-only commit or an explicit WIP commit on an unshared branch.

Features receive subagent review before commit. Review checks requirements, regressions, and whether assertions can detect defects. Neither review nor a passing test substitutes for the other.

Executable changes to the extension or its bundled packages finish with build, package, reinstall, and a check of the installed bundle. The developer reloads the window. Documentation and comment-only edits do not require extension installation when executable equivalence is verified.

## What earns a test

Test behavior that types cannot establish:

- Parsing external data, nullability, malformed payloads, and truncation.
- Failure classification and specific refusal cases.
- Query construction that determines the data returned.
- Deduplication, paging, ordering, state transitions, and concurrency.
- Side effects, protocol boundaries, and required command arguments.
- Verified review findings, with a regression test in the fix where behavior is testable.

Do not add tests for type declarations, pass-through property bags, simple settings reads, or argument-parser structure. Test an entry point through its externally observable behavior instead.

Coverage thresholds are package-specific, declared in each `vitest.config.ts`. They detect untested additions; they do not establish correctness. Keep narrowly justified exclusions for machine-only wrappers whose decisions are tested separately. The VS Code webview floor covers `media/**/*.js`, not `src/` files importing `vscode`. `apps/hub` has spawn tests rather than a coverage floor.

## Choose the test layer

| Layer | Harness | Proves |
|---|---|---|
| Package logic | Vitest with injected readers, clocks, and adapters | Decisions and failures |
| Hub server and transport | Vitest with real test-owned loopback listeners | Protocol, reconnects, authentication and refusal behavior |
| Built entry point | Spawn the built executable under a temporary home | Startup, discovery record, classified failures and shutdown |
| Hook writer | Spawn the script with recorded stdin | Written markers, failure behavior and exit contract |
| VS Code webview | Vitest/jsdom with `acquireVsCodeApi` stub | DOM rendering, controls, messages, notices and reports |
| VS Code extension host | Mocha inside real VS Code | Registration, settings, process/socket wiring and editor calls |
| Chrome DOM/state | Vitest/jsdom with recorded project markup | Card matching, rendering, local state and refusal display |
| Chrome extension | Headless Playwright persistent context | Injection, module loading, worker startup, messaging and frame-dependent behavior |

Keep business decisions in packages. A module that imports nothing from `vscode` should not require an extension-host test merely because it is located under an extension directory.

### Assertions

Use literal expected results independent of the implementation. Do not derive the expectation by calling the function under test or by repeating a selector's condition.

- Test refusals as well as success.
- Assert counts where an empty collection could make the contents check pass.
- Make fakes fail on unexpected calls or pages; do not repeat the final response indefinitely.
- Hold every relevant concurrent fake and assert peak concurrency. Held calls must respond to abort signals.
- Advance clocks only as far as the behavior requires.
- Check observable attributes when platform defaults would make property assertions vacuous. For explicit drag suppression, assert `getAttribute('draggable') === 'false'`.
- Know which source change would break each assertion. Temporarily breaking that source can verify the test.

## Fixtures and isolation

Tests make no external network requests. Loopback is allowed only to a listener the test created on `127.0.0.1` with port `0`; no fixed ports or developer services. Downloads needed to install test tools are setup, not test traffic.

Record external fixtures from real responses or files. Store the recording procedure in the fixture directory's README. Trim external response structure only by deleting whole nodes; do not invent plausible API payloads. A test may derive a nullable scalar case from a recording when the API cannot produce it on demand, with an explanation in the test.

Internal protocol payloads are different: construct them from the project's own types. Type changes must fail client-test typechecking. Fixtures cast to internal types also need a checked key list, such as `satisfies Record<keyof T, true>`, and row validation so new fields cannot silently become `undefined`.

### Recording and scrubbing

The repository is public. Scrub recorded data before saving it, as part of the recorder:

- Replace real repositories, account names, paths, titles, labels, prompts, and other free text with synthetic values.
- Preserve structural relationships, nullable fields, issue-number relationships, timestamps, cursors, and shared assignees needed by tests.
- Use shared vocabularies in `tools/fixture-words.js` and `tools/fixture-scrub.js` where applicable.
- Assert that original values are gone and that no unexpected absolute paths or sensitive free text remain. Cover both Windows and POSIX paths and drive-letter casing.
- Use an allowlist for undocumented payload fields; an unknown field must stop recording for review.

Interactive hooks still require recordings. Record manual steps for prompts a scripted print-mode run cannot produce. Merge new captures into the existing set so routine recording does not erase events only an interactive session can supply. Assert the captured event set and distinguish events the script guarantees from events it preserves.

HTML fixtures can trigger requests. Replace asset URLs with inert data, validate URL-bearing attributes, abort every browser request not explicitly fulfilled by the fixture route, and assert that none was attempted. Synthetic hostnames alone do not make a request safe.

### Homes and child processes

Any module writing user state takes an injected home. Tests use `mkdtemp` homes and must not reach real hooks, settings, lane memory, or agent histories. The Codex home must follow the isolated home too.

Hide console application spawns with `windowsHide: true`, including fixture scripts' child and grandchild spawns. The flag is not inherited. Detached processes can still cause descendants to allocate visible consoles.

## Client parity and presentation

Both boards duplicate some rendering helpers because they cannot load workspace TypeScript packages at runtime. Keep matching literal tables in their suites for `sessionLabel`, `agentTitle`, `ago`, `LANE_TITLES`, `LANE_SHAPES`, phase words/titles, duration titles, triage labels, card action states and outcomes, session start items, the phase and liveness words in session row names, tooltip geometry/timing, the avatar tooltip and accessible name with a linked account (`dev-1 · pull request author (as dev-1-bot)` and `dev-1, pull request author (as dev-1-bot)`; the conversation panel's `as dev-1-bot` is editor-only, since the overlay's panel frames GitHub's own page), `sameDir`, the open-checkout and worktree-control names and hints in each worktree state, the conversation panel's floating width floor, its pair's floor, and keyboard step, and session-link construction where shared. Lane pictogram geometry is product wording, not decoration: the overlay's lane chip has no text, so its shapes are how the lane reads. Pin shared wording literally on both sides: a `toContain` on one side lets that side's copy drift unnoticed. Include fallback precedence and Windows path cases. Test a core helper there too only when core defines one.

Do not assert either board's stylesheet: colors, borders, weight, tint, font size, or CSS declarations. This prohibition includes regex and computed-style assertions. Inspect presentation visually. Computed style remains appropriate for behavioral effects on GitHub's own DOM, such as hiding the original assignee stack, and actual visibility/filter behavior; it must not become a way to pin decorative declarations.

The jsdom harness must contain the controls the shipped panel HTML provides. Build webview message payloads from `BoardMessage`/`Snapshot` types rather than independently maintained untyped shapes.

The webview's `drew` message reports rendered DOM, not a copy of its input. Send it after rendering completes. Assert it against populated DOM in jsdom. The integration suite establishes that the real script starts and reports its own meta line; an empty integration board cannot prove card layout.

Browser tests cover behavior depending on message/repaint ordering. Examples include receiving a log backlog before the next frame and retaining the node under a pointer across a scan. Under jsdom, observer tests should use the product's observer options rather than a separately typed copy.

## VS Code integration

`npm run test:integration` builds and starts [run.mjs](../extensions/ground-control/test-integration/run.mjs), which launches the downloaded VS Code with a temporary portable directory and application home. Set `VSCODE_PORTABLE` to that directory and seed its `user-data/User/settings.json`: portable mode overrides `--user-data-dir` and prevents Windows protocol registration. A temporary profile alone does not prevent the test build from taking over `vscode://` links (M49).

Assert that portable mode remains enabled and the seeded settings are active. On Windows, compare the per-user `vscode://` registry tree before launch, inside the running test host, and after exit. A changed registration fails the run. Re-verify this isolation after VS Code upgrades.

The hub smoke test runs `--uninstall` against a temporary home with real registry access. The Chrome registration is per user, not per home, so removal must keep checking that the registered manifest belongs to the home being uninstalled; without that check the test deletes the developer's own registration.

The profile seeds application-scoped settings with unavailable `gh` and agent executable names. A temporary home alone does not isolate GitHub credentials stored in `%APPDATA%`. No integration test should accidentally run the developer's authenticated CLI.

The outer runner cleans up after VS Code exits, then removes its hub and temporary directories. Cleaning up the hub from a Mocha hook races the still-connected extension's reconnect. Later runs remove abandoned test directories older than one hour.

The extension exports three read-only accessors: `snapshot`, `drew`, and `logs`. Do not expose the client, panel, or action hooks merely for tests. Poll until state is available; an initially undefined snapshot is expected.

Exercise settings propagation, command/URI registration, subscriptions, process launch, and socket communication. Test decisions such as lanes and route selection in packages. Test resident command wiring with controlled handlers where possible; a resolved command promise alone does not establish that an editor opened correctly.

One-off checks use scratch `.test.cjs` files under `extensions/ground-control/test-integration/`. Run them, inspect the result, and remove them. Retain a check when it provides lasting regression coverage. Do not substitute a request for the developer to click through the feature.

Multi-diff assertions must account for the API's incomplete reporting: `textDiffs` omits one-sided additions/deletions. The editor's appended file count is an independent check of accepted resources; see [mechanics](mechanics.md#vs-code-git-and-combined-diffs).

External renderer-driving attempts were unsuccessful in the recorded VS Code environment. Use jsdom handlers, the real-host `drew` report, and scratch integration tests for their respective evidence. Do not generalize those failed attempts into a claim that no future driver can work.

## Chrome integration

Use Playwright's `chromium.launchPersistentContext` with `channel: 'chromium'`, `headless: true`, and the unpacked-extension flags. Load a temporary copy with `nativeMessaging` removed: native hosts are registered per user, so a fresh browser profile alone would still reach the developer's real bridge. Assert the shipped manifest separately.

Serve recorded HTML at the matching github.com URL with `context.route`; abort all other requests. A `file://` page does not exercise content-script matching. Drive extension messages from the worker or UI. `page.evaluate` runs in the page's main world and cannot call the extension's `chrome.runtime` APIs.

The pull request panel's header rule (`rules.json`) applies to responses from the network and not to ones `route.fulfill` synthesizes (M58). The suite serves the pull request page, and the issue page a pair frames beside it, with GitHub's refusal headers from a loopback TLS listener, points the browser's `github.com` at it with `--host-resolver-rules`, and lets that one route `continue`; the self-signed pair is in `fixtures`, and `ignoreHTTPSErrors` accepts it. A fixture served without the refusal would pass with no rule at all.

Use [record.cjs](../extensions/chrome-github-board/test/fixtures/record.cjs) to refresh public-board markup. It trims and scrubs real nodes and supplements the roadmap board with a recorded assignee stack. Exploratory browser inspection finds mechanisms; kept behavior is verified by repository tests.

## Triage and dispatch tests

Fake `AgentAdapter.classify`, `dispatch`, `stopDispatch`, and `WorkSource.readContext` at their interfaces in hub tests. Do not start real model sessions.

Assert full invocation arguments in adapter tests. For classification, flags must suppress persistence, settings, tools, and MCP servers and identify the private classifier session. For Claude dispatch, assert the explicit permission mode, isolation override, and absence of an ignored `--session-id`. Validate Codex's permission translation separately.

Respect production ordering in fakes:

- A dispatch becomes stoppable after its session appears on the roster.
- History arrives after the roster, so checkout information may be unavailable on the first snapshot.
- Seed sessions before constructing a hub when testing its initial read.
- To test a hub filter independently, provide an entry the adapter would not already have removed.

## Coverage failures

One recorded Windows failure duplicated coverage entries under `d:/...` and `D:/...`, with one copy at 0%. Stale Vite caches caused that case. If tests pass but unrelated packages show this exact pattern, inspect the reports, remove only the repository's resolved `.vite` cache directories, and rerun. Do not assume every coverage-only failure has this cause or lower thresholds to bypass it.
