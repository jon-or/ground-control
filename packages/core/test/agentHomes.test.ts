import { describe, expect, it } from 'vitest';
import { agentHomeSchema, resolveAgentHomes } from '../src/agentHomes.js';

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
  it('rejects explicit unknown agents and ignores adapters without storage', () => {
    expect(resolveAgentHomes(agents, { unknown: '/profile' }, '/isolated', {})).toMatchObject({ failure: { kind: 'bad-config', subject: 'unknown' } });
    expect(resolveAgentHomes([{ id: 'stateless' }], undefined, '/isolated', {})).toEqual({ homes: {} });
  });
});
