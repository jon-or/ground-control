import { z } from 'zod';
import type {
  HostAdapter,
  HistoricalSession,
  HostWindows,
  MachineReaders,
  OpenPlan,
  OpenRequest,
  OpenRoute,
  ReadFailure,
  SessionSurface,
  Session,
} from '@ground-control/core';
import { VSCODE_ROUTES, openableSessions, planOpen } from './open.js';
import { PLACEMENTS } from './placements.js';
import type { AgentPlacement } from './placements.js';
import { defaultUserDir, readWindowStores } from './stores.js';
import { surfacesFrom } from './surface.js';
import { primeWindows, readWindows } from './windows.js';

export const VSCODE_HOST_ID = 'vscode';

/**
 * What the developer may set about this host. `userDir` is the running install's own `User` directory, which a
 * portable or Insiders install moves; the two permissions are R27's, and default to what a board spanning worktrees
 * needs (`mayOpenWindow`).
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
 * The VS Code host, headless half. Every route it can plan is resident: each one fires a URI or a command, and both
 * follow whichever window has focus (`docs/mechanics.md` §7, §8), so the process performing one has to be able to
 * see that focus landed. A headless process cannot, so this adapter offers no `open` and the hub forwards instead.
 *
 * `release` is unbuilt: closing the surface costs the window its IDE connection (§22), and what reopening one costs
 * is uncharacterised, so nothing here claims to hand a session back.
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
      primeWindows();
      void readWindowStores(settings.userDir ?? defaultUserDir(), placements);
    },

    windows(session: Session | undefined, deps: MachineReaders): Promise<HostWindows> {
      return readWindows(deps.home, session, placements);
    },

    async surfaces(): Promise<SessionSurface[]> {
      return surfacesFrom(await readWindowStores(settings.userDir ?? defaultUserDir(), placements), placements);
    },

    plan(request: OpenRequest): OpenPlan {
      // R27 is this host's own rule, applied where its settings were parsed: the hub has no business holding a
      // permission whose meaning is "may this application bring one of its windows forward".
      return planOpen(request, placements, settings.mayOpenWindow);
    },

    openable(sessions: readonly Session[], history: readonly HistoricalSession[] = []): string[] {
      return openableSessions([...sessions, ...history], placements);
    },
  };
}

export type VscodeRoute = OpenRoute['route'];
