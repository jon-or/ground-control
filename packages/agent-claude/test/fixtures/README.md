# Recorded Claude fixtures

Fixtures contain scrubbed observations from real sessions. Review recording diffs before committing; session counts and available cases change.

Run from `packages/agent-claude`:

| File | Contents | Recorder |
|---|---|---|
| `agents-active.json` | `claude agents --json` roster | `node test/fixtures/record.js` |
| `agents-all.json` | `--all` roster, including finished background jobs with short IDs and state | Same command |
| `git-reads.json` | Checkout `.git`/HEAD reads keyed by normalized path; null records read failure | Same command |
| `transcripts.json` | Project listings, cwd, resolved directory, mtime, title records, and distance of the last title from EOF | Same command |
| `hook-payloads.json` | Captured hook stdin | `node test/fixtures/record-hooks.js` |
| `history-records.json` | Prompted-parent and title metadata from a real session | `node test/fixtures/record-history.mjs` |

`record.js` writes only the first four files. Its two roster calls are separate invocations; tests must not assume `agents-all.json` is a strict superset of `agents-active.json`. A plain clone's `.git` is a directory and cannot be read as text; the recorded null distinguishes it from a worktree's pointer file.

## Scrubbing and coverage

`anonymise.js` replaces paths, branches, session names, and homes. Shared `tools/fixture-scrub.js` naming keeps the same checkout consistent across packages. Preserve shared checkouts, issue-number relationships, clone/worktree distinctions, directory-case differences, and absent transcripts.

Use nonexistent synthetic paths so bypassing injected `readText`, `mtime`, `listDir`, or `home` cannot pass by reading the real checkout. Four dependency-wiring mutations were caught with these fixtures. Validate that original values and unexpected absolute paths are absent.

Tests require status present/absent, transcript present/absent, case-only directory resolution, and a background short ID. A recording that loses a case must fail. Optional-field variants may be derived from recordings inside tests when unavailable on demand: unknown kind, missing name, detached HEAD, CRLF gitdir pointer, invalid pattern, or directory casing. Identify derived cases; do not save them as observations.

General rules are in [testing.md](../../../../docs/testing.md#fixtures-and-isolation).

## Transcript titles

Record title records rather than surrounding conversation text. Replace title text while preserving record type, field name, ordering, and absence. `readRecordedTails` reconstructs a tail with a truncated initial fragment to exercise positional reads.

`titleBytesFromEnd` is measured over the complete file. A value with empty `titles` records a title outside the read window; preserve that case. No live manual title was captured. Tests derive manual-title precedence from an automatic-title recording using [mechanics M3b](../../../../docs/mechanics.md#claude-transcripts-and-titles).

`transcripts.json` stores observed directory names, not computed slug paths. Tests compare the slug rule to the listing and recorded `dir`, including case differences. The mtime fake uses the full path, so incorrect resolution returns absent.

## Hook capture

`record-hooks.js` runs a print-mode session with a file read, two commands in one batch, and a subagent. It requires `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolBatch`, `Stop`, `SubagentStop`, and `SessionEnd`. The batch produces repeated `PostToolBatch` events. Probe settings are supplied through `--settings`; the recorder does not edit the developer's settings file.

The current recording excludes `PermissionRequest`, `PermissionDenied`, and `Notification`. Print mode has no interactive approval flow; a tested settings deny rule produced `PreToolUse` and `PostToolBatch`, not a denial event. Run `node test/fixtures/record-hooks.js --interactive` for the interactive procedure. It prints the command and required actions, then merges captures. Ordinary recording preserves previously captured interactive events.

Markers are an internal format, so `phase.test.ts` constructs them directly. `hook-writer.test.ts` uses captured external payloads; its derived `notification_type` and nonempty `background_tasks` cases are identified in the test. Scrubbing preserves event names, notification type, source, reason, tool name, background-task count, and presence of agent_id while replacing paths, IDs, prompts, and tool inputs.
