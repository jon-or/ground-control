import type { DispatchInput, DispatchResult, ExecText, ReadFailure } from '@ground-control/core';
import { CLAUDE_AGENT_ID, CLAUDE_DISPLAY_NAME } from './ids.js';

/**
 * Run visible, stoppable Claude background work with an explicit permission mode and display name (mechanics
 * M33). Disable worktree.bgIsolation so repository-main-checkout edits are permitted. Omit --session-id
 * because --bg ignores it. Pass the prompt as an argv element to preserve leading slash commands; shell
 * conversion can turn them into paths. Print-mode jobs cannot be stopped through claude stop (M10).
 */
export function dispatchArgs(input: DispatchInput): string[] {
  return [
    '--bg',
    '--permission-mode',
    input.permissionMode,
    '--settings',
    JSON.stringify({ worktree: { bgIsolation: 'none' } }),
    '-n',
    input.name,
    ...(input.model === null ? [] : ['--model', input.model]),
    input.prompt,
  ];
}

/**
 * The id out of what `--bg` printed. The line is `backgrounded · <short> · <name>`, with the middle field the first
 * eight characters of the session UUID; the surrounding help lines and the `Starting background service…` on stderr
 * are not it. Null where the CLI printed something this does not recognise, which is a dispatch that may well have
 * started a session the board then cannot track — so it is reported rather than guessed at.
 */
export function shortIdFrom(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*backgrounded\s+·\s+([0-9a-f]{8})\s+·/.exec(line);

    if (match?.[1] !== undefined) {
      return match[1];
    }
  }

  return null;
}

function failure(kind: string, message: string, remedy: string): ReadFailure {
  return { subject: CLAUDE_AGENT_ID, kind, message, remedy };
}

/**
 * Starts one piece of work in a checkout and answers with the id the CLI minted. Never throws: a dispatch that did
 * not start is a named failure, the same as a roster read that did not answer (R24).
 *
 * `--bg` returns as soon as the session is backgrounded, so what this waits for is the handful of milliseconds the
 * CLI takes to print — not the work. The timeout is a ceiling on a CLI that will not answer at all.
 */
export function makeClaudeDispatcher(runText: ExecText) {
  return async function dispatch(input: DispatchInput): Promise<DispatchResult> {
    const outcome = await runText(input.path, dispatchArgs(input), {
      timeoutMs: input.timeoutMs,
      cwd: input.cwd,
      signal: input.signal,
    });

    if (!outcome.ok) {
      const remedy =
        outcome.reason === 'missing' || outcome.reason === 'not-executable'
          ? 'Check groundControl.agents, or turn the action off in Settings.'
          : 'Nothing was started. The card keeps its reading; run the action again to retry.';

      return { failure: failure(`dispatch-${outcome.reason}`, `${CLAUDE_DISPLAY_NAME} could not start this work: ${outcome.detail}`, remedy) };
    }

    const shortId = shortIdFrom(outcome.text);

    if (shortId === null) {
      return {
        failure: failure(
          'dispatch-unreadable',
          `${CLAUDE_DISPLAY_NAME} started the work but did not say which session it is.`,
          `Run \`${input.path} agents\` to find it — the board cannot follow or stop a session it was not told the id of.`,
        ),
      };
    }

    return { shortId };
  };
}

/**
 * Stops a session this adapter started. `claude stop` and never `claude rm`: `rm` deletes the session "and its
 * worktree when that is safe", and the checkout a run works in holds the developer's own code (M33).
 */
export function makeClaudeStopper(runText: ExecText) {
  return async function stopDispatch(path: string, shortId: string): Promise<ReadFailure | null> {
    const outcome = await runText(path, ['stop', shortId], { timeoutMs: STOP_TIMEOUT_MS });

    return outcome.ok
      ? null
      : failure(
          'stop-failed',
          `${CLAUDE_DISPLAY_NAME} could not stop session ${shortId}: ${outcome.detail}`,
          `Run \`${path} stop ${shortId}\` in a terminal, or close the session yourself.`,
        );
  };
}

/** A stop is one short command against a running CLI; a longer budget here would only hide one that has hung. */
const STOP_TIMEOUT_MS = 15_000;
