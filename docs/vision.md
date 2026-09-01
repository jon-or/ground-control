# dev-tracker — Vision

## What we are building

A VS Code extension that runs a **software factory**: a repeatable, gated pipeline that carries a unit of work from an issue to a merged PR using coding agents, with a Kanban board as the operator console.

It is two things at once, and the second is the harder one:

- **A process.** A station / gate / evidence state machine, expressed as skills and workflows that agents execute.
- **A UI.** A board showing where every work item is, what its agent is doing right now, and where the line has stopped and is waiting on a human.

Claude Code is the first-class agent. Codex and Gemini are first-class *reviewers* — a model reviewing its own output shares its own blind spots.

## The stance: semi-autonomous

The line runs unattended until a station cannot certify its own output. Then it **parks** and raises a flag rather than guessing.

The operator can, at any moment, on any running agent:

| Level | What it means | Cost |
|---|---|---|
| **Watch** | tail the station's `stream-json` events — current tool call, live | free — does not touch the process |
| **Steer** | edit the agent's artifact (`plan.md`, `findings.json`); the station re-reads at its next checkpoint | free — does not touch the process |
| **Seize** | kill the station, open its session in a native editor tab, drive by hand | **kills every in-flight subagent** |

Seize is a four-step loop, not a button: **kill → seize → release → hand back.** An open editor tab holds the session, and a hand-back attempted while it is open silently forks into a second agent on the same worktree. Release — closing the tab — is a first-class action the extension performs, never something the operator is trusted to remember (`docs/mechanics.md` §11).

Steer is the important one. The operator corrects the agent by editing the artifact, not by arguing in a chat window — which is what makes supervising several items at once tractable.

Seize is the whole argument for a VS Code extension rather than a web dashboard: one keystroke from watching to driving, in a real terminal, with full conversation history intact. It is not free, though — stopping a session SIGKILLs its subagents and discards their results (`docs/mechanics.md` §4). The board must quote that price before the operator pays it, and offer Steer instead.

**Seize is inherently stop-and-take-over, and the tab arrives idle.** The kill is structural, not incidental: a live session plus an open tab is two writers, which forks the transcript and silently orphans one branch's work. And `editor.open`'s seeded prompt *prefills* the input box without submitting — so the operator always presses Enter. That is right for "the station parked on a decision": seed the prompt from the park reason and one keystroke is the whole interaction. It is wrong for "let me see it work" — that is **Watch**, which costs nothing and leaves the station running. If the operator only wants to look, Seize is the wrong verb.

Seize is also **window-addressed**, not global: a Claude tab's working directory is always its host window's first workspace folder, so the session must be opened in a window rooted at its own worktree (`docs/mechanics.md` §5, §8).

## What is on the board

**Only work the factory or the operator currently owns.** When an item is handed to an external reviewer or to QA, its card leaves the board. It returns when review comments arrive.

One item is never in two lanes at once. Lane is a pure function of the item's current station.

## Stations

Nine stations, three of them operator-owned. Reviewing another developer's PR is not a special case — it is the same station machinery under a different work-type template.

| # | Station | Owner | Produces | Gate to advance |
|---|---|---|---|---|
| 1 | `intake` | agent | `spec.md` | operator approves the spec |
| 2 | `plan` | agent | `plan.md`, `tasks.md` | operator approves the plan |
| 3 | `build` | agent | commits, `evidence/build.log`, `evidence/tests.json` | build clean; tests actually ran and passed |
| 4 | `cross-review` | **other-model agent** | `evidence/findings-{model}.json` | findings exist; every finding adjudicated |
| 5 | `remediate` | agent | commits, updated findings | re-dispatch station 4 until it returns dry |
| 6 | `self-review` | **operator** | `review-notes.md` | operator approves, or sends back to `remediate` |
| 7 | `handoff` | agent | push, PR, tracker status write | PR exists — **card leaves the board** |
| 8 | `respond` | agent + operator | `threads.json` | all external threads resolved — back to `handoff` |
| 9 | `review-theirs` | agent + operator | draft review, then posted review | operator approves and posts — card leaves |

The three kinds of review are now structurally distinct rather than heuristically guessed:

- Reviewing the agent's work before it ships = station 6.
- Acting on another developer's review of my code = station 8 (event-triggered re-entry).
- Reviewing another developer's code = station 9 (a template whose entire body is that station).

## Worked example

A bug enters at `intake`. The agent writes `spec.md` and parks at the gate. The operator skims it in the extension panel and approves. `plan` and `build` run unattended overnight. `cross-review` dispatches Codex against the diff; Codex returns four findings. `remediate` adjudicates: two confirmed and fixed, one disputed with reasoning, one it cannot decide — so it pulls the andon cord and parks.

Morning: the board shows one card in **Cross-review**, red, "1 finding needs a call." The operator drops in, resolves it, the line restarts, `cross-review` re-runs and comes back dry, and the card lands in **My review** with the diff, the adjudication log, and Codex's findings side by side.

## The four principles

**1. Evidence, not claims.** A station advances on a stored artifact, never on an agent's assertion. "Tests pass" is not a state transition; a test-run log with a nonzero assertion count and zero failures is. Every hallucinated completion is a missing evidence gate. *(From the DoD DevSecOps reference design's control gates.)*

**2. Stop the line.** Any station may halt rather than pass a defect downstream. Park by default; add bounded retry only where failures prove transient. Retry-first is how a factory silently burns a night of tokens. *(Jidoka and the andon cord, from the original meaning of "software factory.")*

**3. Artifacts are the memory and the steering wheel.** Each station emits a markdown or JSON artifact that grounds the next station and is directly editable by the operator. *(From GitHub Spec Kit's `spec → plan → tasks → implement` chain.)*

**4. Schema and template, not a hardcoded flow.** Stations and artifacts are defined once; a work-type template binds a variant — bug, feature, chore, review-theirs — to a subset of them. A new kind of work is a config file, not a code change. *(From Greenfield & Short's software product lines.)*

## Verified mechanics

The agent-runtime facts this design rests on are measured, not assumed, and recorded in **`docs/mechanics.md`** with the evidence: how stations are dispatched (`claude --bg`), where liveness comes from (`claude agents --json`, never transcripts), what a stop destroys, how a Claude tab resolves its working directory, and why a VS Code window can only be addressed from inside itself. Read it before designing anything that touches a session.

## Control plane

`.factory/` is authoritative. The tracker (GitHub Projects) is a **projection target** written at station 7, not the source of truth. Making the tracker authoritative would force every station to become a tracker column, and the board would degenerate into GitHub's board.

Each item owns a directory holding `state.json` (the contract), its artifacts, its evidence, and an append-only event log. The per-issue workspace is a git worktree.

Agents never write `state.json` directly. They call a small `factory` CLI, which means a Claude Code hook can validate every transition against the schema and refuse an advance with missing evidence — and the extension never has to infer state.

## Constraint model

The operator's gates are the bottleneck, not the agents. Per-lane WIP limits plus a global `max_concurrent_agents`. When `self-review` is full, `intake` stops pulling new work. That is the Kanban part earning its keep rather than decorating.

## Prior art we are drawing on

| Source | What we take |
|---|---|
| OpenAI Symphony (Apache-2.0, Apr 2026) | The orchestration loop: poll the tracker, guarantee every active item has an agent in an isolated workspace until terminal, with concurrency caps, lifecycle events, and an explicit handoff state. **We diverge on the human model** — Symphony is async-only (review the PR at the end); we want mid-run drop-in. That gap is why this is an extension. |
| DoD Platform One / DevSecOps reference design | Control gates that collect evidence for a risk decision. |
| Toyota / lean | Jidoka, andon, WIP limits. |
| GitHub Spec Kit | The artifact chain, and the artifact as steering surface. |
| Greenfield & Short, *Software Factories* (2004) | Schema plus per-variant templates. |
| Cross-model adversarial review (Claude Code plugins; Codex CLI as MCP server) | The reviewer must not be the author's model; schema-constrained findings so remediation can adjudicate mechanically. |

## Explicit non-goals

- Not a replacement for GitHub Projects.
- Not built on the existing `or-*` skills in the `orez` repo. This factory is from scratch; `orez` is its first consumer, not the source of its process.
- Not a general-purpose agent chat UI. Conversation belongs in a real Claude Code session; the board is for state.
- Not VS Code-locked at the core. The orchestrator and CLI stay free of VS Code APIs so the factory can later run headless as a daemon.

## Roadmap

| Task | Scope | Doc |
|---|---|---|
| **1** | `state.json` schema, `factory` CLI, evidence rules. Headless, no UI. Stations run by hand. | `task1.md` |
| **2** | Window registry and the seize channel — address a VS Code window by worktree and open a session in it. | `task2.md` |
| **3** | Read-only board: webview over `factory list --json`, Watch and Seize wired to the channel. | — |
| **4** | Orchestrator loop (poll → dispatch → advance/park), WIP limits, gate UI. The line runs. | — |
| **5** | `cross-review` with Codex, work-type templates, hook-enforced gates. | — |
| **6** | Gemini as second reviewer, `respond` and `review-theirs` templates, headless daemon, multi-repo. | — |

Task 2 comes before the board because seize turned out to be infrastructure rather than a button — see `docs/mechanics.md`.

## Open decisions

1. **Station granularity.** Nine may be too many for a bug, too few for a feature. Resolve empirically in v0 — templates exist so the answer can differ per work type.
2. **What certifies `build`.** Full suite, targeted subset, or subset plus no new build warnings. Must be computable by the CLI from runner output, never assertable by an agent.
3. **Worktree lifecycle.** Does the factory create and tear down the per-issue worktree at intake? Symphony makes workspaces ephemeral; per-issue local IIS sites argue for durable ones.
4. **Cost controls.** Per-item token budget, and what happens when it is exceeded — park, or downgrade the model.
