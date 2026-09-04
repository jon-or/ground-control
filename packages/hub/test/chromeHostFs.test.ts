import { describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('node:child_process', () => ({
  execFileSync: (_command: string, _args: string[], options: Record<string, unknown>) => {
    seen.push(options);

    return '';
  },
}));

const { realChromeHostDeps } = await import('../src/chromeHostFs.js');

describe('registering with the browser', () => {
  /** Run from a command the developer typed, so a console window here is a flash over the editor they are reading. */
  it('runs reg.exe without a console window', () => {
    expect(realChromeHostDeps.registry(['delete', 'HKCU\Software\Nothing', '/f'])).toBeNull();
    expect(seen[0]?.['windowsHide']).toBe(true);
  });
});
