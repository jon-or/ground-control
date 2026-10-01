import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readActionReport } from '@ground-control/automation';
import { RESULT_EXIT, RESULT_USAGE, parseResultArgs, recordResult, unconverted } from '../src/resultCommand.js';
import { tempHome } from './helpers.js';

const TO = 'C:/Users/dev/.claude/ground-control/runs/issue-19719.json';
const GIT = 'C:/Program Files/Git/';

describe('the result command a run records its outcome with (R39)', () => {
  it('reads each outcome with its options, in either form', () => {
    expect(parseResultArgs(['completed', '--to', TO, '--detail', 'Posted the reply.'])).toEqual({
      to: TO, report: { outcome: 'completed', detail: 'Posted the reply.' },
    });
    expect(parseResultArgs([
      'awaiting-approval', `--to=${TO}`, '--detail=Reply drafted.', '--audit', 'C:/w/.wip/qa-response.md', '--approve', '/address-qa 19719 publish',
    ])).toEqual({
      to: TO,
      report: { outcome: 'awaiting-approval', detail: 'Reply drafted.', auditPath: 'C:/w/.wip/qa-response.md', approve: '/address-qa 19719 publish' },
    });
    expect(parseResultArgs(['--detail', 'Which status?', 'blocked', '--to', TO])).toEqual({ to: TO, report: { outcome: 'blocked', detail: 'Which status?' } });
    expect(parseResultArgs(['completed', '--to', TO, '--detail', 'Made it.', '--worktree', 'D:/w/19719'])).toEqual({
      to: TO, report: { outcome: 'completed', detail: 'Made it.', worktree: 'D:/w/19719' },
    });
  });

  it('refuses what the hub could not read as the run meant it, naming the fix', () => {
    const refused = (argv: string[]): string => {
      const parsed = parseResultArgs(argv);

      return 'usage' in parsed ? parsed.usage : 'accepted';
    };

    expect(refused(['--to', TO, '--detail', 'x'])).toBe(RESULT_USAGE);
    expect(refused(['done', '--to', TO, '--detail', 'x'])).toBe(RESULT_USAGE);
    expect(refused(['completed', 'blocked', '--to', TO, '--detail', 'x'])).toBe(RESULT_USAGE);
    expect(refused(['completed', '--detail', 'x'])).toMatch(/^--to takes the absolute \.json result path/);
    expect(refused(['completed', '--to', 'runs/issue-1.json', '--detail', 'x'])).toMatch(/^--to takes/);
    expect(refused(['completed', '--to', 'C:/runs/issue-1.txt', '--detail', 'x'])).toMatch(/^--to takes/);
    expect(refused(['completed', '--to', TO])).toMatch(/^--detail is required/);
    expect(refused(['completed', '--to', TO, '--detail', '  '])).toMatch(/^--detail is required/);
    expect(refused(['completed', '--to', TO, '--detail', 'x', '--audit', 'qa-response.md'])).toMatch(/^--audit takes an absolute path/);
    expect(refused(['completed', '--to', TO, '--detail', 'x', '--worktree', 'w'])).toMatch(/^--worktree takes an absolute path/);
    expect(refused(['completed', '--to', TO, '--detail', 'x', '--approve', '/address-qa 1 publish'])).toMatch(/^--approve takes a prompt, and only with awaiting-approval/);
    expect(refused(['awaiting-approval', '--to', TO, '--detail', 'x', '--approve', ' '])).toMatch(/^--approve takes a prompt/);
    expect(refused(['blocked', '--to', TO, '--detail', 'x', '--worktree', 'D:/w'])).toMatch(/^--worktree goes only with completed/);
    expect(refused(['completed', '--to', TO, '--detail', 'x', '--outcome', 'y'])).toMatch(/^Unknown option --outcome\./);
    expect(refused(['completed', '--to', TO, '--detail'])).toMatch(/^--detail needs a value\./);
    // A left-out value must not take the next option as its text.
    expect(refused(['completed', '--to', TO, '--detail', '--approve'])).toMatch(/^--detail needs a value\./);
    expect(refused(['awaiting-approval', '--to', TO, '--detail', 'x', '--approve', '--audit', 'C:/r.md'])).toMatch(/^--approve needs a value\./);
    expect(parseResultArgs(['blocked', '--to', TO, '--detail=--force was refused'])).toEqual({ to: TO, report: { outcome: 'blocked', detail: '--force was refused' } });
  });

  /** Git Bash turns a leading `/` into its install root, so `/address-qa` would approve with a path (M33). */
  it('restores a slash Git Bash rewrote in the approve prompt and the detail', () => {
    expect(parseResultArgs(['awaiting-approval', '--to', TO, '--detail', `${GIT}tmp is full`, '--approve', `${GIT}address-qa 19719 publish`], GIT)).toEqual({
      to: TO, report: { outcome: 'awaiting-approval', detail: '/tmp is full', approve: '/address-qa 19719 publish' },
    });
    expect(unconverted(`see x=${GIT}y`, GIT)).toBe('see x=/y');
    expect(unconverted(`Posted; see ${GIT}y`, GIT)).toBe(`Posted; see ${GIT}y`);
    expect(unconverted(`${GIT}address-qa 1 publish`, null)).toBe(`${GIT}address-qa 1 publish`);
    expect(unconverted('/address-qa 1 publish', GIT)).toBe('/address-qa 1 publish');
  });
});

describe('writing the result file', () => {
  let home: string;
  let dispose: () => void;

  beforeEach(() => {
    ({ home, dispose } = tempHome());
  });

  afterEach(() => dispose());

  it('writes a file the hub reads back as the same report', () => {
    const to = join(home, 'issue-19719.json').replace(/\\/g, '/');
    const parsed = parseResultArgs(['awaiting-approval', '--to', to, '--detail', 'Reply drafted.', '--approve', '/address-qa 19719 publish']);

    if ('usage' in parsed) throw new Error(parsed.usage);

    expect(recordResult(parsed)).toEqual({ code: RESULT_EXIT.recorded, line: 'Result recorded: awaiting-approval.' });
    expect(readActionReport(JSON.parse(readFileSync(to, 'utf8')))).toEqual(parsed.report);
  });

  it('reports a file it could not write, apart from a usage error', () => {
    const to = join(home, 'missing', 'issue-1.json').replace(/\\/g, '/');
    const outcome = recordResult({ to, report: { outcome: 'blocked', detail: 'x' } });

    expect(outcome.code).toBe(RESULT_EXIT.unwritten);
    expect(outcome.line).toMatch(/^Result not recorded: .*ENOENT/);
  });
});
