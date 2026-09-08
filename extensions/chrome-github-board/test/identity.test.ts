import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NATIVE_HOST_NAME } from '@ground-control/core';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * The board's identity is written out four times — the extension id in two places, and the native host name in two —
 * because this directory has no build step and cannot import what `core` declares. Nothing else compares them, so a
 * rename that missed one of these copies would leave `npm run verify` green and the overlay silently unable to
 * connect: `connectNative` on an unregistered host does not throw, it just closes.
 */
describe('the identity the browser side hard-codes', () => {
  const read = (file: string): string => readFileSync(join(src, file), 'utf8');

  it('asks for the native host by the name the extension registers', () => {
    expect(read('worker.js')).toContain(`const NATIVE_HOST = '${NATIVE_HOST_NAME}';`);
  });

  it('addresses the editor by the extension id the manifest publishes', () => {
    const manifest = JSON.parse(
      readFileSync(join(src, '..', '..', 'ground-control', 'package.json'), 'utf8'),
    ) as { publisher: string; name: string };

    expect(read('overlay.js')).toContain(`vscode://${manifest.publisher}.${manifest.name}/open?session=`);
  });
});
