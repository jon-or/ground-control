# Recorded fixtures

The output of the real readers against the live machine. To re-record:

```
npm run build --workspaces && node test/fixtures/record.js
```

| File | What it holds |
|---|---|
| `issues.json` | what `fetchAssignedIssues` returned, with titles, URLs, account names and the selected avatar replaced by `anonymise.js` — this repo is public, and no test reads those fields |
| `sessions.json` | what `fetchSessions` returned for the sessions live at that moment, links, titles, transcript times and reported activity included |

The tests assert the merge's invariants — every session on exactly one card, issue order preserved, keys unique — against whatever this recording holds, plus that the recording still covers all three ways a session reaches the board (linked to an issue on the board, linked to one that is not, and unlinked), an issue card holding more than one session, and an issue with no session at all. A re-recording that loses a case fails rather than passing quietly.

`helpers.ts` asserts every row of `sessions.json` carries every field of `Session`. It has to: this file predated the `title` field, and `as Session[]` handed every test `undefined` where the type promised `string | null` without a single failure. A recording that has gone stale against the type now fails the run and names the missing field.

`issues.json` predates the pull-request `author`, `isDraft` and `reviewDecision` fields, which is why the recorded rules carry no login: nothing may read a field the recording does not hold. A test that turns on one derives the whole pull request and says so there.

Reported activity is `null` on every row of the current recording — the hooks that write it were not installed when it was made. The lane tests derive each phase and say so where they do it.

Where the machine will not produce a shape on demand — two sessions naming the same absent issue, an empty board — the test derives it from these fixtures and says so there; nothing derived is saved back here.
