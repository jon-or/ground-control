import { describe, expect, it } from 'vitest';
import { agentHomeSchema, agentRootVariable, resolveAgentHomes } from '../src/agentHomes.js';

const agents = [
  { id: 'claude', storage: { environment: 'CLAUDE_CONFIG_DIR', defaultDirectory: '.claude', configure() {} } },
  { id: 'codex', storage: { environment: 'CODEX_HOME', defaultDirectory: '.codex', configure() {} } },
];

describe('agent homes', () => {
  it('resolves explicit roots before environment and defaults', () => {
    expect(resolveAgentHomes(agents, { claude: 'D:\\profiles\\selected\\' }, '/isolated', { CLAUDE_CONFIG_DIR: '/wrong', CODEX_HOME: '/codex/profile' }))
      .toEqual({ homes: { claude: 'D:/profiles/selected', codex: '/codex/profile' } });
    expect(resolveAgentHomes(agents, undefined, '/isolated', {})).toEqual({ homes: { claude: '/isolated/.claude', codex: '/isolated/.codex' } });
  });
  it.each(['', ' ', ' /profile', '/profile ', 'relative', '~/.claude', 'C:relative', '\\\\?\\C:\\profile', '\\\\.\\pipe\\profile', '/profile\\literal', '/bad\npath', '/bad\u007fpath'])('rejects %j without default fallback', (root) => {
    expect(agentHomeSchema.safeParse(root).success).toBe(false);
    expect(resolveAgentHomes(agents, undefined, '/isolated', { CLAUDE_CONFIG_DIR: root })).toMatchObject({ failure: { kind: 'bad-config', subject: 'claude' } });
  });
  it('normalizes dot segments and retains physical path casing and drive roots', () => {
    expect(agentHomeSchema.parse('C:\\Profiles\\Other\\..\\Selected\\')).toBe('C:/Profiles/Selected');
    expect(agentHomeSchema.parse('C:\\')).toBe('C:/');
    expect(agentHomeSchema.parse('/Profiles/Other/../Selected')).toBe('/Profiles/Selected');
    expect(agentHomeSchema.parse('\\\\server\\share\\profile\\')).toBe('//server/share/profile');
  });
  it.each([
    ['C:/Users/Dev/.claude', 'C:/Users/Dev/.claude', null],
    ['c:\\users\\dev\\.claude\\', 'C:/Users/Dev/.claude', null],
    ['/home/dev/.claude/', '/home/dev/.claude', null],
    ['/home/dev/.Claude', '/home/dev/.claude', '/home/dev/.Claude'],
    ['C:/Users/Dev/.claude-work', 'C:/Users/Dev/.claude', 'C:/Users/Dev/.claude-work'],
  ])('selects %s against default %s by the variable value %s', (root, defaultRoot, expected) => {
    expect(agentRootVariable(root, defaultRoot)).toBe(expected);
  });
  it('keeps the variable for the default root only when the launcher set it to that root', () => {
    expect(agentRootVariable('C:/Users/Dev/.claude', 'C:/Users/Dev/.claude', 'c:\\users\\dev\\.claude\\')).toBe('C:/Users/Dev/.claude');
    expect(agentRootVariable('C:/Users/Dev/.claude', 'C:/Users/Dev/.claude', 'D:/other')).toBeNull();
    expect(agentRootVariable('D:/other', 'C:/Users/Dev/.claude', 'C:/Users/Dev/.claude')).toBe('D:/other');
  });
  it('rejects explicit unknown agents and ignores adapters without storage', () => {
    expect(resolveAgentHomes(agents, { unknown: '/profile' }, '/isolated', {})).toMatchObject({ failure: { kind: 'bad-config', subject: 'unknown' } });
    expect(resolveAgentHomes([{ id: 'stateless' }], undefined, '/isolated', {})).toEqual({ homes: {} });
  });
});
