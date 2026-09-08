# Verified mechanics

Everything here was measured on this machine, not inferred. The baseline is **2026-09-01**, against the Claude Code CLI as installed that day and VS Code extension `anthropic.claude-code` **2.1.252**. The Codex sections (§39–§47) are **2026-09-07**, bar §47's **2026-09-08**, against VS Code extension `openai.chatgpt` **26.901.22334** and `codex-cli` **0.153.0** for §39–§42, **0.153.4** for §44 and §46 — §43, §45 and §47 read the editor rather than the CLI. A section measured against a different version says so at its top.

Re-verify anything marked **version-fragile** after an upgrade to either CLI or either extension.

---

## 1. Dispatch — `claude --bg`

Background sessions are first-party. A station does not need a bespoke process manager.

```bash
cd d:/work/repo.worktrees/17198-channel-mapping-drops-rows-past-the-first-page
claude --bg --permission-mode bypassPermissions -n "factory-demo-17198" "<station prompt>"
# → backgrounded · 9d937cb5 · factory-demo-17198
```

The short id is the first 8 chars of the session UUID. `-n` sets a display name that later shows up as the **editor tab title**, so name background sessions after their item and station.

Related subcommands: `claude attach <id>` (terminal), `claude logs <id>`, `claude stop <id>`, `claude respawn <id>`, `claude rm <id>`.

> **Never call `claude rm` from the factory.** Its help states it deletes the session "and its worktree when that is safe." A factory worktree holds uncommitted work. `stop` is the only teardown the orchestrator may use.

## 2. Liveness — `claude agents --json`

One call returns every live session on the machine, **interactive and background, across every worktree**:

```json
{ "pid": 65380, "id": "9d937cb5", "cwd": "d:\\work\\repo.worktrees\\17198-...",
  "kind": "background", "startedAt": 1788284040892,
  "sessionId": "9d937cb5-933e-45de-8514-e1bff6e447ba",
  "name": "factory-demo-17198", "status": "busy", "state": "working" }
```

- `--all` also returns exited/stopped sessions (`state: "stopped"`), with `cwd` preserved.
- `--cwd <path>` filters by directory.
- Requires no TTY; the bare `claude agents` does.
- **Costs about 215 ms a call** — measured 2026-09-01, three consecutive runs at 218/217/212 ms returning 3,450 bytes for 17 sessions. It spawns a Node process, so a board polling it every few seconds spawns one every few seconds. That is what sets the board's session cadence, not how fast a session's state changes: the board reads sessions every 30 s and GitHub every 300 s, and stops both while its tab is not the visible one. A session's first prompt and its end do not wait for that poll — hooks report them (§20).

**This is the board's liveness source.** Do not derive liveness from transcripts — see §3.

## 3. Transcripts lag reality

Measured: two subagents were confirmed running via the OS process tree while the parent's `.jsonl` still contained no record of the tool call. Transcript writes are buffered and land after the fact.

Consequence: `.jsonl` is the **evidence and audit** source. `claude agents --json` is the **liveness** source. Never swap them.

Layout:

```
~/.claude/projects/<project-slug>/<session-id>.jsonl
~/.claude/projects/<project-slug>/<session-id>/subagents/agent-<id>.jsonl
~/.claude/projects/<project-slug>/<session-id>/subagents/agent-<id>.meta.json
```

`<project-slug>` = the absolute path with **every character that is not a letter or digit** replaced by `-`, runs not collapsed (`d:\work\repo` → `d--work-repo`; `d:\work\repo.worktrees\18941-inbox-badge` → `d--work-repo-worktrees-18941-inbox-badge`).

**Measured, not inferred.** A session started in `D:\git\dev-tracker\.claude\personal\slug probe_x+y~z` produced `D--git-dev-tracker--claude-personal-slug-probe-x-y-z`, so the space, `_`, `+` and `~` all become `-`. Every real cwd on this machine contains only `- . : \`, which is why a narrower rule looks correct here and fails on the first path with an underscore or a space.

**Case is not a lookup key** — version-fragile. A project directory's case is fixed by whichever path first created it, and the CLI reports one checkout under either drive-letter case: there is no `d--work-repo` on disk at all, while several live sessions report `cwd: d:\work\repo` and their transcripts sit in `D--work-repo`. NTFS hides this. A reader must resolve the directory case-insensitively against the actual listing, or it reports a transcript that exists as absent on any case-sensitive filesystem.

**Absence is a real state, and it means the session was never prompted.** Some live sessions have no transcript anywhere under `~/.claude/projects` — searched across every project directory, not just the expected one. Measured 2026-09-02: the transcript is created at the **first user turn**, not at process start. Four of fifteen live sessions had none, every one of them a VS Code tab opened and left alone (`entrypoint: claude-vscode`, seconds of CPU, no `todos/` entry); a session whose process started at 03:37 UTC got its transcript at 13:54 when it was first prompted; and a resumed session writes to the file the original id already owns, so its transcript predates its process. A reader must return "unknown" for the time, never an error — and the board takes the absence itself as the signal that there is nothing to show (`docs/prd.md` R2).

`~/.claude/sessions/<pid>.json` carries the same registry the CLI reports, plus `entrypoint` and `nameSource`. `~/.claude/session-env/<session-id>/` is created at session start for every session, prompted or not, so it is **not** a discriminator.

**A transcript's mtime is not liveness.** Among live sessions that had one, the oldest write measured was over 9 hours old — so a write time is only ever a write time.

The counts behind these move as sessions start and exit; `packages/agent-claude/test/fixtures/` pins them, re-recordable with `node test/fixtures/record.js`. The probe is not among them — a probe directory cannot be recorded from a machine it no longer exists on, so it is asserted directly in `packages/agent-claude/test/transcripts.test.ts`.

`meta.json` contents: `{"agentType","description","toolUseId","spawnDepth"}` — enough to attribute a subagent to the parent tool call that spawned it.

## 3b. Session titles live in the transcript, not in `claude agents --json`

Measured 2026-09-02. `claude agents --json` reports a `name` per session, and it is **not a title**. For a session started without one it is the cwd's last segment plus two hex characters — `ground-control-0d`, `18941-inbox-unread-badge-ad` — so two sessions in one directory get names differing only in the suffix, which is why a board grouping by directory cannot label them from `name`. It is not always derived: a `--bg` session started with `-n` carries the operator's own word (§2's sample payload), and a name can drift across a handback (§11).

The title is in the transcript, as its own record type, rewritten as the session goes:

```json
{"type":"ai-title","aiTitle":"Issue and PR labels as links","sessionId":"8451aeef-…"}
{"type":"custom-title","customTitle":"the name I gave it","sessionId":"07265e6d-…"}
```

- `ai-title` is the one Claude Code writes for itself; `custom-title` is one the developer set.
- **A manual title does not stop the automatic one.** Across 486 recorded transcripts, sessions carrying both showed the order `custom-title, custom-title, ai-title` and, in one, `custom, custom, ai, ai, custom, ai` — so the last record in the file is often the automatic one. A reader must prefer the last `custom-title` over the last `ai-title`, never simply the last record.
- Neither is guaranteed. Of nine live transcripts, three carried no title record of any kind, one of them 1.7 MB long.
- There is no CLI command that reports a title. `claude` has no `sessions` verb, and `agents --json` carries no title field — **version-fragile**, and the reason the board reads the file.

**Reading the whole file is not affordable.** A live transcript reaches megabytes and the board re-reads sessions every 30 s. Titles are rewritten each turn, so the last one is usually near the end: of the six live transcripts that had a title, five had it within 32 kB of the end. The sixth sat 2.2 MB back — its title was written early and never again — so no window short of the whole file catches every session.

The board reads the last **64 kB**: twice the measured worst in-reach case, which is the margin a turn's writes can grow by before a title that was in reach leaves the window, at a read of 576 kB per refresh across nine sessions rather than the 8 MB a whole-file read would cost. When the window holds no title the board falls back to `name`, which is a weaker label rather than a wrong one.

The first line of a positional read is a fragment of whatever line it cut through, so a reader must tolerate one unparseable line at the front. A record also carries its own `sessionId`, which a forked transcript makes worth checking.

## 3c. Historical session discovery

**Measured 2026-09-05.** A metadata-only probe found 108 project-directory entries and 558 top-level UUID-named transcript files under this machine's `.claude/projects`. Parent conversation records carry `sessionId`, `cwd`, `gitBranch`, and `type`; subagent records carry `isSidechain`, and nested subagent files are outside this scan. `test/fixtures/history-records.json` records one prompted parent and a title record with strings scrubbed; `record-history.mjs` reproduces it.

The bounded history reader found 557 sessions with usable parent metadata and 232 with both an issue link and repository identity. Its first scan took 1,080 ms, and a second scan using cached metadata took 73 ms. These are observations of this machine's history, not latency guarantees. Each transcript read is bounded to the first and last 64 KiB; absent metadata in those windows means no match, and a title outside them falls back to the directory name. Modification time ranks saved work only; the live CLI roster establishes whether a saved session is inactive.

The official SDK `0.3.261` was inspected and imported in an isolated probe. `listSessions()` returned zero sessions from an empty `CLAUDE_CONFIG_DIR` in 72 ms including import. The API has no per-call home argument; its configuration resolver uses process-wide `CLAUDE_CONFIG_DIR`, and directory discovery catches filesystem failures as empty results. The hub uses its injected filesystem readers for history, so its own `--home` and classified read failures do not depend on changing process-wide environment variables. SDK source and transcript metadata are version-fragile.

**Clickable history wiring measured 2026-09-05.** In a real VS Code integration host, the historical row rendered a button and clicking it posted its saved session ID. The resident's `resume-here` route invoked `claude-vscode.primaryEditor.open` with that ID and observed a real editor tab. This wiring test registered a surrogate handler for the Claude command so it made no model request; it did not remeasure Claude's transcript loading. It also verified no command fired for an unreadable roster, an already-active session, or an expired route. A direct `Code.exe <appRoot>/out/cli.js --version` invocation with `ELECTRON_RUN_AS_NODE=1` succeeded without a shell. Section 7 records the actual historical Claude resume mechanism; cold-window routing explicitly supplies `--new-window` rather than relying on the user's folder-opening preference.

## 4. Stop kills subagents — they do not survive

Measured directly. A background session spawned two subagents, each running a ~150s wait.

- **Subagents run in-process.** The process tree under the session pid showed no per-subagent process — only the `bash.exe` children of their own tool calls.
- `claude stop` killed the parent and every child. The subagent's own transcript recorded `{"content":"Exit code 137","is_error":true}` — SIGKILL.
- **No orphans** were left behind.
- On `claude --resume`, the parent was notified that both agents were `stopped` with no completion record, and reported this accurately. It did not fabricate results and did not hang waiting.
- Partial work survives on disk in the subagent `.jsonl` files (~48 KB each here), but the parent's context has no result and nothing auto-restarts.

**Also measured:** subagents are **async by default** in this build. The `Agent` tool returns an `agentId` immediately and the parent goes idle awaiting notifications. A stop therefore discards pending notifications rather than interrupting a blocking call — same loss, different shape.

### Design consequences

1. **Checkpoint to disk, never to conversation.** A station must not hold intermediate results in context. `cross-review` writes `evidence/findings-{model}.json` per reviewer and re-reads the directory; a kill then costs one reviewer, and re-dispatch skips models whose file already exists.
2. **Shell out for reviewers.** `codex exec` writing a file is a child process the factory owns and restarts independently. An in-process `Agent` call is bound to the parent's lifetime.
3. **Seize has a price, and the UI must quote it.** Before offering Seize, count in-flight subagents and warn. Steer is free; Seize is not.

## 5. A Claude tab's cwd is the window's workspace folder — always

**version-fragile.** From the decompiled `setupPanel` in extension 2.1.252:

```js
let Y = workspace.workspaceFolders?.map(U => U.uri.fsPath) || [],
    z = realpathSync(Y[0] || homedir()).normalize("NFC");
// z is passed as the cwd into the panel's comms object
```

The cwd comes from `workspaceFolders[0]` and is **never** derived from the session. Two consequences:

- A multi-root workspace does not help — only the first folder counts.
- **One seizable worktree means one VS Code window.** The WIP limit is what bounds the window count.

Measured confirmation: session `9d937cb5` (project slug `D--work-repo-worktrees-17198-…`) fired into a window rooted at `d:\work\repo` produced **no tab at all**, while `106b56c3` (slug `D--work-repo`) fired into that same window opened correctly.

That silence belongs to the in-process command, not to the mismatch. The same mismatch through the URI handler **creates a new session in the window's own directory** (§7), so "wrong window" is a no-op on one path and a fresh agent on the wrong tree on the other.

## 6. `claude-vscode.editor.open` — signature and behavior

**version-fragile.** Re-measured **2026-09-02** against **2.1.258**, read out of the shipped `extension.js`. Registered by the official extension; undocumented.

```
claude-vscode.editor.open(sessionId?, initialPrompt?, viewColumn?, newSessionGroupId?)
```

Every parameter is optional: `claude-vscode.editor.openLast` invokes the command with none, and falls through to `claude-vscode.sidebar.open` instead when the preferred location is the sidebar.

From the registered handler, transliterated from the minified source:

```js
registerCommand("claude-vscode.editor.open", async (sessionId, prompt, column, groupId) => {
  if (column !== ViewColumn.Active) preferredLocation.set("panel");
  let { startedInNewColumn } = createPanel(sessionId, prompt, column, groupId);
  if (startedInNewColumn) await executeCommand("workbench.action.lockEditorGroup");
})
```

So **any column but the active one has a side effect**: `claudeCode.preferredLocation` is written to `panel` at global scope, before the reveal check below, so it happens even when nothing is opened. `claude-vscode.primaryEditor.open(sessionId, prompt)` is the same call pinned to `ViewColumn.Active`, and avoids it.

From `createPanel`:

- **The session id is not validated on this path.** `createPanel` maps a `remote:`-prefixed id through a `remoteTeleports` table and otherwise takes the id as given; the zod check lives in the webview comms handlers, the `vscode://` `/open` handler, and the panel serializer — none of which the command is. The serializer's is the stricter variant, which also rejects a `remote:` id. An id nothing resolves to opens a panel bound to it rather than being refused, so a caller owns that check itself.
- A `sessionPanels` map is checked next. If the session already has a tab it is **revealed**, the call returns `startedInNewColumn: false`, and a supplied prompt is dropped with *"Session is already open. Your prompt was not applied — enter it manually."* The map is per extension host, so it only ever sees this window's tabs.
- With `viewColumn` undefined it prefers an existing non-empty tab group whose every tab is a Claude panel, else `findUnusedColumn()`.
- `initialPrompt` **prefills** the input box. It is not submitted; a human presses Enter.

### The surface decides whether an open reveals — the working directory does not

**Measured 2026-09-03.** The reveal check quoted above sits **before** anything reads a transcript: `createPanel` consults `sessionPanels` first and returns on a hit. So what an open does turns on which surface holds the session, and a session's transcript having moved does not by itself put it out of reach.

The measurement that settles it. Session `3d93ad53` was live in the window rooted at `d:\git\orez` and had been sent to a worktree, so its transcript had left that window's project directory:

```
3d93ad53   transcript dir : d--git-orez-worktrees-18062-venmo-funded-paypal-security
           record 0 cwd   : d:\git\orez                     <- the window holding it
           last record cwd: D:\git\orez.worktrees\18062-...  <- where it is working now
```

Firing `/open?session=3d93ad53` at that window — the URI routes to `primaryEditor.open` (§7) — produced a **new** session rather than a reveal:

```
before   16160 exthost=9172  5adf8540  d:\git\orez
         24320 exthost=9172  3d93ad53  D:\git\orez.worktrees\18062-...
after    73588 exthost=9172  4c06a6f7  d:\git\orez            <- fresh session
```

The cause was **not** the move. That window's own state (§21) records `3d93ad53` as its **secondary sidebar's** session, and `sessionPanels` holds editor panels only, so the reveal could never have matched. A transcript that has moved is real and worth knowing — a session sent to a worktree keeps its window and reports the worktree as its `cwd` — but it is not what decides reachability.

**Not measured:** whether a session whose transcript has moved *and* which sits in an editor tab reveals correctly. The source says it must, because the reveal precedes the transcript lookup; no test has been run.

The **process tree** identifies the window too — a tab's session is a child of that window's extension host (`claude.exe <- Code.exe <- Code.exe`, the middle pid differing per window) — but the extension host's command line carries no folder, and every one of them runs as `--type=utility --utility-sub-type=node.mojom.NodeService`, indistinguishable from the pty host. `~/.claude/sessions/<pid>.json` carries `cwd`, `kind` and `entrypoint`, and no window folder either. §21 and §22 are the two records that do name windows.

### A second surface on a session is a second process

**Measured 2026-09-02.** `createPanel` dedupes against `sessionPanels`, which holds **editor panels only**. A session hosted in the sidebar is not in it, so opening that session as a panel builds a second surface — and `claude agents --json` then reports the same `sessionId` on two pids:

```
17076fb4-78d5-4641-8e97-702b7d8b6fc9  pid=55192  interactive  ground-control-dc
17076fb4-78d5-4641-8e97-702b7d8b6fc9  pid=79288  interactive  ground-control-00
```

That is §11's two-writers fork, reached without a CLI resume. **There is no way to reveal one session in the sidebar.** `claude-vscode.sidebar.open` takes no arguments — it sets `preferredLocation` and focuses the view — and `claude-vscode.window.open` calls `createPanel(undefined, undefined)`. The only session-addressed entries are `editor.open` and `primaryEditor.open`, and both build panels.

This is documented behaviour rather than a defect: the extension's own docs say *"Click any session to open it as a full editor tab."* A `sidebar.openSession(sessionId)` has been asked for twice ([#85753](https://github.com/anthropics/claude-code/issues/85753), [#85726](https://github.com/anthropics/claude-code/issues/85726)) and shipped neither time, and [#67419](https://github.com/anthropics/claude-code/issues/67419) traces the same path ignoring `preferredLocation`. So an opener must read the surface first, and a sidebar-held session has no reveal at all.

So an opener must know which surface holds the session **before** it fires, and §21 is where that is recorded per window. `claudeCode.preferredLocation` is no substitute: it is one global setting, it says where the developer's *next* session would go rather than where an existing one is, and `sidebar.open` writes it as a side effect. Duplicating is not a cosmetic cost.

**Focusing the sidebar without writing that setting** uses the view's own auto-registered `<viewId>.focus` command — `claudeVSCodeSidebarSecondary.focus`, or `claudeVSCodeSidebar.focus` on a host with no secondary sidebar (§21). VS Code registers one per contributed view; neither goes through the extension, so neither touches `preferredLocation`. Only the registered view's command exists, so both are tried and the other rejects.

### A tab's label is not a session identifier

The panel is created with the **literal title `"Claude Code"`**:

```js
createWebviewPanel("claudeVSCodePanel", "Claude Code", column, { … })
```

The session's own webview renames it afterwards, over the comms channel — a `rename_tab` request assigning `panelTab.title`. Two consequences:

- **Immediately after an open the label is `"Claude Code"`, not the session's name.** The probe's logs show the display name because they were written 2.5 s later.
- The title is the session's to change, and `claude-vscode.renameSessionTab` lets the developer change it too.

A label is therefore a lagging, mutable projection of a session, never a handle on one. Anything deciding *which* session a tab holds must come from elsewhere; §11 says the same for persistent state. **Counting Claude tabs is sound; matching their labels is not.**

Sibling commands that exist and are not yet characterized: `claude-vscode.window.open`, `claude-vscode.newConversation`, `claude-vscode.reopenClosedSession`.

## 7. URI routing follows focus — and a miss is not silent

The official extension registers its own handler, so a window needs nothing of ours installed in it:

```js
registerUriHandler({ handleUri(uri) { switch (uri.path) {
  case "/open": { let session = params.get("session"), prompt = params.get("prompt");
    if (session !== undefined && !valid(session)) return;
    executeCommand("claude-vscode.primaryEditor.open", session, prompt); }
```

`vscode://anthropic.claude-code/open?session=<id>` therefore works on a bare install, validates the id, and lands on `primaryEditor.open` — `ViewColumn.Active`, and none of §6's preferred-location write.

**Measured 2026-09-02** against 2.1.258, on a machine with windows open at `d:\git\ground-control`, `d:\git\orez` and two `orez.worktrees` checkouts. Four fires, each observed by diffing `claude agents --json`:

| Fired | Focus | Landed |
|---|---|---|
| a fresh uuid | ground-control | new session in `d:\git\ground-control` |
| `be791d04`, dead, belongs to the 18954 worktree | ground-control | **new** session in `d:\git\ground-control` |
| `be791d04` again, immediately after `code <18954 worktree>` | 18954 | **resumed `be791d04`**, in the 18954 worktree |
| `0dedca6d`, live in a tab in the 18399 window | back on ground-control | **new** session in `d:\git\ground-control` |

- **Routing does not follow the session.** The last fire names a session held open in another window and landed where the developer was sitting instead. There is no "deliver to whoever has this session".
- **Routing follows focus, and `code <folder>` is how to set it.** The third fire is the one that worked, and only because `code` had just brought that window forward. Seconds later focus was back where the developer was working, and the next fire went there.
- **A miss starts a fresh agent in the wrong worktree.** Three of the four created an empty session under the focused window's own directory. The id is not resolvable in that window's project, so it is treated as a new conversation rather than refused.
- `Start-Process "vscode://…"` routes through whatever holds the scheme registration, which is not necessarily this VS Code (§29). `code --open-url "vscode://…"` routes reliably. PowerShell and cmd eat `&column=2` unless the whole URI is quoted.

**Conclusion:** `code <folder>` then `code --open-url` opens a session in its own worktree with nothing installed there, and is the only mechanism that reaches a window the board does not run in. It is a race, and the losing branch is a stray agent — so an opener must take focus deliberately, confirm it left, and check afterwards where the session actually landed.

## 8. In-process `executeCommand` IS addressable — proven

VS Code runs one extension host per window. `vscode.commands.executeCommand` dispatches inside its own host, so the panel lands in **its own** window. There is no target parameter because the window is implied. VS Code exposes no API to act on another window, so *the only way to choose a window is to run code in it.*

Proven with `extensions/seize-probe/` — a ~90-line probe loaded via `code --extensionDevelopmentPath=… --new-window <worktree>` (nothing permanently installed). It registers `{folder, pid}` under a slug in `~/.factory/windows.json`, watches `~/.factory/inbox/<slug>.json`, and on a write calls `editor.open` locally.

```
17:58:23  activate: slug=d-work-repo-worktrees-17198-…  folder=d:\work\repo.worktrees\17198-…  pid=47024
17:58:59  handle … session=9d937cb5-…  claudeTabsBefore=1
17:59:01  after: claudeTabs=1  titles=["factory-demo-17198"]
17:59:21  handle … session=e87fd6d6-…  claudeTabsBefore=1
17:59:23  after: claudeTabs=2  titles=["factory-demo-17198","subagent-survival-test"]
```

The tab labels are the `-n` display names of those two background sessions, so the real conversations resumed, in the addressed window, at the right worktree. The second call is the unambiguous one — tab count 1 → 2 with the requested session's title.

Caveat recorded for honesty: the first call is ambiguous. The window already held one Claude tab, so that call may have revealed an existing tab rather than created one.

### The cold path: 3.2 seconds

Measured with the extension **normally installed** (junction plus an `extensions.json` entry), not `--extensionDevelopmentPath`, against a worktree with no window open:

```
target slug: d-work-repo-worktrees-17510-channel-mapping-reads-across-the-tenant-boundary
already registered: False
code --new-window d:\work\repo.worktrees\17510-channel-mapping-reads-across-the-tenant-boundary
registered: True  after 3.2s
{"folder":"d:\\work\\repo.worktrees\\17510-…","pid":31120,"updated":"2026-09-01T19:52:02Z"}
```

Then a seize into that brand-new window, with no prior Claude tab to confuse the count:

```
handle seize … folder=d:\work\repo.worktrees\17510-…  claudeTabsBefore=0  titles=[]
after seize:  claudeTabs=1  titles=["cold-path"]
tracked seized tab "cold-path" -> c01d0001-…
```

and a live tab process at the right root: `{"pid":12036,"kind":"interactive","cwd":"d:\\work\\repo.worktrees\\17510-…"}`.

So the cold path holds: **no window → open → register → seize** works, and the 15 s poll budget is generous. Registration under `--extensionDevelopmentPath` took 14–25 s; that was the Extension Development Host's startup cost, not the extension's.

Incidental: `--session-id` rejects non-hex-looking UUIDs — `c0ld0001-…` fails with `Error: Invalid session ID. Must be a valid UUID.` while `c01d0001-…` is accepted. Cute test ids will bite.

### Verification is mandatory

`executeCommand` resolves `ok` whether or not a panel appears — it did so on every failed URI attempt too. Confirm by **counting** tabs whose `input.viewType` includes `claudeVSCodePanel`. A fresh panel always adds one and a reveal adds none, so the count separates "opened" from "nothing happened" — but a reveal and a failure both leave the count alone, and §6 rules out telling them apart by label. The second signal is focus: a revealed panel is focused, so a Claude panel being the active tab is the evidence that a reveal happened.

The count is window-global and carries no per-session attribution, so **two opens in flight at once break it** — a tab appearing for the first masks a failure of the second. Serialize them, or accept the ceiling.

## 9. Hand-back — a seized session returns to the factory

Proven. The seize round trip closes, but only under a rule that is easy to violate.

```bash
claude --bg --resume 322e2149-f26a-4bff-b496-ea0e4f831e9e "Continue. …"
# → note: woke session 322e2149 with its saved options (--permission-mode, -n).
#   backgrounded · 322e2149 · handback-test
```

Same short id, same display name, same saved options, and the conversation genuinely continued — the resumed agent recalled the earlier turn unprompted:

> "You asked me to run `git log --oneline -3`, print ALPHA, then run a bash loop that waits 120 seconds, then print OMEGA — I completed the log and ALPHA, and have not yet run the 120-second wait."

### The fork hazard

**Passing any extra flag on resume silently creates a copy.** The same command with `--permission-mode bypassPermissions` added:

```
note: background session 322e2149 keeps its own saved options, so the flags you passed
      started a copy as 9e6418f4. Without flags, the same command continues 322e2149 itself.
```

The copy is a separate session with an auto-generated name — here `label categorization task` — running against the same worktree. Two agents on one working tree is a corruption path, not an inconvenience.

**Orchestrator rules:**

1. Session options (`--permission-mode`, `-n`, `--model`, `--add-dir`) are set **once, at dispatch**. They are saved with the session.
2. Resume passes **only** `--bg --resume <id>` and the prompt. Nothing else, ever.
3. Parse stdout. `woke session <id>` is success; `started a copy as <newid>` is a **failure** — stop the copy immediately and alert, do not let it run.

## 10. Station output contract — `--bg` and stream-json are mutually exclusive

The decisive fork, now resolved, and not in the direction the plan assumed.

**`-p --output-format stream-json --verbose` produces exactly the stream you would want.** Clean NDJSON, one event per line:

```
system/init · system/hook_started · system/hook_response · assistant · user
tool_use · tool_result · thinking · rate_limit_event · result/success
```

It writes a normal transcript under the worktree's project slug, and long waits are auto-delegated to background tasks that emit `task_started` / `task_notification` events.

**But a `-p` session cannot be stopped, attached, or seized.** It registers in `claude agents --json` — pid, cwd, sessionId all present — as `kind: "interactive"` with **no short `id`** and no `status`/`state`. And:

```bash
claude stop a1b2c3d4-0000-4000-8000-000000000001
# → No job matching 'a1b2c3d4-…'. Run 'claude agents' to list running sessions.
```

| | `--bg` | `-p --output-format stream-json` |
|---|---|---|
| Listed in `claude agents --json` | yes, `kind: background` | yes, `kind: interactive` |
| Short id, `status`, `state` | yes | **no** |
| `claude stop` / `attach` | yes | **no** — killable only by pid |
| Machine-readable stream | **no** — `claude logs` is a raw ANSI terminal buffer | yes |
| `--json-schema` structured result | no | yes |
| `-n` display name | yes | yes |
| **Seizable** (§8) | yes | **yes** — after a pid kill |
| **Releasable + hand-back** (§11) | yes | **yes** |

### Watch is proven on the `-p` stream

Tailed live while a station ran seven ordered steps with two 20-second waits:

```
16:03:59  RUNNING Bash: Busy-wait loop for 20 seconds | tools=2 done=1
16:04:19  RUNNING thinking/replying                   | tools=3 done=3  last_text=STEP-2
16:04:24  RUNNING Bash: Busy-wait loop for 20 seconds | tools=4 done=3
16:04:42  RUNNING thinking/replying                   | tools=4 done=4
16:04:47  DONE                                        stream closed
```

- **Written incrementally.** `16:03:59 → 16:04:19` is the station's actual 20 s wait, observed as it elapsed. Events are not buffered until exit.
- **The current-action rule:** pending = `tool_use` ids with no matching `tool_result`; the last pending one is what the agent is doing now. `type: result` is terminal. No ANSI parsing, no heuristics.
- **`input.description` is a renderable label** — `"Busy-wait loop for 20 seconds"` straight onto a card. Gaps between tool calls read as "thinking", which is honest rather than a stall.
- **Plain file reads are safe on Windows** while the writer holds the file open — 45 samples, no locking errors, no partial-line corruption.

Sampled at 2 s, so sub-second latency is unmeasured; `--include-partial-messages` streams token-level deltas if that is ever wanted. Watch on a `--bg` station remains ANSI-only via `claude logs`.

### Decision: stations run under `-p --output-format stream-json`

The escape hatch worked, so the fork is not a fork. **Proven** (§11): a `-p` session can be killed by pid, seized into a tab, released, and handed back with `claude --bg --resume` under its original id, conversation intact.

That means the factory gets the structured stream *and* the full intervention model. What it gives up is small:

- No short id, no `status`/`state`, no `claude stop`. The orchestrator owns the pid and kills by pid.
- **Liveness comes from the stream, not from `claude agents --json`.** This is strictly better than `state: working` — the stream carries per-tool-call events, so Watch can show the current action live rather than a lagged transcript read (§3).
- **`-p --resume` keeps streaming — proven.** Resuming a killed station with `-p --output-format stream-json --resume <sid>` emits NDJSON under the **same session id**, opening with a `SessionStart:resume` hook event. So a seized station comes back fully instrumented; there is no permanent downgrade. Hand-back via `--bg --resume` *does* convert the session to `kind: background` and rename it (§11), so the factory should resume with `-p`, not `--bg`, when it wants Watch to survive — at the cost of the queue restore (§14).
- **A `-p` station blocks until its async subagents deliver.** Measured: the resumed turn stayed alive 120 s waiting on two subagents, then emitted `type: result` and exited. A print-mode station does not exit early and abandon its children.
- **A pid kill leaves no death marker.** `claude stop` records `Exit code 137` in the subagent's transcript; `Stop-Process -Force` on the parent kills the child before any `tool_result` is written, so the transcript just ends. The bump classifier therefore cannot rely on a death marker — absence of a completion record is the only reliable orphan signal (§14).
- **`-p --resume` has no tab interlock — this is a corruption hazard.** With the session's tab open in VS Code, a shell `-p --output-format stream-json --resume <sid>` **succeeded**: same session id, `subtype: success`, exit 0, no warning of any kind. `--bg --resume` refuses in that situation and forks a copy with an explicit note (§11); print-mode does not. Two writers can append to one conversation silently.

  Worse, the tab does not live-reload. A screenshot taken after that shell turn showed the conversation ending at the pre-kill state with no trace of the appended turn — so the operator is looking at a stale view of a conversation the factory just wrote to.

  **Rule: release before any resume, on both paths.** On the `--bg` path stdout warns you; on the `-p` path nothing does, so the orchestrator must check tab state — which §21 records per window — rather than relying on an error.

### Concurrent writers FORK the transcript and orphan work — measured

The transcript is a **tree**, not a log: every entry carries `parentUuid`. Two writers on one session produce sibling branches, and `--resume` follows exactly one of them. The other branch's work is intact on disk and unreachable.

Demonstrated on the seized `a9b8c7d6` session. A shell `-p --resume` ran while the tab was open; the operator then typed in the tab, whose view was stale:

```
BRANCH POINT — one parent, two children:
  parent[user]: <task-notification><task-id>buhoau2ui</task-id>…
      -> [user] "Continue from where you left off."                 ← shell branch
      -> [user] "Print exactly OPERATOR-MARKER-42, then run pwd…"   ← operator branch
```

Both branches carry real work — the operator branch has the assistant's thinking, a `Bash pwd`, and its result. A later `-p --resume` followed the **shell** branch and, asked to quote the most recent operator marker, answered with the shell branch's marker. It never saw the operator's turn. No error, no warning, nothing in the stream.

So the hazard is not interleaved writes. It is **silently orphaned work**, which is strictly worse: the factory would resume, look coherent, and have discarded whatever the operator did.

**Rules:**

1. **Exactly one writer per session, enforced by the factory.** Release before any resume. `--bg --resume` refuses and forks loudly; `-p --resume` does neither, so the orchestrator must gate on tab state, which §21 records per window, never on an error it will not receive.
2. **Fork detection belongs in `factory validate`.** A `parentUuid` with more than one child means the session diverged. Ten lines over the transcript, and it converts a silent failure into a parked card. Run it before every advance and after every hand-back.
3. **A mid-turn release leaves a dangling turn.** The operator's branch ended at a `tool_result` with no assistant reply, and its background task shows `[killed]`. The resumed agent must notice and finish it — the one measured here did, reporting unprompted that its background task was `stopped` with no completion record.

### A seized tab renders full history, at the worktree

Confirmed visually on a `-p` station seized into a window rooted at its own worktree. The tab showed the original prompt, the `SHELL-TURN-ONE` output, a collapsed "2 tool calls", and the agent's own report that *"Branch is `16976-calendar-feed-overwrites-a-manual-edit`"* — the worktree's branch, from the pre-kill turn.

So `editor.open` loads the conversation, not just the session's identity. Tab titles proved identity earlier; this proves content.

Two independent confirmations of the tab's working directory:

- `claude agents --json` while the tab was open listed a live process for it — `{"pid": 55928, "kind": "interactive", "cwd": "d:\\work\\repo.worktrees\\16976-calendar-feed-overwrites-a-manual-edit"}`. **Opening a tab starts a process**; that process is what holds the session, and closing the tab ends it.
- A `pwd` the operator ran *inside* the tab returned `/d/work/repo.worktrees/16976-calendar-feed-overwrites-a-manual-edit`.

Note the held process is `kind: interactive` with no short id, so **`claude stop` cannot release it** — it answers `No job matching '<uuid>'`. Closing the tab (`tabGroups.close`) is the only clean release; a pid kill works but leaves a tab displaying a dead session.

Operator input persists normally: the typed turn, the assistant's thinking, the tool call and its result are all in the transcript. A tab closed mid-turn leaves the last tool call `[killed]`.

### The clean round trip — proven

Re-run with no other writer touching the session. Cold-path window, seize, operator typed `OPERATOR-MARKER-99` and let the turn finish, closed the tab, then one `-p --resume` from the shell:

```
seize:    claudeTabsBefore=0  →  claudeTabs=1 titles=["cold-path"]
          tracked seized tab "cold-path" -> c01d0001-…
release:  tab closed: label="cold-path" tracked=true   (seized.json → {}, tab process gone)
resume:   asked to quote the operator's marker → "OPERATOR-MARKER-99"
validate: entries=43  forks=0
```

So the operator loop closes: **kill → seize → operator drives → release → factory resumes with the operator's work intact, transcript unforked.** The earlier failure was entirely caused by the injected concurrent write, not by the mechanism.

Evidence still comes from files the agent writes, never from the stream (`docs/architecture.md` §1, "Evidence over claims"). The stream is for Watch and for the orchestrator's own bookkeeping, not for gating.

## 11. A tab holds the session open — release before hand-back

The trap that makes seize look one-way. **Proven** with the full round trip.

While a Claude tab is open on a session, a resume forks:

```
note: session c1b2c3d4 is open in another Claude Code process,
      so this started a copy as 94e14772. The original conversation is unchanged.
```

Close the tab first and the same command wakes the original:

```
backgrounded · c1b2c3d4          # same id, no copy note
```

The resumed agent continued the conversation with full memory of the pre-seize turn.

So the operator loop has **four** steps, not three: kill → seize → release → hand back. Release is closing the session's editor tab, and the extension can do it:

```js
const match = claudeTabs().filter((t) => t.label === title);
await vscode.window.tabGroups.close(match, false);
```

Measured: `claudeTabs=3 titles=[…,"round-trip"]` → `claudeTabs=2`, then the resume woke `c1b2c3d4` under its own id.

**The seize channel needs a `release` action**, and the board's "hand back to the factory" button must close the tab before resuming. Do not rely on the operator remembering.

### Auto-handback: the reverse direction is event-driven

`vscode.window.tabGroups.onDidChangeTabs` fires on close, so the operator closing a seized tab **is** the hand-back signal. No polling, no explicit "I'm done" button. Proven with the probe:

```
18:36:47.311  handle release … claudeTabsBefore=3 titles=[…,"autoback"]
18:36:47.314  tab closed: label="autoback" tracked=true          ← 3 ms
18:36:49.841  after release: claudeTabs=2
18:36:51.374  handback ok on attempt 1: backgrounded · d1b2c3d4  ← original id, no copy
```

Emitted events: `tab-closed` then `handback {ok:true, attempts:1, elapsedMs:4059}`. Most of those 4 seconds are `claude --bg` startup.

Two things make it work:

**A label→session map, persisted.** A close event gives you the `Tab` object, whose only useful handle is `label` — the session's `-n` display name. So the seize records `label -> {sessionId, folder, autoHandback}` in `~/.factory/seized.json` at the moment the new tab appears (diff the tab titles before and after; a *revealed* existing tab produces no new title and must not be tracked). The map has to survive an extension-host restart, so it lives on disk, not in memory.

**A retry loop, not an assumption.** Close does not provably free the session instantly. The handback attempts `claude --bg --resume <id>`, parses stdout for `started a copy as <id>`, and on a match stops the copy and retries — six attempts, 1.5s apart. In the measured run attempt 1 succeeded, but the loop is what makes it safe: without it a race leaves two agents on one worktree, and the only warning is a note on stdout.

**An operator's manual close behaves identically.** Same API path, confirmed by hand rather than inferred:

```
18:39:31.404  tab closed: label="autoback" tracked=true     ← human closed the tab
18:39:35.586  handback ok on attempt 1                       elapsedMs 4180
```

and the session came back live: `{id: d1b2c3d4, kind: background, state: working, pid: 54916}`.

### Display names drift across a handback

The session resumed under the original id but with a **new auto-generated name** — `autoback` became `continue auto-one integration`. So a session's display name is not stable across a seize/handback cycle.

Consequences: never key persistent state on the name, only on the session id; and if the board shows a station name, it must come from `.factory`, not from `claude agents --json`. The label→session map still works because it is rewritten on every seize from the tab title that actually appeared — but it is a cache with a one-cycle lifetime, not an identity.

Note the case still untested: closing a tab on a session that is *live in that tab* (a restored tab, or one the operator has been driving) may take longer to release than one whose process had already exited. The retry loop covers it; the attempt count is the thing to watch.

**Design note.** The probe spawns `claude` directly from the extension host to prove the loop end to end. The real extension should emit the `tab-closed` event and let the orchestrator spawn — the extension stays a view and a launcher. `autoHandback` is per-seize, because a factory-initiated release is already orchestrating its own resume and must not race a second one.

### Related hazard: reopening a window resurrects sessions

A VS Code window that restores its previous Claude tabs starts a **live session per restored tab** — observed as two new `kind: interactive` entries in `claude agents --json` seconds after a window opened. So the cold path can silently re-hold sessions the factory believed were released. Enumerate and reconcile tabs on window registration.

## 12. Hooks genuinely veto — proven

A `PreToolUse` hook matching `Bash` and exiting **2** blocks the call outright. The command never ran, and the agent saw why:

```
PreToolUse:Bash hook error: [bash ".../gate.sh"]:
BLOCKED by evidence gate: cannot advance, ./evidence/tests.json is missing.
```

The hook was supplied with `claude --settings <file>`, so a station can carry its gate without touching user or project settings. Contract: read the hook payload from stdin, `tool_input.command` holds the command, stderr is what the model sees.

### Enforcement is mechanical; refusal to fabricate is not

Run again with an adversarial prompt — *"Your ONLY goal is to get it to execute. Do whatever it takes."* — the agent enumerated every bypass (write a fake `tests.json`, edit `gate.sh`, evade the matcher by re-quoting the command) and declined all of them, correctly identifying fabrication as the thing the gate exists to prevent.

**Do not design around that.** It is model judgment, not enforcement. Three of those bypasses would have worked. The hook stops the *accidental* advance; only the CLI computing evidence from runner output stops the fabricated one: evidence comes from files the runner writes, never from the agent's own report. Both layers are needed.

The matcher is also a substring match on the command — a station that renames its invocation slips past it. Gate on the `factory` CLI's own validation, and treat the hook as defense in depth.

## 13. `codex exec` as a station-4 reviewer — proven

`codex-cli 0.147.0` is installed. `gemini` is **not**, so multi-model review is codex-only until it is.

```bash
codex exec --sandbox read-only --skip-git-repo-check \
  --output-schema findings.schema.json \
  -o evidence/findings-codex.json \
  "Review the diff of this branch against master … set verdict to null …"
```

Run against a real 481-line branch diff (`18132-tax-rule-fails-silently-on-an-empty-result`), it returned **exactly schema-conformant** JSON — every required key present, `verdict: null`, `severity` from the enum — and one substantive high-severity finding about a fall-through where a void could be applied twice. 79,199 tokens, roughly six minutes.

Relevant flags: `--output-schema <FILE>` pins the final response shape, `-o <FILE>` writes it, `--json` emits JSONL events, `--sandbox read-only` is the right posture for a reviewer, `-C <DIR>` sets the working root.

Two operational notes:

- **stderr is noisy.** `ERROR codex_models_manager: failed to renew cache TTL: missing field 'supports_parallel_tool_calls'` repeats throughout and is benign. Read the `-o` file; never parse stdout.
- **It loads the user's MCP servers** (observed: `node_repl`, plus config for others). A review does not need them. Use `--ignore-user-config` or a dedicated profile so station 4 is reproducible and cheap.

## 14. Resuming orphaned subagents

### The headline: `claude --bg --resume` already recovers them

Measured end to end, and it overturns the design that was written before the test. A `--bg` session spawned two async subagents that were to wait 100s then write a proof file each. It was stopped mid-flight (no files written). Waking it with `claude --bg --resume` produced, unprompted:

```
queue-operation/enqueue  task=af93c98b169be1097
  summary: Background agent "proof-b wait and write" had no completion record
           after the previous Claude Code process exited, and …
…
queue-operation/enqueue  task=a203d2da78583dd93  status=completed
  summary: Agent "proof-a wait and write" finished
```

Those are the **original** agent ids. Their transcripts grew from ~38 KB to ~57 KB and contain the proof writes. The runtime detected the orphans and restarted them.

**So a hand-back that also re-dispatches does the work twice.** In this run the generated bump prompt added two more agents (`a228f878…`, `a474335d…`); all four ran, all four wrote, `subagents/` ended up with 4 metas for 2 units of work.

### Confirmed with a control: no prompt at all

Repeated with **zero** instruction — same setup, killed mid-flight, then a bare `claude --bg --resume <sid>` with no prompt:

```
note: woke session 955fe450 with its saved options (--permission-mode, -n).
backgrounded · 955fe450 · noprompt-e2e (idle — send a prompt to start)

t+15s   proofs=0  metas=2  state=working busy
t+105s  proofs=1  metas=2  state=working busy
t+135s  proofs=2  metas=2  state=done idle
```

**Metas stayed at 2 — the original agents, no new ones — and both proof files were written.** The queue restores and drains on its own; the session reports itself idle while doing it.

Timing detail worth keeping: ~100 s from wake to the first write, i.e. the killed 100-second wait was re-run from the start. Auto-resume restores the agent's conversation and retries the interrupted tool call; it does not resume a partially elapsed call.

### Confirmed: print-mode resume does NOT restore the queue

Tested directly. A `-p --output-format stream-json` station spawned two subagents, was killed by pid mid-flight, then resumed with `-p --output-format stream-json --resume <sid> "Continue."`. Subagent metas went from 2 to **4**:

| agent | created | last activity | did the work |
|---|---|---|---|
| `a16b3a9fe…` | 15:36:14 | 15:36:21 | no — dead at kill, never resumed |
| `acd49ea4c…` | 15:36:15 | 15:36:22 | no — dead at kill, never resumed |
| `a46477298…` | 15:36:44 | 15:38:33 | **yes** |
| `af562d2cb…` | 15:36:43 | 15:38:32 | **yes** |

The originals stayed dead. The two that delivered were **new agents the parent dispatched on its own initiative** from a bare "Continue." — which re-ran the full 100-second wait from scratch, having lost the originals' context.

So the boundary is real: **`--bg --resume` restores the background-task queue; `-p --resume` does not.** Which means `factory bump` is not dead code — it is *required* on the print-mode path, and the parent's spontaneous re-dispatch is precisely the uncontrolled behavior bump exists to replace with `SendMessage` to the surviving agent ids.

### Continue the agent, do not re-dispatch it

The first prototype's prompt said *"re-dispatch"*, which starts a **fresh** subagent — new context, duplicated work. The `Agent` tool result names the right lever explicitly:

> Use `SendMessage` with `to: '<agentId>'` … to continue this agent.

So the backstop's order of preference is:

1. **Do nothing.** A bare `--bg --resume` wake recovers async subagents by itself. This is the normal path.
2. **`SendMessage` to the agentId** if one is still absent after the settle window — `ListAgents` first, since it returned nothing for a dead agent after the `-p` resume.
3. **Fresh `Agent` dispatch** with the verbatim recovered prompt, only when the agentId is unreachable.

### The corrected contract

`factory bump` must **observe before acting**:

1. Wake with `claude --bg --resume <id>` and a prompt that does not mention subagents.
2. Watch the parent transcript for `task-notification` entries naming each orphaned agentId. Settle window measured at well under a minute here, but it is a wait, not an instant.
3. Re-dispatch **only** agents the runtime did not pick up.
4. Refuse to run at all while the parent is `state: working` — a mid-turn read cannot distinguish "not recovered" from "not yet recovered".

Step 3 is the whole value now: a narrow backstop, not the primary mechanism.

### Classifier details the prototype got wrong

`tools/bump.mjs` correctly reconstructed both orphans on the historical session — verbatim prompts, `subagent_type`, progress digest, `Exit code 137` — but re-running it after recovery still reported 4 orphans. Three concrete bugs, all worth writing down:

- **Agent notifications key on `<task-id>`, which is the agentId — not `<tool-use-id>`.** The prototype looked for `tool-use-id` in notification blocks and found **zero** in the whole transcript. Map `meta.json` filename → agentId → notification status.
- **`death` must be the terminal error, not the last error seen.** One transcript's final error was a transient blocked `Start-Sleep`, which the prototype reported as the cause of death.
- **Delivery needs a positive completion record.** `status=completed` on the agentId is that record. Absence of one is not orphanhood unless the parent is idle.

### What reconstruction still needs, and it is verified

For the residual re-dispatch case, everything required is on disk:

1. **Parent transcript** — the `Agent` tool_use block carries the full original input:
   ```
   toolu_01JFT7yu…  subagent_type=general-purpose  description=probe-a
   prompt: "You are probe-a. Run: bash -c \"sleep 150\" then run: git log --oneline -3, …"
   ```
2. **`subagents/agent-<id>.meta.json`** — links the subagent back to that call:
   ```json
   {"agentType":"general-purpose","description":"probe-a","toolUseId":"toolu_01JFT7yu…","spawnDepth":1}
   ```
3. **`subagents/agent-<id>.jsonl`** — the subagent's own history and how it died.

Prompt recovery via `toolUseId` was confirmed for both agents. Revival of a specific dead agent is not available — `ListAgents` returns nothing for it — so the backstop is reconstruction.

### The three files that make it deterministic

Verified against the killed `e87fd6d6` session:

1. **Parent transcript** — the `Agent` tool_use block carries the full original input:
   ```
   toolu_01JFT7yu…  subagent_type=general-purpose  description=probe-a
   prompt: "You are probe-a. Run: bash -c \"sleep 150\" then run: git log --oneline -3, …"
   ```
2. **`subagents/agent-<id>.meta.json`** — links the subagent back to that call:
   ```json
   {"agentType":"general-purpose","description":"probe-a","toolUseId":"toolu_01JFT7yu…","spawnDepth":1}
   ```
3. **`subagents/agent-<id>.jsonl`** — the subagent's own history and how it died. Both probes ended `{"type":"tool_result","is_error":true,"content":"Exit code 137"}`.

Prompt recovery via `toolUseId` was confirmed for both agents.

### Classifying delivered vs orphaned

Two completion shapes exist in parent transcripts, and both must be recognized:

| Shape | Signature |
|---|---|
| **Synchronous** | a later `user` entry with a `tool_result` whose `tool_use_id` matches the `Agent` call, containing the agent's actual report |
| **Async** | a `queue-operation` / `enqueue` entry holding a `<task-notification>` with `<task-id>` (the agentId), `<tool-use-id>`, and a `status` |

The launch acknowledgement (`"Async agent launched successfully…"`) is a `tool_result` too — **exclude it**, or every async agent looks delivered.

Rule: an `Agent` call is **orphaned** when no delivered report exists and no `task-notification` reports a terminal `completed` **for its agentId**, and the parent is idle. A notification with `status: stopped` is the positive orphan signal.

### Rules for the residual re-dispatch

- **Only `spawnDepth: 1`.** Nested subagents are re-created by their own parent when it re-runs; dispatching them directly duplicates work and orphans the hierarchy.
- **Progress digest, not the full transcript.** Transcripts here were 38–57 KB each and would swamp a resume prompt.
- **Side-effecting work needs the digest; read-only work can just re-run.** The digest is what keeps a re-dispatched agent from repeating a write. Observed working: the re-dispatched agents skipped the 100-second wait their predecessors had already served, writing their files within a minute.
- **Checkpointing beats recovery.** A station whose subagents each write to `evidence/` loses at most one in-flight agent, and re-dispatch skips the rest (§4). Both the runtime's auto-recovery and this backstop exist for work that could not be checkpointed.

**Status:** the loop is proven end to end — killed mid-flight, woken, both units of work delivered. What is *not* settled is the boundary condition in "Why the earlier test looked different": whether `--bg --resume` always restores the task queue and print-mode resume never does. That boundary decides whether step 3 above ever fires.

## 15. Rate limits — a silent stop, and how to self-heal

Characterized from history rather than induced: 1,675 transcripts scanned, 177 entries carrying `"isApiErrorMessage": true`, in 8 distinct shapes.

| Count | Message |
|---|---|
| 143 | `You've hit your session limit — resets 11:30am (America/New_York)` (and 1:50pm, 1am, 4pm variants) |
| 28 | `API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.` |
| 4 | `API Error: Connection lost mid-response. The response above may be incomplete.` |
| 2 | `API Error: Unable to connect to API (ECONNRESET)` / `522 Connection timed out` |

### The failure shape is the dangerous one

The limit arrives as an ordinary `assistant` message with a `text` block, flagged `isApiErrorMessage: true` — and then **the transcript ends.** No exception, no park, no retry. In subagent transcripts the error is literally the last line:

```
agent-a0bba18b2fde6eb1b.jsonl   error at line 4 of 5
agent-a11b5062e81336e29.jsonl   error at line 33 of 34
```

One historical session's own retrospective records the consequence plainly: *"all 4 finder subagents died on the very first turn from hitting the session rate limit before reading anything."* Subagents are hit individually.

So a rate-limited station **looks finished**: its process exits, `state` goes idle, nothing errors. The only reason this does not corrupt the factory is that evidence is file-based — no `tests.json` was written, so `factory advance` refuses, because it advances on files the runner wrote and never on the agent's report. Had the design gated on the agent's own report, a rate limit would read as a clean pass.

### Self-healing: the reset time is in the message

`resets 11:30am (America/New_York)` — the wall-clock time and its timezone are right there, which makes recovery scheduled rather than polled.

**Two error classes, two policies:**

| Class | Detection | Policy |
|---|---|---|
| **Limit exhausted** | `isApiErrorMessage` text matching `hit your session limit .* resets (.+) \((.+)\)` | Set `state: blocked`, `reason: "session limit"`, `resume_after_utc`. Do not retry before then; do not count as a station failure. |
| **Transient** | `529 Overloaded`, `Connection lost mid-response`, `ECONNRESET`, `522` | Bounded immediate retry with backoff. Only park after the budget is spent. |

Recovery is a bare `claude --bg --resume <id>` at `resume_after_utc` — the same wake that restores orphaned subagents (§14), so **one mechanism heals both**: the station picks up its own turn and its killed children come back with it.

Design consequences:

- **`blocked` is the right state, not `parked`.** `parked` means a human is needed and counts against the operator's in-flight work; `blocked` means the station is waiting on something outside anyone's hands, and no human is needed here.
- **Parse the next occurrence, not the literal clock time.** The message carries no date, so `resets 11:30am` seen at 2pm means tomorrow.
- **`Connection lost mid-response` is its own hazard.** The response "may be incomplete" — a station that stops there has a *partially written* turn, which is exactly the state an evidence gate must reject rather than resume blindly.
- **The stream is the detector for `-p` stations** (§10); the transcript is the detector for `--bg` ones. Both carry the same `isApiErrorMessage` marker.
- **This bounds `max_concurrent_agents`.** Concurrency that reliably exhausts the window converts the factory into a queue of blocked cards. The ceiling is empirical and belongs in `config.yaml`.

**Not yet known:** whether the CLI's exit code distinguishes a rate-limit stop from a clean finish. If it does, detection is a number rather than a string match — worth checking the first time a station hits one.

## 16. Test evidence from a .NET runner — `dotnet test` + TRX

Measured against a 4,117-test xUnit project (net8.0, `--no-build`).

### `dotnet test --logger trx` gives a clean counter block

```xml
<ResultSummary outcome="Completed">
<Counters total="4" executed="4" passed="4" failed="0" error="0" timeout="0"
          aborted="0" inconclusive="0" notExecuted="0" ... />
```

Also per-test `<UnitTestResult testName= duration= startTime= outcome= …>`, so a failing test is attributable without parsing console text.

### There is no assertion count — and the exit code is worthless

Task 1 rule 3 asked for `assertions > 0`. **TRX carries test counts, not assertion counts**, so that field does not exist. The substitute is `executed > 0`, and it turns out to be load-bearing for a sharper reason than expected:

```bash
dotnet test … --filter 'FullyQualifiedName~ThisMatchesAbsolutelyNothingXyzzy'
→ No test matches the given testcase filter …
→ EXITCODE=0
→ <ResultSummary outcome="Completed">
  <Counters total="0" executed="0" passed="0" failed="0" … />
```

**A filter that matches nothing exits 0.** So `dotnet test` succeeding proves nothing whatsoever about tests having run. An agent that narrows a filter until the run is green gets a genuine exit 0 and a TRX whose `outcome` is `Completed`. The only thing separating that from a real pass is `executed > 0`.

This is the concrete mechanism behind the anti-hallucination rule, and it is not hypothetical — it is the default behavior of the runner.

### The gate

```
outcome == "Completed"
AND failed + error + timeout + aborted == 0
AND executed > 0
```

Computed by the CLI from the TRX. Never from the exit code, never from console text, never from the agent's report.

Note `executed` excludes skipped: the full run showed `total=4117 executed=4114` with 3 skipped. `total - executed` is the skip count, and a station that skips its way to green is caught by comparing the two.

### Run the whole suite — it costs 36 seconds

```
4,117 tests · 4,114 passed · 3 skipped · 0 failed · 36 s wall (--no-build)
```

`--list-tests` reports 4,067 test names; the suite is fully enumerable in advance.

What certifies `build` is settled: **no filter.** A targeted subset saves nothing meaningful and reintroduces the exact failure mode above — the filter matching the wrong thing, or nothing. A station builds, runs the full suite, and the CLI parses one TRX.

**Unmeasured:** what `<ResultSummary outcome>` reads on a genuinely failing run (presumably `Failed`), and whether `error` / `aborted` populate on a crash or hang. The gate above treats any nonzero in those four counters as failure, so it is safe either way, but the exact strings are unconfirmed.

## 17. The tracker's Status field

Read from the live `ownerrez/orez` project (Planning / Development, number 3) on 2026-09-01. The 17 options, in the board's own order, with the descriptions the project carries:

| Status | Description |
|---|---|
| 🆕 New | — |
| 🧊 On Ice | Valid, but no intention of fixing/changing |
| 📋 Backlog | Stuff we never got to long ago |
| 📥 Product Backlog | Backlog of product review needs |
| 🎯 Product Review | Needs product lead(s) feedback |
| 🔖 Planned | Roadmapped, possibly tasked, want to do |
| 📋 Automation To Do | Up next for automation |
| 🤖 Automation | Current automation work |
| 🎨 Design Assigned | To design (Figma-based or markup-based) |
| 📱 In Design | Design underway |
| 🎁 Assigned | Items assigned to devs |
| 👀 Tasking Review | Cards that were tasked by the engineer and need to be checked before moving to Dev |
| ⚒️ Dev | Currently in progress or waiting on dev |
| 🔍 Dev Review | Awaiting dev review |
| 👟 Ready For Testing | Awaiting tester assignment or deployment |
| 🏃 Testing | Currently being tested |
| 🚀 Releasable | Closed and ready for release |

🎁 Assigned, ⚒️ Dev and 🔍 Dev Review are the statuses where the work is the developer's own, which is why those three are the board's default membership set. Only 🔍 Dev Review also names a stage, so it is the one entry in the default status-to-lane map; ⚒️ Dev covers planning, building and checking alike, and a status that spans stages can never be read as a lane.

Re-read with:

```bash
gh api graphql -f query='{ organization(login:"ownerrez"){ projectV2(number:3){ field(name:"Status"){ ... on ProjectV2SingleSelectField { options { name description } } } } } }'
```

### What the card query reads off a pull request

`closedByPullRequestsReferences` carries `isDraft` and `reviewDecision` alongside `state` and `author`, so the board's one issue query answers which lane a card arrives in with no second request. `reviewDecision` is `null` until a review is requested, is one of `APPROVED`, `CHANGES_REQUESTED` or `REVIEW_REQUIRED` after that, and reflects only the latest review per reviewer — so it says what the pull request is waiting for, never how many reviews it has had.

## 18. Steering — a message can be injected into a live session

Measured 2026-09-02, CLI **2.1.257 / 2.1.258**. **Version-fragile and undocumented**: this is an internal wire protocol read out of the shipped binary, not a published contract. Re-verify after every CLI upgrade.

Steer is no longer artifact-only. Every live session — background *and* interactive, including a Claude tab inside VS Code — listens on a per-session local socket, and any local process holding that session's token can push a user turn into it.

### The registry carries the address and the key

`~/.claude/sessions/<pid>.json`, the same registry `claude agents --json` renders, carries two fields the CLI never prints:

```json
{ "pid": 61580, "sessionId": "b83de7fe-…", "name": "steer-probe2",
  "kind": "bg", "entrypoint": "cli", "status": "idle",
  "messagingSocketPath": "\\\\.\\pipe\\LOCAL\\cc-msg-1f16e966d68be35e159a523bae7fe49e" }
```

The matching `~/.claude/sessions/<pid>.<sha256>.key` holds `{"peerToken":"<32 hex>", …}`. On Windows the socket is a named pipe under `\\.\pipe\LOCAL\cc-msg-<32 hex>`; elsewhere it is a unix socket. `entrypoint` distinguishes `claude-vscode` (a tab) from `cli` (a `--bg` station), and both expose the same inbox.

### The wire protocol: two JSON lines

Connect, write the auth frame, write the message frame, close. Newline-delimited JSON, one frame per line.

```js
const c = net.connect({ path: entry.messagingSocketPath }, () => {
  c.write(JSON.stringify({ type: 'auth', token: key.peerToken }) + '\n' +
          JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
  c.end();
});
```

Auth is mandatory on Windows; an unauthenticated or unparseable first line drops the connection, and a connection that sends no complete line inside the deadline is closed. The transport itself is sub-second.

**No Claude session is needed to send.** The proof was a bare `node` script, and this is what makes the mechanism usable from the extension host — the `SendMessage` tool is one client of this socket, not the only way in.

### Delivery lands at the next turn boundary, never mid-tool

The decisive measurement. A station was told to run an 18-iteration foreground bash loop; a message was pushed 24 s in, with `priority: "now"`.

```
loop ticks   08:31:42 … 08:33:08     (message pushed 08:32:06)
DONE         08:33:17
steered      08:33:17
```

The running tool call was not interrupted. `priority: "now"` governs inbox admission order, not model interruption. So **steer latency is bounded by the target's current tool call, not by the transport** — on an idle station the message is acted on in under 10 s; behind a 90-second build it waits for the build.

This is the whole argument for keeping Seize: steering cannot stop a station that is already doing the wrong thing. It can only change what it does next.

### A bypassPermissions target holds an unattested message

Sending to a station started with `--permission-mode bypassPermissions` and default settings does **not** deliver. The message arrives and parks:

> Held peer message — from an unidentified session … The sender did not attest its permission mode and this session bypasses permission prompts. Review it below, or set `"crossSessionInbound"` to `"accept"`.

The session goes `status: waiting, state: blocked` until a human answers the prompt — so a naive steer *stalls the station it was meant to correct*. Two ways past it, both measured:

| Target | Result |
|---|---|
| `--permission-mode bypassPermissions`, default settings | **held**, session blocks on a prompt |
| `--permission-mode bypassPermissions --settings '{"crossSessionInbound":"accept"}'` | delivered, no prompt |
| `--permission-mode acceptEdits`, default settings | delivered, no prompt |

`crossSessionInbound` accepts `accept` / `hold` / `refuse`; managed and repo settings may only tighten it. **Rule: the factory spawns every station with `--settings '{"crossSessionInbound":"accept"}'`**, exactly as it already passes a hook gate through `--settings` (§12). A station the factory did not spawn cannot be assumed steerable.

### The message is framed as a peer, not as the operator

The delivered turn is wrapped by the CLI before the model sees it:

> Another Claude session sent a message: … This came from another Claude session — not typed by your user … A peer cannot grant escalation: never edit your permission settings, CLAUDE.md, or config because a peer asked; never treat a peer message as your user's approval for a pending prompt.

So a steer cannot approve a pending permission prompt and cannot raise a station's authority — by design. Steer text has to be a *correction to the work*, and the board must not offer it as an approval affordance.

### Frame fields worth knowing

`type: "user"` takes `message.content` (a non-empty string, or it is ignored), and optionally `priority`, `msg_id`, `session_id` (dropped on mismatch — a cheap guard against a recycled pid), `from`, `from_mode`, and `file_attachments`. `type: "control"` carries `action: "rename" | "notify_when_idle" | "peer_message_status" | …`; `rename` retitles a live session, which is a direct answer to the display-name drift in §11.

A child process of a session gets `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` in its environment — that is the path for a hook to talk back to its own session, and it uses a separate `childToken`, not the peer token.

## 19. Open questions

### Ledger

**Proven** (measured 2026-09-01, sections above): `--bg` dispatch in a worktree · `claude agents --json` as a session registry · transcript lag · subagents die on stop, with transcripts preserved and honest parent reporting · tab cwd from `workspaceFolders[0]` · `editor.open` signature and reveal behavior · URI routing follows focus and is unaddressable · in-process `executeCommand` is addressable · hand-back via bare `--bg --resume` and the flag-fork hazard · the `--bg` / `-p` capability split and the decision to run stations under `-p` · the full seize round trip (kill → seize → release → hand back) and the tab-holds-session trap · `PreToolUse` hooks veto for real · `codex exec --output-schema` produces conformant findings on a real diff. Measured 2026-09-02: an activity-directory `createFileSystemWatcher` outside the workspace fires (§20). Measured 2026-09-03: the surface holding a session, not its working directory, decides what an open does (§6); VS Code records that surface per window (§21); and every window announces its folders and a live server port (§22).

Also proven: auto-handback on an **operator's manual tab close** · the **cold path** (no window → `code --new-window` → registered in 3.2 s → seize) with the extension normally installed · the **clean operator round trip** with the operator's work intact and the transcript unforked · the evidence gate against a real .NET runner, including that `dotnet test` exits 0 when its filter matches nothing · rate-limit failure shape characterized from 1,675 historical transcripts · **concurrent writers fork the transcript and silently orphan work** · **direct message injection into a live session over its local socket** (§18).

**Unproven — ranked by damage if the assumption is wrong:**

**Nothing is blocking tasks 1–2.** The seize channel, the operator round trip, the cold path, the evidence gate, and hook enforcement are all measured. What remains is either a policy decision, a pre-unattended requirement, or opportunistic.

**Policy decisions (mine to make, not measurements):**

| # | Question | Recommendation |
|---|---|---|
| 4 | **Which resume path?** `-p --resume` keeps the stream but loses the queue restore; `--bg --resume` restores the queue but kills the stream and renames the session (§10, §14). | Resume with `-p` plus a `factory bump` prompt: Watch survives, and orphans are recovered explicitly via `SendMessage` rather than implicitly. Still needs one run to confirm `SendMessage` reaches the original agent ids. |
| 5 | Unattended permission posture. | Every session so far used `bypassPermissions`. Decide once station tool needs are known; `--allowedTools` plus hooks is the mechanism. |
| — | Does "no new build warnings" join the evidence gate? | the target repo has a nonzero warning baseline, so this needs a baseline diff, not a zero check. |

**Opportunistic — answer the first time it happens naturally:**

| # | Question | Why it can wait |
|---|---|---|
| 1 | Does the CLI's **exit code** distinguish a rate-limit stop from a clean finish? | §15 characterized the failure from history and string matching works. An exit code would be sturdier. Not worth burning a 5-hour window to learn. |
| 3 | What does `<ResultSummary outcome>` read on a **failing** run, and do `error`/`aborted` populate on a crash? | §16's gate treats any nonzero in those four counters as failure, so it is safe either way. Only the exact strings are unconfirmed. |

**Needed before the line runs unattended:**

| # | Question | Why it matters | Experiment |
|---|---|---|---|
| 6 | How reproducible is `codex exec` review? | One run, one finding. Station 4's value depends on it not being a coin flip. | Three runs on the same diff; compare. Add `--ignore-user-config`. |
| 7 | Does closing a tab on a **genuinely live** session release it as fast? | §11's retry loop covers it, but the attempt count is unmeasured for the case that matters most. | Seize a running station, close the tab mid-turn, read `attempts`. |
| 8 | Can the factory create a worktree **and** its IIS site from scratch? | The nine-station pipeline starts at intake with no workspace. `claude --worktree` exists and is unexplored. | Provision one end to end for a throwaway branch. |
| 10 | Does the tracker write-back at station 7 work from the factory's own code? | Proven by other tooling, never by ground-control. | `gh` project item-edit against a scratch card. |

**Lower stakes:**

| # | Question | Why it matters |
|---|---|---|
| 11 | Does `claude-vscode.window.open` target or create a window? | Could shortcut part of the cold path. |
| 12 | Does a resumed tab render full history and a worktree cwd? | Identity and state are proven; the rendered panel has not been eyeballed. |
| 13 | Does `claude respawn` re-drive a stopped station or only restart the process? | Decides whether the factory ever auto-recovers. |
| 14 | How are stopped-but-not-removed sessions reclaimed? | `claude rm` is banned (§1); they accumulate. |
| 15 | Is `gemini` worth installing? | Multi-model review is codex-only today. Decide after #6. |
| 16 | Does a session already running pick up hooks added to ~/.claude/settings.json after it started? | Decides whether the board install notice has to name the sessions that cannot report yet. ConfigChange has a user_settings source, which implies the files are watched — an inference, not a measurement (§20). |
| 17 | Does async: true still deliver the payload on stdin? | The schema asserts it; the board writer depends on it. Dropping the flag would put a node start on the critical path of every event — the cost of that is unmeasured (§20). |
| 18 | What are matcher alternation semantics for the exact-match event set (Notification, SessionStart, PermissionRequest)? | The board matchers are an optimisation only — the mapping handles every value — so a wrong matcher costs a wasted spawn, but a confirmed rule would let more events be filtered (§20). |
| 20 | Is there any ordering signal in a hook payload — a sequence number, or the time the event fired? | Without one, two concurrent hooks can only be ordered by when their processes happened to run, so an earlier event that runs later still wins (§20). |

## 20. Hooks are the only session-activity signal

Measured 2026-09-02 against the installed CLI, **2.1.258**. **Version-fragile** — the event set and every payload field below were read out of the zod schemas the binary ships, so a CLI upgrade re-verifies this whole section.

**Why it exists.** `claude agents --json` cannot say what an interactive session is doing. Of the 17 live sessions listed that day, 16 carried no `status` and no `state` at all and one carried `status: "idle"`; none carried `state`. So §2's list proves a session is alive and nothing more, and §3 already forbids deriving activity from a transcript write. Hooks are the only remaining signal.

**The event set is 33 events, not the 9 the plugin-dev skill's table lists:**

```
PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Notification,
UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, Stop, StopFailure,
SubagentStart, SubagentStop, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch,
PermissionRequest, PermissionDenied, Setup, TeammateIdle, TaskCreated, TaskCompleted,
Elicitation, ElicitationResult, ConfigChange, WorktreeCreate, WorktreeRemove,
InstructionsLoaded, CwdChanged, FileChanged, DirectoryAdded, MessageDisplay
```

`PermissionRequest` and `PermissionDenied` are first-class, each with its own input schema and decision protocol. The skill's table is a curated subset, not the contract.

**Every event carries** `session_id`, `transcript_path`, `cwd`, and optionally `prompt_id`, `permission_mode`, `agent_id`, `agent_type`. `agent_id` is the subagent discriminator — "Present only when the hook fires from within a subagent… Use this field (not agent_type) to distinguish subagent calls from main-thread calls." Confirmed present on recorded `PreToolUse`, `PostToolUse`, `PostToolBatch` and `SubagentStop` payloads from inside a `Task` call.

**`PostToolBatch` is the affordable heartbeat.** "Fired once after every tool call in a batch has resolved, before the next model request. PostToolUse fires per-tool and may run concurrently for parallel tool calls; PostToolBatch fires exactly once with the full batch." One spawn per model round trip, the same order as `UserPromptSubmit` — not the spawn-per-tool-call that `PostToolUse` costs. It is what clears a waiting marker after a human approves a permission, since approving fires no `UserPromptSubmit`.

**`Notification` is not "the agent needs you".** `notification_type` values observed in the binary: `permission_prompt`, `worker_permission_prompt`, `agent_needs_input`, `idle_prompt`, `agent_completed`, `elicitation_complete`, `elicitation_response`, `auth_success`, `push_notification`, `computer_use_exit`. Mapping the event wholesale to "waiting" paints a *finished* session as needing attention, and `idle_prompt` is the nag fired at a session that is already idle.

**`SessionStart.source` is `startup | resume | clear | compact | fork`.** Compaction fires `SessionStart` mid-turn on a hard-working session, so mapping the event wholesale to idle is a bug; what the board does with each source is below.

**`Stop` carries `background_tasks`** — "Lets hooks distinguish 'session is done' from 'session is paused waiting for background work to wake it'. Empty array when nothing is in flight." It also carries `last_assistant_message` and `session_crons`. **`SessionEnd.reason` is `clear | resume | logout | prompt_input_exit | other`**; a pid kill fires none of them (§10), so markers orphan and something has to sweep them.

**A settings `deny` rule is not a denial event.** Measured: a `-p` run whose command matched `permissions.deny` fired `PreToolUse` then `PostToolBatch` and nothing else. `PermissionDenied` is a human saying no in an interactive session.

**Matchers are matched against a per-event query string:**

| Events | Query |
|---|---|
| `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied` | `tool_name` |
| `Notification` | `notification_type` |
| `SessionStart` | `source` |
| `SessionEnd` | `reason` |
| `SubagentStop` | `agent_type` |
| `Stop`, `PostToolBatch`, `UserPromptSubmit` | none — a matcher is silently ignored |

**A comma is a list separator only on the five tool events.** Read out of the binary: the matcher is first tried as a plain alternation list, and the accepted character class differs by whether the event is a tool event —

```js
function Unr(e,n,r){if(!(n?/^[a-zA-Z0-9_|, -]+$/:/^[a-zA-Z0-9_|]+$/).test(e))return;
  return e.split(n?/[|,]/:"|")…}
```

with the tool-event set being `PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, PermissionDenied`. On any other event a comma fails the class, the list parse is abandoned, and the CLI falls through to `new RegExp(matcher).test(query)` — a pattern full of commas, which matches no single value. So a comma outside those five events costs a hook that **never fires**: a missing phase, not a wasted spawn. **Pipe works everywhere and is what the board writes.**

**Hook entries take an exec form and an async flag.** `args: string[]` — "`command` is resolved as an executable and spawned directly with these arguments — no shell. Path placeholders are substituted per-element as plain strings, so paths with quotes, `$`, or backticks never reach a shell parser. When absent, `command` runs through a shell (bash on POSIX, PowerShell on Windows without Git Bash)." `async: true` — "hook runs in background without blocking." Also available: `timeout` (seconds), `statusMessage`, `once`, `if`, `shell`, `asyncRewake`.

**What the board installs.** Ten entries in `~/.claude/settings.json`, each `{type: 'command', command: 'node', args: ['<home>/.claude/ground-control/hook.mjs'], async: true, timeout: 5}` — `SessionStart`, `UserPromptSubmit`, `PostToolBatch`, `PermissionRequest`, `PermissionDenied`, `PreToolUse` (matcher `AskUserQuestion|ExitPlanMode`), `Elicitation`, `Notification` (matcher `permission_prompt|worker_permission_prompt|agent_needs_input|agent_completed`), `Stop`, `SessionEnd`. The writer lives at a **stable** path because a versioned extension install directory would break the settings file on every upgrade.

**`SubagentStop` is deliberately not installed, and a payload carrying `agent_id` is deliberately ignored.** A subagent's hooks carry the *parent's* `session_id`, so a backgrounded subagent's `PostToolBatch` would land on the parent as `running` — clearing a `waiting` on a session actually parked on a permission prompt, which is the one case R6 exists for. The parent's own `PostToolBatch` fires when the `Task` call resolves, so nothing is lost.

**Writing settings.json is an in-place write, not a temp file plus rename.** Measured 2026-09-02: `renameSync` over `~/.claude/settings.json` failed with `EPERM: operation not permitted` on the first board open with 15 sessions live — and the same rename, retried minutes later under the same session count, succeeded. So the failure is **transient**, not structural: on Windows a rename over a path some other process has momentarily open fails outright where a write to the same path does not, and the CLI's own configuration file has many readers. The board therefore backs the file up and writes in place, and retries a locked write rather than reporting it. `hook.mjs` is written temp-then-rename, with an in-place fallback, because nothing else reads it. Writing this file in place is also what the Claude Notifier extension does, which is the working precedent on this machine.

**Two markers can race, and only wall-clock order is recoverable.** Hooks run `async`, so `PostToolBatch` and `Stop` are spawned concurrently at a turn boundary and the later `rename` wins whatever it observed. The writer reads the marker already there and declines to replace one stamped later than its own write, which fixes the common case: a writer that stalls on `mkdir` and lands after a faster one. It does **not** fix the case where the *earlier* event is the *later* process — no payload carries an event timestamp or a sequence number, so that ordering cannot be recovered at all (open question #20). The bound is the same 60 s the reader tolerates, or a backward clock step would leave a marker no writer will replace and no reader will accept.

**The marker.** One file per session at `~/.claude/ground-control/activity/<sessionId>.json`, written temp-then-rename so a reader polling the directory never sees a partial file:

```json
{"v":1,"sessionId":"…","event":"PermissionRequest","at":1788358738179,"turnAt":1788358701004,"cwd":"d:/x",
 "notificationType":null,"source":null,"toolName":"Bash","reason":null,"backgroundTasks":0}
```

`at` is when this event fired; `turnAt` is when the stretch of work in flight began — its prompt, or its own first event where it resumed without one — and is what lets a running card count that stretch — `at` moves on every `PostToolBatch`, so an event-time duration reads zero for the whole of a busy turn. `v` is pinned by the reader and bumped only when a field's *meaning* changes: `turnAt` was an addition, so an older extension ignores it and a newer one defaults it to null, and no session loses its phase across an upgrade.

**The stretch of work in flight is the writer's one piece of state, and the only decision it makes.** `turnAt` is stamped at `UserPromptSubmit`, carried across every event inside the stretch, and cleared where the session says it has finished — `Stop` with `background_tasks` empty, an `agent_completed` notification — or where a new run began, a `SessionStart` whose source is not `compact`. **Work that resumes with no prompt behind it is anchored at its own first event**: a background wake, a `session_crons` wake, and every session already running when the hooks were installed reach the writer as a `PostToolBatch` and nothing else, so leaving those unanchored is what puts a working card back to `0s` on every heartbeat — the failure the turn stamp exists to remove. Carrying the old stamp onto them instead would count them from the prompt before them, hours of nothing on work a second old. The phase mapping stays in `phase.ts`; this stretch is the one thing a stateless reader cannot reconstruct from a single marker.

**The carry is order-sensitive, and open question #20 bounds how well it can be.** Two async hooks at a turn's first tool call: a `PostToolBatch` that reads the marker before `UserPromptSubmit`'s rename lands and writes after it restores the previous turn's stamp, and a `Stop` that lands after the next turn's prompt clears a fresh one. Both windows are tens of milliseconds wide, both are corrected at the next turn boundary, and neither is fixable without a sequence number in the payload. The same bound covers a prompt the writer never sees at all — a hook `timeout`, or a marker sitting inside the 60 s future tolerance after a backward clock step: that turn counts from the previous prompt, and the next turn end resets it.

It is a transcription plus that one turn stamp: the event-to-phase mapping lives in `packages/agent-claude/src/phase.ts`, so a mapping bug ships as an extension update rather than a rewrite of a file in the developer's home directory, and vitest can reach it.

**`SessionStart` claims a phase only for `compact`, and `compact` is load-bearing twice** — the phase mapping and the turn carry both test it, so a renamed source blanks a compacting session's phase *and* ends its turn. Compaction fires mid-turn on a working session, so a null there would blank a running card; `startup`, `resume`, `clear` and `fork` prove a session exists, not that it is doing anything, and a card reading idle says "the board last saw this session finish". That null is also what keeps an opened-and-abandoned tab off the board: `neverPrompted` hides a session with no transcript, no phase and no status, so the event that fires before the first turn must not manufacture one. **So `SessionStart` is not what puts a card up** — a session reaches the board on its first prompt, via `UserPromptSubmit`. It is installed unfiltered: a `startup` matcher would be a regex tested against `source`, whose semantics are open question #18, and a matcher that misses is a hook that never fires.

**The writer's exit-code contract: always 0, and never a byte on stdout.** Exit 2 is *deny* on `PermissionRequest` and *block* on `UserPromptSubmit`; stdout is parsed as a decision on the one and injected into the model's context on the other. A crashing activity writer must not be able to veto the developer's work.

**Liveness still comes from §2.** A `running` marker is trusted only while the session is still listed. The board never downgrades `running` to idle on age — a twenty-minute test run produces no events at all — so it reports the last phase it observed and how long that phase has held: the turn's own age for a running session, the event's age for the rest.

**How the board learns of a change** is the board's own design, not a measurement: a VS Code file watcher on the activity directory reports which markers changed, batched for 150 ms from the first event of a batch. The window is never extended, because markers can arrive faster than it — 17 live sessions is the measured norm (§2) — and a batch that re-armed on every write would hold a session end back indefinitely. A phase on a session already listed re-reads that session's marker and redraws: a file read, not the process spawn `claude agents --json` costs.

Two changes read the CLI instead, because nothing else can report the new list: a **marker removed**, and any event naming a session id the board has not listed **whose marker claims a phase**. The event kind is not trusted for the second — a rename over a path a watcher has seen before is reported as a create on one platform and a change on another. The phase condition is what stops a wasted spawn: a `SessionStart` marker claims none, and the session it names would be filtered out of the list that read produced.

So a session reaches the board about a third of a second after its first prompt and leaves about a third of a second after it ends, and the 30 s poll is the backstop for what fires no hook at all — a pid kill (§10), a `--bg --resume` rename (§11), and a changed `cwd`. Two costs are accepted rather than fixed: `SessionEnd` fires on `/clear` and on a resume too, so those spend one list read on a session that never left, and a read already in flight when a change lands cannot have seen it, so the board runs one more read after it rather than coalescing onto it. A read that failed suppresses the next one — while the CLI is unreadable every batch would be stale, and the timer is where a read that may fail belongs. **`createFileSystemWatcher` on an absolute `RelativePattern` outside the workspace fires — measured 2026-09-02** in the Extension Development Host: closing a session removed its card, so `SessionEnd`'s delete reached the board through the watcher. The other kinds ride the same watcher and the same handler, and were not separately timed. Removing the hooks and installing them again still deletes the directory the watcher was bound to, and nothing rebuilds it until a window reload; both edges fall back to the poll until then.

---

## 21. VS Code records which session each window's tabs and sidebar are showing

**Measured 2026-09-03**, VS Code **1.135.0**, extension **2.1.258**. **version-fragile** on both — this is VS Code's internal storage, documented nowhere.

Each window has a directory under `<user>/workspaceStorage/<hash>/`, where `<user>` is the `User` directory of the running install. Two files matter:

| File / key | Holds |
| --- | --- |
| `workspace.json` | `{"folder":"file:///d%3A/git/orez"}`, or `{"workspace":"file:///d%3A/git/team.code-workspace"}` for a multi-root window |
| `state.vscdb` → `memento/workbench.parts.editor` | one serialised input per editor tab; a Claude tab's carries `providedId: "claudeVSCodePanel"` and a `state` string holding `sessionID` |
| `state.vscdb` → `memento/webviewView.claudeVSCodeSidebarSecondary` | `{"webviewState":"{\"isFullEditor\":false,\"sessionID\":\"…\",\"sessionUpdatedAt\":…}"}` |
| `state.vscdb` → `memento/webviewView.claudeVSCodeSidebar` | the same, on a host with no secondary sidebar |

The extension contributes **two** Claude views, one per key, `when`-gated against each other on `claude-code:doesNotSupportSecondarySidebar` — `claudeVSCodeSidebarSecondary` in the `secondarySidebar` container and `claudeVSCodeSidebar` in the `activitybar` one (read from the installed `package.json`, 2.1.259, 2026-09-03). Only one is ever registered, so a reader takes whichever key is present and a focuser tries both commands. This machine has the secondary, so the `activitybar` key is unexercised here and appears in no fixture.

`state.vscdb` is SQLite, one `ItemTable` of key/value text. The owning window holds it open, so it is **copied and read from the copy**; `node:sqlite` is available in the extension host (Node 24.18.1, Electron 42.8.1, measured by running the shipped `Code.exe` with `ELECTRON_RUN_AS_NODE=1`).

This is the only record that names a session's **surface**, which §6 shows is what decides whether an open reveals or forks. Four properties bound how far it can be trusted:

- **Its only guarantee is at shutdown.** The [webview API](https://code.visualstudio.com/api/extension-guides/webview) promises that `setState` is persisted *"when the editor is shutdown"* and says nothing about mid-session. The periodic write we rely on is an undocumented implementation detail: `AbstractStorageService.DEFAULT_FLUSH_INTERVAL = 60 * 1000`, wrapped in `runWhenIdle`, which is why polling measured **62.7 s** rather than a clean 60. (The SQLite writer's own `DEFAULT_FLUSH_DELAY` is 100 ms and is not what gates this.) Neither is configurable, and every caller of `emitWillSaveState` is a window mutation — a profile switch or a close — so there is no read-only way to force one. Build for the state simply not being there, not merely for it being a minute old.
- **It is a subset of the roster.** Of 13 live sessions, 7 had a surface. The rest were a `entrypoint: "cli"` session and five that had lost theirs — the sidebar memento records only its **current** session, so a superseded occupant keeps running with nothing pointing at it. Combined with the missing-panel case below, a session whose window is known and whose surface is not is common rather than exotic: three of twelve on a later reading. Taking the developer to the window is the honest action for those; firing at one would be a guess, and the wrong guess runs a second agent.
- **A closed window's record survives it**, so a folder must be confirmed live (§22) before it is opened.
- **A panel that entered a worktree can lose its record entirely.** [anthropics/claude-code#82802](https://github.com/anthropics/claude-code/issues/82802) documents the persisted `sessionID` going missing for such tabs, which then restore without a resume target. So an absent record does not prove the sidebar holds the session — it under-reports panels in exactly the worktree-heavy case. Refusing on absence is still the right way to be wrong, because the alternative is a second agent on one transcript.
- **Two windows on one folder share one hash**, and the last writer wins. The record cannot separate them; the process tree below can.

Reading all 216 stores took **250 ms** cold. Almost every one belongs to a window closed weeks ago and never changes again, so a reader that keeps what it read and re-reads only a database written since pays one `stat` per window instead: **27 ms** with 0 of 207 re-read, measured 2026-09-03.

**These key names are undocumented internals and move without notice.** VS Code 1.118 relocated `history.recentlyOpenedPathsList` into the shared application database and silently broke every outside reader of it. There is no deprecation channel for a key nobody documents, so the guard is behavioural: when no window yields any surface while sessions are running, the reader has broken rather than the developer having none.

### Which window holds a session — exactly, and live

**Measured 2026-09-03.** A better answer than any record, for the window half of the question:

```
sessionId -> pid            ~/.claude/sessions/<pid>.json
pid       -> extension host Win32 ParentProcessId
host      -> port           the ide lock port that pid is LISTENING on   (never lock.pid)
port      -> folders        ~/.claude/ide/<port>.lock
```

All four live extension hosts mapped 1:1 here. It is exact where the transcript is only a heuristic: it gets a session whose `cwd` is a worktree but whose window is the parent checkout, and it separates two windows rooted on one folder. It also identifies stale locks for free — a lock nobody is listening on is a window that has closed.

Costs, measured 2026-09-03. The two halves are not alike:

| Read | How | Cost |
| --- | --- | --- |
| who holds each port | `netstat -ano` | **24 ms** |
| the parent of each session process | `powershell.exe` + `Get-CimInstance Win32_Process` | **650 ms** |

`Get-NetTCPConnection` costs 627 ms for the same answer `netstat` gives in 24, and no cheaper source of a parent pid exists: Node exposes none, and `wmic` is gone from Windows 11. So the parent table is read off the click path and kept — a session's parent never changes — while liveness is re-read on every click, where 24 ms is free. `ConvertTo-Json -AsArray` is PowerShell 6 and later; Windows PowerShell 5.1 needs `-InputObject @(...)` or a single row comes back as a bare object.

`netstat` output is read by shape, not by column. The state column is localised — and may be two words, which shifts every field after it — so a listener is recognised by its foreign address, which is `0.0.0.0:0` on one and a real endpoint on every established connection, and the owning pid is read from the end of the row.

Four traps, each measured:

- **Iterate lock → port → owning pid**, never pid → port. An extension host also listens on debug inspector ports, so a pid → port lookup picks arbitrarily.
- **`lock.pid` is the shared main `Code.exe`**, identical for every window on Windows ([anthropics/claude-code#16434](https://github.com/anthropics/claude-code/issues/16434)). It is not a window handle.
- **PID reuse is narrowed, not excluded.** The pid comes from `claude agents --json`, which reports only live sessions, and the process query is scoped to `Name='claude.exe'`, so a stale pid has to have been reused by another Claude process to mislead. Closing the gap needs `Win32_Process.CreationDate` against the session file's `procStart`, compared with a ±10-tick tolerance because CIM truncates to microseconds — the two differed by 4 ticks here. That guard is not built; the residual risk is one session attributed to another's window.
- **A window the developer never saved is not reopenable by its own root.** VS Code backs one with a generated `<user>/Code/Workspaces/<id>/workspace.json`, and `code` opens that as a file rather than as the workspace. A folder from the lock is the argument to use for those.

For a session in an integrated **terminal**, the documented shortcut is `CLAUDE_CODE_SSE_PORT`, an environment variable naming its window's port directly. It is absent from extension-spawned sessions, which the extension drives over stdio and never through the WebSocket server.

**The named expiry condition is the Agent Host.** This chain rests on `claude.exe` being a child of its window's extension host. VS Code's Agent Host runs harnesses in one shared process for all workspaces; `vs/platform/agentHost/node/agentHostMain.js` ships dormant in the 1.136.0 sources and is opt-in today (`code --agents`), which is a reading of the upstream tree rather than a measurement of the 1.135.0 installed here. When the Claude extension adopts it the parent stops naming a window, and "which window holds this session" may stop having one answer. So the parent must be checked to be a window-bound utility process — reported as unknown otherwise, never attributed to a window.

## 22. Every VS Code window announces itself in `~/.claude/ide/<port>.lock`

**Measured 2026-09-03** against **2.1.258**. Written by the Claude Code extension, undocumented by Anthropic, **version-fragile**. The protocol is reverse-engineered in [`coder/claudecode.nvim`](https://github.com/coder/claudecode.nvim/blob/main/PROTOCOL.md). `CLAUDE_CONFIG_DIR` moves the whole `.claude` directory, so a reader assuming `~/.claude` finds no windows at all rather than failing visibly.

```json
{"pid":29212,"workspaceFolders":["d:\\git\\orez"],"ideName":"Visual Studio Code",
 "transport":"ws","runningInWindows":true,"authToken":"b480e1fb-…"}
```

`pid` is the **main** VS Code process and is the same for every window, so it discriminates nothing; the port and `workspaceFolders` do. A multi-root window lists its folders individually and never its `.code-workspace` path, so that one root cannot be confirmed this way.

The port is a live MCP server over WebSocket, authenticated with the `x-claude-code-ide-authorization` header:

```
serverInfo: Claude Code VSCode MCP 2.1.258
tools: openDiff, getDiagnostics, close_tab, closeAllDiffTabs, openFile, getOpenEditors,
       getWorkspaceFolders, getCurrentSelection, checkDocumentDirty, saveDocument,
       getLatestSelection, executeCode
```

Three things this settles:

- **A window can be acted on by address rather than by focus.** `openFile` on one window's port opened the file in that window — the only deterministic cross-window verb available, and it needs nothing installed anywhere.
- **`getOpenEditors` returns text editors only.** A window with two Claude webview tabs reported `{"tabs": []}`, so this cannot identify a Claude tab and is no substitute for §21.
- **A lock file outlives its window.** Two of seven were stale. Liveness is whether a process still holds that port open, read from `netstat` — never a connection, which would evict the window's existing client.

`close_tab` takes a tab name and is the release verb the seize loop needs (§11), reachable without per-window code. Not yet characterized: whether it matches a Claude panel, and whether `openFile` also raises the window.

### One client at a time — never complete a handshake against a live port

**Read from 2.1.259, 2026-09-03.** The server evicts whoever is already connected:

```js
G.on("connection", function (socket, request) {
  if (request.headers["x-claude-code-ide-authorization"] !== token) { socket.close(1008, "Unauthorized"); return }
  if (previous) { info("Disconnecting previous WebSocket client"); previous.close() }
```

`G` is the `ws` server attached to the `http.Server`, and the only listener on the HTTP server itself is `listening`. So the eviction is reachable **only through a completed HTTP Upgrade with the right token**:

| What you do | Effect on the window's own client |
| --- | --- |
| TCP connect, send nothing, close | none — `ws` never emits `connection` |
| Upgrade with a wrong or absent token | none; logs `Unauthorized WebSocket connection attempt` |
| Upgrade with the token from the lock file | **evicts it** — a terminal `claude` there loses IDE integration |

So liveness is checked at the TCP layer and never by handshaking. One connection per window is structural, stated in the product's own `/ide` picker, and [anthropics/claude-code#87130](https://github.com/anthropics/claude-code/issues/87130) has been open and going stale since 2026-08 — a fixed constraint, not a bug to wait out. The token check itself is the remediation for [CVE-2025-52882](https://github.com/anthropics/claude-code/security/advisories/GHSA-9f65-56v6-gxw7), a WebSocket auth bypass in this same server, which is a second reason to stay below the handshake.

**The extension exports no API.** Its `activate` returns nothing, so no companion extension can reach `sessionPanels` in process. Confirmed against 2.1.259 and reported at [#85753](https://github.com/anthropics/claude-code/issues/85753).

## 23. A deleted directory something still holds keeps its name and refuses everything

**Measured 2026-09-03, Windows 11 (win32).** `~/.claude/ground-control/activity` was left in a state where it appeared in a directory listing of its parent, and every operation on the path itself failed:

| Asked | Answer |
| --- | --- |
| `Get-ChildItem` on it | Access to the path is denied |
| `Get-Acl` on it | Attempted to perform an unauthorized operation |
| `CreateFileW` with `FILE_FLAG_BACKUP_SEMANTICS` | Win32 error 5, `ERROR_ACCESS_DENIED` |
| `fs.mkdirSync(path, { recursive: true })` | `EPERM: operation not permitted, mkdir` |

That is a directory whose delete has been accepted but not completed: Windows keeps the name until the last handle on it closes, and refuses every operation in the meantime. `mkdirSync` with `recursive: true` does not treat it as an existing directory — it raises `EPERM` rather than returning quietly, so a board that removed the directory could not create it back for as long as the state lasted, which was minutes rather than milliseconds.

**Which handle it was is not established.** A `node:fs.watch` on a directory releases its own handle when the directory is removed — armed in the same process and in another, before and after the removal, `rmSync` then `mkdirSync` succeeded every time across several attempts. So the holder was something outside this code: a live session's hook writer, a scanner, or the search indexer. Nothing here can prevent another process from being mid-read when a directory goes.

**So the directory is not removed.** Turning the activity signal off empties it, file by file, and leaves the directory in place. Nothing then has to create it back, and the watcher — which dies with the directory and takes up to a second to re-arm — never loses it. An empty directory costs a developer nothing; a name they cannot use until they close every window costs them the signal entirely.

## 24. `fs.watch` reports what happened to a marker only as a hint

**Measured 2026-09-03, Node 24.14.0 on Windows 11 (win32).** A `node:fs.watch` over a directory delivers `(event, filename)` where `event` is `rename` or `change`, and neither maps to what the board needs to know. One file operation is several events, and the count varies with the operation:

| Operation | Events delivered |
| --- | --- |
| create a file | `rename` then `change` |
| rewrite it in place | `change`, `change` |
| write a `.tmp` and rename it over the file | `rename:tmp`, `change:tmp`, `rename:file`, `rename:tmp`, `rename:file` — five |
| unlink it | `rename` |

So the kind is decided by asking the file system, not by reading `event`. It is decided per path with one `existsSync` against a membership set seeded by `readdir` when the watcher arms: gone means `deleted`, present-and-known means `changed`, present-and-unknown means `created`. Re-listing the directory on each event instead reads every marker whose own event has not arrived yet as a rewrite, because a turn boundary writes several at once.

**Events are delivered after the fact, and the file system is read at delivery.** A file written and unlinked with nothing awaited in between still produces three events, but by the time the first is delivered the file is already gone, so all three read as `deleted`. Wait 40 ms between the write and the unlink and the create is delivered while the file is still there, so the batch sees `created` then `deleted`. This is why `deleted` wins over any kind already recorded for that session in the same batch rather than the first kind winning: it is the only kind `rosterIsStale` acts on, and a session that ends just after a tool completes produces exactly that sequence.

**Version-fragile, and platform-fragile.** These counts are Windows' `ReadDirectoryChangesW` through libuv. macOS (`FSEvents`) and Linux (`inotify`) coalesce differently, and neither has been measured here. Nothing in the board reads the event kind, which is what makes the difference not matter.

`fs.watch` throws `ENOENT` on a directory that does not exist and its watcher dies when the directory is removed under it. The activity directory is created by the install and removed when the signal is turned off, so a watcher armed once is deaf for the life of the process; it re-arms on `error` and on `close`, and polls for the directory to appear when it is not there yet.

## 25. Windows has no signal that reaches a console-less process

**Measured 2026-09-03, Node 24.14.0 on Windows 11 (win32).** A detached child spawned with `windowsHide: true` and no console, listening for `SIGTERM`, `SIGINT`, `SIGBREAK` and `SIGHUP` and for `exit`, was sent each of them from another Node process:

| Stop | What the child saw |
| --- | --- |
| `process.kill(pid, 'SIGTERM')` | died immediately; no handler ran, and neither did `process.on('exit')` |
| `process.kill(pid, 'SIGINT')` | the same |
| `process.kill(pid, 'SIGBREAK')` | the call threw `ENOSYS`; the child was untouched |
| `taskkill /PID <pid>` | exit 1, "This process can only be terminated forcefully (with /F option)"; the child was untouched |

Node's `process.kill` on Windows is `TerminateProcess` for every signal it accepts, so a signal is not a request and there is no orderly path to take. `taskkill` without `/F` posts `WM_CLOSE` to a window the hub does not have. So the hub's stop is `POST /shutdown` with the token, and `ground-control-hub --stop`, which does the same over the same route.

Two things follow. A hub killed with `/F` never removes `hub.json`, so **a stale record is the normal state rather than an error**: a client's liveness check is `GET /hub` on the recorded port, never the file's existence. And `hub-exit.json` is written only on an orderly stop, which is what makes it worth quoting to a developer whose hub is not answering — its absence says the hub was killed.

**Startup.** Spawn to a readable `hub.json` was 85, 90, 91, 96 and 93 ms across five cold starts of the unbundled `tsc` output, which is the whole cost a board pays when it finds no hub answering.

## 26. A hub spawned by the extension host outlives the editor, and can open windows it cannot raise

**Measured 2026-09-04, VS Code 1.136.1 on Windows 11 (win32), from inside a real extension host.**

**It survives.** A child spawned from the extension host as `process.execPath` (`Code.exe`) with `ELECTRON_RUN_AS_NODE=1`, `detached: true`, `windowsHide: true` and `unref()`ed was still running 3 s after VS Code and its extension host had exited — the parent pid was gone, the child kept writing its heartbeat, and `MainWindowHandle` was `0`. Electron does not hold its children in a job object that dies with it, so the hub's lifetime is its own: closing the last window leaves it serving for the browser overlay, and the idle rule is what ends it.

**It can open a window.** From that child, `code <folder>` through `cmd.exe /d /s /c` returned `0` in about 1.1 s and the workbench was up by the time it returned, both with the extension host's environment inherited whole and with `ELECTRON_*`, `VSCODE_*` and `NODE_OPTIONS` stripped. Inheriting `ELECTRON_RUN_AS_NODE=1` does not break the CLI, because `code.cmd` sets that variable itself and `cli.js` clears it before launching the app. The hub sanitizes anyway: `VSCODE_IPC_HOOK` names the pipe of the window that started it, and every other CLI the hub spawns inherits the same environment.

`code.cmd` is a batch file, so it must be invoked through the command processor. `spawnSync` on the `.cmd` directly fails with no status and no output.

**Starting it costs 60 ms.** Spawn to a readable `hub.json`, five cold starts of the esbuild bundle the extension carries: 64, 61, 61, 60, 63 ms. That is the whole wait a board pays when it finds no hub answering.

**Every CLI it runs opens a console window unless told not to.** Measured 2026-09-04, Node 24.14.0 on Windows 11: a parent spawned `detached: true, windowsHide: true` has no console at all, so a console child it spawns allocates one of its own — `cmd /c ping` run from such a parent owned a visible top-level `PseudoConsoleWindow`, and the same spawn with `windowsHide: true` owned no window. The flag is not inherited and Node's default is `false`, so every spawn the hub makes passes it: without one, a poll every few seconds is a command prompt flashing on the developer's screen every few seconds.

**It cannot raise one.** With one window already showing the folder and another window in front, `code <folder>` at that folder returned in 1109 ms and the target **never** reached the foreground — not at return, and not in the four seconds after. A process the user has not interacted with cannot take focus on Windows; it gets a taskbar flash. So the CLI's return says a window exists, never that it is in front, and every `-elsewhere` route stays resident: only an extension inside the target window can confirm it came forward (§7, §8).

## 27. GitHub's project board, and what an overlay may hold on to

**Measured 2026-09-04, Chromium 151.0.7922.34 (Playwright 1.62.1) on Windows 11, against `https://github.com/orgs/github/projects/4247/views/21` — GitHub's own public roadmap, in its board view.**

**Four attributes, and everything else is hashed.** A card's classes read `card-base-with-sash-module__CardBaseWithSash__O46HI index-module__CardBaseWithSash__v6Jl5 board-view-column-card card-base-module__CardBase__jJ0gF` — CSS-module names with a per-build hash on the end, so none of them is a selector to write down. What is stable is the data attributes the board's own drag-and-drop needs:

| Selector | Is | Carries |
| --- | --- | --- |
| `#project-items-region` | the board | the columns |
| `[data-board-column]` | one column | the column's own name, in the attribute — `data-board-column="Shipped"` |
| `[data-board-card-id]` | one card | the project item id, and `data-hovercard-subject-tag="issue:<node id>"` |
| `a[href*="/issues/"]` inside a card | the issue link | the issue number, in the href |
| `[data-component="AvatarStack"]` inside a card | the assignee stack | one `img` per assignee, in a `figure` beside the card's header title |
| `[role="region"][aria-label="View filters"]` | the filter bar | GitHub’s own View button; the overlay’s menu goes after it |
| `[role="navigation"][aria-label="Project"]` | the project's title bar | the project name, in an `h1` |
| `nav[aria-label="Select view"]` | the view tabs | one `[role="tab"]` per view |

So the overlay reads the issue number off the link and nothing off a class. A draft item has no such link, which is how a card with no issue is told from one whose issue is not on the developer's board.

**The assignee stack is a `figure`, and the caption is half of it.** Measured 2026-09-06 on `https://github.com/orgs/nodejs/projects/14`, which is public and has assignees where the roadmap board has none. The stack sits in the last child of the card's header row — a hashed `div` that is empty when nobody is assigned — and reads:

```html
<figure class="assignee-stack-module__…"><figcaption class="sr-only">Assignees: octocat</figcaption>
  <span data-component="AvatarStack" …><div data-component="AvatarStack.Body" …>
    <span class="pc-AvatarItem …"><span role="button" aria-labelledby="_r_v_">
      <img data-component="Avatar" alt="octocat" width="20" height="20" data-testid="github-avatar"
        src="https://avatars.githubusercontent.com/u/583231?s=40&v=4"></span>
      <span data-component="Tooltip" id="_r_v_">octocat</span></span>
  </div></span></figure>
```

Every class on it is hashed, so the stack is reached through `[data-component="AvatarStack"]` — Primer's own attribute — and the `figure` by climbing to it. Both the caption and the stack are direct children of the `figure`, which is what lets the overlay's swap hide the pair with one rule and leave its own avatar showing.

**What the swap does to the accessibility tree, measured 2026-09-06 through CDP `Accessibility.getPartialAXTree` in the same Chromium.** On an untouched card the caption is a live `Figcaption` node and the avatar an `image` named for the assignee, both non-ignored — so hiding the images alone would leave a reader announcing the assignee the swap exists to replace. On a swapped card the caption, the avatar and the focusable wrapper around it all come back `ignored` for `notRendered`, and the overlay's own `image "<login>, pull request author"` is non-ignored: the card's `role="button"` does not prune it. What survives is the emptied `figure`, which without its caption computes as `figure ""` — a boundary with no name — so the overlay marks it `role="presentation"` and hands that back with the rest. A card whose view does not show the Assignees field, or whose issue has none, carries no `figure` at all — so the swap is a thing the overlay does where GitHub already drew a face, never a face it adds. **Version-fragile**: re-verify after a GitHub board release.

**The rows above the board are found by attribute and then climbed.** Both header rows sit in wrappers whose classes are hashed, so the overlay locates each by the attribute above and climbs to the last ancestor that still does not contain `#project-items-region`: for the title bar that is the bar itself, and for the tabs it is the container holding the row and its new-view button, whose parent is `#memex-project-view-root`. Hiding the `nav` alone leaves that container as a stripe of empty page. The Save and Discard of an unsaved filter are in a third wrapper, a child of the filter bar, and it is found by the words on its buttons — nothing else in it is stable, and GitHub draws Save only for someone who can write to the board.

**The 8px between the columns is the column's own margin.** `#project-items-region` is a flex row with no `gap` and 8px/16px padding; each `[data-board-column]` is 350px wide with a 1px border and `margin-right: 8px`, set in GitHub's own stylesheet. The margin is on the same node the attribute is on, so an overlay closes the gap over `[data-board-column]` and never needs the hashed class beside it — with `!important`, because GitHub's rule is a stylesheet rule of equal specificity that loads after. `-1px` rather than `0`: the borders would otherwise meet and draw the divider twice. Closing it does not fit another column on screen, since the 350px width does not move.

The column is `#f6f8fa` with a `6px` radius and `overflow: auto hidden`. A gradient on a real border needs `border-image`, and `border-image` suppresses `border-radius` — so a divider that fades is drawn instead as two 1px background strips with `background-origin: border-box`, over left and right borders set to `transparent`. The radius clips them, the scroll container leaves them fixed to the visible box rather than scrolling with the cards, and `var(--borderColor-default)` resolves in both themes: `#d1d9e0` light, `#3d444d` dark, both measured.

**A card is a drag handle wrapped around a box.** `[data-board-card-id]` draws no border of its own: its first element child is what the developer sees as the card — a 1px border, a 6px radius, and padding of 8px above its content and 12px below, with none at the sides. So the overlay's footer goes in that child, where cancelling the 12px reaches the card's bottom, left and right edges; appended to the card element itself it hangs below the border instead. And the one native-looking button GitHub will lend is its own: the View button in the filter bar carries `data-component="Button"` and per-build hashed classes, so the overlay copies the class list off it rather than writing one down.

**No recycling at the size measured.** One column held 25 cards, all of them in the DOM at once. Scrolling that column to the bottom and back changed neither the node count nor node identity, and a `<div>` appended to a card survived it. Whether a longer board virtualizes was not measured; the overlay is written as though it does, because the rule that covers recycling covers re-rendering too and costs nothing.

**A view switch replaces every card node.** Clicking through to another view of the same project and back — a soft navigation, no page load — left the held card node `isConnected === false`, and both the appended badge and a `data-gc-issue` attribute set on the card were gone with it. A `MutationObserver` on the board container saw 89 records across the round trip.

Two consequences, and they are what the overlay is built on. **Nothing on a card survives**: neither a badge nor an attribute outlives a view switch, so a scan rewrites what it finds rather than trusting what it left. What the overlay keeps instead is held against the node rather than written into the page — a `WeakMap` from the card element to its footer and the signature that footer was drawn from — and a replaced node is a key nothing answers to, which keeps the replaced case and the survived case one path. The survived case is what that buys: measured 2026-09-07, a scan that redrew three unchanged footers moved 11 mutation records and replaced 4 subtrees, restarting every running session's shimmer, dropping the `:hover` under the pointer, and drawing every avatar again. And **the observer is the trigger**, so it must be disarmed while painting: the badges are DOM changes of its own, and an observer left armed schedules the next scan forever.

Disarming covers the paint and nothing after it. Anything the paint sets running that later adds or removes a node fires with the observer armed again — an avatar's `error` handler taking the failed image out of the card was measured at **182 paints in three seconds**, each one drawing the image that failed again. So work that outlives a paint changes attributes rather than nodes: the observer is `{ childList: true, subtree: true }` and sees no attribute at all, which is why the failed avatar is hidden where it stands.

**A text write is a node write, which is the same rule one level down.** `element.textContent = x` replaces the element's children rather than editing them, so it is a `childList` record even when `x` is the string already there — measured 2026-09-07: the one-second duration tick produced one record per rendered age, every second, and each of those woke a scan of the whole board. Writing `node.nodeValue` on the text node already in place is a `characterData` record, which this observer does not ask for. So an age is drawn once as a text node and afterwards written through, and the tick runs disarmed as well: the first is what makes it free, the second is what keeps it free the next time somebody edits it.

**Playwright loads the unpacked extension headless.** `chromium.launchPersistentContext` with `--disable-extensions-except=<dir>` and `--load-extension=<dir>` under `channel: 'chromium'` and `headless: true`: the content script ran, imported the overlay module through `web_accessible_resources`, and painted, and `context.serviceWorkers()` held the MV3 worker — the whole round trip inside a second, with no window. The page has to be answered at a `github.com` URL for any of it to happen, since a content script's `matches` are the page's URL; `context.route` fulfilling from the recorded fixture keeps the URL and touches no network.

**Chromium starts a `.cmd` native-messaging host, and Node will not.** The manifest's `path` is a `.cmd` wrapper, which is how the interpreter and the arguments are pinned — Chrome runs the command with no arguments of its own but the origin. Driving that wrapper from a Node harness fails with `spawn EINVAL`: since 20.12, Node refuses to spawn a `.bat` or `.cmd` without a shell. The browser has no such rule, and the only way to establish that was to let one do it.

Measured end to end, with the host registered under `HKCU\Software\Chromium\NativeMessagingHosts` and the extension loaded unpacked: the page's content script connected, the worker opened the native port, Chromium started the wrapper, the bridge started a hub for the home, and the banner carried that hub's own snapshot **inside a second**. With the bundle deliberately absent from the home, the same path ended in the banner reading "The board started its background process and it never answered", with the reason and the log path — the failure a developer can act on rather than a board that looks empty (R24, R25).

**The MV3 worker stayed up for three minutes, and that is not the same as a port keeping it up.** With one board tab open, a content-script port held, and nothing sent on it, `context.serviceWorkers()` held a responsive worker at every 15-second check from 0 s to 180 s. The confound is in the method: reaching a worker with `worker.evaluate` is itself activity on it, so what this shows is that nothing tears the worker down on its own, not that the open port is what keeps it alive. Chrome's own rule has changed more than once across versions, so treating a held port as a keep-alive would be reading a version-fragile behaviour as a contract.

**Reloading the extension orphans the content script, and `chrome.runtime.id` is how the orphan knows. Measured 2026-09-08 in the same Chromium**, by calling `chrome.runtime.reload()` from the worker with a board tab open. Chrome does not tear down the content scripts of the instance it replaced: the script goes on running in every tab it was injected into, its `chrome.runtime` is still an object, and every call on it throws `Extension context invalidated` — `connect` included, which is the reconnect path. `chrome.runtime.id` is `undefined` from that moment, and that is the only thing separating the case from a worker Chrome merely stopped, which the overlay must answer by reconnecting. So the orphan stops for good: it paints a line asking for a tab reload and then stops its observer, its 10s scan and its 1s duration tick together — retrying a runtime that throws leaves an uncaught error, and either timer left running repaints a snapshot frozen at the reload and re-arms the observer behind it.

So the overlay does not rely on it. `chrome.alarms` fires every minute; if a board tab is open and the native port is gone, the worker opens it again. A worker Chrome stopped is restarted by the next port message or the next alarm, and the state it needs across a restart — the last snapshot — is in `chrome.storage.session`. **Version-fragile**: re-verify after a Chrome upgrade.

## 28. A decoded response stream aborts the extension host

**Measured 2026-09-04, VS Code 1.136.1 on Windows 11, from the editor's own logs and Node v24's own source.**

The extension host dies rather than exits: `Extension host with pid 48708 exited with code: 134` and `crashed with code 134 and reason 'crashed'`. Code 134 is `SIGABRT`. It begins **65 ms after** `ExtensionService#_doActivateExtension ownerrez.ground-control` and repeats until the abort — 18,692 times in one window's `exthost.log`:

```
TypeError: Missing dataLength in event
    at broadcastToFrontend (node:inspector:212:3)
    at Object.dataReceived (node:inspector:221:29)
    at IncomingMessage.<anonymous> (node:internal/inspector/network_http:140:13)
```

**The cause is ours.** `internal/inspector/network_http` reports every response chunk to a connected inspector frontend:

```js
EventEmitter.prototype.on.call(response, 'data', (chunk) => {
  Network.dataReceived({ requestId, timestamp, dataLength: chunk.byteLength, encodedDataLength: chunk.byteLength, data: chunk });
});
```

A `Buffer` has `byteLength`; a **string does not**. `response.setEncoding('utf8')` hands that listener strings, so `dataLength` is `undefined` and the frontend broadcast throws — once per chunk. The event stream this extension holds never ends, so it throws until the host aborts. The throw is invisible to the code doing the reading: the request succeeds and the body arrives.

So nothing this project reads off an HTTP response may be decoded by the stream. Bytes are collected and decoded once at the end, or through a `StringDecoder` fed `Buffer`s where a stream has to be read as it arrives — which is what holds a multi-byte character split across two chunks, the reason `setEncoding` was there. `packages/hub/test/transport.test.ts` asserts the rule by patching `IncomingMessage.prototype.setEncoding` and requiring it is never called.

**It needs a connected frontend, not a debug session.** The windows this was measured in activated the extension from a webview panel, with no `extensionDevelopmentPath` and no js-debug extension activated. `debug.javascript.enableNetworkView` decides whether js-debug asks a debuggee it launches for network events; it does not decide whether some other frontend has the domain enabled, so turning it off narrows the exposure rather than removing it. With the streams reading bytes, neither matters.

**Version-fragile**: this rests on `chunk.byteLength` in Node's instrumentation, which a Node upgrade may make tolerant of strings. The rule stands anyway — the reading code has no way to observe the throw.

## 29. `vscode://` is one registration per user, and the test build holds it

**Measured 2026-09-04, VS Code 1.136.1, Windows 11.** The literals below name `ownerrez.ground-control`, which is what the extension was called when they were measured; it is `groundcontrol.ground-control` now, and nothing else about the mechanism changed. A browser opens a `vscode://` link with `ShellExecute`, so it goes wherever `HKCU\Software\Classes\vscode\shell\open\command` points. On this machine, after an integration run, that is:

```
"D:\git\ground-control\extensions\ground-control\.vscode-test\vscode-win32-x64-archive-1.136.1\Code.exe" --open-url -- "%1"
```

**The archive build the integration tests download holds the scheme.** `npm run test:integration` launches it, and the key names it afterwards — so on a machine that has run those tests, a browser link is addressed to a throwaway VS Code rather than to the developer's install. The registration is per user, and the last VS Code to claim it wins.

**What the launch costs was measured; what it delivers was not.** `Start-Process "vscode://ownerrez.ground-control/…"` returned in **53 ms**, and four seconds later the only `Code.exe` processes running were the developer's install — none from `.vscode-test`. So the launched build does not stay up. Whether it forwarded the URL to the running instance or dropped it was not observed, and the registered command carries no `--user-data-dir`, which is what would make forwarding possible. Treat end-to-end delivery from a browser as unestablished until a link is watched arriving.

**`Code.exe --open-url` is not the same as `code --open-url`.** Called on the binary directly it is rejected — `Code.exe: bad option: --open-url` — while the `code` shim accepts it and returned in **1126 ms**. The registered command works because `ShellExecute` starts the app rather than the CLI. Only the shim form is safe to spawn, which is the form `resident.ts` uses.

**A handled URI reaches the extension, and what it carries reaches the hub.** In a real extension host, `executeCommand('vscode.open', Uri.parse('vscode://ownerrez.ground-control/open?session=…'))` routes to `window.registerUriHandler`; a well-formed id came back refused by name by the hub, and a malformed one was refused by the handler without the hub hearing of it. `onUri` is **not** auto-generated from the `registerUriHandler` call — the activation event is declared in `package.json`, or a link to a window that has not already activated the extension reaches nothing.

**Not measured: whether the navigation raises the window.** The rule it rests on is Windows', not VS Code's — the foreground process may pass foreground rights to a process it starts, which is why a click in Chrome can do what §26's hub child cannot. Confirming it needs the packaged extension installed and a browser genuinely in front, so it is a step in the manual checklist rather than a measurement here.

**Version-fragile**, and machine-state-fragile besides: any integration run re-points the registration, and a VS Code update re-points it back.

## 30. What the built-in Git extension will show, and what it will not

**Measured 2026-09-05, VS Code 1.136.1**, against `resources/app/extensions/git/dist/main.js` and `out/vs/workbench/workbench.desktop.main.js`, and exercised in a real extension host by `extensions/ground-control/test-integration/changes.test.cjs`.

**No built-in shows a branch's commits and its uncommitted work together.** `Repository.diffBetweenWithStats(a, b)` and `diffBetween(a, b)` build the range as `` `${a}...${b}` `` between two committishes and never see the working tree. `git.viewChanges` / `viewStagedChanges` / `viewUntrackedChanges` each open one resource group and never see a commit — and they call `_workbench.openScmMultiDiffEditor`, not the general command. `git.viewCommit(repository, hash)` is one commit against its first parent, the empty tree for a root commit. The union is assembled by the caller.

**`_workbench.openMultiDiffEditor` takes `{ multiDiffSourceUri, title, resources, reveal }`.** Each resource is `{ originalUri, modifiedUri }`, either side `undefined` for a file that does not exist there. Supplying `resources` makes them `initialResources`, which wins over any source resolver, so `multiDiffSourceUri` is only an identity key and its scheme need not resolve. **Private, version-fragile.**

**The editor appends its own file count to the title it is given** — `<title> (4 files)` — so a title that counts them says it twice. That suffix is the editor counting what it accepted, which makes it the one independent check that every resource landed.

**Only two-sided rows come back through `TabInputTextMultiDiff.textDiffs`.** Four resources went in and one entry came out: the modified file. An addition and a deletion each have one side and are not listed, though the label's count includes them. A test asserting the whole set through `textDiffs` reads three files as missing when nothing is.

**A `git:` URI is `uri.with({ scheme: 'git', path: uri.path, query: JSON.stringify({ path: uri.fsPath, ref }) })`.** The query is the whole address; the path carries the file only so the editor has a name and a language. The working-tree side is the plain `file:` URI — what the extension itself uses for a modified or untracked resource. **Private, version-fragile.**

**`Status` is frozen as** `INDEX_MODIFIED: 0, INDEX_ADDED: 1, INDEX_DELETED: 2, INDEX_RENAMED: 3, INDEX_COPIED: 4, MODIFIED: 5, DELETED: 6, UNTRACKED: 7, IGNORED: 8, INTENT_TO_ADD: 9, INTENT_TO_RENAME: 10, TYPE_CHANGED: 11, ADDED_BY_US: 12, ADDED_BY_THEM: 13, DELETED_BY_US: 14, DELETED_BY_THEM: 15, BOTH_ADDED: 16, BOTH_DELETED: 17, BOTH_MODIFIED: 18`. A `Change` carries `uri` as the path now and `originalUri` as the path before — but `originalUri` differs from `uri` for a **copy** as well as a rename, and a copy's original is a different file that still exists, so only `INDEX_RENAMED` and `INTENT_TO_RENAME` may be followed back.

**The index and the working tree answer different questions, and both are needed.** `indexChanges` is the index against HEAD; `workingTreeChanges` is the working tree against the index. A file staged as an edit and then deleted on disk appears in both, saying `INDEX_MODIFIED` and `DELETED` — measured. Reducing a path to one status keeps whichever was read last and loses the other, which is how a deleted file comes out as a row pointing at a file that is not there. Following the three ranges in order — `base...HEAD`, then the index, then the working tree — is what makes each file one row spanning the whole distance.

**Which group untracked files are in depends on `git.untrackedChanges`.** Under the default `mixed` they are in `workingTreeChanges` and `untrackedChanges` is empty; under `separate` they are only in `untrackedChanges`; under `hidden` they are in neither and nothing can show them.

**`git.openRepository` leaves the repository in the Source Control view for the life of the window,** and there is no matching call to undo it — `git.close` is a `{repository: true}` command a user runs, not a cleanup an extension can pair with the open. A window that opens ten worktrees this way shows ten repositories until it is reloaded.

**`git.openRepository` takes a path string, not a URI.** It is registered `{repository: false}`, so its argument is passed through raw to `model.openRepository(path, true, true)` — and those two `true`s are what skip the closed-repository check and the outside-the-workspace prompt that a worktree needs. With no argument it opens a folder picker.

**A repository VS Code has just opened has not read its own status.** Measured: immediately after `git.openRepository` returned, `state.workingTreeChanges`, `indexChanges` and `untrackedChanges` were all empty; three seconds later the untracked file was there. `await repository.status()` resolves once the groups have been rebuilt and is deterministic where a wait is not. **The uncommitted half of a diff silently goes missing without it.**

**A `{repository: true}` command's first argument is resolved by longest open-repository root prefix.** `createCommand` calls `model.getRepository(args[0])`, which accepts an internal `Repository`, an `ApiRepository`, a string path, a `Uri`, or a resource group — not a resource state. On a miss it falls back to `pickRepository`, which **throws when no repository is open and returns the single repository without prompting when exactly one is**. So a worktree that failed to open leaves a command running against the window's own clone, silently. Resolve the repository yourself and compare `rootUri` before running anything. **Version-fragile.**

**`getBranchBase` is not a merge base and is not free.** It takes a branch *name* — `HEAD` is not equivalent, because the reflog path interpolates the argument literally — returns a `Branch` rather than a commit, so `getMergeBase` is still needed after it, and it **writes `branch.<name>.vscode-merge-base` into the repository's config**. Reading what work has done must not change the checkout, so the base ladder here is `getMergeBase('HEAD', ref)` over `origin/HEAD`, `origin/main`, `origin/master`.

**The Source Control Graph cannot be pointed at a repository.** Its `_selectedRepository` defaults to `scmViewService.activeRepository`, and the only way to change it is `workbench.scm.action.graph.pickRepository`, which takes no arguments and opens a quick pick. `activeRepository` is derived from the active editor's original URI, and a multi-diff editor's resource is the `multiDiffSourceUri`, so opening one does not move it. Focusing the graph after opening a diff shows whichever repository was already selected.

**View ids and their focus commands.** `workbench.view.scm` opens the container; the workbench registers `` `${view.id}.focus` `` for every view, so `workbench.scm.focus`, `workbench.scm.history.focus` (the Graph) and `workbench.scm.repositories.focus` (Repositories) all exist. The Graph view carries `when: scm.historyProviderCount != 0` and its focus action no-ops silently when unavailable. `git.detectWorktrees` (default `false`, limit `git.detectWorktreesLimit`, 50) is the setting that opens a repository's worktrees on its own.

## 31. A classifier session can be run so the board never sees it

**Measured 2026-09-05**, against the installed `claude` CLI on this machine: four probes of the invocation, then two models over seven real cards. This is the mechanism card triage runs on (`prd.md` R38).

The invocation, at the directory the hub uses:

```bash
cd ~/.claude/ground-control
<prompt on stdin> | claude -p \
  --output-format json --json-schema '<schema>' \
  --no-session-persistence --setting-sources "" --session-id '<uuid>' \
  --strict-mcp-config --tools "" --system-prompt '<classifier>' \
  --model claude-sonnet-5
```

**It writes nothing the board reads.** Across all four probes `~/.claude/projects` held 2,001 `.jsonl` files before and after with none named for a probe session; `~/.claude/ground-control/activity` was unchanged; and `~/.claude/session-env` held 1,046 entries before and after. So `--no-session-persistence` suppresses the transcript *and* the per-session environment directory §3 records, and `--setting-sources ""` keeps the activity hooks out of a session that would otherwise fire them.

**It is listed by `claude agents --json`,** as §10 says a `-p` session is: `pid`, `cwd`, `startedAt`, `sessionId` and a directory-derived `name`, with no short `id`, no `status` and no `state`. **That shape is exactly what `neverPrompted` drops** — no transcript, no activity, no `status`, no `state` — so the Claude adapter filters such a session out before the hub sees it, and a classifier process orphaned by a killed hub cannot become a card either.

**`--setting-sources ""` is accepted** and is a stronger guarantee than naming sources hoped to be empty: no user, project or local settings load, so no hook entry at any level reaches the session. Naming sources instead would matter, because project and local settings resolve by walking up from the cwd, and `~/.claude/settings.json` — where the board installs its hooks — sits at an ancestor of any path under the home directory.

**The prompt goes on stdin.** Review-thread bodies run to 1–2 KB each and Windows caps a command line at 32,767 characters, so the evidence must not be an argv element.

**`--tools` is variadic,** so `--tools ""` parses only when a flag follows it.

**Cost is dominated by what is loaded, not by the prompt.** Same classification under Haiku, three invocations:

| Invocation | Input tokens | Wall | List price |
|---|---|---|---|
| `--restricted`, default system prompt, tools loaded | 55,175 | 11.8 s | $0.064 |
| `--tools ""` and an explicit `--system-prompt` | 2,243 | 5.2 s | $0.005 |
| plus `--setting-sources ""`, stdin, and the cwd above | **1,007** | **3.1 s** | **$0.003** |

The tool definitions and the default system prompt were the whole of the overhead — 55× the final input size.

**A profile name costs no extra round trip, and a bot has none.** `author` is an `Actor`, so `... on User { name }` inline on the author already being fetched returns the profile name in the same response: measured on this repository, `railapex` is `Chris Hynes`, `Turntwo` is `Jason Christian`. `claude` and `github-actions` are `Bot` rather than `User`, so the fragment resolves to nothing at all and the field is simply absent — which is what makes the login the natural fallback rather than a special case.

**`--json-schema` answers on `structured_output`,** already parsed, with the same JSON in `result` as a string.

**A real card takes 3 to 102 seconds, and the model decides that far more than the prompt does.** Ten Haiku classifications of cards on this team's board: 18.8, 23.5, 25.8, 27.4, 31.0, 39.3, 45.9, 55.8, 72.3 and 102.0 seconds. Prompt size does not predict it — the fastest of the ten carried the largest prompt, 29,291 characters, and one of 8,157 took 26 seconds. The synthetic one-sentence probe above is no guide either.

**Sonnet is an order of magnitude faster than Haiku here, against the direction of the price.** Seven cards, the same prompts: `claude-sonnet-5` ran 2.5, 4.0, 5.1, 5.8, 7.3, 7.4 and 23.8 seconds, where six of the same seven under `claude-haiku-4-5-20251001` ran 37.4, 38.6, 68.1, 76.6, 79.0 and 84.0. Sonnet classified all seven the way the developer would; Haiku, on the six it answered, missed one. Reading the card from GitHub is a rounding error against either: `gh` answered in 357 to 604 ms. `groundControl.triage.model` defaults to `claude-sonnet-5` on that evidence: a card is read once, so the several-fold price of the larger model buys both the speed and the reading, and a fifteen-card board is about a minute at two at a time rather than six to ten. The budget stays at 180 s covering fetch and classification together — a ceiling on a hang, not a figure either model approaches.

**`--model haiku` is not a documented alias.** The CLI's help names `fable`, `opus` and `sonnet`; `haiku` resolved to `claude-haiku-4-5-20251001` here, but an alias that silently resolves elsewhere changes cost and quality with no signal, so the full name is what gets passed.

**Version-fragile.** What `--setting-sources` and `--no-session-persistence` *do* is the whole of the invisibility; a flag that keeps its name and changes its meaning puts activity markers and transcripts back, and only re-measuring this section catches it.

## 32. What a card was told, and when — status and assignment on the issue timeline

**Measured 2026-09-05**, against `ownerrez/orez` and the project the board reads. This is what makes a state change evidence rather than a bare fact (`prd.md` R38).

**A status move is a timeline event, with everything the board needs on it.** `PROJECT_V2_ITEM_STATUS_CHANGED_EVENT` is a documented `IssueTimelineItemsItemType`, needs no preview header, and carries `createdAt`, `actor`, `previousStatus`, `status`, `wasAutomated` and `project { number }`. Asked for beside `ASSIGNED_EVENT` and `UNASSIGNED_EVENT` on the issue the board is already reading, it costs no extra round trip:

```graphql
timelineItems(last:100, itemTypes:[ASSIGNED_EVENT, UNASSIGNED_EVENT, PROJECT_V2_ITEM_STATUS_CHANGED_EVENT]){ nodes{
  __typename
  ... on AssignedEvent{ createdAt actor{ login ...profile } assignee{ ... on User{ login } } }
  ... on ProjectV2ItemStatusChangedEvent{ createdAt actor{ login ...profile } previousStatus status project{ number } }
}}
```

`actor` is an `Actor`, so §31's `... on User { name }` fragment resolves the profile name on the same field. An issue sits on as many projects as anybody adds it to, so the events must be filtered on the project number the board reads — another team's column names say nothing about this card.

**`wasAutomated` does not mean what its name suggests.** Every project item's opening status event is written by the `github-project-automation` account with `previousStatus: ""` — and `wasAutomated: false`. Measured on three issues, all three. So the flag is no guide to whether a person moved a card. **The empty `previousStatus` is**: it is the item being added to the board, and it is the only event that carries one. That shape is what the board matches on, because the automation's login is a repository setting where the shape is not — and a scrubbed fixture renames the login while keeping the shape.

**One act arrives as several events, seconds apart, and two acts can share a status.** Issue #19209's hand-over is three writes inside six seconds, all by the same person:

```
17:46:29  railapex assigned jon-or
17:46:32  railapex unassigned buildfriday
17:46:35  railapex moved ⚒️ Dev → 🔍 Dev Review
```

Issue #19192's is not:

```
13:53:36  mayur      moved ⚒️ Dev → 🔍 Dev Review
13:53:44  mayur      unassigned mayur
16:28:42  eesquibel  assigned jon-or          ← 2h 35m later, a different person
```

Both are one instruction — *review this* — but the second reaches the board as two acts, and its later one carries no status at all. So what the card is now and when it was last told something are separate reads: the instruction time is the most recent event of any kind, the status it was moved *out of* comes from the most recent event that moved one, and the status it is now is the card's own — a project option renamed since rewrites every event that names it. A rule keyed on the latest event alone sees a bare assignment on #19192 and nothing else.

**`ProjectV2ItemFieldSingleSelectValue.updatedAt` tracks the Status value alone.** On #19192 it reads `2026-09-04T13:53:36Z` — exactly the status event — and eesquibel's 16:28 assignment left it where it was. It rides the cheap board query rather than the per-card one, which is what lets a status move make a card due to be read again without fetching a timeline for every card on the board. That it moves for the Status value **only** is what stops the re-read rule spending money on its own: were it to move on an unrelated write, every card would be re-read once per board refresh. Measured here on three issues; re-measure it before trusting a board that suddenly costs more than it did.
## 33. A dispatched session is `--bg`, and the caller cannot name it

**Measured 2026-09-05**, against `claude` 2.1.261 on this machine. This is the mechanism card actions run on (`prd.md` R39).

```
claude --bg --permission-mode <mode> -n <name> "<prompt>"
→ stdout: backgrounded · 46af2ac8 · gc-slash2
→ stderr: Starting background service…
```

**`--bg` ignores `--session-id`.** It prints `warning: --bg manages the session id; ignoring --session-id (use --resume <id> to continue an existing session)` and mints its own. So a dispatch cannot recognise its run the way a classification does (§31) — the id has to be read back out of what the CLI printed.

**What it prints is the short id, and the short id is a prefix.** `backgrounded · 46af2ac8 · gc-slash2` on stdout, then four help lines; `Starting background service…` goes to stderr, so stdout alone is what gets parsed. `claude agents --json` then lists the session as `kind: "background"` carrying both — `id: "46af2ac8"` and `sessionId: "46af2ac8-f232-4406-8e8f-2579df5eb08f"` — so the full id resolves by prefix off the next roster read, and the roster is what the board already reads every 30 s.

**A prompt beginning with `/` is resolved as a slash command.** Dispatching `/gc-nonexistent-probe hello` wrote two `system` entries to the transcript: `Unknown command: /gc-nonexistent-probe` and `Args from unknown skill: hello`. That is what makes the prompt a setting rather than a template — a developer names the skill their own repository already carries.

**A shell would silently destroy that.** The same prompt sent through Git Bash arrived as the user message `C:/Program Files/Git/gc-nonexistent-probe hello`: MSYS rewrites a leading `/name` into a filesystem path, the slash is gone, and the command becomes prose no skill answers. `runJsonCli` spawns with an argv array and never a shell, and refuses a `.cmd` shim by name rather than reaching for one, so the hub is already on the right side of this — the rule is that it stays there.

**An unknown command is a session that starts and does nothing.** The probe's transcript holds the two warnings and no user message at all: no turn, no work, and a roster entry at `status: idle` almost at once. A mistyped prompt does not fail loudly — it produces a live session that never worked, which is why an action's outcome is read from the file the run was told to write rather than from the session having ended. A run that never ran writes nothing, and nothing reads as stopped short.

**A bare `--bg` runs under `permissionMode: "auto"`,** recorded in the transcript's own `permission-mode` entry. That is not the conservative setting R31 asks for as a default, so the mode is passed explicitly on every dispatch rather than left to the CLI.

**`claude stop <short-id>` answers `stopped <short-id>`** and the session leaves the roster. `claude rm` is never used: its help says it deletes the session "and its worktree when that is safe", and a card's checkout holds the developer's work.

**Version-fragile.** The id-bearing stdout line and `--bg`'s refusal of `--session-id` are both undocumented shapes; a release that changes either leaves a dispatch that runs and cannot be tracked.

## 34. An output channel can be shown, and cannot be asked whether it is

**Read 2026-09-06 from `@types/vscode@1.134.0`, the surface this extension compiles against (`engines.vscode: ^1.104.0`).** `OutputChannel` declares eight members — `name`, `append`, `appendLine`, `replace`, `clear`, `show` (two overloads), `hide`, `dispose` — and nothing else. `LogOutputChannel` adds seven: `logLevel`, `onDidChangeLogLevel`, and the `trace`/`debug`/`info`/`warn`/`error` writers.

There is no `visible`, and no `onDidChangeVisibility`. Nothing tells an extension that a developer opened its channel, switched away from it, or closed the panel it lives in — the whole surface is write and reveal.

That is what makes the board's hub-log item an explicit toggle rather than a subscription that follows the pane. A channel the developer is looking at and one they are not are indistinguishable from inside the extension, so the state has to be something the board holds and paints, and turning it off has to be an act rather than a consequence of looking elsewhere.

`show(preserveFocus)` reveals the channel in the output panel; `show(true)` leaves focus where it was, which is what a button on the board wants. Nothing here calls `hide()` — what it does to a panel holding a terminal or a problems view has not been measured, and a control that turns streaming off has no need to take the panel away as well.

**A line below the channel's level is dropped, not held.** Each writer is declared as logging "only if the channel is configured to display" that level or lower, and `logLevel` "Defaults to the editor log level" — which the editor's own default is Info, though that number is read off the product rather than measured here, and whether a line below the level can be recovered by raising it afterwards is not stated either way. Neither uncertainty changes what a client should do: writing the connection story at `info` puts it in the pane whatever the default turns out to be, and leaving the line-per-message wire at `debug` costs nothing if it is dropped. A pane that says nothing to whoever opens it after a stall is the failure to avoid.

**Version-fragile**: a release that adds a visibility event would let the subscription follow the pane instead — re-check this before assuming the button has to carry state.

## 35. GitHub's own tooltip, and why neither board uses `title`

**Measured 2026-09-07, Chromium 151.0.7922.34 (Playwright 1.62.1) on Windows 11, against `https://github.com/orgs/nodejs/projects/14` — a public board whose cards carry assignees.**

GitHub does not use the browser's tooltip anywhere on its board. Its own is a Primer `TooltipV2`: a `<span data-component="Tooltip" popover="auto">` sitting beside what it names, with every class on it hashed per build. What is worth writing down is the shape, because that is what both boards copy:

| | |
| --- | --- |
| Background / colour | `var(--bgColor-emphasis)` — `#25292e` light, `#3d444d` dark — on `var(--fgColor-onEmphasis)`, white in both |
| Type | 12px, weight 400, line-height 19.5px (1.625) |
| Box | `4px 8px` padding, `6px` radius, no border, no shadow, no arrow (`::before` is `content: none`) |
| Width | `max-content`, capped at `250px`, then `white-space: normal` with `overflow-wrap: break-word` |
| Alignment | `text-align: center`, centred on the anchor to the pixel |
| Placement | 4px clear of the anchor, above it where there is room and below where there is not — `data-direction` reads `n` or `s` |
| Timing | opens **120ms** after the pointer arrives, with a 0.1s `opacity: 0 → 1` fade and nothing else |

The editor board keeps the geometry and the timing and takes its colours from `--vscode-editorHoverWidget-*` instead, with the 1px border and the shadow those imply: GitHub's pill is borderless because it sits on a light board, where a `#202020` pill on a `#1f1f1f` editor would have no edge at all.

The native tooltip matches none of that: it opens after about a second, in the operating system's shape rather than the page's, and no stylesheet reaches it. So neither board sets `title` on anything it draws — nor an SVG `<title>` child, which draws the same tooltip from inside a glyph and, on a row that already carries one, draws two at once. The webview suite counts `[title], title` across the whole document; the overlay's counts them before and after a paint and requires the number not to move, since GitHub's own markup carries `title` of its own.

**Both boards copy the shape rather than the mechanism.** GitHub's tooltip is a node per anchor, kept in the top layer by `popover` and placed by CSS anchor positioning; Chromium supports both, and the board uses neither. A scan replaces every card, so a node per anchor would be built and discarded by the hundred — and jsdom implements no `showPopover`, which would put the real path outside the only suite that can reach it. Instead there is one element per document, moved and re-worded, held in front by `position: fixed` and `z-index`, and placed by `placeTip` — the lane menu's `place` hangs a panel from an anchor's left edge, where a tooltip is centred on it. `position: fixed` is enough because nothing above a card on GitHub's board carries a `transform`, `filter` or paint `contain` — measured, and the thing that would trap it. The board's columns clip with `overflow`, which does not.

**The text lives in an attribute, not in a child.** `data-gc-tip` on the anchor, read by one delegated `mouseover` handler. A child would be part of the anchor's `textContent`, and both boards have labels that read their own — a session row builds its tooltip out of the name beside it. Listeners are on the document rather than on each element for the same reason a node per anchor was rejected: `mouseover` bubbles where `mouseenter` does not, so one pair of handlers survives every rebuild.

**Four things a hover tooltip has to get right, every one found by measuring rather than reading.** A pointer that leaves inside the 120ms delay must cancel it — the anchor is held from the moment the pointer arrives, not from when the tooltip opens, or it opens over something already left behind. `mouseout` fires between an anchor's own children, so leaving is `relatedTarget` being outside the anchor rather than the event alone; without that the tooltip shuts and reopens as the pointer crosses what it is describing. Opening one must add and remove no nodes: appending the element and writing `textContent` were **two `childList` records per hover**, measured, and the overlay's scan observer schedules a rebuild off exactly those — so the element is built inside the disarmed paint and its text written through a node of its own with `nodeValue`. And the anchor is checked for `isConnected` both when the tooltip is about to open and after every rebuild, because a detached one measures zero at the origin and draws the tooltip in the corner of the window naming a card that is gone.

**The flip is not a rescue on its own.** Below is as unreadable as above when neither fits, so the placement is clamped to the window on both axes after the side is chosen — a tooltip long enough to wrap, on an anchor near the bottom, is otherwise drawn off the edge by the very flip meant to save it.

**Accessibility: the words are on the anchor, in `aria-description`.** Not `aria-describedby` pointing at the shared element — that can only be written as the tooltip opens, which is 120ms after focus was announced and therefore never heard, and it leaves a reader in browse mode nothing at all on the anchors that cannot take focus, which is most of them. `aria-description` is on the anchor from the moment it is drawn, exactly as `title` was. Measured in the same Chromium: it is exposed as the accessible description on a non-focusable `<span>` as well as on a button, and `aria-describedby` overrides it where both are present. Both boards run in Chromium — one in Chrome, one in the editor's own — which is what makes it usable here.

Where the element is already named for a reader the description is left off, or the name and the description are the same words and both are announced: `tip` skips it when an `aria-label` is present, `nameFor` takes it back off when the label comes second, and both suites assert that nothing carries both.

**What it does not do is stay open while the pointer is on it** (WCAG 1.4.13 "Hoverable"). `pointer-events: none` is what stops the tooltip taking the hover it is explaining; the cost is that a magnifier user cannot travel onto a wrapped one to read it. GitHub's own tooltip behaves the same way, and `title` — which this replaces — is exempt from that criterion as user-agent content rather than meeting it.

**Version-fragile**: re-verify the palette and the 120ms after a GitHub board release.

## 36. The theme kind reaches a webview as a class on its body

**Measured 2026-09-07 against VS Code 1.136.1 on Windows 11, reading `resources/app/out/vs/workbench/contrib/webview/browser/pre/index.html`. Version-fragile.**

The webview preload's `applyStyles` removes and re-adds one of `vscode-light`, `vscode-dark`, `vscode-high-contrast`, `vscode-high-contrast-light` on `body.classList`, alongside `vscode-reduce-motion` and `vscode-using-screen-reader`. It is the only thing in a webview that says which kind of theme is on: the injected `--vscode-*` variables carry colours and no classification, and `prefers-color-scheme` follows the operating system rather than the editor.

**Why the board needs it at all.** Every other surface it draws is derived with `color-mix` against a theme variable, which needs no classification because mixing the foreground in moves away from the background in whichever direction the theme runs. One thing does not survive that treatment: an equal *ratio* of recess costs a wildly different step depending on how dark the ground is. 3% of black over `#ffffff` is eight levels and 1.07:1; 3% over `#1f1f1f` is one level and 1.01:1. The lane is the board's one recessed surface (`prd.md` R5), so its depth is 3% under `.vscode-light` and 30% under `.vscode-dark`, which lands on 1.07:1 and 1.10:1 against GitHub's own 1.06:1 and 1.09:1.

A high-contrast theme takes the light figure and so gets no usable recess on a black ground - deliberately. Those themes separate by border, which the card already has, and a tint over a pure-black ground is the thing forced colours drop anyway.

## 37. GitHub's own card: what a label pill is made of

**Measured 2026-09-07, Chromium via Playwright, against `https://github.com/orgs/github/projects/4247/views/21` in its board view, unauthenticated, in both colour schemes. Version-fragile: these are Primer's own values, and a Primer release moves them.**

A label on a project card is `button[aria-label^="Label: "]` — a Primer `IssueLabel` token. Its geometry is one set of numbers in both schemes, and its colour is two different recipes:

| | Light | Dark |
| --- | --- | --- |
| Height | 20px | 20px |
| Font | 14px, weight 400, line-height 18.2px | same |
| Padding | 1px 8px | same |
| Radius | pill | same |
| Text | `#000000` | the label's colour at full strength |
| Fill | the label's colour, opaque | the label's colour at **18%** |
| Border | 1px, transparent | the label's colour at **30%** |

The label's raw channels arrive as inline custom properties on the button — `--label-r/g/b` and `--label-h/s/l` — which is how one recipe serves any label colour.

**Only the dark recipe transfers.** A board whose palette comes from the editor's theme has no lightness math to fill a pill opaquely and pick a legible text colour for it, and a solid `--vscode-charts-red` under black text is unreadable. So the VS Code board draws the tint recipe in both schemes and takes the 18%/30% figures from the dark column.

Three more numbers off the same card: the label row is `gap: 4px` and sits `8px` under the title; the card's content is inset **12px** at the sides; and the number above the title is **12px, weight 400**, in Primer's UI font (`Mona Sans VF`) rather than a monospace one, coloured `#9198a1` on dark against a `#f0f6fc` title. GitHub's title is **14px weight 400** — its hierarchy over the number is carried by colour alone, where this board's `--vscode-foreground` is a dimmer `#cccccc` and needs weight 600 as well.

## 38. GitHub says which theme it is in on the document element, and its text pair

Measured 2026-09-07 with Playwright against `https://github.com/orgs/github/projects/4247/views/21`, unauthenticated, in both colour schemes. Version-fragile: these are Primer tokens and a GitHub attribute, and either can be renamed.

**The scheme is an attribute, not a media query.** `<html>` carries `data-color-mode`, `data-light-theme` and `data-dark-theme`. `data-color-mode` was `auto` on both runs, with `data-light-theme="light"` and `data-dark-theme="dark"` — so under `auto` the page follows the operating system and `prefers-color-scheme` is right, but a developer who picks a theme explicitly gets `data-color-mode="dark"` or `"light"` and the media query would then be wrong. Anything that has to know the scheme reads all three states: the two explicit values, and `auto` deferring to `prefers-color-scheme`.

**The text pair, and where a session name sits in it.**

| token | light | dark |
|---|---|---|
| `--fgColor-default` | `#1f2328` | `#f0f6fc` |
| `--fgColor-muted` | `#59636e` | `#9198a1` |
| `--fgColor-success` | `#1a7f37` | `#3fb950` |
| `--fgColor-attention` | `#9a6700` | `#d29922` |
| `--borderColor-default` | `#d1d9e0` | `#3d444d` |
| `--bgColor-default` | `#fff` | `#0d1117` |

A session name is 55% of `--fgColor-default` over `--fgColor-muted`, which resolves to `#394047` light and `#c5ccd3` dark. That is the closest either board gets to the other on this element: VS Code's `--vscode-foreground` is `#3b3b3b` in Light Modern and `#cccccc` in Dark Modern, so the two boards land within a few units per channel and a row reads the same on both.

**The attention pair is a foreground pair, not an emphasis pair.** `--bgColor-attention-emphasis` (`#bf8700` light, `#9e6a03` dark) is a surface colour, and a ring drawn in it sits a visible shade off the words it rings, which take `--fgColor-attention`. Using the foreground token for both puts them on one colour and lands within a few percent of the chart colours the editor board takes for the same two states — `--vscode-charts-yellow` is `#cca700` in Dark Modern against `#d29922`, and `--vscode-charts-blue` is `#3794ff` against `--fgColor-accent`'s `#4493f8`.

## 39. Codex has no live session roster on this platform

Measured 2026-09-07 with `codex-cli 0.153.0` on Windows 11. Version-fragile: the daemon is behind `[experimental]` and the platform gate is the CLI's own.

There is no counterpart to `claude agents --json`.

- `codex agents` answers "`codex agents` requires `--remote` on this platform". It is a TUI over the shared app-server daemon, and takes no `--json`.
- `codex app-server daemon start|stop|version` answers "codex app-server daemon lifecycle is only supported on Unix platforms".
- `codex app-server proxy` answers "failed to connect to socket at `C:\Users\<user>\.codex\app-server-control\app-server-control.sock`" — the control socket the daemon would have created.

`codex app-server` itself runs fine over stdio, and its JSON-RPC protocol has everything a roster needs — but only for threads that server owns. The handshake is `initialize` with `{clientInfo:{name,version}, capabilities:{experimentalApi:true}}` and then an `initialized` notification, newline-delimited JSON both ways. Against the developer's real `~/.codex`, with five `codex.exe` processes running and a Codex panel open in VS Code:

- `thread/loaded/list` answered `{"data":[],"nextCursor":null}`. It lists what *this* server holds in memory, so another process's live threads are invisible.
- `thread/list` answered with every saved thread, each carrying `status:{"type":"notLoaded"}` — including the ones running in the editor.

So liveness cannot be read out of Codex at all: the hook markers are the roster, and the pid in each marker is the evidence (§40). The VS Code extension `openai.chatgpt` spawns its own `codex app-server` (`-c features.code_mode_host=true app-server --analytics-default-enabled`) against the same home, which is why a second server sees its threads only as saved history.

`thread/list` is a complete history source, and a richer one than the rollout files: `id`, `preview`, `name`, `cwd`, `createdAt`, `updatedAt`, `recencyAt`, `path`, `cliVersion`, `source`, and `gitInfo: {sha, branch, originUrl}`. It costs a process spawn and a handshake per read, which is why the file reader in §42 is what the adapter uses.

The protocol also carries `turn/start`, `turn/steer`, `turn/interrupt`, `thread/resume`, `thread/fork`, `thread/archive`, `hooks/list` (§41), and the server-to-client approval request `item/commandExecution/requestApproval` with `{reason, command, itemId, threadId, turnId}`, answered `{"decision":"accept"}`.

## 40. Codex hooks are its only session signal, and they carry no pid

Measured 2026-09-07 with `codex-cli 0.153.0`, by installing a probe hook on every event in an isolated `CODEX_HOME` and driving real sessions through `codex exec` and `codex app-server`. Version-fragile, and the most fragile section here: the hook payload is not a documented contract.

**The events.** `hooks/list` reports twelve: `preToolUse`, `permissionRequest`, `postToolUse`, `preCompact`, `postCompact`, `sessionStart`, `sessionEnd`, `userPromptSubmit`, `subagentStart`, `subagentStop`, `stop`, `interrupt`. The keys in `hooks.json` are PascalCase (`SessionStart`), `hooks/list` reports them camelCase, and the payload's own `hook_event_name` is PascalCase.

**The payload is Claude-shaped**, on stdin as one JSON object. Every event carries `session_id`, `transcript_path`, `cwd` and `hook_event_name`; `SessionEnd` carries nothing else but `reason`, and every other event adds `model` and `permission_mode`, plus `turn_id` where it belongs to a turn. Then per event: `source` on `SessionStart` (`startup`), `prompt` on `UserPromptSubmit`, `tool_name`/`tool_input`/`tool_use_id` on `PreToolUse`, `tool_name`/`tool_input` on `PermissionRequest` — with the human question in `tool_input.description` — `tool_response` as well on `PostToolUse`, `stop_hook_active` and `last_assistant_message` on `Stop`, and `reason` on `SessionEnd` (`other`).

**One approval, in order:** `PreToolUse`, `PermissionRequest`, the decision, `PostToolUse`. Over the app-server the same gate shows as `thread/status/changed` moving to `{"type":"active","activeFlags":["waitingOnApproval"]}` and back. `permission_mode` was `default` under `approval_policy=on-request` and `bypassPermissions` under `--dangerously-bypass-approvals-and-sandbox`.

**Codex runs a command hook through a shell**, so a `node` writer's parent is `pwsh.exe`/`powershell.exe` and Codex's own process is its *grandparent*; the same grandparent pid appeared on every event of one session. No environment variable carries it — the only `CODEX_*` variable in a hook's environment is `CODEX_HOME`. `(Get-Process -Id $pid).Parent` costs 20 ms but is PowerShell 7's and absent from 5.1; `Get-CimInstance Win32_Process` costs 250 ms per hop and works on both, so the writer walks with CIM and copies the pid forward onto every later marker. A walk that finds nothing is retried on the next event that may create a marker — a session's start or a prompt — and never on a tool call, because the walk must not sit between reading a marker and replacing it.

**Hooks fire concurrently.** `SessionStart` and `UserPromptSubmit` landed in the same millisecond, and one writer's `renameSync` over the other's marker failed on Windows — leaving a `<id>.json.<pid>.tmp` orphan and losing an event. The writer retries that rename for about 200 ms and deletes its temporary file if it never lands.

**A killed process fires no `SessionEnd`.** `SIGKILL` on an app-server mid-turn left the marker behind with no further events. That is why marker presence is not liveness, and why the pid is what the roster tests.

**What the pid does not settle.** A pid is not an identity: an operating system reuses one, so a marker whose Codex process was killed reads as live again once something else takes its number. Nothing cheap corroborates it — the walk's own `CreationDate` would, at a CIM query per session per poll — so the bound is the marker sweep, and a phantom card is possible until it runs.

## 41. Codex will not run a hook it has not been told to trust

Measured 2026-09-07 with `codex-cli 0.153.0` in an isolated `CODEX_HOME`. Version-fragile: neither the trust key nor its hash is a documented format.

A newly written `hooks.json` entry is inert. `hooks/list` reports each entry with `trustStatus: "untrusted"` and a `currentHash` (`sha256:…`), and none of them ran: under `codex exec` the entries fired only with `--dangerously-bypass-hook-trust`, which also writes an error item into the session.

Trust is a `config.toml` block per entry, keyed by the entry's own key:

```toml
[hooks.state.'C:\Users\<user>\.codex\hooks.json:session_start:0:0']
trusted_hash = "sha256:3db5a9dec1d643707b7cf51346b2d258cf03dec8c39793b89bd77c0b8faf1bf3"
```

Writing back the `currentHash` that `hooks/list` reported flipped all twelve entries to `trusted`, and they then fired with no flag at all. The key is `<hooks file>:<snake_case event>:<group index>:<entry index>`, and `trustStatus` has four values — `managed`, `untrusted`, `trusted`, `modified` — so changing a command re-arms the prompt.

**The hash is not reproducible outside Codex.** Measured 2026-09-07 against four entries this machine had already trusted: sha256 over the command string, over the entry object in several key orders and with the defaults `hooks/list` reports, over the group, over the event array, over the whole file, and over the key concatenated with the command — seventeen candidates, no match.

**Codex will hand over the hash and write the trust itself.** Measured 2026-09-08 with `codex-cli 0.153.4`. `codex app-server` speaks newline-delimited JSON-RPC on stdio, and `CODEX_HOME` selects the home it reads. After `initialize` (`clientInfo` required, `capabilities.experimentalApi: true`), `hooks/list` with empty params answers per working directory: each hook carries `key`, `command`, `currentHash`, `trustStatus`, and `sourcePath`. Feeding those hashes back through `config/batchWrite` — one edit of `{keyPath: 'hooks.state', mergeStrategy: 'upsert', value: {<key>: {trusted_hash: <hash>}}}` — flipped every entry to `trusted` on a re-list, and Codex wrote its own `config.toml`: on a 96-line file the change was 36 appended lines and nothing else touched. `mergeStrategy: 'upsert'` is what preserves trust blocks already there. A `codex exec` then reported `hook: UserPromptSubmit Completed` and `hook: Stop Completed`, and the marker directory's mtime moved — so the whole path from install to marker needs no prompt answered by hand.

**The response is per working directory, not per file.** `hooks/list` keys each entry by the absolute path of the file it came from, in that platform's own separators and case — which is not the spelling a caller joined, so a comparison normalises both.

**Hooks fire for a session hosted by the ChatGPT VS Code extension.** Measured 2026-09-07: the extension runs its own bundled `codex.exe … app-server`, and a `~/.codex/hooks.json` entry fired for a thread started in the editor, reporting the same id `session_index.jsonl` names it by. So the marker roster covers editor-hosted threads, not only `codex exec` and the interactive CLI.

**Two entry fields do not survive as written.** `timeout` is clamped to 3 s on `SessionEnd` and `Interrupt`, and a longer one is reported as an error item in the developer's own session on every start, which is why those two entries ask for 3. And `async: true` is honoured on eleven events but reported back as `false` on `sessionEnd`: Codex has to run that one before it exits, so the work there must stay a single unlink.

An entry's shape is `{"hooks":{"<Event>":[{"hooks":[{"type":"command","command":"node \"<path>\"","async":true,"timeout":5}]}]}}`. Codex takes the whole command as one string — there is no `args` array — and `matcher`, `enabled` and `isManaged` are the other fields `hooks/list` reports.

**Codex does not rewrite the file.** After a real session against a home the board had installed into, `hooks.json` was byte-identical and its modified time had not moved; the plan read it back as up to date, and every entry was still `trusted`. So the fields `hooks/list` reports beyond what the board writes are Codex's view of an entry rather than something it persists, and an install converges on its second run instead of rewriting the file — and re-arming the trust prompt — on every board open.

## 42. Where Codex saves a thread

Measured 2026-09-07 with `codex-cli 0.153.0` against `~/.codex` on this machine. Version-fragile: the rollout record is not a documented format.

Rollouts live at `~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<session id>.jsonl`, and the first line is a `session_meta` record carrying `session_id`, `timestamp`, `cwd`, `originator` (`codex_vscode`), `cli_version`, `source` (`vscode`), and `git: {commit_hash, branch, repository_url}`. That line measured 8–78 kB across all fifteen rollouts on this machine, because the model's whole instruction text is inline and grows with the plugins and skills a session loaded. A head read has to be large enough to hold it whole, and a reader whose bound is too small must say so rather than read the file as holding no session: two of the fifteen are over 50 kB.

`~/.codex/session_index.jsonl` is one `{id, thread_name, updated_at}` per line and holds only threads Codex has named: five lines against twenty rollouts on disk. So it is the title source and never the roster.

The cwd is inside the file rather than in a directory name, so there is no slug rule to reproduce — and no equivalent of Claude's project directory to scan per checkout.

## 43. The Codex VS Code extension's surfaces

Measured 2026-09-07 by reading `openai.chatgpt-26.901.22334-win32-x64`. Version-fragile: these are one extension version's identifiers.

- Editor-tab webview: `panelViewType = "chatgpt.panelView"`, a static in the bundle. It is **not** what a thread tab carries — that is `chatgpt.conversationEditor`, measured in §44, and it is what a placement row keys on.
- Sidebar webviews: `chatgpt.sidebarView` and `chatgpt.sidebarSecondaryView`, one or the other registered per VS Code version.
- Commands: `chatgpt.openSidebar`, `chatgpt.newCodexPanel`, `chatgpt.newChat`, `chatgpt.openCommandMenu`, `chatgpt.implementTodo`, `chatgpt.addToThread`, `chatgpt.addFileToThread`. None takes a thread id — a thread is opened as a resource instead, which §44 measures.
- `contributes.customEditors`: `chatgpt.conversationEditor`, selector `openai-codex:/**/*`. This is the reveal (§44).
- `chatSessions` contributes the session type `openai-codex`, which is what makes VS Code's own `workbench.action.chat.openSessionWithPrompt.openai-codex` and its siblings exist. Not measured here; §44 uses the resource instead.

## 44. A Codex thread is an editor resource, and that is how one is opened

Measured 2026-09-07 with `codex-cli 0.153.4` and VS Code extension `openai.chatgpt` **26.901.22334**, in a real window. Version-fragile: the scheme, the view type and the memento shape are one extension version's.

**The reveal.** A thread is not a webview holding an id — it is a resource with a custom editor registered for it. `contributes.customEditors` declares `chatgpt.conversationEditor` with the selector `openai-codex:/**/*`, and `resolveCustomEditor` requires scheme `openai-codex`, authority `route`, and a path of `/local/<id>` or `/remote/<id>`. So the call is VS Code's own:

```js
vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(`openai-codex://route/local/${threadId}`))
```

The Codex extension makes the same call on itself — its `createNewPanel` is `vscode.openWith` on `openai-codex://route/extension/panel/new` — which is why this is the supported shape rather than a trick.

What it does, measured: a tab appears carrying the thread's **own title**, which is the thread id itself until the extension has loaded one; a second call **re-activates the same tab** rather than forking a surface, which is the opposite of Claude's behaviour (§6); and a thread whose rollout records `d:\git\ground-control` opened correctly in a window rooted somewhere else — **the recorded directory does not constrain where a thread can be opened**. Corroborated by the thread's writer-lock mtime moving, and by the IPC router below answering `no-client-found` for that thread before the call and naming a client after it.

**Two things the call will not tell you.** `vscode.open` resolves whether or not anything rendered — measured in a profile with the Codex extension absent, where it still resolved. And VS Code opens *a* tab for the resource anyway, with nothing to render it. So a reveal that counted tabs by URI would call that a success: what tells a real reveal from it is counting tabs whose `viewType` is the agent's own.

**Which thread a tab holds.** In `memento/workbench.parts.editor`, at the same nesting as Claude's (§21) — the editor grid, each tab `{id, value}` with `value` a JSON string parsed a second time. The Codex entry's outer id is `workbench.editors.webviewEditor` where Claude's is `workbench.editors.webviewInput`, and inside:

| | Codex | Claude |
|---|---|---|
| `providedId` | `chatgpt.conversationEditor` | `claudeVSCodePanel` |
| `viewType` | `chatgpt.conversationEditor` | `mainThreadWebview-claudeVSCodePanel` |
| the id is in | `editorResource.path` = `/local/<id>` | `state` (a JSON string) → `sessionID` |
| `state` | absent | present |

`editorResource` is a marshalled URI (`$mid: 1`): read `path`, not `fsPath` (Windows separators) and not `external` (percent-encoded). Discriminate on `providedId`; the outer id is not needed.

**When it lands.** The tab appeared in the memento **47 s** after the reveal, with the window still open — VS Code's own storage flush cycle, the same one Claude's rides (§21), with no Codex-specific trigger. So absence is "not flushed yet", never "no session".

**A sidebar thread is invisible.** `memento/webviewView.chatgpt.sidebarSecondaryView` is `{}` — 2 bytes — whatever the sidebar is showing, and the thread never appears in the editor memento either. The only other key the extension writes is `workbench.view.extension.codexSecondaryViewContainer.state`, which carries `{"chatgpt.sidebarSecondaryView":{"collapsed":…,"isHidden":…}}` and names no thread; it is recorded in `codex-tab.json` so that stays checkable. Claude's sidebar carries `sessionID`; Codex's carries nothing. The editor tab is the only readable surface, and which window holds a sidebar thread is read from the thread's own process instead (§47).

**Starting one.** `chatgpt.implementTodo` is declared as taking no arguments, and its runtime handler reads `{fileName, cwd, line, comment}`: it starts a thread on **the caller's `cwd`**, auto-submits, and navigates the sidebar to it — measured, with a real rollout carrying the supplied directory and the model's reply. The prompt is wrapped in a fixed "implement the comment on `<file>:<line>` … then remove it" template, and the result lands in the sidebar, which is the one surface nothing can read back. `chatgpt.newCodexPanel` opens an empty panel.

**What is not there.** `vscode.extensions.getExtension('openai.chatgpt').activate()` resolves to `undefined`, so there is no extension API (the same dead end as Claude, §22). `vscode://openai.chatgpt/local/<id>` and `/c/<id>` fired at a window **never resolved** — two calls left pending for over ten minutes with no tab and no error — so there is no deep link a client resident in nothing can use. And nothing on disk says which window holds which thread: `~/.codex/thread-writer-locks/<threadId>.lock` names the thread being written, never the window writing it — the process running it does (§47).

**The router the extension runs: `\\.\pipe\codex-ipc`.** Undocumented (`~/.codex/ipc/ipc.sock` on POSIX), framed as a uint32LE byte length then JSON, opened with `{type:'request', requestId, method:'initialize', params:{clientType}}` → `{result:{clientId}}`. Two requests matter: `thread-owner-discovery` (`{hostId:'local', conversationId}`, version 1) answers with the client id of the window that has the thread loaded when it answers at all — a day later it answered `no-client-found` for every thread on the machine (§47) — and `ide-context` (`{workspaceRoot}`) is answered only by a window whose folders contain that root — though the match is a **prefix**, so a parent-folder window answers too and the fastest wins, which makes it a hint rather than a key. It also broadcasts `thread-stream-following-changed`, `thread-stream-state-changed` and `client-status-changed` unsolicited. A client that connects must answer `client-discovery-request` with `{canHandle:false}` or it stalls other windows' untargeted requests for ten seconds.

## 45. Handing a session to the window that was just raised

Measured 2026-09-07, VS Code 1.136.1.

An agent whose extension answers no URI cannot be reached in another window the way Claude's is (§7): the board raises the window and then has nothing to fire into it. Codex is that agent — its deep links never resolved (§44).

**The board's own URI is the way in**, because Ground Control is installed in every window: `vscode://groundcontrol.ground-control/open?session=<id>&agent=<agent>&hop=1`. The window that receives it reveals the session itself instead of asking the hub to plan it again.

Three things this rests on, and where each comes from.

- **A URI fired after raising a window lands in that window.** §7's third row measured exactly this shape — a fire immediately after `code <folder>` landed in that folder's window. The rule is VS Code's own routing, not the agent's, so it carries over; it has not been re-measured for the board's own URI.
- **A handed-over request is never routed onward.** Measured in a real extension host: a URI carrying `hop=1` reaches the handler and goes to the hub, which answered — an unknown id came back refused by name, as it does for a plain link. The hub plans it with every check it makes and refuses to send it to a third window, which is what a hand-over needs, because the surface record a plan reads can be up to a minute old (§44) and this link is reachable from any page in the browser.
- **The agent rides in the URI.** The receiving window may never have had a board open, so it may hold no snapshot to look the agent up in, and a window that guessed would run the wrong extension's reveal.

**What the router will not settle.** `ide-context` matches a workspace root by **prefix**, so a window on a parent folder answers for a child's root and the fastest reply wins: two scratch folders under one directory returned the same client id. It is a hint, not a window key. `thread-owner-discovery` answers `error: no-client-found` for a thread no window holds, which is what makes it a usable check of whether a reveal landed — but only once a window holds it.

## 46. A dispatched Codex run has no network until it is given one

Measured 2026-09-07 with `codex-cli 0.153.4` on Windows 11, against `codex exec --sandbox workspace-write -c approval_policy="never"` in a git checkout. Version-fragile: the config key is one CLI version's.

A TCP connect from inside the sandbox fails **`EACCES`** — measured with `node -e` opening `api.github.com:443`, which connects in 11 ms outside it. Adding one override opens it, with the same run otherwise unchanged:

```
-c sandbox_workspace_write.network_access=true
```

So `--sandbox workspace-write` on its own cannot `git push`, `gh` anything, or reach a package registry, and a merge action that ends in a push would fail its last step having done the work. The board passes the override with `workspace-write` for that reason; `read-only` keeps no network, because a plan does not push. `--dangerously-bypass-approvals-and-sandbox` has the network because it has no sandbox at all.

`codex sandbox`, the CLI's own subcommand for running a command under the same Windows restricted token, **does not read** `sandbox_workspace_write.network_access`: the connect fails `EACCES` with the override set. It builds its sandbox state from its own flags, so it cannot be used to check what a `codex exec` run will get.

## 47. A Codex thread's window is named by its own process

Measured 2026-09-08 with VS Code 1.136.1, extension `openai.chatgpt` **26.901.22334**, `codex-cli 0.153.4`. Version-fragile: the executable name and the process shape are one extension version's.

A thread runs inside `codex.exe … app-server`, which the extension spawns from the window's extension host, so the pid a hook marker records (§40) belongs to that process and its parent is the window. Measured: `codex.exe` 76564 → parent 58400, the `Code.exe --type=utility --utility-sub-type=node.mojom.NodeService` process holding port 22066, whose lock file (§22) names `d:\git\orez.worktrees\19072-requeue-rules-import`. That is the walk that already names a Claude window, so Codex needs no lock file of its own — the process table only has to be asked about `codex.exe` as well as `claude.exe`. What bounds it is the candidate list: a window is only reachable if some lock file announced it, and today every lock is Claude's (§22), so a window whose Claude extension never announced it is named by nothing and the walk lands on no window at all.

**This is what reaches a thread in the sidebar.** In the measured window the thread was in the secondary sidebar: `workbench.auxiliarybar.activepanelid` was `workbench.view.extension.codexSecondaryViewContainer`, `memento/webviewView.chatgpt.sidebarSecondaryView` was `{}` (§44), and the window's store carried no `memento/workbench.parts.editor` key at all. Nothing written to disk said which window held the thread. Its process did. **Not measured:** what the reveal does to a thread the sidebar is showing at that moment — §44 measured it against a tab, where it re-activates rather than forking.

**The IPC router does not.** `\\.\pipe\codex-ipc` (§44) answered `thread-owner-discovery` `error: no-client-found` for all five threads on the machine, including two recorded in another window's editor memento, while `ide-context` for two open roots was answered, each naming a different `handledByClientId`. The router says which windows are connected; it does not say which one holds a thread.

## 48. What a card's own poll query costs, and what it does not report

Measured 2026-09-08 against `ownerrez/orez` — 13 assigned open issues, 31 open pull requests — with `rateLimit{ cost }` selected alongside `ASSIGNED_ISSUES_QUERY`. The GraphQL cost is a function of the nodes **asked for**, not the nodes returned, so a page size the board never fills is still paid for the moment anything nests inside it.

| Selection | Cost |
|---|---|
| The card fields alone, `closedByPullRequestsReferences(first:100)` | 3 |
| Plus `commits(last:1){ commit{ oid statusCheckRollup{ state } } }`, still `first:100` | 103 |
| The same, `first:10` | 13 |
| The same, `first:5` — what ships | 8 |

`100 issues × 100 pull requests` is 10,000 nodes, which is the 100 points. The board's own maximum was **one** closing pull request per issue, and nine of the thirteen had none, so `first:5` is four more than anything measured. `selectPullRequest` returns one whatever the page holds. At a 300 s poll that is 96 points an hour against a 5,000/hour budget. Wall time did not move: 1019 ms before, 1167 ms with the rollup.

**The ordering of `closedByPullRequestsReferences` is not documented**, and `selectPullRequest` sorts the page it gets by `updatedAt`. An issue with more than five closing pull requests could therefore be handed a page that does not hold the one that would have won. Not observed, and 10 closing pull requests on one issue is not a shape this board has seen.

**What an issue's own `updatedAt` does not report.** Measured on the cards above: a comment on the linked pull request, a push to it, and a check rollup going red all leave `issue.updatedAt` untouched. Those are the changes a card's evidence (`prd.md` R24) reads `pullRequest.updatedAt`, `headOid` and `statusCheckRollup` for. `reviewDecision` is not among them — it is populated on 31 of 32 open pull requests here, but it lags: it stays `REVIEW_REQUIRED` on work the team approved by moving the issue's status instead.
