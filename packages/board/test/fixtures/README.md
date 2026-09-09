# Recorded fixtures

Record actual reader output from the package directory:

```
npm run build --workspaces && node test/fixtures/record.js
```

| File | Contents |
|---|---|
| `issues.json` | Assigned-issue results with text, URLs, accounts, and avatars scrubbed |
| `sessions.json` | Live session results, including links, titles, transcript times, and activity |

Tests require unique card keys, preserved issue order, and exactly one card per session. Recordings must cover sessions linked to assigned issues, sessions naming other issues, unlinked sessions, multiple sessions on one issue, and issues without sessions.

`helpers.ts` checks every recorded session against all `Session` fields. Type assertions alone cannot detect fields missing from a recording.

`record.js` writes both files. Retain only the recording needed for a shape change; refreshing issues also changes the issue numbers used by lane tests.

The anonymiser replaces `details.name` and `details.shortId`, preserves known neutral `kind`, `status`, and `state` values, and rejects unknown keys so new adapter fields cannot bypass scrubbing.

`issues.json` predates PR `author`, `isDraft`, and `reviewDecision` fields. Test helpers supply missing values; tests requiring specific PR data derive it explicitly.

Session rows include both reported and absent activity. Tests derive specific phases or cases unavailable on demand, such as an empty board or duplicate references to an absent issue. Do not save those derived cases over the recordings.
