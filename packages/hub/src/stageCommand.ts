import { STAGE_STEP_LIMIT, WORKFLOW_STAGES } from '@ground-control/core';
import type { StageRequest, StageStep } from '@ground-control/core';
import type { StageSent } from './discover.js';

export const STAGE_USAGE = `Usage: stage <issue> <plan|build|review|done> [--note "<text>"] [--step <n>/<of>], with 1 <= n <= of <= ${STAGE_STEP_LIMIT}`;

/** Exit codes a skill branches on: nothing recorded because no hub answered is not the same as a refusal (R49). */
export const STAGE_EXIT = { recorded: 0, usage: 1, unreached: 2, refused: 3 } as const;

/** `<n>/<of>`, or null where it is not one. */
function stepOf(text: string): StageStep | null {
  const match = /^(\d+)\/(\d+)$/.exec(text.trim());
  const n = Number(match?.[1]);
  const of = Number(match?.[2]);

  return match !== null && n >= 1 && n <= of && of <= STAGE_STEP_LIMIT ? { n, of } : null;
}

/** Read `<issue> <stage> [--note <text>] [--step <n>/<of>]`, each option also as `--name=value`, after `stage`. */
export function parseStageArgs(argv: readonly string[]): StageRequest | { usage: string } {
  const positional: string[] = [];
  const options: Record<string, string> = {};

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    const named = /^--(note|step)(?:=(.*))?$/s.exec(argument);

    if (named !== null) {
      if (named[2] === undefined && index + 1 >= argv.length) return { usage: `--${named[1]} needs a value. ${STAGE_USAGE}` };
      options[named[1]!] = named[2] ?? argv[++index]!;
    } else if (argument.startsWith('--')) {
      return { usage: `Unknown option ${argument}. ${STAGE_USAGE}` };
    } else {
      positional.push(argument);
    }
  }

  const [issueText, stage] = positional;
  const issue = Number(issueText?.replace(/^#/, ''));
  const stages: readonly string[] = [...WORKFLOW_STAGES, 'done'];

  if (positional.length !== 2 || !Number.isSafeInteger(issue) || issue <= 0 || stage === undefined || !stages.includes(stage)) {
    return { usage: STAGE_USAGE };
  }

  const step = options.step === undefined ? undefined : stepOf(options.step);

  if (step === null) {
    return { usage: `--step takes <n>/<of>. ${STAGE_USAGE}` };
  }

  return { issue, stage: stage as StageRequest['stage'], note: options.note ?? '', ...(step === undefined ? {} : { step }) };
}

/** The exit code and the one line a stage report prints. */
export function stageOutcome(request: StageRequest, sent: StageSent): { code: number; line: string } {
  if ('unreached' in sent) {
    return { code: STAGE_EXIT.unreached, line: `Stage not recorded: ${sent.unreached}.` };
  }

  const { answer } = sent;

  if (!answer.ok) {
    return { code: STAGE_EXIT.refused, line: `Stage refused: ${answer.reason}` };
  }

  if (request.stage === 'done') {
    return { code: STAGE_EXIT.recorded, line: `Issue ${request.issue} released from its workflow stage.` };
  }

  const where = answer.pending
    ? `Issue ${request.issue} is not on the board yet; it goes to ${request.stage} once it appears`
    : `Issue ${request.issue} is in ${answer.lane ?? request.stage}`;

  return { code: STAGE_EXIT.recorded, line: `${where}${answer.note === '' ? '' : ` · ${answer.note}`}.` };
}
