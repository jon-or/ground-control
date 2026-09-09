# Recorded Codex fixtures

`hook-payloads.json` contains seven real hook-event types in capture order, scrubbed by `anonymise.js`. Recorded 2026-09-07 with `codex-cli 0.153.0`; see [mechanics M40–M41](../../../../docs/mechanics.md#codex-hook-payloads-and-process-identity).

Capture real sessions in an isolated `CODEX_HOME`. `codex exec` can produce hook events; approval capture requires an interactive approval flow.

1. Create an isolated home and checkout. Copy `~/.codex/auth.json` into that home. Keep it outside the OS temp directory: the recorded Windows sandbox could not create its helper binaries there and rejected tool calls.
2. Write `hooks.json` with a probe entry per event. Each command appends hook stdin to the capture file; use the structure from `planHookInstall`.
3. Start `codex app-server` with the isolated `CODEX_HOME`, send `initialize`, then `hooks/list` with the checkout in `cwds`. New entries report `untrusted` and a `currentHash`.
4. Trust only the probe entries using `config/batchWrite`: an edit with `keyPath: "hooks.state"`, `mergeStrategy: "upsert"`, and `value` mapping each returned key to `{ trusted_hash: currentHash }`. `hooks/list` should then report `trusted`. See the exchange in [exchange.ts](../../src/exchange.ts); do not compute hashes or rewrite TOML.
5. Start a thread with `sandbox: 'read-only'` and `approvalPolicy: 'on-request'`. Ask it to read a file and write another. The write produces `PermissionRequest`; answer `item/commandExecution/requestApproval` with `{"decision":"accept"}` to capture `PostToolUse`.
6. Capture `SessionEnd` from a cleanly finished `codex exec` session. A killed process emits no such event.
7. From this directory, run `node record.js <captured.ndjson>`. Supply one raw payload per line in capture order.

The recorder scrubs values, checks that no original values or absolute paths survive, and requires all seven events. Unknown fields stop recording for review. General policy is in [testing.md](../../../../docs/testing.md#recording-and-scrubbing).
