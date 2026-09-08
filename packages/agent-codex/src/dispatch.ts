import type { DispatchInput, DispatchResult, ReadFailure } from '@ground-control/core';
import { CODEX_AGENT_ID, CODEX_DISPLAY_NAME } from './ids.js';

/**
 * A process the board started and left running. Injected, because a dispatch is the one thing this adapter does that
 * is neither a file read nor a short-lived command: `codex exec` runs for as long as the work does, and the board
 * has to answer as soon as the thread exists rather than when the work is finished.
 */
export interface StartedProcess {
  /** Resolves with the first line of stdout that satisfies `wanted`, or null when the process ended without one. */
  firstLine(wanted: (line: string) => boolean): Promise<string | null>;
  /** The process id, so a stop has something to signal. */
  pid: number | null;
  /** Why it could not be started at all. Null once it is running. */
  failure: { reason: string; detail: string } | null;
}

export type StartProcess = (
  path: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; signal: AbortSignal },
) => Promise<StartedProcess>;

/**
 * How the board's permission modes reach Codex, which has two controls where Claude has one: a sandbox, and whether
 * an approval is asked for. The vocabulary is Claude's, because it is the board's — an adapter translates it.
 *
 * The three modes that need a human are refused rather than translated. `codex exec` has nobody to ask: an approval
 * it would raise is denied outright, so a run under `manual` starts, fails its first tool, and reports work it never
 * did (R15, R31). Refusing names the setting the developer would have to change.
 */
export function sandboxArgs(permissionMode: string): string[] | null {
  switch (permissionMode) {
    // Read-only with nothing to ask about: a session that can look and answer, which is what a plan is.
    case 'plan':
      return ['--sandbox', 'read-only', '-c', 'approval_policy="never"'];

    // `workspace-write` blocks outbound sockets, so a merge action under it cannot push — measured on Windows at
    // 0.153.4, where a connect inside the sandbox fails `EACCES` until `network_access` is set (§46).
    case 'dontAsk':
      return [
        '--sandbox',
        'workspace-write',
        '-c',
        'approval_policy="never"',
        '-c',
        'sandbox_workspace_write.network_access=true',
      ];

    case 'bypassPermissions':
      return ['--dangerously-bypass-approvals-and-sandbox'];

    default:
      return null;
  }
}

/**
 * What a dispatched run is spawned with. `--json` is what makes the thread's own id readable (`docs/mechanics.md`
 * §39); `--skip-git-repo-check` is not passed, because the checkout a card names is a checkout.
 *
 * `--` ends the flags. Without it a prompt opening with `review`, `resume`, `fork` or `help` is read as one of
 * `codex exec`'s own subcommands and the run refuses its own arguments — and "Review this diff…" is exactly how a
 * review action's prompt begins. A prompt of `-` alone would make it read the work from stdin.
 */
export function dispatchArgs(input: DispatchInput, sandbox: readonly string[]): string[] {
  return [
    'exec',
    '--json',
    ...sandbox,
    '-C',
    input.cwd,
    ...(input.model === null ? [] : ['-m', input.model]),
    '--',
    input.prompt,
  ];
}

const threadStarted = /"type"\s*:\s*"thread\.started"/;
const threadId = /"thread_id"\s*:\s*"([A-Za-z0-9-]+)"/;

/** The id out of the `thread.started` line `--json` prints first. Null for a line that is not it. */
export function threadIdFrom(line: string): string | null {
  return threadStarted.test(line) ? (threadId.exec(line)?.[1] ?? null) : null;
}

function failure(kind: string, message: string, remedy: string): ReadFailure {
  return { subject: CODEX_AGENT_ID, kind, message, remedy };
}

/**
 * Starts one piece of work in a checkout and answers with the thread id Codex minted, which it prints before the
 * work begins. Never throws: a dispatch that did not start is a named failure (R24).
 *
 * The run is headless, and it is on the board because its hooks write a marker like any other session (§40) — a
 * process editing the developer's code with nothing on screen saying so is what R2 exists to prevent.
 */
export function makeCodexDispatcher(start: StartProcess, remember: (threadId: string, pid: number | null) => void = () => {}) {
  return async function dispatch(input: DispatchInput): Promise<DispatchResult> {
    const sandbox = sandboxArgs(input.permissionMode);

    if (sandbox === null) {
      return {
        failure: failure(
          'dispatch-refused',
          `${CODEX_DISPLAY_NAME} cannot run work under the "${input.permissionMode}" permission mode: a run the board starts has nobody to answer its approval prompts, so it would fail at its first tool.`,
          'Set groundControl.actions.permissionMode to "dontAsk", "plan" or "bypassPermissions" to let the board start Codex work, or run this card with Claude.',
        ),
      };
    }

    const started = await start(input.path, dispatchArgs(input, sandbox), {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });

    if (started.failure !== null) {
      const remedy =
        started.failure.reason === 'missing' || started.failure.reason === 'not-executable'
          ? 'Check groundControl.agents, or turn the action off in Settings.'
          : 'Nothing was started. The card keeps its reading; run the action again to retry.';

      return {
        failure: failure(
          `dispatch-${started.failure.reason}`,
          `${CODEX_DISPLAY_NAME} could not start this work: ${started.failure.detail}`,
          remedy,
        ),
      };
    }

    const line = await started.firstLine((held) => threadStarted.test(held));
    const id = line === null ? null : threadIdFrom(line);

    if (id === null) {
      return {
        failure: failure(
          'dispatch-unreadable',
          `${CODEX_DISPLAY_NAME} started the work but did not say which thread it is.`,
          'The board cannot follow or stop a session it was not told the id of. Check the run in Codex, and stop it there.',
        ),
      };
    }

    // The pid of the process the board itself started, remembered before any marker exists: a run whose hooks are
    // not installed or not trusted (§41) writes no marker at all, and one nobody can stop must not be offered (R15).
    remember(id, started.pid);

    return { shortId: id };
  };
}
