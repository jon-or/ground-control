import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

/**
 * Temp variables that put every test temp file, and those of the processes tests start, in one `gc-tests` folder, which
 * a developer can exclude from antivirus scanning (docs/testing.md, Isolation).
 */
export function testTemp(): Record<string, string> {
  const base = tmpdir();
  const dir = basename(base) === 'gc-tests' ? base : join(base, 'gc-tests');

  mkdirSync(dir, { recursive: true });

  return { TEMP: dir, TMP: dir, TMPDIR: dir };
}
