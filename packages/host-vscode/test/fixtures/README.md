# Recorded fixtures

Recorded from this machine, then anonymised. Nothing here is hand-written. To re-record:

```
node test/fixtures/record-window-stores.js
node test/fixtures/record-codex-tab.js
```

Read the diff before committing — a fixture is evidence.

| File | What it holds |
|---|---|
| `codex-tab.json` | One window's editor memento while it held a revealed Codex thread, plus Codex's own sidebar state. Recorded by revealing a thread in a real window and waiting for the memento to flush; the recorder refuses to write unless a window is holding one. Codex titles a fresh tab with the thread id, which the title rule replaces like any other |
| `window-stores.json` | VS Code's own per-window state — each window's `workspace.json`, its serialised editor grid, and its Claude sidebar's webview state, taken verbatim so every layer of the JSON-inside-JSON unwrapping is exercised. Non-Claude editors are dropped as whole nodes, one `gettingStartedInput` kept so the walk is still proved to step over an editor that is not ours |

`record-window-stores.js` carries its own anonymiser, because the shapes it records are not the ones a session recording knows: an editor grid names files from anywhere the developer has opened one, not only the checkouts a window is rooted at. It takes `REPO`, `WORKTREES` and the absolute-path sweep from `tools/fixture-scrub.js` so the fixtures across packages cannot drift apart, and keeps a Windows-shaped home of its own, since a POSIX home inside a recorded Windows path is incoherent.

`record-codex-tab.js` scrubs the same three ways, and pairs each spelling of a path with the same spelling of its replacement: a Codex tab's own state is a JSON string inside the memento's JSON, so one Windows separator is written there as four backslashes, and a pass that only knew one and two deep left the checkout named in full.

It scrubs three ways — the values it set out to replace must be gone, no absolute path outside the synthetic prefixes may survive on any platform, and every recorded tab title is replaced with `recorded session` and asserted to be nothing else. Each caught leaks the others passed over: the path sweep found files from checkouts no window was rooted at, and the title rule found a real issue number that no path or id would ever have matched.

The open plan is tested against built `Session` rows rather than a recording: every decision it makes is about where a session is held, which is the machine's window state, and a built row is checked whole against the type so it cannot go stale the way a cast recording can.
