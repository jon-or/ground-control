# Recorded fixtures

Every file here is a verbatim `gh api graphql` response against `ownerrez/orez`, trimmed only by deleting whole
`nodes` entries. Scalars — `issueCount`, `pageInfo` — are left as recorded, so a fixture can legitimately report
more matches than it carries nodes for. That is the truncation case the tests need.

`$Q` is the document in `src/queries.ts`.

| File | Command |
|---|---|
| `project-mode.json` | `gh api graphql -f query="$Q" -f cards='repo:ownerrez/orez is:issue is:open assignee:jon-or project:ownerrez/3' -f all='repo:ownerrez/orez is:issue is:open assignee:jon-or'` |
| `not-on-project.json` | same, with `project:ownerrez/6` in `cards` — a real response where the filter excludes every assigned issue |
| `paged-page1.json` | `-f cards='repo:ownerrez/orez is:issue is:open' -f all='…'`, nodes trimmed to 3 |
| `paged-page2.json` | same plus `-f after='Y3Vyc29yOjEwMA=='`, nodes trimmed to 2 |
| `project-truncated.json` | `-f cards='repo:ownerrez/orez is:issue is:open project:ownerrez/3' -f all='repo:ownerrez/orez is:issue is:open'`, nodes trimmed to 3 — the only fixture where the board's own match count and the wider assigned count differ *and* more pages remain |
| `untyped.json` | `-f cards='repo:ownerrez/orez is:issue -type:Bug -type:Feature -type:Task -type:Epic' -f all=<same>`, nodes trimmed to 2 |

A test may null a scalar the GraphQL schema declares nullable — `pageInfo.endCursor`, say — when the live API will
not produce that shape on demand. Derive it from a recorded fixture in the test itself and say so there; do not
save the derived shape as a fixture, or the next reader will take it for a recording.
