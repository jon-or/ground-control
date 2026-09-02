# @ground-control/sessions

Live agent sessions on this machine, read from agent CLIs. Must not import `vscode`.

`fetchSessions(config, deps)` returns a snapshot, never a failure: with several CLIs configured, one being absent must not hide the sessions the others reported. A CLI that could not be read contributes a `Failure` and no sessions.

## Adding an agent CLI

Claude Code is the only provider implemented. A provider owns **its own transport** — `ProviderDeps` deliberately carries no way to talk to a CLI, so two providers can diverge as far as their CLIs do.

1. Write `src/providers/<id>.ts` exporting a factory that returns a `SessionProvider` — `id`, `defaultPath`, `defaultEnabled`, and `listSessions(path, deps)`. Take the transport as a parameter so a test can supply a recorded one, the way `makeClaudeProvider` does. `runJsonCli` in `src/providers/exec-json.ts` is a helper for the one-JSON-document-on-stdout shape, offered rather than imposed.
2. Add the factory's result to the `registry` array in `src/providers.ts`.
3. Add the CLI's settings to the extension manifest. The extension reads the registry, so `config.ts` needs no change.
4. Record a fixture of the CLI's real output under `test/fixtures/`. Expect to write your own recorder: `record.js` is Claude-shaped throughout — its command, its transcript layout, its slug rule.

Set `defaultEnabled: false` for anything that is not the developer's primary agent. R30 says optional tools are detected and never required — a CLI nobody asked for must not produce a "not found" notice on every refresh.

**The interface is not proven beyond one CLI.** `codex-cli` is installed here and is not shaped like `claude agents --json`: no subcommand lists sessions as JSON, the only machine-readable list is `Thread/list` over a `codex app-server` JSON-RPC daemon with cursor pagination, and its transcripts are date-partitioned under `~/.codex/sessions/YYYY/MM/DD/` with the cwd inside the file rather than in a directory name. `gemini` is not installed. So `SessionProvider` is the right seam and `ProviderDeps` is still Claude-shaped: a second provider will likely need a way to read the head of a large file, and a way to tell a live session from an exited one without a CLI to ask. Expect `ProviderDeps` to grow when that provider is written, not before.

Codex's threads also carry `gitInfo.branch` directly, which the current design gives a provider no way to prefer over the branch derived from disk. Worth revisiting then.

## The hook contract

The package owns the Claude Code hook contract as well as the session reads, because both are Claude mechanics and neither may import `vscode`.

`claude agents --json` cannot say what an interactive session is doing — measured, `docs/mechanics.md` §20 — so a hook writes one marker file per session under `~/.claude/ground-control/activity/`. **The hook transcribes the event and decides nothing.** `phaseOf` in `src/phase.ts` maps an event to a phase, which means a mapping bug ships as an extension update rather than as a rewrite of a file in the developer's home directory, and vitest can reach the ten branches of judgement that mapping involves.

`HOOK_SOURCE` is the writer's text, held as a string so it has no `.vsix` packaging surface and `test/hook-writer.test.ts` can spawn real `node` against it. The writer ignores any payload carrying `agent_id`: a subagent's hooks report the parent's session id, so its work would otherwise clear a `waiting` on a parent parked on a prompt. `planHookInstall` decides what to write to the developer's settings file and is pure — string in, string out — so the merge that touches the most dangerous file on the machine is entirely testable. The extension does the file system and nothing else.

## What a session carries, and what it does not

`status` and `state` are reported only where the CLI supplied them — for Claude those are the `--bg` shape, and an interactive session carries neither, nor a short `id`. `transcriptWrittenAt` is a write time in epoch milliseconds, not liveness: a live session's transcript can be many hours old, or absent entirely. R24 forbids the board claiming a state it has not verified, so absence is `null` here and stays `null` all the way to the card.

`startedAt` is epoch **milliseconds**. Claude reports it that way; another CLI reporting seconds must multiply, or every one of its sessions lands in 1970 and the board sorts wrong in silence.

`activity` is the last phase a hook reported and when it reported it — never a guarantee the session is in that phase now, because nothing can be. An event the board does not recognise, a marker that disagrees with the session it claims to be from, and a clock too far ahead to reason about all read as `null`, which is the truth rather than a guess.

`kind`, `status` and `state` are Claude's vocabulary as much as anything shared, and `shortId` has no analogue in every CLI. A second provider will have to either flatten its own state model into these or leave them null; that is a known cost of one flat `Session` type, taken deliberately so the board has one shape to render.
