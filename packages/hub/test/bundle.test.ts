import { describe, expect, it } from 'vitest';
import { compareVersions, shouldWrite, stamp, versionOf } from '../src/bundle.js';

// Use a long first line so rejecting unstamped input depends on the marker check, not file length.
const code = '"use strict";var a=1;var b=2;var c=3;\nconsole.log(a + b + c);\n';

describe('which copy of the hub wins', () => {
  it('reads stamped versions and rejects unstamped files', () => {
    expect(versionOf(stamp('1.2.3', code))).toBe('1.2.3');
    expect(versionOf(code)).toBeNull();
    expect(versionOf(null)).toBeNull();
    expect(versionOf('// ground-control-hub \nconsole.log(1);')).toBeNull();
  });

  it('orders versions by number rather than by text', () => {
    // The one a string comparison gets wrong, which is what this exists to rule out.
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.2.0', '1.2')).toBe(0);
    expect(compareVersions('0.9.9', '1.0.0')).toBe(-1);
  });

  /** Nonnumeric prerelease parts sort below numeric version parts. */
  it('sorts a version it cannot read as numbers below one it can', () => {
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBe(1);
    expect(compareVersions('1.0.0-beta.1', '1.0.0-beta.2')).toBe(0);
  });

  it('writes missing bundles and preserves newer versions', () => {
    expect(shouldWrite(stamp('1.0.0', code), null)).toBe(true);
    expect(shouldWrite(stamp('1.1.0', code), stamp('1.0.0', code))).toBe(true);
    expect(shouldWrite(stamp('1.0.0', code), stamp('1.1.0', code))).toBe(false);
  });

  /** Every build in a source tree carries the same version, so this is the case a developer actually hits. */
  it('replaces an equal version only when the bytes differ', () => {
    expect(shouldWrite(stamp('1.0.0', code), stamp('1.0.0', code))).toBe(false);
    expect(shouldWrite(stamp('1.0.0', `${code}console.log(4);\n`), stamp('1.0.0', code))).toBe(true);
  });

  /** Something else wrote it, so there is no version to compare — and the carried copy is the one known good. */
  it('compares bytes against a file it did not stamp', () => {
    expect(shouldWrite(stamp('1.0.0', code), code)).toBe(true);
    expect(shouldWrite(code, code)).toBe(false);
  });
});
