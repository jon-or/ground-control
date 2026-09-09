import { z } from 'zod';
import type {
  CheckoutRequest,
  HostAdapter,
  HistoricalSession,
  HostWindows,
  MachineReaders,
  OpenPlan,
  OpenRequest,
  OpenRoute,
  ReadFailure,
  SessionSurface,
  StartRequest,
  StartableAgent,
  Session,
} from '@ground-control/core';
import { VSCODE_ROUTES, openableSessions, planCheckout, planOpen, planStart, startableAgents } from './open.js';
import { PLACEMENTS } from './placements.js';
import type { AgentPlacement } from './placements.js';
import { defaultUserDir, readWindowStores } from './stores.js';
import { surfacesFrom } from './surface.js';
import { primeWindows, readWindows } from './windows.js';

export const VSCODE_HOST_ID = 'vscode';

/**
 * Host settings: the installation's User directory and permission to focus other windows (R14, R27). Window
 * opening defaults to enabled for worktree navigation.
 */
const config = z
  .object({
    userDir: z.string().min(1).optional(),
    mayOpenWindow: z.boolean().default(true),
  })
  .strict();

export type VscodeConfig = z.infer<typeof config>;

export interface VscodeHost extends HostAdapter {
  /** Last accepted settings, used to build OpenRequest. */
  settings(): VscodeConfig;
}

/**
 * Plan VS Code operations for execution by a resident extension. In-process commands target that extension's
 * window; external URI routing depends on focus (mechanics M7, M8). This headless adapter implements neither
 * open nor release. Tab release remains experimental (M11).
 */
export function makeVscodeHost(placements: Readonly<Record<string, AgentPlacement>> = PLACEMENTS, env: NodeJS.ProcessEnv = process.env): VscodeHost {
  let settings: VscodeConfig = config.parse({});

  return {
    id: VSCODE_HOST_ID,
    residentRoutes: VSCODE_ROUTES,

    settings: () => settings,

    configure(raw: unknown): ReadFailure | null {
      const parsed = config.safeParse(raw ?? {});

      if (!parsed.success) {
        const issue = parsed.error.issues[0];

        return {
          subject: VSCODE_HOST_ID,
          kind: 'bad-config',
          message: `The "${VSCODE_HOST_ID}" host settings could not be read: ${issue?.path.join('.') || 'the value'} ${issue?.message ?? 'is not valid'}.`,
          remedy: `Fix the "${VSCODE_HOST_ID}" entry in groundControl.hosts, or remove it to use the defaults.`,
        };
      }

      settings = parsed.data;

      return null;
    },

    prime(): void {
      primeWindows(placements);
      void readWindowStores(settings.userDir ?? defaultUserDir(), placements);
    },

    windows(session: Session | undefined, deps: MachineReaders): Promise<HostWindows> {
      return readWindows(deps.home, session, placements, env);
    },

    async surfaces(): Promise<SessionSurface[]> {
      return surfacesFrom(await readWindowStores(settings.userDir ?? defaultUserDir(), placements), placements);
    },

    plan(request: OpenRequest): OpenPlan {
      // Apply window-opening permission in the host that owns the setting (R14).
      return planOpen(request, placements, settings.mayOpenWindow);
    },

    planCheckout(request: CheckoutRequest): OpenPlan {
      return planCheckout(request, settings.mayOpenWindow);
    },

    // Starting a session stays in the current window; window-opening permission does not apply (R14).
    planStart(request: StartRequest): OpenPlan {
      return planStart(request, placements);
    },

    startable(): readonly StartableAgent[] {
      return startableAgents(placements);
    },

    openable(sessions: readonly Session[], history: readonly HistoricalSession[] = []): string[] {
      return openableSessions([...sessions, ...history], placements);
    },
  };
}

export type VscodeRoute = OpenRoute['route'];
