import { isAbsolute } from '@ground-control/core';
import type { ActionReport } from '@ground-control/core';
import { readActionReport } from '@ground-control/automation';
import { writeAtomic } from './fs.js';

export const RESULT_USAGE =
  'Usage: result <completed|awaiting-approval|blocked> --to <result path> --detail "<text>" ' +
  '[--audit <absolute path>] [--approve "<prompt>"] [--worktree <absolute path>]';

/** Exit codes a skill branches on: a usage error is the skill's to fix; a write failure is not (R39). */
export const RESULT_EXIT = { recorded: 0, usage: 1, unwritten: 2 } as const;

const OPTIONS = ['to', 'detail', 'audit', 'approve', 'worktree'] as const;

/** A run's result and the file it goes to. */
export interface ResultRequest {
  to: string;
  report: ActionReport;
}

/**
 * Undo Git Bash's rewrite of `/` at the start of an argument or after its first `=`: `/address-qa 1 publish` arrives
 * as `C:/Program Files/Git/address-qa 1 publish` (M33). `root` is `cygpath -m /`, or null outside Git Bash.
 */
export function unconverted(value: string, root: string | null): string {
  if (root === null || !root.endsWith('/')) return value;

  const at = value.startsWith(root) ? 0 : value.indexOf(`=${root}`);

  if (at < 0) return value;

  const start = at === 0 && value.startsWith(root) ? 0 : at + 1;

  return `${value.slice(0, start)}/${value.slice(start + root.length)}`;
}

/** Read `<outcome> --to <path> --detail <text> [...]` after `result`, each option also as `--name=value`. */
export function parseResultArgs(argv: readonly string[], msysRoot: string | null = null): ResultRequest | { usage: string } {
  const positional: string[] = [];
  const options: Partial<Record<(typeof OPTIONS)[number], string>> = {};

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    const named = /^--([a-z]+)(?:=(.*))?$/s.exec(argument);

    if (named !== null) {
      const name = named[1] as (typeof OPTIONS)[number];

      if (!OPTIONS.includes(name)) return { usage: `Unknown option ${argument}. ${RESULT_USAGE}` };
      // A value that starts with `--` is the next option, so the value was left out; `--name=--text` passes such text.
      if (named[2] === undefined && (index + 1 >= argv.length || argv[index + 1]!.startsWith('--'))) {
        return { usage: `--${name} needs a value. ${RESULT_USAGE}` };
      }

      options[name] = named[2] ?? argv[++index]!;
    } else {
      positional.push(argument);
    }
  }

  const [outcome] = positional;
  const { to, audit, worktree } = options;
  const detail = options.detail === undefined ? undefined : unconverted(options.detail, msysRoot).trim();
  const approve = options.approve === undefined ? undefined : unconverted(options.approve, msysRoot).trim();

  if (positional.length !== 1 || (outcome !== 'completed' && outcome !== 'awaiting-approval' && outcome !== 'blocked')) {
    return { usage: RESULT_USAGE };
  }

  if (to === undefined || !isAbsolute(to) || !to.endsWith('.json')) {
    return { usage: `--to takes the absolute .json result path the run was given. ${RESULT_USAGE}` };
  }

  if (detail === undefined || detail === '') {
    return { usage: `--detail is required. ${RESULT_USAGE}` };
  }

  for (const [name, path] of [['audit', audit], ['worktree', worktree]] as const) {
    if (path !== undefined && !isAbsolute(path)) return { usage: `--${name} takes an absolute path. ${RESULT_USAGE}` };
  }

  if (approve !== undefined && (outcome !== 'awaiting-approval' || approve === '')) {
    return { usage: `--approve takes a prompt, and only with awaiting-approval. ${RESULT_USAGE}` };
  }

  if (worktree !== undefined && outcome !== 'completed') {
    return { usage: `--worktree goes only with completed. ${RESULT_USAGE}` };
  }

  const report = readActionReport({
    outcome,
    detail,
    ...(audit === undefined ? {} : { auditPath: audit }),
    ...(approve === undefined ? {} : { approve }),
    ...(worktree === undefined ? {} : { worktree }),
  });

  return report === null ? { usage: RESULT_USAGE } : { to, report };
}

/** Write the result file the hub reads when the run ends, and the one line the command prints. */
export function recordResult(request: ResultRequest, write: (path: string, text: string) => void = writeAtomic): { code: number; line: string } {
  try {
    write(request.to, `${JSON.stringify(request.report)}\n`);
  } catch (error) {
    return { code: RESULT_EXIT.unwritten, line: `Result not recorded: ${error instanceof Error ? error.message : String(error)}` };
  }

  return { code: RESULT_EXIT.recorded, line: `Result recorded: ${request.report.outcome}.` };
}
