import type { MachineReaders } from '@ground-control/core';

/**
 * `readers` with `readText` and `listDir` answers reused until the current synchronous run ends, then `ended` is called.
 * A caller holding them across an await reads the disk again from then on.
 */
export function perRun(readers: MachineReaders, ended: () => void): MachineReaders {
  const texts = new Map<string, string | null>();
  const dirs = new Map<string, string[] | null>();
  let live = true;

  queueMicrotask(() => {
    live = false;
    texts.clear();
    dirs.clear();
    ended();
  });

  return {
    ...readers,
    readText: (path) => {
      if (!live) return readers.readText(path);
      if (!texts.has(path)) texts.set(path, readers.readText(path));

      return texts.get(path)!;
    },
    listDir: (path) => {
      if (!live) return readers.listDir(path);
      if (!dirs.has(path)) dirs.set(path, readers.listDir(path));

      return dirs.get(path)!;
    },
  };
}
