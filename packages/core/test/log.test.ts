import { describe, expect, it } from 'vitest';
import { LOG_LEVELS, formatLogLine, meetsLevel, parseLogLines } from '../src/log.js';
import type { LogEntry } from '../src/log.js';

const AT = '2026-09-06T19:01:24.114Z';

function entry(over: Partial<LogEntry> = {}): LogEntry {
  return { at: AT, level: 'info', source: 'hub', message: 'read 14 cards in 812ms', ...over };
}

describe('the levels', () => {
  it('orders them from the most detail to the least', () => {
    expect([...LOG_LEVELS]).toEqual(['debug', 'info', 'warn', 'error']);
  });

  it('keeps a line at or above the floor and drops one under it', () => {
    expect(meetsLevel('debug', 'info')).toBe(false);
    expect(meetsLevel('info', 'info')).toBe(true);
    expect(meetsLevel('error', 'info')).toBe(true);
    expect(meetsLevel('warn', 'error')).toBe(false);
  });
});

describe('one line as hub.log holds it', () => {
  it('writes the timestamp, the level, and the scope in brackets', () => {
    expect(formatLogLine(entry({ scope: 'github' }))).toBe(`${AT} info [github] read 14 cards in 812ms`);
  });

  it('leaves the brackets out where the line is the process itself', () => {
    expect(formatLogLine(entry({ message: 'listening on 127.0.0.1:51844' }))).toBe(
      `${AT} info listening on 127.0.0.1:51844`,
    );
  });

  it('reads back exactly what it wrote, scope and all', () => {
    const written = entry({ level: 'warn', scope: 'server', message: 'refused GET /hub: an Origin header, https://a.example' });

    expect(parseLogLines([formatLogLine(written)])).toEqual([written]);
  });

  it('reads back a line with no scope without inventing one', () => {
    const written = entry({ level: 'error', message: 'stopping: a client asked it to stop' });

    expect(parseLogLines([formatLogLine(written)])).toEqual([written]);
  });

  // The hub's own messages are full of colons, and an unbracketed scope would swallow the first word of half of them.
  it('does not read a colon in the message as a scope', () => {
    const [read] = parseLogLines([`${AT} info stopping: a client asked it to stop`]);

    expect(read?.scope).toBeUndefined();
    expect(read?.message).toBe('stopping: a client asked it to stop');
  });
});

describe('the lines the logger did not write', () => {
  // The spawn points the hub's stdout and stderr at the same descriptor, so a crash is in this file unstructured.
  it('keeps an unparseable line verbatim rather than dropping it', () => {
    const read = parseLogLines([`${AT} error uncaughtException: TypeError: x is not a function`, '    at Object.<anonymous> (d:/a.js:1:1)']);

    expect(read.map((one) => one.message)).toEqual([
      'uncaughtException: TypeError: x is not a function',
      '    at Object.<anonymous> (d:/a.js:1:1)',
    ]);
    expect(read[1]?.scope).toBe('raw');
  });

  it('gives a stack trace the timestamp of the error above it rather than none', () => {
    const read = parseLogLines([`${AT} error uncaughtException: boom`, '    at one (a.js:1:1)', '    at two (b.js:2:2)']);

    expect(read.map((one) => one.at)).toEqual([AT, AT, AT]);
  });

  it('leaves the timestamp empty for a fragment that opens a tail read', () => {
    const read = parseLogLines(['ed mid-line by the tail read', `${AT} info listening`]);

    expect(read[0]).toEqual({ at: '', level: 'info', source: 'hub', scope: 'raw', message: 'ed mid-line by the tail read' });
  });

  it('drops the blank line every file ends with', () => {
    expect(parseLogLines([`${AT} info listening`, ''])).toHaveLength(1);
  });

  // A timestamp that is not one, a level that is not one: both are lines something else wrote, not entries to trust.
  it.each([
    ['2026-09-06 19:01:24 info listening', 'a timestamp with no T and no Z'],
    [`${AT} trace listening`, 'a level this build does not have'],
    [`${AT}info listening`, 'no space after the timestamp'],
  ])('treats %s as a raw line', (line) => {
    expect(parseLogLines([line])).toEqual([{ at: '', level: 'info', source: 'hub', scope: 'raw', message: line }]);
  });
});

describe('lines that came from somewhere else', () => {
  // The hub's own sink writes \n, but the same file receives the process's stdout and stderr through another
  // descriptor, and a Windows child writes CRLF down it.
  it('reads a line back the same whether it ends with LF or CRLF', () => {
    expect(parseLogLines([`${AT} info [github] read 14 cards in 812ms\r`])).toEqual([
      { at: AT, level: 'info', source: 'hub', scope: 'github', message: 'read 14 cards in 812ms' },
    ]);
  });

  it('keeps a raw line verbatim but without the carriage return', () => {
    const [read] = parseLogLines(['Ground Control hub listening on 127.0.0.1:51844\r']);

    expect(read?.message).toBe('Ground Control hub listening on 127.0.0.1:51844');
  });

  // Several hub messages carry a CLI's own output, and third-party text opens with a bracket often enough to matter.
  // A scope is one lowercase word, so a shouted tag is left in the message where it belongs.
  it('does not tear a bracketed tag off a message and call it a scope', () => {
    const written = entry({ message: '[ERROR] the CLI said no' });

    expect(parseLogLines([formatLogLine(written)])).toEqual([written]);
  });

  it('still reads a real scope, which is always one lowercase word', () => {
    const [read] = parseLogLines([`${AT} debug [gh] api graphql (page 2) in 795ms`]);

    expect(read?.scope).toBe('gh');
    expect(read?.message).toBe('api graphql (page 2) in 795ms');
  });
});
