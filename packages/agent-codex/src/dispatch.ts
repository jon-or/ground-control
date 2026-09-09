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
 * Translate shared permission modes into Codex sandbox and approval settings. Refuse manual, auto, and
 * acceptEdits because unattended codex exec cannot obtain the approvals those modes require. Supported
 * mappings are explicit below (R31).
 */
export function sandboxArgs(permissionMode: string): string[] | null {
  switch (permissionMode) {
    // Read-only with nothing to ask about: a session that can look and answer, which is what a plan is.
    case 'plan':
      return ['--sandbox', 'read-only', '-c', 'approval_policy="never"'];

    // `workspace-write` blocks outbound sockets, so a merge action under it cannot push — measured on Windows at
    // 0.153.4, where a connect inside the sandbox fails `EACCES` until `network_access` is set (M46).
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
 * Request JSON output to identify the thread and retain Codex's repository check. Use -- to prevent prompts
 * beginning with review, resume, fork, or help from selecting a subcommand. A lone '-' remains Codex's stdin
 * sentinel and requires separate handling.
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
 * The run is headless, and it is on the board because its hooks write a marker like any other session (M40) — a
 * process editing the developer's code with nothing on screen saying so is what R2 exists to prevent.
 */
export function makeCodexDispatcher(start: StartProcess, remember: (threadId: string, pid: number | null) => void = () => {}) {
  return async function dispatch(input: DispatchInput): Promise<DispatchResult> {
    const sandbox = sandboxArgs(input.permissionMode);

    if (sandbox === null) {
      return {
        failure: failure(
          'dispatch-refused',
          `${CODEX_DISPLAY_NAME} cannot use "${input.permissionMode}" for card actions because background runs cannot accept approval prompts.`,
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
          : 'The triage result is retained. Run the action again to retry.';

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
          `${CODEX_DISPLAY_NAME} started work without returning a thread ID.`,
          'Ground Control cannot track or stop the session without its ID. Check and stop the run in Codex.',
        ),
      };
    }

    // Remember the spawn PID before hooks produce a marker so this adapter can stop the action even without
    // installed or trusted hooks (R39, mechanics M41).
    remember(id, started.pid);

    return { shortId: id };
  };
}
