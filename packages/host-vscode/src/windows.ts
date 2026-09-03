import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '@ground-control/core';
import { ideWindowsFrom, listeningFrom, liveWindows, processesFrom, windowForProcess } from './ide.js';
import type { IdeWindow, ListeningPort, ProcessEntry } from './ide.js';
import type { AgentPlacement } from './placements.js';

const PORTS_TIMEOUT_MS = 5000;
const PROCESSES_TIMEOUT_MS = 8000;
/**
 * How long a read of the process table is reused. A session's parent never changes, so the only thing ageing here is
 * whether a session started since — and the board primes this on every refresh, so a click rarely waits for one.
 */
const PROCESSES_TTL_MS = 30_000;

/**
 * `Get-CimInstance` costs 650 ms against `netstat`'s 24, so it is asked only for what nothing cheaper reports: the
 * parent of each session process. Node exposes no other process's parent, and `wmic` is gone from Windows 11.
 */
const PROCESS_QUERY = [
  '$ErrorActionPreference = "SilentlyContinue";',
  `$r = @(Get-CimInstance -Query "SELECT ProcessId,ParentProcessId FROM Win32_Process WHERE Name='claude.exe'" |`,
  'Select-Object ProcessId,ParentProcessId);',
  'ConvertTo-Json -Compress -InputObject $r',
].join(' ');

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

/** Who holds each port open. `netstat` rather than `Get-NetTCPConnection`: 24 ms against 627, and no shell to start. */
async function readPorts(): Promise<ListeningPort[]> {
  if (process.platform !== 'win32') {
    return [];
  }

  return listeningFrom(await run('netstat', ['-ano'], PORTS_TIMEOUT_MS));
}

async function readProcesses(): Promise<ProcessEntry[]> {
  if (process.platform !== 'win32') {
    return [];
  }

  return processesFrom(
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PROCESS_QUERY], PROCESSES_TIMEOUT_MS),
  );
}

let cached: { at: number; processes: ProcessEntry[] } | undefined;
let inFlight: Promise<ProcessEntry[]> | undefined;

function processes(): Promise<ProcessEntry[]> {
  if (cached !== undefined && Date.now() - cached.at < PROCESSES_TTL_MS) {
    return Promise.resolve(cached.processes);
  }

  inFlight ??= readProcesses()
    .then((read) => {
      // A read that came back empty is a failure, not an answer, and caching it would refuse every session for the
      // whole window. Routing falls back to the recorded roots instead, and the next call tries again.
      if (read.length > 0) {
        cached = { at: Date.now(), processes: read };
      }

      return read;
    })
    .finally(() => {
      inFlight = undefined;
    });

  return inFlight;
}

/** Reads the process table ahead of any click, so opening a session waits on the cheap half only. */
export function primeWindows(): void {
  void processes();
}

/** Every window that has written a lock file, open or not, under every placed agent's lock directory. */
function lockedWindows(home: string, placements: Readonly<Record<string, AgentPlacement>>): IdeWindow[] {
  const byPort = new Map<number, IdeWindow>();

  for (const placement of Object.values(placements)) {
    const dir = placement.lockDir(home, process.env);
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
  /** The windows still open — a closed one leaves its lock file behind but stops listening (`docs/mechanics.md` §22). */
  live: IdeWindow[];
  /** The window holding this session's own process, or null where its parent is not a window's extension host. */
  holding: IdeWindow | null;
}

/**
 * Which VS Code windows are open, and which one is running this session. Liveness is read from who holds a port open
 * rather than by connecting, which would evict whatever client that window already has (`docs/mechanics.md` §22).
 */
export async function readWindows(
  home: string,
  session: Session | undefined,
  placements: Readonly<Record<string, AgentPlacement>>,
): Promise<Windows> {
  const locked = lockedWindows(home, placements);
  const [ports, table] = await Promise.all([readPorts(), processes()]);
  const live = liveWindows(locked, ports);

  return {
    live,
    holding: session ? windowForProcess(session.pid, table, ports, live) : null,
  };
}
