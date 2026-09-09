import * as vscode from 'vscode';
import { saveLogins, splitLogins } from './config.js';

/**
 * Asks once, in place, seeded with what the hub already detected (R26, R28). Returns the logins the developer
 * confirmed, or an empty list if they dismissed the box — the board then explains itself rather than querying.
 */
export async function promptForLogins(detected: readonly string[]): Promise<string[]> {
  const answer = await vscode.window.showInputBox({
    title: 'Ground Control — GitHub accounts',
    prompt: 'GitHub usernames, separated by commas.',
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
