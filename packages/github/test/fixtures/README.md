# Recorded fixtures

Every file here is a `gh api graphql` response, trimmed only by deleting whole `nodes` entries and then run through
`anonymise.js`. Scalars — `issueCount`, `pageInfo` — are left as recorded, so a fixture can legitimately report more
matches than it carries nodes for. That is the truncation case the tests need.

`$Q` is the document in `src/queries.ts`. `$REPO`, `$LOGIN` and `$PROJECT` are your own repository, `gh` login and
project number; the recorded values are scrubbed before the fixture is saved, because this repo is public.

| File | Command |
|---|---|
| `avatars.json` | `$Q` with `cards` and `all` set to a focused issue-number search; preserves a recorded Dev Review card where the issue assignee and linked PR author differ |
| `project-mode.json` | `gh api graphql -f query="$Q" -f cards='repo:$REPO is:issue is:open assignee:$LOGIN project:$REPO_OWNER/$PROJECT' -f all='repo:$REPO is:issue is:open assignee:$LOGIN'` |
| `not-on-project.json` | same, with a project number the assigned issues are not on — a real response where the filter excludes every one |
| `paged-page1.json` | `-f cards='repo:$REPO is:issue is:open' -f all='…'`, nodes trimmed to 3 |
| `paged-page2.json` | same plus `-f after='Y3Vyc29yOjEwMA=='`, nodes trimmed to 2 |
| `project-truncated.json` | `-f cards='repo:$REPO is:issue is:open project:$REPO_OWNER/$PROJECT' -f all='repo:$REPO is:issue is:open'`, nodes trimmed to 3 — the only fixture where the board's own match count and the wider assigned count differ *and* more pages remain |
| `untyped.json` | `-f cards='repo:$REPO is:issue -type:Bug -type:Feature -type:Task -type:Epic' -f all=<same>`, nodes trimmed to 2 |

## Scrubbing

After recording, scrub every fixture in one pass — a login has to mean the same person in all of them:

```
GC_SELF_LOGINS=<your gh logins, comma-separated> node test/fixtures/anonymise.js
```

Titles are rebuilt from `tools/fixture-words.js`, keyed by issue number, so re-recording the same issue produces the
same text and the diff stays readable. The repository becomes `example-org/example-repo`, the logins you pass become
`dev-1` and `dev-1-bot`, and every other account becomes `dev-2`, `dev-3` … in the order it is met. Issue numbers,
timestamps and cursors are kept: the tests turn on them and an integer names nobody. The script refuses to write a
file that still contains a recorded title, repository or login — the tests cannot catch that, because they only ever
see scrubbed output.

A test may null a scalar the GraphQL schema declares nullable — `pageInfo.endCursor`, say — when the live API will
not produce that shape on demand. Derive it from a recorded fixture in the test itself and say so there; do not
save the derived shape as a fixture, or the next reader will take it for a recording.
