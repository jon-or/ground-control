# Recorded fixtures

Every file here is a `gh api graphql` response, trimmed only by deleting whole `nodes` entries and then run through
`anonymise.js`. Scalars — `issueCount`, `pageInfo` — are left as recorded, so a fixture can legitimately report more
matches than it carries nodes for. That is the truncation case the tests need.

`$Q` and `$ISSUE_Q` are `ASSIGNED_ISSUES_QUERY` and `ISSUE_BY_NUMBER_QUERY` in `src/queries.ts`. `$REPO`, `$LOGIN` and `$PROJECT` are your own repository, `gh` login and
project number; the recorded values are scrubbed before the fixture is saved, because this repo is public.

| File | Command |
|---|---|
| `avatars.json` | `$Q` with `cards` and `all` set to a focused issue-number search; preserves a recorded Dev Review card where the issue assignee and linked PR author differ, and a Dev card whose linked PR is older, so the newest-first rule can be tested from a recording |
| `project-mode.json` | `gh api graphql -f query="$Q" -f cards='repo:$REPO is:issue is:open assignee:$LOGIN project:$REPO_OWNER/$PROJECT' -f all='repo:$REPO is:issue is:open assignee:$LOGIN'` |
| `not-on-project.json` | same, with a project number the assigned issues are not on — a real response where the filter excludes every one |
| `paged-page1.json` | `-f cards='repo:$REPO is:issue is:open' -f all='…'`, nodes trimmed to 3 |
| `paged-page2.json` | same plus `-f after='Y3Vyc29yOjEwMA=='`, nodes trimmed to 2 |
| `project-truncated.json` | `-f cards='repo:$REPO is:issue is:open project:$REPO_OWNER/$PROJECT' -f all='repo:$REPO is:issue is:open'`, nodes trimmed to 3 — the only fixture where the board's own match count and the wider assigned count differ *and* more pages remain |
| `issue-by-number.json` | `gh api graphql -f query="$ISSUE_Q" -f owner=$REPO_OWNER -f name=$REPO_NAME -F number=<a closed issue nobody is assigned>` — the case the by-number read exists for |
| `untyped.json` | `-f cards='repo:$REPO is:issue -type:Bug -type:Feature -type:Task -type:Epic' -f all=<same>`, nodes trimmed to 2 |

## Scrubbing

After recording, scrub every fixture in one pass — a login has to mean the same person in all of them:

```
GC_SELF_LOGINS=<your gh logins, comma-separated> node test/fixtures/anonymise.js
```

Titles are rebuilt from `tools/fixture-words.js`, keyed by issue number, so re-recording the same issue produces the
same text and the diff stays readable. A pull request's `url` is rebuilt the same way from its number. The repository becomes `example-org/example-repo`, the logins you pass become
`dev-1` and `dev-1-bot`, and every other account becomes `dev-2`, `dev-3` … in the order it is met. Issue numbers,
timestamps and cursors are kept: the tests turn on them and an integer names nobody. The script refuses to write a
file that still contains a recorded title, repository or login — the tests cannot catch that, because they only ever
see scrubbed output.

A test may null a scalar the GraphQL schema declares nullable — `pageInfo.endCursor`, say — when the live API will
not produce that shape on demand. Derive it from a recorded fixture in the test itself and say so there; do not
save the derived shape as a fixture, or the next reader will take it for a recording.

## Triage context

`context-*.json` are `CARD_CONTEXT_QUERY` responses — one card's conversation, for triage. They are recorded and
scrubbed in one pass by `record-context.js`, which reads the query out of `src/queries.ts` so a recording can never
be of a document the board does not send:

```
GC_SELF_LOGINS=<your gh logins> GC_CONTEXT_REPO=owner/name \
  node test/fixtures/record-context.js <issue>:<pr> <issue>:<pr> <issue>
```

A `-` in a slot leaves that fixture alone, so one card can be re-recorded without disturbing the rest:
`node test/fixtures/record-context.js - - - - <issue>`.

| File | What it demonstrates |
|---|---|
| `context-review.json` | A card with an open pull request carrying a submitted review and one resolved thread — checks green. Its issue body is padded past the reader's 2 KB limit, so one fixture exercises clipping |
| `context-fresh.json` | The same shape with no reviews, no threads and no review requests: a pull request nobody has looked at yet |
| `context-no-pr.json` | An issue with comments and no pull request at all, recorded with `withPr=false` |
| `context-bots.json` | A colleague's pull request commented on by bots — no profile name, no author association — which also happens to be **stacked on another feature branch**, so `baseRefName` is not the repository's default. That is the case R39 refuses to automate, recorded rather than invented |
| `context-handover.json` | A card handed over with nothing written on it: the status moved and the mover took themselves off it eight seconds later, and somebody else assigned the developer two and a half hours after that. Every comment predates all of it, which is what the live/background split is read against |

Run with no arguments to re-scrub what is on disk.

**One state is derived in the tests rather than recorded, and says so there.** A null `statusCheckRollup` appears
only on a commit no check ran against, so it cannot be captured from a repository that runs them.

### Scrubbing

`anonymise-context.js` replaces **every body wholesale** rather than matching known values: a recorded conversation is
the developer's and their colleagues' own words about their own work, and no list of logins or paths will match one.
Bodies are rebuilt from `remark()` in `tools/fixture-words.js`, keyed by number and position so two comments never
read alike and the diff stays readable across re-records. Logins go through the same map as the search fixtures, so a
person is the same `dev-N` in every file; a requested team becomes `team-N` for the same reason a login does.

Kept, because the tests turn on them: issue and pull request numbers, comment order, author associations, review
states and timestamps, thread resolution, every merge and check field, and the project statuses on the timeline —
those are the project's own column names, they identify nobody, and the shipped defaults already carry the same list.

**A branch name is free text and is rebuilt, not matched.** A name like `19072-requeue-rules-import` is the issue
title with the spaces taken out, so it names real work as surely as the title does. The leading issue number
survives — the tests turn on it and an integer names nobody — and the rest is rebuilt through `branchFor` in
`tools/fixture-scrub.js`, the same shared vocabulary every other package's recording uses, so issue 19072's branch
reads the same everywhere. The branches every repository has — `main`, `master`, `trunk`, `develop` — are left
alone: they name nobody, and whether a base equals the default branch is the whole of what decides that a merge is
one leg or a chain of them.

The second sweep covers branch names too: every ref-shaped value in the written file must be one `branchFor` would
have produced. That is what catches one arriving in a field nobody enumerated — a `headRef` the query grows later,
a merge-queue entry — rather than only in the two the anonymiser knows about today.

It asserts twice before writing — that each recorded value is gone, and that nothing shaped like a link, an email
address or an `@mention` survives anywhere in the file. The second is the sweep that catches what the first never
enumerated.
