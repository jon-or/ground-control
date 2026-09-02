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

**R2. The board shows every active agent session on the machine.**
No session is invisible. A session the user forgot about is exactly what this board exists to surface. Claude Code is the agent the board reads today; a developer running a second agent CLI sees its sessions on the same board, labelled by which agent reported them, rather than a second board.

A session that has never been prompted is not on it. An editor tab opened and left alone is a running process and nothing else — no transcript, no turn, no work — and a board of them is a board the user learns to ignore. The board omits a session only when all three of its independent signals are silent: no transcript, no reported activity, and no status of its own from the agent. Any one of them means the session has begun, so the cost of a transcript the board fails to locate is a card without a title, never a session it hides.

**R3. A session linked to an issue appears under that issue's card.**
An issue card can hold several sessions. The card is the unit of work; sessions are attempts at it.

**R4. Sessions with no linked issue get a card per directory.**
Ad-hoc work is first-class. It is not hidden, and it is not forced into an issue it does not belong to. The directory such a session runs in is what it has in common with the others there, so one checkout is one card however many agents are in it, and the card is named for the directory. The card appears only while something runs there — and because the card is the directory, the lane the developer put it in belongs to the directory too: it outlives any one session and new ad-hoc work in that checkout joins the card where they left it.

**R5. Each card shows enough to decide whether to act, without opening it.**
At minimum: what stage it is in, whether anything is running, whether anything needs the user, and how long it has been in that state.

A running session's own name shimmers, so a board of ten cards shows which ones are moving without being read. The duration beside it is the time since the board last *observed* the session take a step, not the time since the prompt was submitted — an hour on a working session and an hour on a stuck one have to look different, and only an observation can tell them apart.

A GitHub reference the board read itself is the way to that page: the issue number and the title open the issue in the browser, and the pull-request chip opens that pull request. The board resolves the address from its own read, so the card never carries a URL the webview hands back — which is also why an issue number the board only learned from a session's branch is shown but not linked. It has no read for that issue and will not guess its URL.

**R6. Cards that need the user are visually unmistakable.**
A card waiting on a decision must not look like a card that is working. This is the board's primary job — a parked agent the user never noticed is the failure mode being designed against.

A card holding a session waiting on the developer is marked on three channels at once — a badge that says so in words, a border, and the session's own name set apart — because colour alone is not unmistakable to everyone who will use this. The mark is on the card, not only on the session line, so it survives being seen from across the board. Such a card does not move to the top of its lane: a phase flips on its own every few minutes, and cards jumping under the cursor is worse than a static order.

### Lanes

**R7. Lanes are the board's own stages, independent of the tracker's statuses.**
A GitHub status says whether a piece of work is the user's; it does not say what stage the user is at with it. ⚒️ Dev covers planning, building and checking alike, and 🔖 Planned or 👀 Tasking Review describe steps that happen before the work is theirs at all. So the board keeps its own lanes and does not try to read them out of a status. Every lane names one action the card is asking for; a lane holding two unlike jobs should be two lanes or none.

| Lane | The action it asks for |
|---|---|
| **Unstarted** | pick it up, or leave it |
| **Plan** | agree what to build |
| **Build** | nothing, unless it stopped |
| **Review** | read a diff and judge it |
| **Done** | confirm and let go |
| **Icebox** | nothing, deliberately |

The lane is called **Unstarted** rather than New so it is never confused with the 🆕 New status, which is a different thing and is not on the board at all.

**Review holds both kinds of review.** Checking an agent's diff before it ships and reviewing another developer's PR are the same process — read a diff, judge it — so they are one lane, and the card says whose work it is. Answering comments on the user's own PR is not review: there is code to change, so it returns to **Build**.

**Done and Icebox are ends, not stages,** so an empty one is hidden. Both reappear the moment a card is picked up, or a card could never be dropped into an empty one.

There is no Blocked lane. Its three would-be members are unlike: a session stopped by a usage limit recovers on its own (R20), a failed read is already a notice, and "I am avoiding this" is the Icebox. A card that is genuinely waiting says so on the card, in whatever lane it sits.

**R8. A card sits in exactly one lane, and the user puts it there.**
A card arrives in **Unstarted**, except one with no issue of its own: ad-hoc work is on the board only while its agent is running, so it arrives in **Build** rather than claiming to be unstarted. After that it moves only when the user moves it — by dragging it between columns, or with Alt and an arrow key on the focused card, which is the same move without a mouse. The board remembers the placement across refreshes and restarts. Nothing else moves a card: not a status change, not a session starting or stopping. When the factory's stations exist they will move cards, and that is the one thing that will ever join the user in doing so.

**R9. Work that has left the user's hands leaves the board.**
A status decides board membership and nothing else. The statuses that keep a card are the ones where the work is the user's; everything else — before it reaches them, or once it is with a reviewer, a tester, a release or another team — takes the card off. Those cards are archived rather than deleted: a toggle in the header reveals them, with a count, in an Archived column at the end, so nothing is hidden without saying so. A card that comes back after being archived returns to the lane the user last had it in, marked as returned and sorted to the top of it — R6's "unmistakable" is a marker on the card, never a lane of its own, because a returned PR and a bounced issue ask for different work. The mark clears when the user moves the card, which is the only evidence the board has that they have seen it.

An archived status cannot hide a card that still has a live agent on it. R2 outranks R9: no session is ever invisible, so the card stays where the user put it and says on its face what its status is.

**R10. Each lane shows how full it is.**
The lane header carries its card count, so the user can see at a glance that they have too much in flight. The board does not enforce a limit and has nothing to refuse yet — it does not start work (R32). Limits become a requirement when it does.

### Watching

**R11. The user can see what a session is doing right now.**
The current action, in plain language, updating live while it runs — not a log to read, and not a stale snapshot.

A session is named by its own title: the one the developer set where they set one, otherwise the one the agent wrote for itself. The name the CLI reports is the fallback, not the label — for a session started without one it is derived from the directory, so two sessions in one checkout would otherwise read as the same work twice.

**R12. Watching costs nothing.**
Looking at a session never interrupts it, slows it, or changes its state.

**R13. The user can tell a working session from a stuck one.**
"Thinking" and "waiting on a 5-minute command" must not look the same as "stopped 40 minutes ago".

The board reports two facts and never a third: the last thing it observed a session do, and how long ago. It never turns a running session idle because time passed — a twenty-minute test run produces nothing to observe, and calling that stopped is the same lie in the other direction. A session stuck with a stale report reads as an implausible duration instead.

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

Telling a running session from an idle one is part of that. The agent CLI does not report it, so the board installs its own hooks into the developer's Claude Code settings when it is activated — by opening the board, by one of its commands, or by a window reopening with the board tab already in it. A developer who has never opened it is never activated and so is never touched, which is what §2 asks. It backs the file up first, adds only its own entries — never a hook of the developer's own, even one sitting in the same group as ours — and refuses to write at all rather than repair a file it cannot fully read.

**R27. Team-wide facts ship with the tool; personal facts are the developer's own settings.**

| Shared — same for everyone, ships as defaults | Personal — differs per developer |
|---|---|
| Which repository and project board work is tracked on | Their GitHub account(s) |
| The set of statuses and what they mean | Where their checkout(s) live, and whether they use worktrees |
| The branch-naming convention | Their local site hostname(s) |
| The default lane set, and which statuses keep a card on the board | Which extra AI CLIs they have installed |
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
Limits vary with how a person works and with what their account can sustain. There is no such setting yet, because nothing enforces a limit (R10) — the board suggests a starting value and the developer changes it when the board starts work of its own (R32).

**R34. Settings are changeable without editing files.**
Anything a developer is expected to set, they can set from the board or from normal editor settings.

Anything the board writes outside its own storage is reversible the same way, and reversible when the developer says so rather than at the next restart. Turning off the activity hooks removes the entries it added, on the change itself, rather than merely declining to add them again; the command is the same switch in one step. Uninstalling the extension removes them too — hook entries naming a writer nobody maintains would otherwise go on firing forever. The writer file itself is the one thing left behind, because sessions that already read the old settings go on spawning it and a deleted script makes each of them report a failure on every event.

### Honesty

**R24. The board never shows a state it has not verified.**
If an action may not have worked, the board says so rather than assuming success.

A session reports what it is doing through the board's own hooks, and anything the board cannot read it declines to name: an event it has never seen, a report that disagrees with the session it claims to be from, a clock too far ahead to reason about. Each of those shows a session with no reported state, which is the truth, rather than a guess. The board also shows one state per session, never two — its own observation where it has one, and the agent CLI's own word where it does not.

**R25. The user can see why a card cannot move forward.**
In their own terms: what is missing, or what failed. Where that fits a badge, the badge carries it; a condition that belongs to the whole board — a status set matching nothing, a source that failed to read, hooks that could not be installed — is stated once above the lanes rather than on every card. A card carries no explanation of its own: the per-card hover that held one was removed, and nothing has replaced it.

Newly installed hooks are one of those conditions: sessions already running cannot report what they are doing until they restart, and a board showing no state for any of them looks like a board where nothing is happening. The board says how many, **once** — an install is something that happened, not a condition of the board, and a line the developer has already read and cannot act on is noise on every subsequent refresh. Removing the hooks and installing them again says it again.

## 4. What success looks like

- The user can answer "what is every agent on this machine doing?" in one glance, from one window.
- No agent sits parked and unnoticed for hours.
- Taking over a session and handing it back is a small enough action to do casually, several times a day.
- Work is never silently lost or silently duplicated.
- The user stops keeping a mental list of which worktree holds which task.
- A second developer installs it and gets value the same day, without a setup session or a document to follow.

## 5. Open questions

1. **Whether the lane set survives use.** *Settled for now.* R7's seven lanes and R8's manual movement are decided, and the statuses that keep a card on the board ship as a default the developer can change. What is untested is whether Plan and Review earn their columns once the factory's stations start moving cards, or whether the stations turn out to be the finer-grained thing and the lanes should coarsen.
2. **When the board starts enforcing limits.** Deferred, not decided against. R10 displays a count today because the board has nothing to refuse; enforcement becomes a question the moment the board starts work of its own (R32).
3. **How much of the pipeline is automatic?** Does the board only surface and intervene, or does it also start work on its own? This is the largest open question and it determines whether "unattended overnight" is a goal.
4. **What links a session to an issue?** Branch name, working directory, something the user sets by hand, or a mixture. Affects how often R3 guesses wrong.
5. **Sessions on other machines.** Out of scope for v1, but the board's value grows if it is the one place to look.
6. **Where shared defaults come from.** Checked into the repo so a new developer inherits them by pulling, or shipped inside the extension so they update with it. The first keeps them reviewable alongside the code they describe; the second keeps them working before a checkout exists.
7. **What links a session to an issue when the branch does not say.** *Partly settled.* The board reads the branch of the checkout the session runs in, searching upward so a session started in a subdirectory still finds it, and falls back to the checkout directory's own name. A session it cannot link joins the card for the directory it runs in (R4) rather than a guess. What is still open is the case the branch genuinely cannot answer — a session started before a branch exists, or a single clone carrying several issues — where asking the developer once per session may beat guessing. There is no way for a developer to set the link by hand today.
8. **Whether a developer can see the board without the extension changing anything.** A read-only first run would let someone evaluate it with no risk, which matters for adoption across a team.
