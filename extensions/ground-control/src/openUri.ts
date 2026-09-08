import * as vscode from 'vscode';
import { agentOfSession } from '@ground-control/core';
import { handedOver, sessionFromUri } from '@ground-control/host-vscode';
import { client } from './hubClient.js';
import { agentExtensionReady } from './resident.js';

/**
 * The board's second entry point: a `vscode://groundcontrol.ground-control/open?session=…` navigation from the browser
 * overlay. It exists because focus cannot be taken, only given — a navigation raises VS Code and hands this window
 * the foreground, which is what every route then needs (`docs/mechanics.md` §26, §29).
 *
 * The link is reachable from any page, so this takes one well-formed id, an agent where the board named one, and nothing else. Every path goes through the hub, which resolves the id against its live roster and saved history and refuses what it does not know.
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
      const held = client();

      // Which extension has to be up is the session's own agent's. A hand-over names it in the URI, because the
      // window the board raised may never have had a board open and so may hold no snapshot to read it from; a link
      // a developer clicked is read off the snapshot, and falls back to Claude where this window has none.
      const handed = handedOver(uri.query);
      const agent = handed ?? agentOfSession(held?.snapshot, sessionId);

      // A hand-over goes through the hub like any other open. The hub is local and every window can reach it, and
      // it is what proves the session exists, which surface holds it, and whether a resume is allowed — none of
      // which a link can prove, and this link is reachable from any page in the browser.
      held?.send({
        type: 'open',
        sessionId,
        extensionReady: await agentExtensionReady(agent),
        ...(handed === null ? {} : { handedOver: true }),
      });
    },
  });
}
