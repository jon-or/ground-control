import { existsSync } from 'node:fs';
import type * as vscode from 'vscode';
import { readMemory } from '@ground-control/board';
import { lanesPathOf, makeLaneStore } from '@ground-control/hub';
import { readBoardStatuses } from './config.js';

/** The memento key a window without `lanes.json` wrote its placements to. */
const MEMORY_KEY = 'groundControl.cardMemory';

/** Migrate window placements to the shared file once, then clear the old storage (R8). */
export function migrateLaneMemory(memento: vscode.Memento, stateDir: string): void {
  const stored = memento.get<unknown>(MEMORY_KEY);

  if (stored === undefined) {
    return;
  }

  if (existsSync(lanesPathOf(stateDir))) {
    void memento.update(MEMORY_KEY, undefined);

    return;
  }

  // Clear old placements only after a successful write to prevent data loss on disk or permission failures.
  if (makeLaneStore(stateDir).write(readMemory(stored, readBoardStatuses()))) {
    void memento.update(MEMORY_KEY, undefined);
  }
}
