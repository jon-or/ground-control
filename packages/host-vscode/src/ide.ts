import { dirKey } from '@ground-control/core';
import type { HostWindow } from '@ground-control/core';

/**
 * One VS Code window, as it announces itself in the lock file an agent's extension writes per window. The only live
 * enumeration of windows on the machine — VS Code offers none — and undocumented, so **version-fragile** (§22).
 */
export interface IdeWindow extends HostWindow {
  port: number;
}

/** A lock file as found on disk. The name carries the port; nothing else does. */
export interface IdeLock {
  name: string;
  text: string | null;
}

/**
 * The windows the lock files claim. A closed window leaves its lock behind — two of seven were stale when measured —
 * so this is a list of candidates, and only a port that answers is a window (`docs/mechanics.md` §22).
 */
export function ideWindowsFrom(locks: readonly IdeLock[]): IdeWindow[] {
  const windows: IdeWindow[] = [];

  for (const lock of locks) {
    const port = Number(lock.name.replace(/\.lock$/, ''));

    if (!Number.isInteger(port) || port <= 0 || lock.text === null) {
      continue;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(lock.text);
    } catch {
      continue;
    }

    const folders = (parsed as { workspaceFolders?: unknown } | null)?.workspaceFolders;

    if (Array.isArray(folders)) {
      windows.push({ port, folders: folders.filter((folder): folder is string => typeof folder === 'string') });
    }
  }

  return windows;
}

/** One process and its parent, which is the whole of what the machine is asked for. */
export interface ProcessEntry {
  pid: number;
  parentPid: number;
}

/** A listening TCP port and the process holding it open, which is how a window's server is tied to its extension host. */
export interface ListeningPort {
  port: number;
  owningPid: number;
}

/**
 * The listening sockets in `netstat -ano` output. The state column is localised and may be two words, so a listener is
 * recognised by its empty foreign address and the pid is read from the end of the row rather than by column.
 */
export function listeningFrom(output: string): ListeningPort[] {
  const found: ListeningPort[] = [];

  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/);
    const [protocol, local, foreign] = fields;

    if (protocol !== 'TCP' || local === undefined || foreign === undefined || !foreign.endsWith(':0')) {
      continue;
    }

    const port = Number(local.slice(local.lastIndexOf(':') + 1));
    const owningPid = Number(fields[fields.length - 1]);

    if (Number.isInteger(port) && port > 0 && Number.isInteger(owningPid) && owningPid > 0) {
      found.push({ port, owningPid });
    }
  }

  return found;
}

/**
 * The process table as PowerShell reports it. Windows PowerShell 5.1 has no `-AsArray`, so a single row arrives as a
 * bare object rather than a one-element array and is taken as one either way.
 */
export function processesFrom(stdout: string): ProcessEntry[] {
  let rows: unknown;

  try {
    rows = JSON.parse(stdout);
  } catch {
    return [];
  }

  return (Array.isArray(rows) ? rows : [rows]).flatMap((row) => {
    const { ProcessId: pid, ParentProcessId: parentPid } = (row ?? {}) as Record<string, unknown>;

    return typeof pid === 'number' && typeof parentPid === 'number' ? [{ pid, parentPid }] : [];
  });
}

/**
 * The window holding a session's own process: its parent is that window's extension host, which is the process
 * listening on the window's lock port (`docs/mechanics.md` §22), so the parent pid names the window exactly.
 */
export function windowForProcess(
  sessionPid: number | null,
  processes: readonly ProcessEntry[],
  listening: readonly ListeningPort[],
  windows: readonly IdeWindow[],
): IdeWindow | null {
  const parent = processes.find((process) => process.pid === sessionPid)?.parentPid;

  if (parent === undefined) {
    return null;
  }

  // Read lock to port to owner, never owner to port: an extension host also listens on debug inspector ports, and
  // asking which port a pid holds would pick among them arbitrarily.
  const held = new Set(listening.filter((port) => port.owningPid === parent).map((port) => port.port));

  return windows.find((window) => held.has(window.port)) ?? null;
}

/** The windows still open. A closed one leaves its lock file behind, but nothing is listening on its port any more. */
export function liveWindows(windows: readonly IdeWindow[], listening: readonly ListeningPort[]): IdeWindow[] {
  const open = new Set(listening.map((entry) => entry.port));

  return windows.filter((window) => open.has(window.port));
}

/** Every folder some live window has open — what tells a surface still on screen from one recorded before a close. */
export function liveRootsOf(windows: readonly HostWindow[]): string[] {
  return [...new Set(windows.flatMap((window) => window.folders.map((folder) => dirKey(folder))))];
}
