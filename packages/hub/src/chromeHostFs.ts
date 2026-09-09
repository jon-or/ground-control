import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  read(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },

  registry(args) {
    try {
      execFileSync('reg', [...args], { stdio: 'pipe', windowsHide: true });

      return null;
    } catch (error) {
      return String(error);
    }
  },

  registered(key) {
    try {
      // The value label is localized; the type column is not.
      const output = execFileSync('reg', ['query', key, '/ve'], { stdio: 'pipe', windowsHide: true, encoding: 'utf8' });

      return /REG_SZ\s+(.+?)\s*$/m.exec(output)?.[1] ?? null;
    } catch {
      return null;
    }
  },
};
