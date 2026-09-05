import * as vscode from 'vscode';
import { sessionFromUri } from '@ground-control/host-vscode';
import { client } from './hubClient.js';
import { agentExtensionReady } from './resident.js';

/**
 * The board's second entry point: a `vscode://ownerrez.ground-control/open?session=…` navigation from the browser
 * overlay. It exists because focus cannot be taken, only given — a navigation raises VS Code and hands this window
 * the foreground, which is what every route then needs (`docs/mechanics.md` §26, §29).
 *
 * The link is reachable from any page, so this takes one well-formed id and nothing else, and hands it to the same
 * path the board's own session row uses. The hub resolves the id against its live roster and saved history, and refuses unknown ids.
 */
export function registerUriHandler(): vscode.Disposable {
  return vscode.window.registerUriHandler({
    async handleUri(uri: vscode.Uri): Promise<void> {
      const sessionId = sessionFromUri(uri.path, uri.query);

      if (sessionId === null) {
        void vscode.window.showWarningMessage('That link does not name a session Ground Control can open.');

        return;
      }

      // Activation builds the client before it registers this handler, and VS Code delivers a URI only once
      // activation has settled — so there is no window in which this window has no client to send through.
      client()?.send({ type: 'open', sessionId, extensionReady: await agentExtensionReady() });
    },
  });
}
