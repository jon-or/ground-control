# Recorded fixtures

## `project-board.html`

The markup a GitHub project board serves in its board view, which is what the overlay paints onto. GitHub's project board is undocumented and its classes are hashed per build, so this is a recording rather than a description; `docs/mechanics.md` §27 carries the four attributes the overlay actually reads and the date they were measured.

Re-record with:

```bash
npm run record --workspace @ground-control/chrome-github-board
```

The source is GitHub's own **public** roadmap board (`https://github.com/orgs/github/projects/4247/views/21`), so recording needs no account, no token, and no login — which is why this is the one fixture in the repo a fresh checkout can refresh unattended. It is still somebody's real work, so `anonymise.cjs` runs as part of the recording and the tests only ever see the scrubbed file.

What the recorder keeps and what it replaces:

| Kept | Replaced |
| --- | --- |
| The board region, two columns, three cards, and every attribute the overlay reads | Issue numbers (`4501`–`4503`) and the repository slug (`example-org/example-repo`) |
| The wrapper elements and their hashed class names, so the fixture is the shape GitHub really serves | Issue titles, wholesale, from `tools/fixture-words.js` — free text is never matched, only overwritten |
| One empty column, because that is the shape a fresh board has | Column names and their cursor ids, and every project item id |

Trimming is by removing whole nodes: the other columns, the cards past the third, the label lists, and the icons. The label list goes because it is free text nothing here reads; the icons because they are paths no test walks.

`anonymise.cjs` asserts twice, which is the rule `docs/testing.md` states: that every value it set out to replace is gone, **and** that nothing of that shape survives at all — an issue link outside the synthetic repository, an issue number outside the three, a project item id not derived from one. A scrub that only removes what it enumerated is not a scrub.
