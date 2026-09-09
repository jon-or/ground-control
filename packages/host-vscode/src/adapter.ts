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
 * What the developer may set about this host. `userDir` is the running install's own `User` directory, which a
 * portable or Insiders install moves. `mayOpenWindow` is R14's permission to bring another window forward, granted
 * by default because a board spanning worktrees is useless without it; that it is theirs to set is R27's.
 */
const config = z
  .object({
    userDir: z.string().min(1).optional(),
    mayOpenWindow: z.boolean().default(true),
  })
  .strict();

export type VscodeConfig = z.infer<typeof config>;

export interface VscodeHost extends HostAdapter {
  /** What `configure` last accepted, which is what a client reads to build an `OpenRequest`. */
  settings(): VscodeConfig;
}

/**
 * Plan VS Code operations for execution by a resident extension. In-process commands target that extension's
 * window; external URI routing depends on focus (mechanics M7, M8). This headless adapter implements neither
 * open nor release. Tab release remains experimental (M11).
 */
export function makeVscodeHost(placements: Readonly<Record<string, AgentPlacement>> = PLACEMENTS): VscodeHost {
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
      return readWindows(deps.home, session, placements);
    },

    async surfaces(): Promise<SessionSurface[]> {
      return surfacesFrom(await readWindowStores(settings.userDir ?? defaultUserDir(), placements), placements);
    },

    plan(request: OpenRequest): OpenPlan {
      // R14 is this host's own rule, applied where its settings were parsed: the hub has no business holding a
      // permission whose meaning is "may this application bring one of its windows forward".
      return planOpen(request, placements, settings.mayOpenWindow);
    },

    planCheckout(request: CheckoutRequest): OpenPlan {
      return planCheckout(request, settings.mayOpenWindow);
    },

    // No `mayOpenWindow`: a start never raises a window, so R14 has nothing to say about it.
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
