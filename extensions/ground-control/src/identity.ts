import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import { parseAuthStatusLogins } from '@ground-control/github';
import { saveLogins, splitLogins } from './config.js';

function ghAuthStatus(ghPath: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(ghPath, ['auth', 'status'], (err, stdout, stderr) => resolve(`${stdout}${stderr}`));
  });
}

/**
 * Asks once, in place, seeded with whatever `gh` already knows (R26/R28). Returns the logins the developer
 * confirmed, or an empty list if they dismissed the box — the board then explains itself rather than querying.
 */
export async function promptForLogins(ghPath: string): Promise<string[]> {
  const detected = parseAuthStatusLogins(await ghAuthStatus(ghPath));

  const answer = await vscode.window.showInputBox({
    title: 'Ground Control — whose issues is this board for?',
    prompt: 'GitHub username. Comma-separate several if you work under more than one account.',
    value: detected.join(','),
    placeHolder: 'your-github-username',
    ignoreFocusOut: true,
  });

  if (answer === undefined) {
    return [];
  }

  const logins = splitLogins(answer);

  if (logins.length > 0) {
    await saveLogins(logins);
  }

  return logins;
}
