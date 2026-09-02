# Recorded fixtures

The output of the real readers against the live machine. To re-record:

```
npm run build --workspaces && node test/fixtures/record.js
```

| File | What it holds |
|---|---|
| `issues.json` | what `fetchAssignedIssues` returned, with titles, URLs and account names replaced by `anonymise.js` — this repo is public, and no test reads those three fields |
| `sessions.json` | what `fetchSessions` returned for the sessions live at that moment, links and transcript times included |

The tests assert the merge's invariants — every session on exactly one card, issue order preserved, keys unique — against whatever this recording holds, plus that the recording still covers all three ways a session reaches the board (linked to an issue on the board, linked to one that is not, and unlinked), an issue card holding more than one session, and an issue with no session at all. A re-recording that loses a case fails rather than passing quietly.

Where the machine will not produce a shape on demand — two sessions naming the same absent issue, an empty board — the test derives it from these fixtures and says so there; nothing derived is saved back here.
