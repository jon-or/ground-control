# Recorded fixtures

## `project-board.html`

The markup a GitHub project board serves in its board view, which is what the overlay paints onto. GitHub's project board is undocumented and its classes are hashed per build, so this is a recording rather than a description; `docs/mechanics.md` §27 carries the four attributes the overlay actually reads and the date they were measured.

Re-record with:

```bash
npm run record --workspace @ground-control/chrome-github-board
```

The source is GitHub's own **public** roadmap board (`https://github.com/orgs/github/projects/4247/views/21`), so recording needs no account, no token, and no login — which is why this is the one fixture in the repo a fresh checkout can refresh unattended. It is still somebody's real work, so `anonymise.cjs` runs as part of the recording and the tests only ever see the scrubbed file.

**The assignee stacks come from a second public board.** Nobody is assigned on the roadmap board, and the stack is the node the overlay's swap takes over — so one real stack is recorded from the first board in `ASSIGNEE_SOURCES` that has one, its person replaced, and grafted into the empty slot GitHub leaves in the card header. Two of the three cards get one; the third is left unassigned, which is a shape a real board has and the case the overlay must not act on. The recorder throws rather than record a fixture without one: a public board's assignees are its own team's, and a fixture quietly missing the thing the tests assert is worse than a failed recording.

What the recorder keeps and what it replaces:

| Kept | Replaced |
| --- | --- |
| The board region, two columns, three cards, and every attribute the overlay reads | Issue numbers (`4501`–`4503`) and the repository slug (`example-org/example-repo`) |
| One real assignee stack, grafted onto two cards | The assignee (`example-dev`), their avatar (a `data:` URI, so nothing rendering the fixture fetches anything), and the tooltip id, read off the recorded markup and rewritten per card |
| The wrapper elements and their hashed class names, so the fixture is the shape GitHub really serves | Issue titles, wholesale, from `tools/fixture-words.js` — free text is never matched, only overwritten |
| One empty column, because that is the shape a fresh board has | Column names and their cursor ids, and every project item id |

Trimming is by removing whole nodes: the other columns, the cards past the third, the label lists, and the icons. The label list goes because it is free text nothing here reads; the icons because they are paths no test walks.

`anonymise.cjs` asserts twice, which is the rule `docs/testing.md` states: that every value it set out to replace is gone, **and** that nothing of that shape survives at all — an issue link outside the synthetic repository, an issue number outside the three, a project item id not derived from one, and any `src`, `srcset`, `href`, `poster` or `data-src` holding an absolute address, since each of those is a fetch the moment a browser renders the fixture. A scrub that only removes what it enumerated is not a scrub. That last one earned itself on the first run: `getAttribute` hands back the decoded `&` where the serialised markup carries `&amp;`, so a replace by value left the real avatar in place — and the enumerated half reported the fixture clean.
