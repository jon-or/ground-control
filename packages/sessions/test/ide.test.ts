import { describe, expect, it } from 'vitest';
import {
  claudeDirOf,
  ideWindowsFrom,
  listeningFrom,
  liveRootsOf,
  liveWindows,
  processesFrom,
  windowForProcess,
} from '../src/ide.js';
import type { IdeLock } from '../src/ide.js';

/** A lock file exactly as a window writes one: the port is the file name, and nothing inside repeats it. */
function lock(port: number, folders: string[]): IdeLock {
  return {
    name: `${port}.lock`,
    text: JSON.stringify({
      pid: 29212,
      workspaceFolders: folders,
      ideName: 'Visual Studio Code',
      transport: 'ws',
      runningInWindows: true,
      authToken: 'b480e1fb-73e7-473f-a744-3a03d6fb4cb3',
    }),
  };
}

describe('ideWindowsFrom', () => {
  it('reads a window\u2019s port from the file name and its folders from the contents', () => {
    expect(ideWindowsFrom([lock(11201, ['d:\\git\\orez'])])).toEqual([{ port: 11201, folders: ['d:\\git\\orez'] }]);
  });

  it('keeps every folder of a multi-root window, which announces them one by one', () => {
    const folders = ['d:\\git\\tier3', 'd:\\git\\orez.wiki', 'd:\\git\\orez'];

    expect(ideWindowsFrom([lock(49241, folders)])[0]?.folders).toEqual(folders);
  });

  it('keeps a window with no folder open, which is still a window', () => {
    expect(ideWindowsFrom([lock(22365, [])])).toEqual([{ port: 22365, folders: [] }]);
  });

  it('drops a file whose name is not a port, since nothing could be dialled', () => {
    expect(ideWindowsFrom([{ name: 'notes.lock', text: lock(1, []).text }])).toEqual([]);
  });

  it('drops one unreadable lock without losing the rest', () => {
    const locks = [{ name: '1.lock', text: 'not json' }, { name: '2.lock', text: null }, lock(3, ['d:\\a'])];

    expect(ideWindowsFrom(locks)).toEqual([{ port: 3, folders: ['d:\\a'] }]);
  });

  it('drops a lock with no folder list at all, which names no window to aim at', () => {
    expect(ideWindowsFrom([{ name: '4.lock', text: '{"pid":1,"ideName":"Visual Studio Code"}' }])).toEqual([]);
  });

  it('drops a folder entry that is not a path, keeping the ones that are', () => {
    const mixed = { name: '5.lock', text: '{"workspaceFolders":["d:\\\\a",null,7]}' };

    expect(ideWindowsFrom([mixed])[0]?.folders).toEqual(['d:\\a']);
  });
});

describe('claudeDirOf', () => {
  it('defaults to the home directory, where Claude Code keeps its state', () => {
    expect(claudeDirOf('C:/Users/dev', undefined)).toBe('C:/Users/dev/.claude');
  });

  it('honours CLAUDE_CONFIG_DIR, which moves the directory wholesale', () => {
    expect(claudeDirOf('C:/Users/dev', 'd:/config/claude')).toBe('d:/config/claude');
  });

  it('treats an empty or blank setting as unset rather than as the filesystem root', () => {
    expect(claudeDirOf('C:/Users/dev', '')).toBe('C:/Users/dev/.claude');
    expect(claudeDirOf('C:/Users/dev', '   ')).toBe('C:/Users/dev/.claude');
  });
});

describe('liveRootsOf', () => {
  it('gathers every folder some window has open, as comparable keys', () => {
    const windows = ideWindowsFrom([lock(1, ['D:\\Git\\Orez\\']), lock(2, ['d:/git/tier3'])]);

    expect(liveRootsOf(windows).sort()).toEqual(['d:/git/orez', 'd:/git/tier3']);
  });

  it('names a folder once when two windows both have it open', () => {
    const windows = ideWindowsFrom([lock(1, ['d:\\git\\orez']), lock(2, ['d:\\git\\orez'])]);

    expect(liveRootsOf(windows)).toEqual(['d:/git/orez']);
  });

  it('names nothing when no window is open, which is what refuses a stale surface', () => {
    expect(liveRootsOf([])).toEqual([]);
  });
});

/**
 * One window's worth of the real shape: a session process under its window's extension host, that host listening on
 * the window's own lock port, and — the trap — on a debug inspector port as well. The window every test below expects
 * is deliberately not the first, so returning whichever came to hand fails.
 */
const WINDOWS = ideWindowsFrom([lock(24477, ['d:\\git\\tier3']), lock(18634, ['d:\\git\\orez'])]);
const PROCESSES = [
  { pid: 24320, parentPid: 9172 },
  { pid: 16160, parentPid: 9172 },
  { pid: 54048, parentPid: 38088 },
  { pid: 40040, parentPid: 3040 },
];
const LISTENING = [
  { port: 53529, owningPid: 9172 },
  { port: 18634, owningPid: 9172 },
  { port: 24477, owningPid: 38088 },
];

describe('windowForProcess', () => {
  it('names the window whose extension host is the session process’s parent', () => {
    expect(windowForProcess(24320, PROCESSES, LISTENING, WINDOWS)?.port).toBe(18634);
  });

  it('puts two sessions under one extension host in the same window', () => {
    expect(windowForProcess(16160, PROCESSES, LISTENING, WINDOWS)?.port).toBe(18634);
  });

  it('picks the lock port over a debug port the same host also listens on', () => {
    expect(windowForProcess(24320, PROCESSES, LISTENING, WINDOWS)?.folders).toEqual(['d:\\git\\orez']);
  });

  it('names no window for a session whose parent is not one, which is a terminal or a shared agent host', () => {
    expect(windowForProcess(40040, PROCESSES, LISTENING, WINDOWS)).toBeNull();
  });

  it('names no window for a process nothing reported, rather than guessing at one', () => {
    expect(windowForProcess(99999, PROCESSES, LISTENING, WINDOWS)).toBeNull();
    expect(windowForProcess(null, PROCESSES, LISTENING, WINDOWS)).toBeNull();
  });

  it('names no window when the machine would not answer, so routing falls back rather than refusing', () => {
    expect(windowForProcess(24320, [], [], WINDOWS)).toBeNull();
  });
});

describe('liveWindows', () => {
  it('keeps a window something is listening on', () => {
    expect(liveWindows(WINDOWS, LISTENING).map((window) => window.port).sort()).toEqual([18634, 24477]);
  });

  it('drops a window that closed, whose lock file outlived it', () => {
    const stale = ideWindowsFrom([lock(22365, ['d:\\git\\gone'])]);

    expect(liveWindows([...WINDOWS, ...stale], LISTENING).map((window) => window.port)).not.toContain(22365);
  });

  it('drops every window when nothing could be read, which refuses rather than aiming blind', () => {
    expect(liveWindows(WINDOWS, [])).toEqual([]);
  });
});

/** Verbatim `netstat -ano`, trimmed to whole lines: a UDP row, IPv6, an established pair, and the header. */
const NETSTAT = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       2168',
  '  TCP    127.0.0.1:18634        0.0.0.0:0              LISTENING       70332',
  '  TCP    127.0.0.1:443          127.0.0.1:57512        ESTABLISHED     4',
  '  TCP    [::]:80                [::]:0                 LISTENING       4',
  '  UDP    0.0.0.0:500            *:*                                    3168',
  '',
].join('\r\n');

/** The same rows on an Italian Windows, where the state is two words and the pid is no longer the fifth field. */
const NETSTAT_IT = [
  '  Proto  Indirizzo locale       Indirizzo esterno      Stato           PID',
  '  TCP    127.0.0.1:18634        0.0.0.0:0              IN ASCOLTO      70332',
  '  TCP    127.0.0.1:443          127.0.0.1:57512        STABILITO       4',
].join('\r\n');

describe('listeningFrom', () => {
  it('reads the port and the process holding it open', () => {
    expect(listeningFrom(NETSTAT)).toContainEqual({ port: 18634, owningPid: 70332 });
  });

  it('reads an IPv6 listener, whose address carries colons of its own', () => {
    expect(listeningFrom(NETSTAT)).toContainEqual({ port: 80, owningPid: 4 });
  });

  /**
   * The pid is taken from the end of the row rather than by column, because a state written in two words shifts it —
   * reading the fifth field would leave every window on such a machine looking closed.
   */
  it('reads the owning pid where the state is more than one word', () => {
    expect(listeningFrom(NETSTAT_IT)).toEqual([{ port: 18634, owningPid: 70332 }]);
  });

  it('leaves out an established connection, which is not something listening', () => {
    expect(listeningFrom(NETSTAT).some((entry) => entry.port === 443)).toBe(false);
  });

  /** A foreign address of its own, so the protocol is the only thing that can leave this row out. */
  it('leaves out UDP, which holds no port a window could be reached on', () => {
    const udp = '  UDP    0.0.0.0:500            0.0.0.0:0              LISTENING       3168';

    expect(listeningFrom(udp)).toEqual([]);
  });

  it('reads nothing out of a header, a blank line, or an empty run', () => {
    expect(listeningFrom('')).toEqual([]);
    expect(listeningFrom('Active Connections\r\n\r\n  Proto  Local Address')).toEqual([]);
  });
});

describe('processesFrom', () => {
  it('reads the parent of each process out of what PowerShell wrote', () => {
    const stdout = '[{"ProcessId":24320,"ParentProcessId":9172},{"ProcessId":16160,"ParentProcessId":9172}]';

    expect(processesFrom(stdout)).toEqual([
      { pid: 24320, parentPid: 9172 },
      { pid: 16160, parentPid: 9172 },
    ]);
  });

  /** Windows PowerShell 5.1 has no `-AsArray`, so one running session arrives as a bare object and must still read. */
  it('reads a single row, which arrives unwrapped', () => {
    expect(processesFrom('{"ProcessId":24320,"ParentProcessId":9172}')).toEqual([{ pid: 24320, parentPid: 9172 }]);
  });

  it('reads nothing out of an empty run, a null, or output that is not JSON', () => {
    expect(processesFrom('')).toEqual([]);
    expect(processesFrom('null')).toEqual([]);
    expect(processesFrom('Get-CimInstance : Access denied')).toEqual([]);
  });

  it('drops a row missing either half of the link, keeping the rows that carry both', () => {
    const stdout = '[{"ProcessId":24320},{"ParentProcessId":9172},{"ProcessId":1,"ParentProcessId":2}]';

    expect(processesFrom(stdout)).toEqual([{ pid: 1, parentPid: 2 }]);
  });
});
