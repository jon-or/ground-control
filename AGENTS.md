# Ground Control

A VS Code board and Chrome overlay for assigned GitHub issues and local Claude Code and Codex sessions. Both use one background hub. Installation and usage are in [README.md](README.md).

## Workflow

1. Read the relevant docs and implementation. Write a plan, including verification, before coding.
2. Implement the change and update affected docs in the same task. Test new behavior according to [testing.md](docs/testing.md).
3. Use subagents to review features before committing. Cover requirements, correctness, regressions, and UI behavior where applicable.
4. Complete the required checks. For executable changes to the installed extension or its bundled packages, [rebuild and reinstall](#reinstalling-after-a-change).
5. Commit each self-contained story or task after review, verification, and user acceptance.

Continue until the task is complete or blocked. Ask for clarification when required intent is unresolved, credentials are missing, the work would deviate from the PRD, or verification is inadequate.

## Documentation

Read and update the document responsible for the decision:

| Document | Owns |
|---|---|
| [prd.md](docs/prd.md) | Product behavior, scope, requirements (R IDs), and implementation gaps |
| [architecture.md](docs/architecture.md) | Component responsibilities, dependencies, state, and protocols |
| [mechanics.md](docs/mechanics.md) | Dated experiments and source inspections, versions, limitations, and current use (M IDs) |
| [testing.md](docs/testing.md) | Required checks, test layers, fixture rules, and isolation |

Replace superseded text in place. Record the decision and its constraint; omit discussion history, discarded proposals, and changelog prose. Distinguish current implementation, future requirements, and experimental evidence. An experiment does not imply product support. Re-verify version-fragile mechanisms after upgrading the relevant CLI or editor extension.

## Code and package boundaries

- Keep the VS Code board/extension and GitHub Chrome extension feature-equivalent wherever their platforms and permissions allow. Assess both clients for every user-facing change and update shared behavior in the same task. Adapt controls to each host while keeping capabilities, displayed state, and terminology consistent. Document intentional differences and their reasons in the PRD, and verify shared behavior in both clients under the [parity rules](docs/testing.md#client-parity-and-presentation).
- Keep business decisions in `packages/*`. Neither packages nor `apps/hub` may import `vscode`; extension-host API calls belong in `extensions/ground-control`.
- Agent packages must not import another agent or host package. Core defines neutral contracts and must not depend on adapters.
- The VS Code webview and Chrome overlay use JavaScript with their own test harnesses. Chrome APIs are provided by the extension runtime.
- Consult the [component table](docs/architecture.md#components-and-dependencies) for package responsibilities. `extensions/seize-probe` is an unshipped experiment, outside npm workspaces.
- Root `package.json` lists workspaces in build order. Run `npm install` after changing the list.
- Prefer existing tools before building substantial replacements. Refactor affected code when necessary; remove dead code, unused imports, and commented-out implementations.
- Use direct names and simple implementations. Comments should explain non-obvious constraints or behavior, without boilerplate, metaphors, personification, or change history.
- Validate external data at runtime. The project uses Zod schemas and explicit readers for external formats.

The stack is TypeScript 5.9 with strict checking, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, ES2022, NodeNext modules, and project references. npm workspaces require Node >= 20. Vitest provides tests and coverage; esbuild bundles the extension and vsce packages it. External integrations use `gh`, `claude`, `codex`, and local agent/editor files.

## Verification

[testing.md](docs/testing.md) is the full contract.

- Run `npm run verify` for executable changes: build, typecheck, tests, and coverage thresholds. The pre-commit hook runs it for staged changes beyond Markdown/text files. Bypass the hook only for docs-only work or an explicit WIP commit on an unshared branch.
- Run `npm run test:integration` for VS Code host wiring or UI-visible behavior. It uses a real extension host with isolated settings and home. Use scratch integration tests for one-off checks; remove them unless they provide lasting regression coverage. Verify behavior directly instead of asking the developer to click through it.
- Choose the test layer by API dependencies. Package logic and webview DOM belong in Vitest; `vscode` wiring belongs in the real-host suite. Chrome integration uses headless Playwright with an isolated copy that excludes `nativeMessaging`.
- Use recorded, scrubbed fixtures and injected homes. No external network traffic or developer services in tests; test-owned loopback listeners are allowed.
- Assert failures and refusals as well as success. Each assertion must detect a possible implementation defect.
- Do not test decorative stylesheet values. Inspect presentation visually. Computed style is appropriate for behavioral visibility checks and effects on GitHub's existing DOM.
- For documentation, check accuracy and links. For comment-only edits, also verify unchanged executable code, embedded scripts/styles, JSDoc types, and directives. Neither requires installation when behavior is unchanged.

Run commands from the repository root:

| Command | Purpose |
|---|---|
| `npm run verify` | Build, typecheck, tests, coverage |
| `npm run verify:full` | Verify plus VS Code integration tests |
| `npm run test:integration` | Build and run VS Code integration tests |
| `npm run build` | Build workspace packages and extension bundles |
| `npm run watch` | Incremental builds |
| `npm test` | Workspace tests with configured coverage |
| `npm run typecheck` | Source and test typechecking |

### Reinstalling after a change

For executable changes to the VS Code extension, hub, or bundled packages:

```bash
npm run build
npm run package --workspace ground-control
code --install-extension extensions/ground-control/ground-control-0.0.0.vsix --force
```

Packaging must succeed with `vsce package --no-dependencies`; the workspace script includes that flag, and `--baseContentUrl`/`--baseImagesUrl` because the extension README links to repository-root files. It has no `vscode:prepublish` hook, so build first. A repository build alone does not update the installed VSIX.

Verify the relevant installed bundle (`dist/hub.js` or `dist/extension.js`) contains the change. For example, replace the placeholder below with a changed, single-line ASCII string from the hub bundle:

```javascript
// Run with Node on Windows.
const fs = require('node:fs');
const file = process.env.USERPROFILE + '/.vscode/extensions/groundcontrol.ground-control-0.0.0/dist/hub.js';
console.log(fs.readFileSync(file, 'utf8').includes('<changed ASCII text>'));
```

Confirm installation and report that the developer can reload when ready. Do not reload their window. Activation copies the installed hub bundle to the shared home path and can replace an older running hub, including a foreground development process.

## Commit messages

Use `type(scope): summary`, adding `(fixes #123)` on the same line when closing an issue.

- Use a conventional type such as `feat`, `fix`, `docs`, `refactor`, `test`, or `chore`, and an area such as `hub`, `board`, or `architecture` as scope.
- Write an imperative, lowercase summary under about 70 characters, without a final period.
- Name the changed identifier and behavior. Use exact settings, flags, message types, and measurements. Avoid metaphors and personification.
- A trivial change needs only the summary. Otherwise use two to five single-line bullets for non-obvious constraints, measurements, or defects. Omit diff narration, review history, and routine check results.

```text
fix(hub): decode streamed responses with StringDecoder

- The Node inspector requires byte chunks; setEncoding('utf8') supplies strings.
- StringDecoder preserves multibyte characters split across chunks.
```
