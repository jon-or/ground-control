import { describe, expect, it } from 'vitest';
import { FrictionFixes, frictionReportPath, frictionSummaryPath } from '../src/frictionFixes.js';
import { captureLog } from './helpers.js';

const DIR = 'C:/Users/dev/.claude/.wip/debrief';
const SUMMARY = 'C:/Users/dev/.claude/.wip/debrief/fixes/summary.json';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: refused`), { code });
}

/** A summary reader that answers each read from `answers` in turn, and fails a read the test did not script. */
function reading(answers: (string | NodeJS.ErrnoException)[]) {
  const logging = captureLog();
  const paths: string[] = [];
  const fixes = new FrictionFixes({
    log: logging.log,
    readFile: async (path) => {
      paths.push(path);
      const next = answers.shift();

      if (next === undefined) throw new Error('an unscripted read');
      if (typeof next !== 'string') throw next;

      return next;
    },
  });

  return { fixes, paths, warned: () => logging.entries.filter((entry) => entry.level === 'warn').map((entry) => entry.message) };
}

const summary = (toReview: unknown, v: unknown = 1) => JSON.stringify({ v, generatedAt: '2026-10-02T06:00:00.000Z', toReview });

describe('the friction fixes summary (R52)', () => {
  it('names the summary and the report under the debrief directory', () => {
    expect(frictionSummaryPath(DIR)).toBe(SUMMARY);
    expect(frictionReportPath(DIR)).toBe('C:/Users/dev/.claude/.wip/debrief/report.md');
  });

  it('reads the count, says when it changed, and keeps fields it does not know', async () => {
    const r = reading([summary(12), summary(12), JSON.stringify({ v: 1, generatedAt: '2026-10-02T08:00:00+02:00', toReview: 3, problems: 9 }), summary(0)]);

    expect(r.fixes.count()).toBe(0);
    expect(await r.fixes.read(DIR)).toBe(true);
    expect(r.fixes.count()).toBe(12);
    expect(await r.fixes.read(DIR)).toBe(false);
    expect(await r.fixes.read(DIR)).toBe(true);
    expect(r.fixes.count()).toBe(3);
    expect(await r.fixes.read(DIR)).toBe(true);
    expect(r.fixes.count()).toBe(0);
    expect(r.paths).toEqual([SUMMARY, SUMMARY, SUMMARY, SUMMARY]);
    expect(r.warned()).toEqual([]);
  });

  it('shows nothing for a missing file or directory, without logging', async () => {
    const r = reading([summary(4), errno('ENOENT'), errno('ENOTDIR')]);

    await r.fixes.read(DIR);
    expect(await r.fixes.read(DIR)).toBe(true);
    expect(r.fixes.count()).toBe(0);
    expect(await r.fixes.read(DIR)).toBe(false);
    expect(r.warned()).toEqual([]);
  });

  it.each([
    ['version 2', summary(5, 2), `${SUMMARY} is not a version 1 summary (v: Invalid literal value, expected 1), so no friction fixes are shown.`],
    ['a negative count', summary(-1), `${SUMMARY} is not a version 1 summary (toReview: Number must be greater than or equal to 0), so no friction fixes are shown.`],
    ['a fractional count', summary(1.5), `${SUMMARY} is not a version 1 summary (toReview: Expected integer, received float), so no friction fixes are shown.`],
    ['a count as text', summary('5'), `${SUMMARY} is not a version 1 summary (toReview: Expected number, received string), so no friction fixes are shown.`],
    ['a generatedAt that is not an ISO time', JSON.stringify({ v: 1, generatedAt: 'yesterday', toReview: 5 }), `${SUMMARY} is not a version 1 summary (generatedAt: Invalid datetime), so no friction fixes are shown.`],
    ['no generatedAt', JSON.stringify({ v: 1, toReview: 5 }), `${SUMMARY} is not a version 1 summary (generatedAt: Required), so no friction fixes are shown.`],
    ['an array', '[]', `${SUMMARY} is not a version 1 summary (value: Expected object, received array), so no friction fixes are shown.`],
    ['not JSON', '{"v":1,', `${SUMMARY} is not JSON, so no friction fixes are shown.`],
  ])('shows nothing for %s, and logs it once however often it is read', async (_, text, said) => {
    const r = reading([summary(7), text, text, text]);

    await r.fixes.read(DIR);
    expect(await r.fixes.read(DIR)).toBe(true);
    expect(r.fixes.count()).toBe(0);
    await r.fixes.read(DIR);
    await r.fixes.read(DIR);
    expect(r.warned()).toEqual([said]);
  });

  it('logs an unreadable file once, a different error again, and the first again after a good read', async () => {
    const r = reading([errno('EACCES'), errno('EACCES'), errno('EISDIR'), summary(2), errno('EACCES')]);

    for (let n = 0; n < 5; n++) await r.fixes.read(DIR);

    expect(r.warned()).toEqual([
      `Could not read ${SUMMARY}: EACCES: refused`,
      `Could not read ${SUMMARY}: EISDIR: refused`,
      `Could not read ${SUMMARY}: EACCES: refused`,
    ]);
    expect(r.fixes.count()).toBe(0);
  });

  it('keeps the newer of two reads that finish out of order', async () => {
    const logging = captureLog();
    const held: ((text: string) => void)[] = [];
    const fixes = new FrictionFixes({ log: logging.log, readFile: () => new Promise((resolve) => held.push(resolve)) });

    const older = fixes.read('C:/old');
    const newer = fixes.read(DIR);

    held[1]!(summary(3));
    expect(await newer).toBe(true);
    held[0]!(summary(9));
    expect(await older).toBe(false);
    expect(fixes.count()).toBe(3);
  });
});
