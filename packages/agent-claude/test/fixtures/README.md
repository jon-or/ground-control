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
| `hook-payloads.json` | real Claude Code hook payloads, captured through `claude --settings <file>` so the developer's own `~/.claude/settings.json` is never involved. Re-record with `node test/fixtures/record-hooks.js` |
| `history-records.json` | A prompted parent conversation record and a title record from one real session, with all unrelated strings redacted. Re-record with `node test/fixtures/record-history.mjs`. The history reader uses only metadata, not conversation content. |
| `transcripts.json` | the project-directory listing, plus each live session's cwd, the directory its transcript was found in (`dir`), that transcript's write time, the title records inside the window the reader reads (`titles`), and how far from the transcript's end its last title sat (`titleBytesFromEnd`) |

## Anonymised, and why that makes the tests stronger

This repo is public, so `anonymise.js` rewrites every checkout path, branch, session name and home directory on each recording. A branch name spells out the work it is for, so leaving them in would leak issue titles through a field nobody thinks of as one.

Every structural property the tests turn on survives: which sessions share a checkout, which branches carry an issue number, which checkouts are worktrees rather than clones, which project directories differ from their slug only by case, and which sessions have no transcript. Only the names change.

The checkout vocabulary and the absolute-path sweep are `tools/fixture-scrub.js`, shared with `packages/core` and `packages/host-vscode`, so one real checkout reads the same in every package's fixtures and a path any anonymiser let through fails the recording.

The paths are also **deliberately not paths that exist on this machine**, and that is load-bearing. While the fixtures named real checkouts, a reader that ignored its injected `readText`, `mtime`, `listDir` or `home` and read the real disk instead got identical answers and the suite stayed green — four mutations of `fetchSessions`'s dependency wiring survived. Against synthetic paths all four fail.

## Titles: the records, not the bytes around them

A transcript's title records are recorded; the conversation they sit among is not. Those bytes name real work in prose and cannot be anonymised the way a path can, so `titles` holds the records alone and the test's `readRecordedTails` rebuilds a tail from them behind a truncated fragment — which is what a positional read of a real file's end hands a reader. The title *text* is replaced like every other name; the record type, the field it uses, the order they appeared in, and which sessions had none are what the recording preserves.

`titleBytesFromEnd` is the evidence behind the reader's window: it is measured over the whole file, so an entry with a `titleBytesFromEnd` and an empty `titles` is a session whose title sits beyond what the reader reads. That case is in the recording, and a test asserts it stayed there.

No live session on this machine had a manual title when this was recorded, so the precedence between a manual and an automatic title is derived in `transcripts.test.ts` from a recorded automatic one, in the order §3b of `docs/mechanics.md` measured.

## Hook payloads, and the leg a human has to run

`record-hooks.js` runs one real `-p` session that reads a file, runs two commands in one batch, and spawns a subagent — which is what makes `PostToolBatch` fire more than once and `SubagentStop` fire at all. That covers `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolBatch`, `Stop`, `SubagentStop` and `SessionEnd`, and the recorder fails if a re-recording loses any of them.

`PermissionRequest`, `PermissionDenied` and `Notification` are **not** in the recording. A `-p` session has no permission prompt for anyone to answer, and a settings `deny` rule is not a denial event — measured, it fires `PreToolUse` then `PostToolBatch` and nothing else. So those three exist only in a session a human is sitting in front of: `node test/fixtures/record-hooks.js --interactive` prints the command and the five things to do in it, waits, and merges what was captured. A run without `--interactive` carries the payloads it cannot produce forward from whatever is already on disk, so a routine re-record never drops them.

Because the marker the board reads is **our own shape**, not the CLI's, `phase.test.ts` builds markers directly rather than deriving events it has no recording of. What is recorded is the payload the writer transcribes, which is `hook-writer.test.ts`'s job. Only `notification_type` and a non-empty `background_tasks` are derived in that test, and it says so where it does it.

The scrub keeps everything the tests turn on — the event name, `notification_type`, `source`, `reason`, `tool_name`, the length of `background_tasks`, and whether `agent_id` was present — and replaces every path, id, prompt and tool input, because a Bash command names real work as surely as a branch name does.

## What the tests rest on

`transcripts.json` stores no computed path. The slug rule is what the tests compute; the recorded listing and the recorded `dir` are what they are checked against. `dir` differs from the exact-case slug for several sessions, which is what makes the case-resolution rule testable at all — the mtime fake is keyed on the whole path, so a wrong directory reads as absent here exactly as it would on disk.

The two `claude` calls are separate invocations, so `agents-all.json` is not guaranteed to be a strict superset of `agents-active.json`. Tests assert properties of each file, never a relation between them.

Tests assert the mapper's contract against whatever this recording holds — that `status` survives exactly where the CLI supplied it, that each session's write time is found in the directory it is really in — plus that the recording still covers both sides of each case: a session with a status and sessions without, a transcript present and absent, one resolved only by directory case, and a background session with a short id. A re-recording that loses a case fails those tests rather than passing quietly.

A test may vary a field the CLI's own output declares optional — an unknown `kind`, a missing `name`, a detached `HEAD`, a CRLF gitdir pointer, an unusable pattern, two casings of one directory — when the machine will not produce that shape on demand. Derive it from a recorded fixture in the test and say so there; do not save the derived shape as a fixture, or the next reader will take it for a recording.
