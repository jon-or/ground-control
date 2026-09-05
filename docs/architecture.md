# ground-control — Architecture

How the pieces fit: what tracks, what decides, what renders, and where a new agent, host, work source, or board plugs in. Requirements live in `prd.md`, measured mechanisms in `mechanics.md`, and the test contract in `testing.md`. This document also carries the stance the rest of the design leans on (§1).

Naming: the **hub** is the background process. `tracker` in the other docs means GitHub Projects, the team's work tracker; here that seam is the **work source**, and GitHub Projects is named in full.

## 1. Shape

One headless hub owns what every board needs to render and act: which issues the developer holds, which agent sessions are alive, what each session is doing, where each session is showing, and which lane the developer put each card in. Boards are clients of the hub. They render its snapshot and forward the developer's actions; they decide nothing.

```
                 ┌──────────────── hub (node, headless) ────────────────────┐
 work sources ──►│  poll · coalesce · watch activity · merge · lane memory  │──► snapshot + change events
 agent adapters ►│                                                          │◄── actions: refresh · move · open
 host adapters ─►│  one loop, one snapshot, one record of what is where     │
                 └──────────────────────────────────────────────────────────┘
                              ▲                                ▲
                   VS Code board (webview)          GitHub project overlay (Chrome, via a stdio bridge)
```

The hub is a single process per machine because two of the things it holds cannot be held twice. Lane placement is one record: a card in `Build` on one board is in `Build` on every board, or "a card sits in exactly one lane" (`prd.md` R8) is false. Hook installation is one act: two processes both syncing `~/.claude/settings.json` is the race the install lock exists to prevent.

A Chrome extension forces the hub out of VS Code. It cannot spawn `claude` or `gh`, read `~/.claude`, or watch a directory, so the tracking must run in a node process the browser reaches. Running that process inside a VS Code window would tie the browser board's lifetime to whichever window happened to host it, and elect a host among several windows on every launch.

The hub owns no work item's state. It reads what the sources report and what the developer placed; it never decides that a piece of work is done.

### Stance

- **Evidence over claims.** A session's phase comes from files the agent writes as it works, never from the agent's own report of what it did (`mechanics.md` §20; `prd.md` R23, R24). The hub never infers a phase from a transcript's age.
- **The control plane is authoritative; the project board is a projection.** When a `.factory/` control plane exists, its station state is what moves a card, and the GitHub Projects status becomes one more thing the board reads. Until then, the status and the developer's own placement are the only inputs.
- **Seize is stop-and-take-over, and it needs the editor.** Taking a session over stops it, hands it to the developer in an editor tab, and hands it back when the tab closes (`prd.md` R15, R17). Only an extension resident in the editor can do that; a browser board watches and moves cards, and sends a seize to the editor. Opening a session is not that: it stops nothing, so a browser board does it itself — by navigating to a `vscode://` link the extension answers, which is how focus is given rather than taken (`mechanics.md` §26, §29).
- **The tracking is headless.** Everything that reads the machine runs in the hub, so a board is only ever a renderer, and a second board is a second renderer.

## 2. The three seams

Every external thing the hub touches sits behind one of three interfaces, each backed by a registry in `packages/hub`. Adding a target is a new registry entry and a configuration id; nothing in the loop, the merge, the lane memory, or any client changes.

| Seam | Answers | Implementations |
| --- | --- | --- |
| **Agent adapter** | Which sessions are alive, what each is doing, what each is called | `claude` |
| **Host adapter** | Where a session is showing, how to reveal it, how to release it | `vscode` |
| **Work source** | Which items are on the board and each one's status | `github` |

### Agent adapter

One per agent CLI. It owns its transport, its response shape, where its transcripts live, the wording of its failures, and its activity signal.

```ts
interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly defaultPath: string;
  /** R30: an agent that is not the developer's primary one stays off until enabled, so absence never nags. */
  readonly defaultEnabled: boolean;
  /** Every live session this CLI reports. Never throws; a failure comes back classified. */
  listSessions(path: string, deps: MachineDeps): Promise<{ sessions: Session[]; failure: ReadFailure | null }>;
  /** The phase signal this CLI offers, or absent when it has none. */
  readonly activity?: ActivitySignal;
}

interface ActivitySignal {
  /** What to write to put the signal in place, or take it away. Pure: the hub does the file system. */
  plan(input: { settingsText: string | null; home: string; wanted: 'install' | 'remove' }): ActivityPlan;
  /** The agent's own settings file, which the plan is written into. */
  settingsPath(home: string): string;
  /** The directory whose changes mean a phase may have moved, watched by the hub. */
  watchDir(home: string): string;
  /** The last phase reported for a session, or null to claim nothing. */
  read(home: string, sessionId: string, readText: ReadText, now?: number): SessionActivity | null;
  /** A script the signal needs on disk, where it needs one. The hub writes it and never reads it. */
  readonly writer?: { path(home: string): string; source: string };
}
```

`MachineDeps` is the hub's view of the machine handed to every adapter: the `MachineReaders` (`readText`, `mtime`, `listDir`, `readTail`, `home`) plus the compiled branch pattern. `fetchSessions(config, adapters, readers)` in `core` compiles the pattern and fans out to the adapters named in the configuration; an unknown id is a named failure. An adapter never touches `node:fs` directly, which is what makes it testable against recorded reads.

`activity` is optional because the signal is the least portable part of an agent. Claude's is a hook script writing a marker per session (`mechanics.md` §20); another CLI may offer a status file, a socket, or nothing. An adapter with no signal produces sessions with `activity: null`, which the board already renders as no phase (R24).

`Session` is neutral. It carries what every board needs to place and label a card: `agent`, `sessionId`, `pid`, `title`, `cwd`, `branch`, `issueNumber`, `startedAt`, `transcriptWrittenAt`, `activity`, and `finished`, the agent's own word that the session ended, which the lane rules read and never infer. Anything only one CLI reports goes in `details: Record<string, string>` for display, absent rather than null where the CLI said nothing. The board reads four keys where present: `name` and `shortId` in the label ladder after `title` (R11), and `state` or `status` as the CLI's own word when no phase is reported (R24). A field like Claude's background-session `status` never becomes a column every adapter has to fake, and `finished` is the only word promoted out of the bag, because a lane decision may not rest on one agent's vocabulary.

### Host adapter

One per application a session can show in. It owns the host's persisted state, its window enumeration, and the verbs for reaching a session in it.

```ts
interface HostAdapter {
  readonly id: string;
  /** Parses this host's entry in the configuration, or names what is wrong with it. */
  configure(raw: unknown): ReadFailure | null;
  /** Warms whatever `windows` and `surfaces` read, once per session poll. */
  prime(deps: MachineReaders): void;
  /** Which windows are open, and which one is running this session. */
  windows(session: Session | undefined, deps: MachineReaders): Promise<HostWindows>;
  /** Which surface in which window holds each session, from the host's own records. */
  surfaces(deps: MachineReaders): Promise<SessionSurface[]>;
  /** A route to the session, or a named refusal with its remedy. Pure, and judged against this host's own settings. */
  plan(request: OpenRequest): OpenPlan;
  /** Which of these sessions this host offers to open. Another host's answer is its own (R14). */
  openable(sessions: readonly Session[]): string[];
  /** Routes only a client resident in the host can perform, named so the hub can forward them. */
  readonly residentRoutes: readonly OpenRoute['route'][];
  /** Routes this adapter can perform from a headless process. Absent where every route is resident. */
  open?(route: OpenRoute, deps: MachineReaders): Promise<OpenOutcome>;
  /** Closes the surface holding a session so it can be handed back (§1, Seize). Absent where the host cannot. */
  release?(session: Session, deps: MachineReaders): Promise<void>;
}
```

A host adapter takes `MachineReaders` rather than the full `MachineDeps`: linking a branch to an issue is an agent's job, and a host never does it. Its own permissions stay inside it: whether the board may bring another window forward is R27's rule about one application's windows, so `configure` parses it and `plan` applies it, and the hub carries no setting whose meaning is a host's. Only a host the configuration names is reached at all: one left out of it was handed no settings, and an editor reached on defaults nobody chose reads another install's windows and brings the wrong one forward.

Two rules keep the seams from bleeding into each other.

**Placement knowledge lives in the host adapter, keyed by agent.** A session's location inside a host is recorded by that agent's integration with the host: a Claude tab in VS Code is a webview with `providedId` `claudeVSCodePanel`, and a Claude window announces itself in `~/.claude/ide/<port>.lock` (`mechanics.md` §21, §22). A Codex session in the same VS Code is recorded under Codex's ids. The `vscode` host adapter holds `PLACEMENTS`, a table per agent id of the webview id, the sidebar memento keys, the state key carrying the session id, the lock directory, the extension id, the reveal and focus commands, and the open URI, because the host owns the storage format and the agent owns the identifiers. A session whose agent has no row is refused by name. An agent adapter knows nothing about any host.

**A host adapter has a headless half and, where needed, a resident half.** Locating a session is reachable from the hub. Reaching it is not always: every route into VS Code that fires a URI or a command must first confirm that the target window has focus, because the URI follows focus and a miss starts a fresh agent in the wrong window (`mechanics.md` §7, §8), and a headless process has no focus signal. So today every `vscode` route is resident, and the adapter offers no `open` at all rather than one that performs nothing. The adapter names such routes in `residentRoutes`; a client that can perform them says so when it connects, and the hub forwards those actions to it. A host with no resident half, such as a terminal, lists none, and its `plan` never returns one.

`release` over a window's own port is unbuilt, so the `vscode` adapter omits it too. Closing the surface costs the window its IDE connection (`mechanics.md` §22), and until §22 characterizes what reopening one costs, no host performs a release. Both verbs are optional on the interface rather than stubs, so a host cannot claim a capability it does not have.

### Work source

One per place work items come from. `github` reads the developer's assigned issues through `gh` and reports the GitHub Projects status that decides whether a card is on the board and where it arrives (`prd.md` R8, R9). The `.factory/` control plane becomes a second source when stations exist, and station state then becomes the second thing that may move a card.

```ts
interface WorkSource {
  readonly id: string;
  readonly displayName: string;
  /** Takes this source's entry in the configuration and holds it, or names why it will not read with it. */
  configure(raw: unknown): ReadFailure | null;
  read(): Promise<SourceReading>;
}
```

A source holds the last configuration it accepted, and a refused one leaves it holding nothing: reading with the settings from before a refusal is reading with settings nobody set, under a board that already says the settings were refused. So `SourceReading` is three nullable fields rather than a result, and the two ways of reading nothing are told apart. `items` null beside a `failure` is a read that failed, and keeps whatever the source last returned on the board (R24). All three null is a source with nothing to say at all, and its cards go: they were read for a repository the developer is no longer asking about.

`needs` is what a source can work out for itself but may not adopt. GitHub reads the logged-in accounts out of `gh auth status`; every query it makes is `assignee:`, and picking one would put somebody else's issues on the board as the developer's. So it reports them as detected, reads nothing, and a client puts the question to the developer (R26, R28).

`WorkItems` carries the cards, the counts R1 asks to be stated, and `owners` — who the read was actually made for, which the lane rules use to tell the developer's own pull request from a colleague's. That is a read of the source, not of the setting, so a login the developer has just typed does not change how cards are laned until the read that used it lands.

The hub reads the sources its configuration names and no others, so a source in the registry that nobody asked for costs nothing. A source the configuration stops naming, and one whose settings it refuses, both lose their last read the moment that configuration lands rather than at the next poll: with nothing watching there may not be one, and cards read for settings nobody is naming any more would sit on the board for the length of a poll interval. A board with a source it cannot read is stale and dims, whether the read failed or the settings for it were refused — a misconfigured host is worth saying and is not staleness, because the cards on screen are still what the world says.

Every source's last read merges into one board, and the items' `fetchedAt` is the oldest of them: the board is only as fresh as the source that has not been read since. A source that throws rather than returning a failure is named on the board like one that failed — the seam is public, and a rejection swallowed would take the whole pass's broadcast with it and say nothing anywhere the developer looks.

## 3. The hub

The hub is the loop that was the board panel's, made headless and made one per machine.

- **Two cadences.** Work sources are a network round trip and poll on the long interval. Agent adapters spawn a CLI and poll on the short one. Each source keeps its last good read and its last failure, so one failing never blanks another.
- **Activity is event-driven.** The hub watches each activity signal's directory. A change on a listed session is one marker read; a marker removed, or one naming an unlisted session, is a roster change that only the CLI can settle, so it triggers a session read. Changes batch for 150 ms. The directory comes and goes with the install and `node:fs.watch` cannot be armed on a missing path, so the watcher re-arms until it appears and again whenever it is removed underneath. A marker's kind is decided from one `exists` on that path against the set the watcher held before the batch: a listing taken mid-batch already holds markers whose own events have not arrived, which would read every one of them as a rewrite.
- **Coalescing.** A read in flight absorbs a timer or a button. A change the in-flight read cannot have seen queues one more read behind it. A refresh within a second of the last read is ignored.
- **Idle when unwatched.** A client says whether it is watching: the VS Code panel reports hidden, and the Chrome bridge disconnects when no project-board tab exists. With no client watching, the hub stops polling and an activity event costs nothing. Each session poll costs about a fifth of a second of CLI time (`mechanics.md` §2), which nobody would be looking at. The hub exits after 30 minutes at zero clients, and the next board open starts it again in about a second. A window that has activated the extension stays connected whether or not a board is open, because a setting changed with no board on screen still has to reach it (R34).
- **Lane memory is a file.** `~/.claude/ground-control/lanes.json`, written atomically, read by every client through the snapshot. A client never stores placement of its own.
- **Activity install is the hub's.** It applies each agent's `ActivityPlan` under the existing install lock and reports what it observed, never what it intended (R25). The install and announce marks live in `hub-marks.json`; the announce is per client, so a second window still sees the notice once.
- **The hub owns the defaults, and remembers what it was told.** Its configuration is built from each adapter's `defaultPath` and `defaultEnabled` (R30) plus the shipped statuses and lanes (R27). A client pushes its settings on connect and on every change. The hub writes each configuration it accepts to `~/.claude/ground-control/config.json` and starts on that, because a default is not enough for every source: which repository work is tracked in cannot be guessed, and the settings that say so live in an editor that need not be open — so a hub the browser started would otherwise report itself unconfigured however long ago the developer set it (R36). A refused configuration is never remembered, or the mistake would outlive the window that made it. The file is parsed on the way back in exactly as a pushed one is: one field of it becomes a process, and it sits in a directory any process running as the developer can write. Every registered host and source is named in the defaults with an empty entry: a source nobody has configured then says what it is missing, where saying nothing would read as a developer with no work assigned to them. Every setting that reaches the hub is application-scoped in VS Code: one board's memory is shared by every window (R9), so two windows can never disagree.

### Protocol

The snapshot and the actions are one typed contract in `packages/core`, and every client builds its messages from those types. A field renamed in the hub fails the typecheck in every client rather than rendering an empty board (`testing.md`, "The webview protocol is typed on both sides"). The protocol carries an integer version; a client and a hub that disagree on it do not talk.

| Direction | Message | Carries |
| --- | --- | --- |
| client → hub | `hello` | client id, the host it lives in or none, its workspace root, the resident routes it can perform, whether it is watching |
| client → hub | `configure` | the client's settings, merged over the hub's defaults, and whether the developer asked to be told what the activity install did |
| client → hub | `watching` | whether the client is looking at the board now |
| client → hub | `refresh` | — |
| client → hub | `move` | card key, lane id |
| client → hub | `open` | session id, and whether the agent's own extension is ready — read on the click, because an extension activates while a board is up |
| hub → client | `snapshot` | lanes, per-source counts and failures, which sessions are openable, the hook notice, what the hub needs from the developer, when it was read |
| hub → client | `changed` | the same, sent on any change; clients replace, never patch |
| hub → client | `perform` | a resident route, forwarded to the one client that offered it |
| hub → client | `notice` | a message for the developer, with the refusal it came from where there is one |
| bridge → browser | `trouble` | that the hub is not answering, or that it is again — the bridge's own, since a client cannot be told by a hub it cannot reach |

A configuration is parsed before it is taken, and a bad one is refused whole and named above the lanes rather than half-applied: one field of it becomes a process, and a client is not necessarily this editor. What it settled on is broadcast before the read it triggers, because that read has a floor: a setting corrected within a second of being made wrong would otherwise leave every board showing the complaint until the next poll. A client restates its configuration after every `hello`, since a hub it has just started knows nothing about it.

`needs` on the snapshot is what the hub cannot detect and must ask for once, in place (R26): today, the developer's GitHub logins when none are configured. The client that can ask does, saves the answer to settings, and pushes `configure`.

### Transport

The hub serves HTTP on `127.0.0.1` on an ephemeral port: the snapshot and the actions as requests, changes as Server-Sent Events with a comment heartbeat every 20 s. Every client reaches it the same way, whether it is a VS Code window or the Chrome bridge.

| Route | Carries |
| --- | --- |
| `GET /hub` | the hub's name, protocol version, a fingerprint of its configuration directory, and, when the caller supplies a nonce, an HMAC of that nonce under the token. No token, and nothing else — not the pid, not the version of the code |
| `GET /snapshot` | the snapshot as it stands |
| `GET /roster` | a fresh read of the sessions on the machine, for a client carrying out an open route |
| `GET /events?client=<id>` | that client's stream: `snapshot`, `changed`, `perform`, `notice`, and a `: ping` comment every 20 s |
| `POST /actions?client=<id>` | one `ClientMessage`. `hello` is the first, and it must name the client its stream belongs to |
| `POST /shutdown` | the stop |

A client reads `~/.claude/ground-control/hub.json` for the port and the token, then probes `GET /hub` with a fresh nonce and sends the token only to a listener that answers as a hub, for the same home, on the same protocol, holding the same token. The fingerprint alone would not do: it is a hash of the home directory's path, which any process running on the machine can guess, so on its own it lets anything holding the port be believed. The proof is what the record's own token is checked against, and it never puts the token on the wire. Liveness is that probe, never the file's existence; a stale `hub.json` is the normal state after a hub is killed, not an error (`mechanics.md` §25). A stream is what a client is: an action for a client with no open stream is refused, and a stream that closes disconnects it, which is what makes "nobody is connected" something the hub can tell.

The server refuses any request carrying an `Origin` header, any `Host` other than its own loopback address, any target that is not origin-form, any `POST` that is not `application/json`, any body over 64 KB, and more than eight event streams. A web page can reach loopback, and the request that pushes configuration carries executable paths, so nothing a browser can send is accepted. The browser board is reached another way. The first three happen before any route, and each is written to `hub.log` with the header that decided it while the client is told only that it was turned away. Those three are the ones worth recording: a client refused by them sees a status it cannot tell from a port some other program has taken, so without the hub's own note a board that cannot reach the hub it can see leaves no evidence anywhere on the machine. The rest refuse a request that already reached its route, which the client asked for and can read from the answer.

**The Chrome bridge.** Chrome talks to the hub through native messaging: a per-user host registered under the developer's own profile (`HKCU` on Windows, the profile directory elsewhere), which Chrome starts on demand and talks to over stdio. The bridge is the hub bundle in a second mode. It reads `hub.json`, starts a hub if none answers, connects to the event stream with the token, and relays messages both ways. It connects as a client with no host and no resident routes, so no route is ever forwarded to it.

The bridge is the boundary the browser is held at, and it is a whitelist rather than a blacklist: `refresh`, `watching`, and a `move` to a lane the board has, and everything else is refused by name and the refusal sent back for the overlay to show. Going to a session does not widen it: that is a navigation the browser makes, answered by the extension's own URI handler, and it never passes through here. The hub's own server treats it like any other client, so the rule has to live where the browser's messages arrive. Frames are Chrome's own: four bytes of length and then JSON, reassembled across however stdin chunks them, with a header claiming more than a megabyte treated as a stream out of step with its frames rather than a body to wait for.

Google Chrome is the browser it registers with: the manifest goes where Chrome looks for it, and on Windows under Chrome's own key. Chromium, Edge and the rest read their own locations and would each need a row; none has been asked for.

The registration is written by a deliberate command, **Ground Control: Enable GitHub Overlay**, removed by the command that reverses it, and removed again when the extension is uninstalled — what it names is the bundle the uninstall deletes, so left behind it would have Chrome starting a host that is not there (R34). What it writes is a wrapper script and a manifest naming it, plus the registry value Chrome finds the manifest by on Windows. The wrapper prints nothing of its own: Chrome reads the process's stdout as message frames, so a line from a shell is a malformed frame and the port closes. It names the bundle at `~/.claude/ground-control/hub.js`, never the copy inside an extension, so an update never orphans it.

### Lifecycle

The extension writes the hub bundle to `~/.claude/ground-control/hub.js` on activation when the version it carries is newer than the one on disk, and never when older, the way it writes the hook script. Each copy carries its version on its first line, so which is newer is read without running either. Equal versions compare bytes, which is the case every development build hits — every build in a source tree carries the same version, and without that rule a rebuilt hub would never reach the disk. A bundle that cannot be written is said out loud and nothing else in the window is lost: the hub already on disk from an earlier run still starts.

The bundle is compared against the hub that is running, not only against the file: a hub whose record was written before the bundle was is running an older copy, and the client that finds it stops that hub — by the record it found, never by the file read again, because a replacement may hold the record by then — and starts what is on disk now. Both sides of that comparison are file times from the one filesystem, the bundle against the `hub.json` its hub wrote as it bound, because a time read on one clock cannot be compared against a time read on another. That is what a rebuilt bundle takes to reach a board — a build and a client, rather than a `--stop` by hand — and it is how a fix shipped in an update reaches a machine at all. A client with no starts left in its budget stops nothing, because a stop it has nothing to follow with would leave the board with nothing; a stop that hit nothing is a hub already replaced, and the client takes whichever one answers now. The cost is that a bundle which will not run takes the board down with it, where an unreplaceable hub merely went stale — the client says which of the two happened, and that is the trade the rule is worth.

The spawn command, the native-messaging manifest, and the uninstall all point at that one path, so an extension update never orphans a running hub.

A client starts the hub when `GET /hub` does not answer. VS Code spawns its own executable as node (`ELECTRON_RUN_AS_NODE`, the Node measured in `mechanics.md` §21), detached and unreferenced so it outlives the window, with output appended to `hub.log`. There is no search for an interpreter: the extension host's PATH is the launcher's rather than the shell's, and the Electron it is already running is the one Node that is certainly there. A child spawned that way survives the editor closing (`mechanics.md` §26), which is what lets the browser overlay keep working after VS Code is gone.

The hub scrubs `ELECTRON_*`, `VSCODE_*`, and `NODE_OPTIONS` from its own environment at startup. Not for the `code` CLI's sake — that sets `ELECTRON_RUN_AS_NODE` itself and clears it before launching the app (`mechanics.md` §26) — but because `VSCODE_IPC_HOOK` names the pipe of the window that started the hub, and every CLI the hub spawns would inherit it.

Single instance is the record, not the socket: `listen(0)` cannot collide, so binding decides nothing. A hub probes the recorded port before binding, and afterwards claims `hub.json` by exclusive create; the one that loses that create closes and stands down, and a record naming a port that answers as nothing is a hub that was killed and is taken over. Only a hub whose own pid is still in the record ever removes it, so an orphan cannot take the winner's record away with it. A client talks only to a hub on its own protocol. One answering a different number is a hub, but not one it can speak to, and which of them gives way is the same rule the bundle follows: newer wins. A newer client stops the older hub over `/shutdown` — the record's token proves it is the developer's own, and stopping is one route in every version — and starts its own. An older client stops nothing and starts nothing, because the bundle it would run is the newer hub's; it says so and asks to be updated. A cold start of the bundle costs 60 ms (`mechanics.md` §26).

What `GET /hub` answers is the one shape that must survive every version: a client that cannot parse it cannot tell an older hub from a stranger on the port, and would tell the developer to stop a hub that is theirs. Fields may be added to it; the three it has are fixed.

Seven things come to the same nothing at a client: no record, a port nothing holds, a port that went quiet, something that is not a hub, a hub tracking another home, a hub whose token this record cannot prove, and a hub of another protocol. Only the first is "there is no hub". Every other one is a process that is up and did not become this client's hub — and the hub the client then spawns stands down against it. It names the port and, where the record describes the process holding it, the pid; the remedy is ending that process, because a hub whose token this client could not prove cannot be told to stop — `/shutdown` needs that token. Where the miss is that something answered as not a hub, the client says what it answered — the status and the first line of the body, clipped to one — because the alternative is telling a developer that a stranger holds a port on no evidence, and that answer is the only evidence there is. A probe that goes quiet is asked once more with three seconds rather than half of one, because that deadline is spent on the client's own event loop: a window that has just activated is not a hub that is gone, and treating it as one is how a board comes to start a second hub against a working one.

A spawn that stands down writes why into `hub-exit.json`, the same file an orderly stop writes. Without it a spawn that found the home already served and a spawn that died are the same silence to the client that asked for one, and the client would tell a developer to go stop a stranger while their own hub is up and only that window cannot see it. What the client says instead names the running hub's port and that it is the one it cannot reach.

A client that cannot reach its hub retries with a doubling backoff from one second to thirty, starting one again each time none answers. What bounds that is a budget on **consecutive** starts that never answered: one a minute, three in five minutes, and then the developer is told, with the reason the last hub stopped and the path of its log. The budget is one client's, not the machine's — two windows each hold their own, which is what keeps a window's own retries paced without one window's trouble silencing another's board. A start that produced a live hub clears the count, so killing a working hub gets it back at once rather than after a minute — only a hub that will not come up at all is one the board stops making.

There is no orderly signal on Windows for a process without a console (`mechanics.md` §25), so the stop is `POST /shutdown` with the token, or `ground-control-hub --stop`, which does the same over the same route. An orderly stop removes `hub.json` and writes `hub-exit.json` with the reason; a hub that was killed leaves the first behind and never writes the second, which is what a client whose spawn did not come up has to go on. Uninstalling the extension shuts the hub down, removes the activity hooks and the Chrome registration, and removes the bundle.

### Privacy

The snapshot is the developer's work in the open: session titles derived from their prompts, the absolute path of every checkout, branch names, issue and pull request titles, and the `gh` logins they declared. `hub.log` carries the same, plus the origin of any web page that reached the loopback port and was refused — a slice of browsing history, clipped and rationed, kept because a board that cannot reach its hub has nothing else to go on. `config.json` carries the settings behind the snapshot: the repository, the logins, and the paths of the CLIs the hub spawns. Both are written for the developer alone, as the bundle is. Any process running as the developer can read `hub.json` and so the snapshot; the token keeps other users and web pages out, not the developer's own processes, and on Windows a file mode is not protection. Nothing leaves the machine. The Chrome extension keeps the last snapshot in `chrome.storage.session`, which Chrome clears when it exits, and nowhere else.

## 4. Clients

A client renders the snapshot and forwards actions. It holds no state the hub does not, except what its own display needs to draw.

**VS Code board.** The webview panel, the commands, the settings UI, and the resident half of the `vscode` host adapter: it offers every route in `residentRoutes` on `hello`, and performs one with `executeCommand` when the hub forwards it. It is also the client that asks for what the hub `needs`. Everything else it did lives in the hub, the transport included — what stays in the extension is spawning the process and writing the bundle, which are the two things only something inside VS Code can do.

**GitHub project overlay.** A Chrome extension whose content script runs on project board pages, finds the issue number in each card's link, and paints a footer inside the cards the snapshot knows: a first line carrying the lane the board has the card in and R6's returned mark, then one row per session, the full width of the card, carrying its agent, its own name, and the one state the board will claim for it — its observation and how long that has held, or the CLI's own word where there is no observation, or nothing. R6's attention is written to GitHub's own card element, which rings the card because a footer is not readable at the distance a project board is, and the CSS paints the row that attention is about — a rule down its edge, its colour and its weight — rather than adding a badge that says the same thing without naming which session means it. A running session's name carries a pass of light instead, monochrome, because yellow and blue already mean the two things that want the developer. Durations advance in place on a one-second timer rather than through a repaint: the footer is rebuilt from scratch by every scan, and rebuilding one a second to move a number would fight the observer watching for it. The footer goes inside the card's own box rather than under the card element, which is GitHub's drag handle wrapped around it (`mechanics.md` §27). What R25 asks be stated once is split by what the developer must do about it. What went wrong — a source that failed, a hub that cannot be reached, an action refused — is a toast, in front of them and dismissible, and one toast per condition however many times the board repaints. What is merely true — how old the reading is, what a hook install did — is in a menu the overlay hangs in the board's own filter bar, beside GitHub's View button and wearing its classes, because the page has no space above the lanes that is the board's to take. The button carries a mark when the reading is stale, so a bridge that lost the hub never leaves a footer that looks current. Its actions are `refresh`, from that menu, a `move` to another lane, offered from the lane chip, and going to a session, which is the row itself: an `<a href="vscode://ownerrez.ground-control/open?session=…">`, because only a navigation the developer makes in the application in front of them can hand VS Code the foreground. That link is a second entry point into the one open path — the extension's URI handler resolves it to the same `open` the board's own row sends — and it is reachable from any page, so it takes one well-formed session id and nothing else, which the hub then resolves against its own roster and refuses by name. `openable` for a client resident in nothing is the configured host's own answer rather than empty, because the link addresses the editor rather than a window that is running. Stopping a session and taking it over is not offered: the resident half is in VS Code, and the row goes to a session rather than seizing one.

The content script is injected across `github.com` rather than on project boards alone, because a board reached by clicking through the site is a soft navigation and Chrome injects nothing for one. Which pages it paints is therefore decided in the script, on every location change, and leaving a board is something it handles rather than a page it never sees.

The overlay splits three ways, and the two halves holding no `chrome` port are the ones vitest reaches. `overlay.js` is a pure function of a snapshot and a document; `state.js` is what a message from the worker does to what is drawn, which page is a board, and how long to wait before trying the worker again. What is left in `content.js` is the port and the observer, and in `worker.js` the native port.

The trouble line is the worker's to set and clear, never the tab's. A tab is handed the last snapshot from `chrome.storage.session` before anything has answered, and a tab that cleared the line on receiving one would show an hours-old reading beside a button saying nothing was wrong (R24). The footer is rebuilt from scratch on every scan rather than patched, because a view switch replaces every card node and takes the footer with it (`mechanics.md` §27) — and the observer is disarmed while painting, or the badges it writes would schedule the next scan forever.

**Worked example.** A hook fires `PermissionRequest` for the Claude session on issue 4521. Claude's activity writer replaces that session's marker. The hub's watcher fires; the session is listed, so the roster is not stale, and the hub reads one file instead of spawning the CLI. `phaseOf` returns `waiting`. The hub rebuilds the snapshot and pushes `changed` to both clients. The VS Code webview repaints the card amber. The bridge relays the message to the worker, the content script finds the project card whose link ends in `/issues/4521`, rings it, and paints that session's row amber with the duration. End to end is one file event plus the 150 ms batch window.

## 5. Packages

| Package | Holds | May import |
| --- | --- | --- |
| `packages/core` | `Session`, `ReadFailure`, `AgentAdapter`, `HostAdapter`, `WorkSource`, the lane and card types, the protocol, the browser overlay's own identity, and the neutral helpers: paths, the branch link, the JSON CLI runner, the disk readers, the configuration directory | nothing of ours |
| `packages/agent-claude` | the `claude` adapter: `claude agents --json`, transcript titles, the hook writer, the marker reader | `core` |
| `packages/host-vscode` | the `vscode` adapter's headless half: lock files, window stores, surfaces, the placement table, the open plan | `core` |
| `packages/github` | the `github` work source | `core` |
| `packages/board` | merge and lane rules | `core`, `github` |
| `packages/hub` | the registries and defaults, the loop, lane memory, activity install, the watcher, the server, and the client half: finding or starting a hub, and the transport that rides its event stream | everything above |
| `apps/hub` | the daemon entry point and the Chrome bridge; `ground-control-hub` | `core`, `hub` |
| `extensions/ground-control` | the VS Code client and the `vscode` resident half; bundles `apps/hub` as `dist/hub.js` | `core`, `host-vscode`, `hub`; the only package that imports `vscode` |
| `extensions/chrome-github-board` | the Chrome client: the MV3 worker, the content script, and the overlay's DOM layer | `core` for its types; the only package that imports `chrome` |

The extension also imports `board` and `github` for the two settings readers that turn a raw value into one the hub takes. Those stay in the client: what they read is VS Code's own settings, which only something inside VS Code can see. The Chrome client has no build step and imports nothing at runtime — `core` reaches it as JSDoc types, so a protocol rename fails its typecheck, and Chrome loads the directory as it stands.

One package per adapter is what makes the seams enforceable. The boundary rule and the coverage floor apply per package, so `agent-claude` cannot reach `host-vscode`, and an adapter that arrives without tests fails on its own number rather than hiding in a larger one. `core` names no adapter; the registries are the hub's.

Configuration names each registry by id, and an unknown id is a named failure on the board rather than a silent omission:

```jsonc
"groundControl.agents": [{ "id": "claude", "path": "claude" }],
"groundControl.hosts": ["vscode"],
"groundControl.sources": ["github"]
```

## 6. Adding a target

**A second agent in VS Code.** A `packages/agent-codex` implements `listSessions` over the Codex CLI. If Codex offers no phase signal it omits `activity`, and its cards show without a phase. The `vscode` host adapter gains one row in its placement table: Codex's webview id and where its extension records the session per window. The developer adds `{ "id": "codex" }` to the agents list. Nothing else changes.

**A second host.** A `packages/host-windows-terminal` implements `windows()` over the terminal's own window enumeration and an `open` that brings a window forward. It has no resident half, so `residentRoutes` is empty and `plan` only ever returns focus routes. One string in the hosts list.

**A second work source.** A `packages/source-factory` reads `.factory/*/state.json` and reports each item's station. The lane rules gain the station-to-lane mapping. One string in the sources list.

## 7. What each layer owes in tests

The contract is `testing.md`; this is where each layer lands in it.

- `core` earns tests for its helpers, the paths, the branch link, the CLI runner, the disk readers, and none for its types.
- Each adapter tests its parsing, its failure classification, and its refusals against recorded, scrubbed fixtures. A script an adapter hands to its CLI, such as Claude's activity writer, is tested by spawning it.
- `hub` tests the loop with an injected clock and fake adapters: coalescing, staleness, idle-when-unwatched, lane memory round trips, the watcher over a temp directory, and the server's refusals against a fake hub.
- `apps/hub` has no coverage floor; its entry point is covered by a test that spawns the built bundle with an empty home and reads what it serves.
- Each client's DOM layer imports nothing from its platform and tests under jsdom with payloads built from `core`'s types. The Chrome overlay's card matching runs against recorded project board markup, which is version-fragile and dated in `mechanics.md` like every other undocumented surface.
