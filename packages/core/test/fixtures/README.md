# Recorded fixtures

Record and anonymise local Git reads from the package directory:

```
node test/fixtures/record.js <checkout> [<checkout>...]
```

`git-reads.json` contains `.git` and `HEAD` reads keyed by forward-slash paths. Null records a read failure, including a clone's `.git` directory read as text.

Include a worktree with an issue-number branch, a worktree with a slash in its branch name, and a plain clone. `anonymise.js` uses `tools/fixture-scrub.js` for consistent paths and branches across packages. Fixture paths must not exist locally, so tests fail if readers ignore the injected filesystem.
