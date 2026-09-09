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
 * Read the eight-character session UUID prefix from `backgrounded · <short> · <name>`. Ignore help text and
 * return null for unrecognized output; the session may have started without a trackable ID.
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
 * Start background work and return its CLI-assigned ID, or a failure (R24). `--bg` returns after startup; the
 * timeout limits the CLI response wait, not the work duration.
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
          : 'The triage result is retained. Run the action again to retry.';

      return { failure: failure(`dispatch-${outcome.reason}`, `${CLAUDE_DISPLAY_NAME} could not start this work: ${outcome.detail}`, remedy) };
    }

    const shortId = shortIdFrom(outcome.text);

    if (shortId === null) {
      return {
        failure: failure(
          'dispatch-unreadable',
          `${CLAUDE_DISPLAY_NAME} started work without returning a session ID.`,
          `Run \`${input.path} agents\` to find the session. Ground Control cannot track or stop it without its ID.`,
        ),
      };
    }

    return { shortId };
  };
}

/**
 * Stop adapter-started sessions with `claude stop`. Avoid `claude rm`, which can delete the session worktree
 * containing user code (M33).
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

/** Limit the wait for an unresponsive stop command. */
const STOP_TIMEOUT_MS = 15_000;
