# Recorded fixtures

These fixtures contain recorded, anonymized VS Code state. Build the package, then run:

```
node test/fixtures/record-window-stores.js
node test/fixtures/record-codex-tab.js
```

Review the recorded diff before committing.

| File | Contents |
|---|---|
| `codex-tab.json` | Editor memento with a revealed Codex thread and its sidebar state. Reveal a thread and wait for storage to flush; the recorder requires a matching window. Replace tab titles, including default thread-ID titles. |
| `window-stores.json` | Window `workspace.json`, nested editor grid, and Claude sidebar state. Keep Claude tabs and one `gettingStartedInput` to test ignoring unrelated editors. |

The recorders replace checkout paths, session IDs, account names, and titles while preserving nested JSON encoding. They share synthetic checkout prefixes and path checks from `tools/fixture-scrub.js`, with a Windows-format home for recorded Windows paths. Match each replacement's separator and escaping style; nested JSON can encode one separator as four backslashes.

Before writing, each recorder checks that original identifiers are absent, every absolute path uses a synthetic prefix, and every tab title is `recorded session`. These checks also cover paths outside window roots and free-text identifiers that path substitution cannot remove.

Open-plan tests use typed `Session` rows with recorded window state. Their decisions depend on session placement; the constructed rows remain checked against the current type.
