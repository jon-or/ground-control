# Recorded fixtures

Fixtures are `gh api graphql` responses with whole `nodes` entries removed, then scrubbed by
`anonymise.js`. Recorded counts and cursors remain unchanged, so match counts can exceed retained nodes.

`$Q` and `$ISSUE_Q` refer to `ASSIGNED_ISSUES_QUERY` and `ISSUE_BY_NUMBER_QUERY` in
[src/queries.ts](../../src/queries.ts). Substitute your repository, login, and project number in the commands below.
Scrub recordings before saving them in this public repository.

| File | Command or scenario |
|---|---|
| `avatars.json` | `$Q` with `cards` and `all` filtered by issue number; include a Dev Review card with differing assignee/PR author, plus a Dev card with an older linked PR. Predates the issue `author` selection; tests derive it |
| `project-mode.json` | `gh api graphql -f query="$Q" -f status=Status -f cards='repo:$REPO is:issue is:open assignee:$LOGIN project:$REPO_OWNER/$PROJECT' -f all='repo:$REPO is:issue is:open assignee:$LOGIN'` |
| `not-on-project.json` | Same query with a project that excludes all assigned issues |
| `paged-page1.json` | `-f cards='repo:$REPO is:issue is:open' -f all='…'`, nodes trimmed to 3 |
| `paged-page2.json` | Same query plus `-f after='Y3Vyc29yOjEwMA=='`, nodes trimmed to 2 |
| `project-truncated.json` | `-f cards='repo:$REPO is:issue is:open project:$REPO_OWNER/$PROJECT' -f all='repo:$REPO is:issue is:open'`, nodes trimmed to 3; filtered and assigned counts differ, with more pages available |
| `issue-by-number.json` | `gh api graphql -f query="$ISSUE_Q" -f status=Status -f owner=$REPO_OWNER -f name=$REPO_NAME -F number=<closed unassigned issue>` |
| `untyped.json` | `-f cards='repo:$REPO is:issue -type:Bug -type:Feature -type:Task -type:Epic' -f all=<same>`, nodes trimmed to 2 |

## Scrubbing

Run from `packages/github`. Scrub all fixtures together to preserve account mappings:

```sh
GC_SELF_LOGINS=<comma-separated gh logins> node test/fixtures/anonymise.js
```

Titles use [fixture-words.js](../../../../tools/fixture-words.js), keyed by issue number for stable output.
Repositories become `example-org/example-repo`; URLs retain issue/PR numbers. Configured accounts become `dev-1`
and its bot/alternate variants; other accounts become `dev-2`, `dev-3`, and so on. Numbers, timestamps, and cursors
remain unchanged. The script rejects remaining recorded titles, repositories, and logins before writing.

Tests may derive nullable fields, such as `pageInfo.endCursor`, from recorded fixtures when the API cannot produce
the state on demand. Document the derivation in the test; do not save it as a recording.

`$Q` and `$ISSUE_Q` take `-f status=<field>`; the context query does not. The recordings predate `project.owner`
and `project.field`, which the schemas treat as absent; `issues.test.ts` and `context.test.ts` derive them,
including the same project number under another owner, which the API cannot produce on demand. Project owner
logins are scrubbed to `example-org` and `other-org` in order of appearance.

## Triage context

`record-context.js` reads `CARD_CONTEXT_QUERY` from source, records card conversations, and scrubs them before saving:

```sh
GC_SELF_LOGINS=<gh logins> GC_CONTEXT_REPO=owner/name \
  node test/fixtures/record-context.js <issue>:<pr> <issue>:<pr> <issue>
```

Arguments correspond to the files below in order. Use `-` to preserve a file, for example
`node test/fixtures/record-context.js - - - - <issue>`. Run without arguments to re-scrub existing files.

| File | Scenario |
|---|---|
| `context-review.json` | Open PR with a submitted review, resolved thread, passing checks, and a synthetic issue body exceeding the 2,000 UTF-16-code-unit clipping limit |
| `context-fresh.json` | PR with no reviews, threads, or review requests |
| `context-no-pr.json` | Issue with comments and no PR, recorded with `withPr=false` |
| `context-bots.json` | Colleague's PR with bot comments lacking profile names/associations; targets a feature branch rather than the default branch, which R39 refuses to automate |
| `context-handover.json` | Status change followed by the actor's unassignment eight seconds later and developer assignment 2.5 hours later; all comments predate these events |

Tests derive a null `statusCheckRollup` because the recording repository runs checks on every commit.

### Context scrubbing

`anonymise-context.js` replaces every body using `remark()` in `fixture-words.js`, keyed by number and position.
It shares the search fixtures' login map and replaces profile names and team slugs. It preserves issue/PR numbers,
authorship relationships, comment order, author associations, review states, timestamps, thread resolution,
merge/check fields, and project status names used by the shipped defaults.

Branch names use `branchFor` in [fixture-scrub.js](../../../../tools/fixture-scrub.js), preserving leading issue
numbers and consistent synthetic names across packages. Standard branches (`main`, `master`, `trunk`, `develop`)
remain unchanged so base/default-branch comparisons stay representative.

Before writing, checks reject original identifying values, links, email addresses, mentions, and branch-shaped
values that `branchFor` would not produce. These checks cover fields not explicitly listed by the anonymizer.
