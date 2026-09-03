import { existsSync } from 'node:fs';
import type * as vscode from 'vscode';
import { readMemory } from '@ground-control/board';
import { lanesPathOf, makeLaneStore } from '@ground-control/hub';
import { readBoardStatuses } from './config.js';

/** The memento key a window without `lanes.json` wrote its placements to. */
const MEMORY_KEY = 'groundControl.cardMemory';

/**
 * Moves a window's stored placements to the machine's own record, once, so a developer upgrading keeps the lanes
 * they put their cards in. Cleared afterwards so nothing ever reads two memories (R8).
 */
export function migrateLaneMemory(memento: vscode.Memento, home: string): void {
  const stored = memento.get<unknown>(MEMORY_KEY);

  if (stored === undefined) {
    return;
  }

  if (existsSync(lanesPathOf(home))) {
    void memento.update(MEMORY_KEY, undefined);

    return;
  }

  // Only once the file holds them. Clearing on a write that failed — a read-only home, a full disk — loses every
  // placement the developer ever made, silently and for good.
  if (makeLaneStore(home).write(readMemory(stored, readBoardStatuses()))) {
    void memento.update(MEMORY_KEY, undefined);
  }
}
