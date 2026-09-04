import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChromeHostDeps } from './chromeHost.js';

/**
 * The machine half of the browser registration: three file operations and `reg.exe`. Every decision it carries out
 * is in `chromeHost.ts` and tested against a fake — this is here rather than in a client because two of them do it,
 * the command that registers and the uninstall that reverses it, and they must write the same thing.
 */
export const realChromeHostDeps: ChromeHostDeps = {
  write(path, text, executable) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);

    if (executable) {
      chmodSync(path, 0o700);
    }
  },

  remove(path) {
    rmSync(path, { force: true });
  },

  registry(args) {
    try {
      execFileSync('reg', [...args], { stdio: 'pipe', windowsHide: true });

      return null;
    } catch (error) {
      return String(error);
    }
  },
};
