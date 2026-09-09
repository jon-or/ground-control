import * as vscode from 'vscode';
import { agentOfSession, sessionOf } from '@ground-control/core';
import type { Session } from '@ground-control/core';
import { attachFromUri, handedOver, sessionFromUri } from '@ground-control/host-vscode';
import { attachTo } from './attach.js';
import { client } from './hubClient.js';
import { agentExtensionReady } from './resident.js';

/**
 * Handle browser and cross-window session links. Validate the ID and agent before resolving an open through
 * the hub or an attach through the roster. OS URI routing and foreground activation have measured limits
 * (mechanics M26, M29); receiving a link does not establish session ownership.
 */
export function registerUriHandler(): vscode.Disposable {
  return vscode.window.registerUriHandler({
    async handleUri(uri: vscode.Uri): Promise<void> {
      // Before the open read, and never through the hub: a detached run is entered by attaching to it, which is
      // this window's own terminal rather than a surface the hub could route to.
      const attaching = attachFromUri(uri.path, uri.query);

      if (attaching !== null) {
        await attach(attaching);

        return;
      }

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

/** How long a link is given to find its run. A cold window registers its hub in 3.2s (`docs/mechanics.md` M8). */
const ATTACH_DEADLINE_MS = 8_000;

async function attach(sessionId: string): Promise<void> {
  const known = await runNamed(sessionId);

  if (!known || !attachTo(known)) {
    void vscode.window.showWarningMessage('That run is no longer on this machine, or is not one the board can attach to.');
  }
}

/**
 * Resolve an attach ID from the snapshot or a fresh roster. URI activation can precede connection: retry null
 * roster responses until the deadline, but treat a returned list as authoritative for that read.
 */
async function runNamed(sessionId: string): Promise<Session | null> {
  const held = client();

  if (!held) {
    return null;
  }

  for (const deadline = Date.now() + ATTACH_DEADLINE_MS; ; ) {
    const shown = sessionOf(held.snapshot, sessionId);

    if (shown) {
      return shown;
    }

    const roster = await held.roster();

    if (roster !== null) {
      return roster.find((session) => session.sessionId === sessionId) ?? null;
    }

    if (Date.now() >= deadline) {
      return null;
    }

    await new Promise((wake) => setTimeout(wake, 500));
  }
}
