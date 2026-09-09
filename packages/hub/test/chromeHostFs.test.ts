import { describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('node:child_process', () => ({
  execFileSync: (_command: string, args: string[], options: Record<string, unknown>) => {
    seen.push(options);

    if (args[0] === 'query' && args[1] === 'HKCU\\Software\\Registered') {
      return '\r\nHKEY_CURRENT_USER\\Software\\Registered\r\n    (Standard)    REG_SZ    C:\\Users\\dev\\manifest.json\r\n\r\n';
    }

    if (args[0] === 'query') {
      throw new Error('ERROR: The system was unable to find the specified registry key or value.');
    }

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

  it('reads a manifest file and reports an absent one as null', () => {
    expect(realChromeHostDeps.read('d:/nowhere/at/all/manifest.json')).toBeNull();
  });

  it('reads the registered manifest path whatever the value label is called', () => {
    expect(realChromeHostDeps.registered('HKCU\\Software\\Registered')).toBe('C:\\Users\\dev\\manifest.json');
    expect(realChromeHostDeps.registered('HKCU\\Software\\Nothing')).toBeNull();
  });
});
