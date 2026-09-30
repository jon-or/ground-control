import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as promises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The canonical path is read after the file is opened; these tests stand in for a link changed in between.
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof promises>();

  return { ...actual, realpath: vi.fn(actual.realpath) };
});

const { renderReport } = await import('../src/report.js');
const realpath = vi.mocked(promises.realpath);
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

let round: string;

beforeEach(() => {
  round = mkdtempSync(join(tmpdir(), 'gc-report-link-'));
  mkdirSync(join(round, 'screenshots'));
  writeFileSync(join(round, 'screenshots', 'one.png'), PNG);
  writeFileSync(join(round, 'screenshots', 'other.png'), PNG);
});

afterEach(() => {
  realpath.mockRestore();
  rmSync(round, { recursive: true, force: true });
});

const envelope = (html: string) => ({ html });

describe('a report path whose link changes while it is read (R51)', () => {
  it('refuses an image whose canonical path names another file than the one opened', async () => {
    writeFileSync(join(round, 'review.md'), '![x](screenshots/one.png)');
    const actual = await vi.importActual<typeof promises>('node:fs/promises');
    realpath.mockImplementation(async (path) => (String(path).endsWith('one.png') ? join(round, 'screenshots', 'other.png') : actual.realpath(path)));

    const rendered = await renderReport(join(round, 'review.md'), envelope);

    expect(rendered.ok && rendered.html).toContain('[Image one.png: cannot be read]');
  });

  it('refuses a report whose canonical path is a network share', async () => {
    writeFileSync(join(round, 'review.md'), '# Round 1');
    realpath.mockResolvedValue(String.raw`\\server\share\review.md`);

    expect(await renderReport(join(round, 'review.md'), envelope)).toEqual({ ok: false, name: 'review.md', failure: 'The run named its report by a path the board does not read.' });
  });
});
