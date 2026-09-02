# Recorded fixtures

Recorded from this machine, then anonymised. Nothing here is hand-written. To re-record every file in this directory:

```
node test/fixtures/record.js
```

Read the diff before committing — a fixture is evidence, and the counts move as sessions start and exit.

| File | What it holds |
|---|---|
| `agents-active.json` | `claude agents --json` — every live session |
| `agents-all.json` | `claude agents --all --json` — the same sessions plus finished background ones. The only fixture carrying a short `id` or a `state`, so it is what proves those two fields are mapped rather than hardcoded |
| `git-reads.json` | each recorded checkout's `.git` and its `HEAD`, keyed by forward-slash path. A `null` is a real read failure: a plain `.git` is a directory, so reading it as text fails, which is how a clone is told from a worktree |
| `transcripts.json` | the project-directory listing, plus each live session's cwd, the directory its transcript was found in (`dir`), and that transcript's write time — both `null` where there is no transcript |

## Anonymised, and why that makes the tests stronger

This repo is public, so `anonymise.js` rewrites every checkout path, branch, session name and home directory on each recording. A branch name spells out the work it is for, so leaving them in would leak issue titles through a field nobody thinks of as one.

Every structural property the tests turn on survives: which sessions share a checkout, which branches carry an issue number, which checkouts are worktrees rather than clones, which project directories differ from their slug only by case, and which sessions have no transcript. Only the names change.

The paths are also **deliberately not paths that exist on this machine**, and that is load-bearing. While the fixtures named real checkouts, a reader that ignored its injected `readText`, `mtime`, `listDir` or `home` and read the real disk instead got identical answers and the suite stayed green — four mutations of `fetchSessions`'s dependency wiring survived. Against synthetic paths all four fail.

## What the tests rest on

`transcripts.json` stores no computed path. The slug rule is what the tests compute; the recorded listing and the recorded `dir` are what they are checked against. `dir` differs from the exact-case slug for several sessions, which is what makes the case-resolution rule testable at all — the mtime fake is keyed on the whole path, so a wrong directory reads as absent here exactly as it would on disk.

The two `claude` calls are separate invocations, so `agents-all.json` is not guaranteed to be a strict superset of `agents-active.json`. Tests assert properties of each file, never a relation between them.

Tests assert the mapper's contract against whatever this recording holds — that `status` survives exactly where the CLI supplied it, that each session's write time is found in the directory it is really in — plus that the recording still covers both sides of each case: a session with a status and sessions without, a transcript present and absent, one resolved only by directory case, and a background session with a short id. A re-recording that loses a case fails those tests rather than passing quietly.

A test may vary a field the CLI's own output declares optional — an unknown `kind`, a missing `name`, a detached `HEAD`, a CRLF gitdir pointer, an unusable pattern, two casings of one directory — when the machine will not produce that shape on demand. Derive it from a recorded fixture in the test and say so there; do not save the derived shape as a fixture, or the next reader will take it for a recording.
