import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { spawnEnvironment } from '@ground-control/hub';

/**
 * Registration writes a native-host manifest and, on Windows, an HKCU entry. Explicit enable/disable commands
 * keep these changes reversible (R34).
 */
function runHub(bundle: string, home: string, mode: string): Promise<string> {
  const env = spawnEnvironment();

  return new Promise((resolve, reject) => {
    execFile(process.execPath, [bundle, `--${mode}`, `--home=${home}`], { env, windowsHide: true }, (error, stdout, stderr) => {
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
    ? `Load ${beside} in Chrome at chrome://extensions with Developer mode on.`
    : 'Load the chrome-github-board directory from the Ground Control repository at chrome://extensions, with Developer mode on.';
}

export function registerOverlayCommands(context: vscode.ExtensionContext, home: string, bundle: string): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('groundControl.enableGithubOverlay', async () => {
      try {
        const result = await runHub(bundle, home, 'install-chrome-host');

        void vscode.window.showInformationMessage(`${result} ${unpacked(context)}`);
      } catch (error) {
        void vscode.window.showErrorMessage(`Could not enable the browser overlay: ${String(error)}`);
      }
    }),
    vscode.commands.registerCommand('groundControl.disableGithubOverlay', async () => {
      try {
        void vscode.window.showInformationMessage(await runHub(bundle, home, 'uninstall-chrome-host'));
      } catch (error) {
        void vscode.window.showErrorMessage(`Could not disable the browser overlay: ${String(error)}`);
      }
    }),
  ];
}
