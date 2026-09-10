import { describe, expect, it } from 'vitest';
import { readableLink } from '../src/detail.js';

describe('links a reader can follow out of a conversation', () => {
  it('opens the web addresses GitHub renders', () => {
    for (const url of [
      'https://github.com/example-org/example-repo/issues/1',
      'http://example.com/spec',
      'https://example.com/a?b=c#d',
    ]) {
      expect(readableLink(url)).toBe(url);
    }
  });

  it('refuses schemes that would run or read something instead of opening a page', () => {
    for (const url of [
      'javascript:fetch("https://example.com")',
      'vbscript:msgbox',
      'data:text/html,<script>1</script>',
      'file:///c:/Users/dev/.ssh/id_rsa',
      'vscode://ms-vscode.node-debug/launch',
      'command:workbench.action.terminal.new',
      ' javascript:alert(1)',
    ]) {
      expect(readableLink(url)).toBeNull();
    }
  });

  it('refuses anything that is not an address at all', () => {
    for (const value of ['', 'not a url', '/relative/path', undefined, null, 42, {}]) {
      expect(readableLink(value)).toBeNull();
    }
  });
});
