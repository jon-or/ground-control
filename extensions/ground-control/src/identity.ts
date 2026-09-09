import * as vscode from 'vscode';
import { saveLogins, splitLogins } from './config.js';

/**
 * Prefill GitHub identities from detected accounts (R26, R28). Return confirmed logins, or an empty list on
 * cancellation.
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
