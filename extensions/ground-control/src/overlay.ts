import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { parseBrowsers, spawnEnvironment } from '@ground-control/hub';
import { SECTION } from './config.js';

/**
 * Registration writes a native-host manifest and, on Windows, an HKCU entry. Explicit enable/disable commands
 * keep these changes reversible (R34).
 */
function runHub(bundle: string, home: string, mode: string, browsers: readonly string[]): Promise<string> {
  const env = spawnEnvironment();
  const args = [bundle, `--${mode}`, `--home=${home}`, `--browsers=${browsers.join(',')}`];

  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { env, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${stderr || stdout || String(error)}`.trim()));

        return;
      }

      resolve(stdout.trim());
    });
  });
}

/**
 * The overlay is loaded unpacked and excluded from the VSIX. Offer the adjacent repository path when present;
 * otherwise give repository instructions.
 */
function unpacked(context: vscode.ExtensionContext): string {
  const beside = join(context.extensionPath, '..', 'chrome-github-board');

  return existsSync(join(beside, 'manifest.json'))
    ? `Load ${beside} unpacked at chrome://extensions or edge://extensions with Developer mode on.`
    : 'Load the chrome-github-board directory from the Ground Control repository unpacked at chrome://extensions or edge://extensions, with Developer mode on.';
}

/** The selected browsers, or why the setting cannot be used. */
function overlayBrowsers(): { browsers: string[] } | { problem: string } {
  const selection = parseBrowsers(vscode.workspace.getConfiguration(SECTION).get<unknown>('overlayBrowsers', ['chrome']));

  if (selection.unknown.length > 0) {
    return { problem: `groundControl.overlayBrowsers names ${selection.unknown.join(', ')}; choose chrome or edge.` };
  }

  return selection.browsers.length === 0 ? { problem: 'groundControl.overlayBrowsers is empty; choose chrome or edge.' } : { browsers: selection.browsers };
}

export function registerOverlayCommands(context: vscode.ExtensionContext, home: string, bundle: string): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('groundControl.enableGithubOverlay', async () => {
      const selection = overlayBrowsers();

      if ('problem' in selection) {
        void vscode.window.showErrorMessage(selection.problem);

        return;
      }

      try {
        const result = await runHub(bundle, home, 'install-chrome-host', selection.browsers);

        void vscode.window.showInformationMessage(`${result} ${unpacked(context)}`);
      } catch (error) {
        void vscode.window.showErrorMessage(`Could not enable the browser overlay: ${String(error)}`);
      }
    }),
    vscode.commands.registerCommand('groundControl.disableGithubOverlay', async () => {
      const selection = overlayBrowsers();

      if ('problem' in selection) {
        void vscode.window.showErrorMessage(selection.problem);

        return;
      }

      try {
        void vscode.window.showInformationMessage(await runHub(bundle, home, 'uninstall-chrome-host', selection.browsers));
      } catch (error) {
        void vscode.window.showErrorMessage(`Could not disable the browser overlay: ${String(error)}`);
      }
    }),
  ];
}
