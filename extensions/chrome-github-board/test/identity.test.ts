import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NATIVE_HOST_NAME } from '@ground-control/core';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * Verify duplicated extension and native-host IDs because this unbundled client cannot import core. An
 * unregistered connectNative host closes the port without throwing.
 */
describe('browser integration identifiers', () => {
  const read = (file: string): string => readFileSync(join(src, file), 'utf8');

  it('asks for the native host by the name the extension registers', () => {
    expect(read('worker.js')).toContain(`const NATIVE_HOST = '${NATIVE_HOST_NAME}';`);
  });

  it('addresses the editor by the extension id the manifest publishes', () => {
    const manifest = JSON.parse(
      readFileSync(join(src, '..', '..', 'ground-control', 'package.json'), 'utf8'),
    ) as { publisher: string; name: string };

    for (const path of ['open', 'attach']) {
      expect(read('overlay.js')).toContain(`://${manifest.publisher}.${manifest.name}/${path}?session=`);
    }
  });
});
