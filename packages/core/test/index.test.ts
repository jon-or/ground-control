import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

describe('the package public surface', () => {
  it('exposes the helpers every adapter and the hub share, and names no adapter', () => {
    expect(Object.keys(api).sort()).toEqual([
      'GROUND_CONTROL_DIR',
      'LANE_ORDER',
      'LANE_TITLES',
      'PROTOCOL',
      'basename',
      'compilePattern',
      'dirKey',
      'diskReaders',
      'fetchSessions',
      'findCheckout',
      'groundControlDirOf',
      'hubConfig',
      'idsFrom',
      'isAbsolute',
      'issueNumberFrom',
      'join',
      'linkOf',
      'listDirFromDisk',
      'mtimeFromDisk',
      'normalize',
      'parent',
      'parseHubConfig',
      'readTailFromDisk',
      'readTextFromDisk',
      'resolveOnDisk',
      'rosterIsStale',
      'runJsonCli',
      'spawnable',
      'unreportedSessions',
    ]);
  });
});
