import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

describe('the package public surface', () => {
  it('exposes the helpers every adapter and the hub share, and names no adapter', () => {
    expect(Object.keys(api).sort()).toEqual([
      'GROUND_CONTROL_DIR',
      'basename',
      'compilePattern',
      'dirKey',
      'diskReaders',
      'fetchSessions',
      'findCheckout',
      'groundControlDirOf',
      'isAbsolute',
      'issueNumberFrom',
      'join',
      'linkOf',
      'listDirFromDisk',
      'mtimeFromDisk',
      'normalize',
      'parent',
      'readTailFromDisk',
      'readTextFromDisk',
      'resolveOnDisk',
      'runJsonCli',
    ]);
  });
});
