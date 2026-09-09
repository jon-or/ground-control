import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '@ground-control/core';
import {
  ideWindowsFrom,
  listeningFrom,
  liveWindows,
  processNames,
  processQuery,
  processesFrom,
  windowForProcess,
} from './ide.js';
import type { IdeWindow, ListeningPort, ProcessEntry } from './ide.js';
import type { AgentPlacement } from './placements.js';

const PORTS_TIMEOUT_MS = 5000;
const PROCESSES_TIMEOUT_MS = 8000;
/**
 * Cache process ancestry between refreshes. Parent PIDs are stable; refreshes discover newly started sessions
 * before most clicks.
 */
const PROCESSES_TTL_MS = 30_000;

function text(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function run(command: string, args: readonly string[], timeout: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 },
      (_error, stdout) => resolve(stdout),
    );
  });
}

/**
 * Read port owners with netstat: measured at 24 ms versus 627 ms for Get-NetTCPConnection, without starting a
 * shell.
 */
async function readPorts(): Promise<ListeningPort[]> {
  if (process.platform !== 'win32') {
    return [];
  }

  return listeningFrom(await run('netstat', ['-ano'], PORTS_TIMEOUT_MS));
}

/**
 * Use Get-CimInstance only for parent PIDs (650 ms measured). Node cannot read other processes' parents, and
 * Windows 11 no longer includes wmic.
 */
async function readProcesses(names: readonly string[]): Promise<ProcessEntry[]> {
  // Skip empty executable lists to avoid an invalid empty WHERE clause.
  if (process.platform !== 'win32' || names.length === 0) {
    return [];
  }

  return processesFrom(
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', processQuery(names)], PROCESSES_TIMEOUT_MS),
  );
}

let cached: { at: number; asked: string; processes: ProcessEntry[] } | undefined;
let inFlight: Promise<ProcessEntry[]> | undefined;

function processes(names: readonly string[]): Promise<ProcessEntry[]> {
  const asked = names.join(',');

  if (cached !== undefined && cached.asked === asked && Date.now() - cached.at < PROCESSES_TTL_MS) {
    return Promise.resolve(cached.processes);
  }

  inFlight ??= readProcesses(names)
    .then((read) => {
      // Do not cache failed or empty reads. Fall back to recorded roots and retry next time.
      if (read.length > 0) {
        cached = { at: Date.now(), asked, processes: read };
      }

      return read;
    })
    .finally(() => {
      inFlight = undefined;
    });

  return inFlight;
}

/** Cache process ancestry before clicks to reduce open latency. */
export function primeWindows(placements: Readonly<Record<string, AgentPlacement>>): void {
  void processes(processNames(placements));
}

/** Read candidate windows from all configured agent lock directories, including stale files. */
function lockedWindows(home: string, placements: Readonly<Record<string, AgentPlacement>>): IdeWindow[] {
  const byPort = new Map<number, IdeWindow>();

  for (const placement of Object.values(placements)) {
    const dir = placement.lockDir?.(home, process.env);

    if (dir === undefined) {
      continue;
    }

    let names: string[];

    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }

    const locks = names.filter((name) => name.endsWith('.lock')).map((name) => ({ name, text: text(join(dir, name)) }));

    for (const window of ideWindowsFrom(locks)) {
      byPort.set(window.port, window);
    }
  }

  return [...byPort.values()];
}

export interface Windows {
  /** Open windows identified by listening lock ports (M22). */
  live: IdeWindow[];
  /** Session window, or null when its parent is not a known extension host. */
  holding: IdeWindow | null;
}

/**
 * Find open windows and the session's window through port ownership. Connecting to a lock port could evict its
 * existing client (M22).
 */
export async function readWindows(
  home: string,
  session: Session | undefined,
  placements: Readonly<Record<string, AgentPlacement>>,
): Promise<Windows> {
  const locked = lockedWindows(home, placements);
  const [ports, table] = await Promise.all([readPorts(), processes(processNames(placements))]);
  const live = liveWindows(locked, ports);

  return {
    live,
    holding: session ? windowForProcess(session.pid, table, ports, live) : null,
  };
}
