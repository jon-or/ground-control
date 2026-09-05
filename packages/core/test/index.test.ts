import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

describe('the package public surface', () => {
  it('exposes the helpers every adapter and the hub share, and names no adapter', () => {
    expect(Object.keys(api).sort()).toEqual([
      'CHROME_EXTENSION_ID',
      'GROUND_CONTROL_DIR',
      'LANE_ORDER',
      'LANE_TITLES',
      'NATIVE_HOST_NAME',
      'PROTOCOL',
      'basename',
      'checkoutOf',
      'compilePattern',
      'dirKey',
      'diskReaders',
      'fetchSessionHistory',
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
      'readHeadFromDisk',
      'readTailFromDisk',
      'readTextFromDisk',
      'repositoryKey',
      'repositoryOf',
      'resolveOnDisk',
      'rosterIsStale',
      'runJsonCli',
      'sessionLabel',
      'spawnable',
      'unreportedSessions',
    ]);
  });
});
