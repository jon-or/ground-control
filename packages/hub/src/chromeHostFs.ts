import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChromeHostDeps } from './chromeHost.js';

/** Execute native-host filesystem and registry operations. Shared by registration and uninstall; chromeHost.ts defines the tested plan. */
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
