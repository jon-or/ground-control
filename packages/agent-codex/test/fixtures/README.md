# Recorded Codex fixtures

`hook-payloads.json` is one real Codex session's seven hook events, in the order Codex fired them, scrubbed by `anonymise.js`. Recorded 2026-09-07 against `codex-cli 0.153.0`; the mechanisms are written up in `docs/mechanics.md` §40 and §41.

`record.js` writes the fixture, and the capture it takes is made by hand: a Codex hook cannot be provoked from a one-line command, because the payloads only exist inside a session, an approval only exists when something asks for one, and Codex will not run a hook it has not been told to trust. The capture happens in an isolated `CODEX_HOME`, so the developer's own hooks and history are untouched.

1. Make a scratch home and a scratch checkout, and copy `~/.codex/auth.json` into the scratch home. The home must not be under the OS temp directory — the Windows sandbox refuses to create its helper binaries there and every tool call is then rejected by policy.
2. Write a `hooks.json` into it with one entry per event whose `command` is a script that appends its stdin to a file. `planHookInstall` writes exactly this shape; the probe differs only in what the command does.
3. Ask Codex what it sees: start `codex app-server` with `CODEX_HOME` pointed at the scratch home, `initialize`, then `hooks/list` with the scratch checkout as its `cwds`. Every entry comes back `untrusted` with a `currentHash`.
4. Write each `currentHash` into the scratch `config.toml` as `[hooks.state.'<key>'] trusted_hash = "<hash>"`. `hooks/list` then reports `trusted`, and the hooks fire with no flag.
5. Start a thread with `sandbox: 'read-only'` and `approvalPolicy: 'on-request'`, and give it a turn that reads one file and writes another. The write is what produces `PermissionRequest`; answer the server's `item/commandExecution/requestApproval` with `{"decision":"accept"}` and `PostToolUse` follows.
6. `SessionEnd` comes from a session that ends cleanly — a `codex exec` run that finishes. A killed process fires none, which is the measurement behind the roster's pid check.
7. `node record.js <captured.ndjson>` — one raw payload per line, in the order they fired. It scrubs through `anonymise.js`, which asserts that no recorded value survived, that no absolute path did, and that all seven events are present, so a re-record that cannot provoke one fails rather than quietly shrinking the fixture. A field the payload has grown since this was written stops the recording until someone decides whether it is kept or replaced.
