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
      // Handle detached attach locally in a terminal before normal hub session routing.
      const attaching = attachFromUri(uri.path, uri.query);

      if (attaching !== null) {
        await attach(attaching);

        return;
      }

      const sessionId = sessionFromUri(uri.path, uri.query);

      if (sessionId === null) {
        void vscode.window.showWarningMessage('Invalid or unsupported session link.');

        return;
      }

      // Activation creates the client before registering this URI handler.
      const held = client();

      // Resolve the agent from cross-window URI parameters or the snapshot; default to Claude when neither is
      // available.
      const handed = handedOver(uri.query);
      const agent = handed ?? agentOfSession(held?.snapshot, sessionId);

      // Validate session identity, placement, and resume permission through the hub. Browser-accessible links
      // cannot authorize these operations.
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
    void vscode.window.showWarningMessage('This run is unavailable or does not support attaching.');
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

    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
