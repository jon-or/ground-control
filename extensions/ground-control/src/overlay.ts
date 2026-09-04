import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { spawnEnvironment } from '@ground-control/hub';

/**
 * Registering the browser overlay writes outside the extension's own storage — a manifest in the developer's Chrome
 * profile, and on Windows a key under `HKCU`. R34 asks that such a thing be a deliberate act and reversible the same
 * way, so it is two commands rather than something activation does.
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
 * What to hand Chrome's `Load unpacked`, when this install has it to hand. The browser extension is not on the
 * Chrome Web Store; it sits beside the editor extension in the repository, which an installed `.vsix` does not
 * carry — so a path is offered only where one exists rather than named and found missing.
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
        const said = await runHub(bundle, home, 'install-chrome-host');

        void vscode.window.showInformationMessage(`${said} ${unpacked(context)}`);
      } catch (error) {
        void vscode.window.showErrorMessage(`The browser overlay could not be enabled: ${String(error)}`);
      }
    }),
    vscode.commands.registerCommand('groundControl.disableGithubOverlay', async () => {
      try {
        void vscode.window.showInformationMessage(await runHub(bundle, home, 'uninstall-chrome-host'));
      } catch (error) {
        void vscode.window.showErrorMessage(`The browser overlay could not be disabled: ${String(error)}`);
      }
    }),
  ];
}
