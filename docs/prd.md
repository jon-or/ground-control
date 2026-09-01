# ground-control — PRD

User-facing requirements only. Mechanisms, schemas, and APIs live in `docs/mechanics.md`, `docs/task1.md`, `docs/task2.md`.

## 1. Purpose

A VS Code extension that gives one developer a single place to see, and intervene in, every piece of work they own — the GitHub issues assigned to them and every Claude Code session running on their machine — on one Kanban board.

Today those live in three disconnected places: GitHub's project board, a fleet of VS Code windows across many worktrees, and a set of terminal sessions whose state is only visible by attaching to them. Nothing shows what an agent is doing right now, and nothing shows which agent belongs to which issue.

## 2. Audience and scope

**Any OwnerRez developer, on their own machine.** Not a team dashboard and not a manager view — a personal board — but one that any developer on the team can install and use on day one, not a tool shaped around one person's setup.

That distinction drives real requirements. It must not assume the user runs dozens of worktrees, keeps seven VS Code windows open, has a second AI CLI installed, has hand-installed helper extensions, or works with agents at all times. A developer who runs one session a day and switches branches in a single clone has to get value from it, and a developer who never opens it must not be affected by it.

**In scope:** issues assigned to the user, sessions running on this machine, and the user's interventions on them.

**Out of scope for v1:** other people's work, remote/cloud sessions, team reporting, and any writing to GitHub beyond what the user explicitly triggers.

### Assumed, because it is how the team already works

The team's shared conventions are fair to rely on, but they belong in configuration, not in the product's assumptions about a person:

- Work is tracked as GitHub issues on the team's project board, with the developer as assignee.
- Branch names carry the issue number.
- Development happens in a local checkout of the repo, served by a local site.

Everything else about a developer's environment is theirs, and the board adapts to it.

## 3. Requirements

### Board and cards

**R1. The board shows the GitHub issues assigned to the user.**
One card per issue, with its number, title, and type. Issues nobody has assigned to the user do not appear.

**R2. The board shows every active Claude Code session on the machine.**
No session is invisible. A session the user forgot about is exactly what this board exists to surface.

**R3. A session linked to an issue appears under that issue's card.**
An issue card can hold several sessions. The card is the unit of work; sessions are attempts at it.

**R4. A session with no linked issue gets its own card.**
Ad-hoc work is first-class. It is not hidden, and it is not forced into an issue it does not belong to.

**R5. Each card shows enough to decide whether to act, without opening it.**
At minimum: what stage it is in, whether anything is running, whether anything needs the user, and how long it has been in that state.

**R6. Cards that need the user are visually unmistakable.**
A card waiting on a decision must not look like a card that is working. This is the board's primary job — a parked agent the user never noticed is the failure mode being designed against.

### Lanes

**R7. Lanes represent broad stages of the user's own work, named in the team's existing vocabulary.**
A developer who already thinks in the project board's statuses should not have to learn a second set of words. Working proposal, to be settled in use:

| Lane | Meaning |
|---|---|
| **Plan** | scope or tasking not yet agreed; nothing being built |
| **Build** | work in progress |
| **Review** | work exists and is being checked |
| **Blocked** | waiting on something outside the user's control |

Where a lane corresponds to a status on the team's board, it says so, so that "what lane is this in" and "what status is this in" are never in conflict.

**R8. A card sits in exactly one lane.** Its lane reflects where the *user's* attention is needed, not the issue's status in GitHub.

**R9. Work that has left the user's hands leaves the board.**
Once an issue is with another reviewer, a tester, or a release, its card disappears. It returns when it comes back to the user. The board is a to-do list, not a record.

**R10. Each lane shows how full it is.**
The user should be able to see at a glance that they have too much in flight. (Whether the board *enforces* a limit is an open question — see §5.)

### Watching

**R11. The user can see what a session is doing right now.**
The current action, in plain language, updating live while it runs — not a log to read, and not a stale snapshot.

**R12. Watching costs nothing.**
Looking at a session never interrupts it, slows it, or changes its state.

**R13. The user can tell a working session from a stuck one.**
"Thinking" and "waiting on a 5-minute command" must not look the same as "stopped 40 minutes ago".

### Taking over

**R14. The user can open a session in a Claude Code tab and drive it by hand.**
The tab shows the full prior conversation and runs in that work's own directory, so anything typed operates on the right code.

**R15. Taking over stops the session, and the user is told so before it happens.**
The cost is stated in specific terms — including how much in-flight work will be discarded — with the option to watch or redirect instead.

**R16. Taking over pre-fills the most likely next message.**
When a session stopped to ask something, the reply the user probably wants is already in the box. One keystroke should be the whole interaction.

**R17. Closing the tab hands the session back.**
No separate "give it back" step. When the user is done, they close the tab and the work resumes on its own, picking up where it left off — including anything that was interrupted.

**R18. The user cannot accidentally create two agents on the same work.**
If a session is already open somewhere, the board says so and refuses to start a second one rather than silently splitting the work in two.

### Redirecting without taking over

**R19. The user can change what a session is doing by editing its working notes.**
No need to stop it, and no need to argue with it in a chat window. The session picks up the change on its own.

### Recovering by itself

**R20. A session stopped by a usage limit resumes on its own when the limit lifts.**
The card says what it is waiting for and when it expects to resume. No user action, and it does not count against their in-flight work.

**R21. Transient failures retry without involving the user.**
Only a failure that survives retrying becomes something the user sees.

**R22. Work interrupted by a stop is resumed, not silently dropped.**
Anything that was in flight when a session stopped comes back when it resumes, or the card says plainly that it did not.

**R23. Nothing advances on an agent's word alone.**
A stage completes when there is something to show for it. A session that stopped early — for any reason — must not look finished.

### Configuration

**R26. It works on first run with no setup.**
A developer installs it, opens the board, and sees their assigned issues and running sessions. Anything the board can detect, it detects; anything it cannot, it asks for once, in place, rather than failing or showing an empty board with no explanation.

**R27. Team-wide facts ship with the tool; personal facts are the developer's own settings.**

| Shared — same for everyone, ships as defaults | Personal — differs per developer |
|---|---|
| Which repository and project board work is tracked on | Their GitHub account(s) |
| The set of statuses and what they mean | Where their checkout(s) live, and whether they use worktrees |
| The branch-naming convention | Their local site hostname(s) |
| The default lane set and lane→status mapping | Which extra AI CLIs they have installed |
| | How much work they want in flight at once |
| | How much the board is allowed to do on its own |
| | What agents it starts are allowed to do without asking |
| | Whether it may open new editor windows |

A new developer should inherit every shared default without configuring anything, and should never have to edit a shared setting to make the tool work on their machine.

**R28. The developer declares their GitHub identity, and it can be more than one account.**
Several developers work under both a personal account and a bot or AI account. Work under any of their accounts is theirs, and the board treats it as one person.

**R29. The board adapts to how the developer organizes checkouts.**
One clone with branch switching, many clones, or many worktrees — all supported. The developer says where their code lives; the board does not impose a layout.

**R30. Optional tools are detected, never required.**
If a second AI CLI is installed, features that use it appear. If not, the board works without them and does not nag. Nothing is broken by absence.

**R31. Permissions for agents the board starts default to the safe setting, and loosening them is explicit.**
A developer who has not thought about it gets the conservative behavior. Anyone who wants agents to act without asking turns that on themselves, knowingly.

**R32. How much the board does on its own is a setting, and it starts at nothing.**
Out of the box the board shows and intervenes; it does not start work. A developer opts in to more autonomy, in steps, at their own pace.

**R33. How much work is allowed in flight is the developer's number.**
Limits vary with how a person works and with what their account can sustain. The board suggests a starting value and the developer changes it.

**R34. Settings are changeable without editing files.**
Anything a developer is expected to set, they can set from the board or from normal editor settings.

### Honesty

**R24. The board never shows a state it has not verified.**
If an action may not have worked, the board says so rather than assuming success.

**R25. The user can see why a card cannot move forward.**
In their own terms: what is missing, or what failed.

## 4. What success looks like

- The user can answer "what is every agent on this machine doing?" in one glance, from one window.
- No agent sits parked and unnoticed for hours.
- Taking over a session and handing it back is a small enough action to do casually, several times a day.
- Work is never silently lost or silently duplicated.
- The user stops keeping a mental list of which worktree holds which task.
- A second developer installs it and gets value the same day, without a setup session or a document to follow.

## 5. Open questions

1. **Lane set.** The Plan / Build / Review / Blocked proposal in R7 is untested. Does "Review" need splitting by *who* is reviewing — the user checking an agent's work, the user answering someone else's review, the user reviewing another developer's code? All three are things the user does, and they may want separate lanes.
2. **Does the board enforce limits or only display them?** Enforcement changes it from an information tool to a process tool.
3. **How much of the pipeline is automatic?** Does the board only surface and intervene, or does it also start work on its own? This is the largest open question and it determines whether "unattended overnight" is a goal.
4. **What links a session to an issue?** Branch name, working directory, something the user sets by hand, or a mixture. Affects how often R3 guesses wrong.
5. **Sessions on other machines.** Out of scope for v1, but the board's value grows if it is the one place to look.
6. **Where shared defaults come from.** Checked into the repo so a new developer inherits them by pulling, or shipped inside the extension so they update with it. The first keeps them reviewable alongside the code they describe; the second keeps them working before a checkout exists.
7. **What links a session to an issue when the branch does not say.** Branch number is the obvious signal, but it fails for a session started before a branch exists, and for developers working in a single clone across several issues. Falling back to asking the developer once per session may be better than guessing.
8. **Whether a developer can see the board without the extension changing anything.** A read-only first run would let someone evaluate it with no risk, which matters for adoption across a team.
