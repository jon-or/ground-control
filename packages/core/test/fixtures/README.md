# Recorded fixtures

Recorded from this machine, then anonymised. Nothing here is hand-written. To re-record:

```
node test/fixtures/record.js <checkout> [<checkout>...]
```

| File | What it holds |
|---|---|
| `git-reads.json` | each recorded checkout's `.git` and its `HEAD`, keyed by forward-slash path. A `null` is a real read failure: a plain `.git` is a directory, so reading it as text fails, which is how a clone is told from a worktree |

The recording must carry a worktree whose branch starts with an issue number, a worktree on a branch with a slash in its name, and a plain clone, because the link tests turn on all three. `anonymise.js` rebuilds every path and branch through `tools/fixture-scrub.js`, so the same checkout reads the same here as in `packages/agent-claude`'s fixtures, and the paths are deliberately ones that do not exist on the machine running the tests: a reader that ignored its injected `readText` and read the real disk would find nothing.
