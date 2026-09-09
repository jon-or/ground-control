import type { DispatchInput, DispatchResult, ReadFailure } from '@ground-control/core';
import { CODEX_AGENT_ID, CODEX_DISPLAY_NAME } from './ids.js';

/**
 * Injected detached process handle. Return when the thread ID is available; codex exec continues until its work
 * finishes.
 */
export interface StartedProcess {
  /** Resolves with the first line of stdout that satisfies `wanted`, or null when the process ended without one. */
  firstLine(wanted: (line: string) => boolean): Promise<string | null>;
  /** Process ID used to stop the run. */
  pid: number | null;
  /** Startup error, or null when running. */
  failure: { reason: string; detail: string } | null;
}

export type StartProcess = (
  path: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; signal: AbortSignal; env?: NodeJS.ProcessEnv },
) => Promise<StartedProcess>;

/**
 * Translate shared permission modes into Codex sandbox and approval settings. Refuse manual, auto, and
 * acceptEdits because unattended codex exec cannot obtain the approvals those modes require. Supported
 * mappings are explicit below (R31).
 */
const SANDBOX_ARGS: Readonly<Record<string, readonly string[]>> = {
  // Plan mode permits reads without approval prompts.
  plan: ['--sandbox', 'read-only', '-c', 'approval_policy="never"'],
  // Explicit network access permits pushes from workspace-write (M46).
  dontAsk: ['--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '-c', 'sandbox_workspace_write.network_access=true'],
  bypassPermissions: ['--dangerously-bypass-approvals-and-sandbox'],
};

export const DISPATCH_PERMISSIONS: readonly string[] = Object.keys(SANDBOX_ARGS);

export function sandboxArgs(permissionMode: string): string[] | null {
  return Object.hasOwn(SANDBOX_ARGS, permissionMode) ? [...SANDBOX_ARGS[permissionMode]!] : null;
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

/** Read the ID from the initial thread.started JSON record; return null for other lines. */
export function threadIdFrom(line: string): string | null {
  return threadStarted.test(line) ? (threadId.exec(line)?.[1] ?? null) : null;
}

function failure(kind: string, message: string, remedy: string): ReadFailure {
  return { subject: CODEX_AGENT_ID, kind, message, remedy };
}

/**
 * Start detached work and return the Codex-assigned thread ID, or a classified failure (R24). Hooks supply
 * board activity markers for the headless run (R2, M40).
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
