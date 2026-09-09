import { dirKey } from '@ground-control/core';
import type { HostWindow } from '@ground-control/core';
import type { AgentPlacement } from './placements.js';

/**
 * Window metadata from an agent extension's lock file. VS Code has no live window-list API; this undocumented
 * format is version-fragile (M22).
 */
export interface IdeWindow extends HostWindow {
  port: number;
}

/** Lock file content and filename, which contains its port. */
export interface IdeLock {
  name: string;
  text: string | null;
}

/**
 * Read candidate windows from lock files. Closed windows leave stale files, so callers must check for a
 * listening port (M22).
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

/** Process ancestry used to identify extension hosts. */
export interface ProcessEntry {
  pid: number;
  parentPid: number;
}

/** TCP listener and owning process, used to identify a window's extension host. */
export interface ListeningPort {
  port: number;
  owningPid: number;
}

/**
 * Parse `netstat -ano` listeners by their empty foreign address and final PID column. Avoid the localized state
 * column, which can contain two words.
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

/** Agent executable names to query in the process table. */
export function processNames(placements: Readonly<Record<string, AgentPlacement>>): string[] {
  return Object.values(placements).map((placement) => placement.processName);
}

/** Filter `Get-CimInstance` by agent executable names to avoid reading every process (650 ms measured). */
export function processQuery(names: readonly string[]): string {
  const where = names.map((name) => `Name='${name}'`).join(' or ');

  return [
    '$ErrorActionPreference = "SilentlyContinue";',
    `$r = @(Get-CimInstance -Query "SELECT ProcessId,ParentProcessId FROM Win32_Process WHERE ${where}" |`,
    'Select-Object ProcessId,ParentProcessId);',
    'ConvertTo-Json -Compress -InputObject $r',
  ].join(' ');
}

/**
 * Normalize PowerShell process output to rows. Windows PowerShell 5.1 lacks `-AsArray` and may return a single
 * object.
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

/** Match the session's parent PID to the extension host listening on a window lock port (M22). */
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

  // Match lock ports to owners; an extension host may also listen on unrelated debug ports.
  const held = new Set(listening.filter((port) => port.owningPid === parent).map((port) => port.port));

  return windows.find((window) => held.has(window.port)) ?? null;
}

/** Keep windows whose lock ports are still listening. */
export function liveWindows(windows: readonly IdeWindow[], listening: readonly ListeningPort[]): IdeWindow[] {
  const open = new Set(listening.map((entry) => entry.port));

  return windows.filter((window) => open.has(window.port));
}

/** Distinct normalized folders in live windows. */
export function liveRootsOf(windows: readonly HostWindow[]): string[] {
  return [...new Set(windows.flatMap((window) => window.folders.map((folder) => dirKey(folder))))];
}
