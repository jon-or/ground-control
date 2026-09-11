import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LogEntry, LogFloor } from '@ground-control/core';
import { LOG_FLOORS } from '@ground-control/core';
import { LOG_LIMIT_BYTES, fileSink, makeLogger, readLogTail } from '../src/index.js';
import { logPathOf } from '../src/paths.js';
import { tempHome } from './helpers.js';

const AT = '2026-09-06T19:01:24.114Z';

function logging(level?: LogFloor) {
  const written: string[] = [];
  const log = makeLogger({ write: (line) => written.push(line), now: () => AT, ...(level ? { level } : {}) });

  return { log, written };
}

describe('what the hub writes about itself', () => {
  it('writes a line at the floor, formatted the way hub.log holds it', () => {
    const { log, written } = logging();

    log.info('read 14 cards in 812ms', 'github');

    expect(written).toEqual([`${AT} [info] [github] read 14 cards in 812ms`]);
  });

  it('defaults to info logging', () => {
    expect(logging().log.level()).toBe('info');
  });

  // The refusal, and the reason the level exists at all.
  it('filters entries below the threshold', () => {
    const { log, written } = logging();

    log.debug('47 sessions in 180ms', 'sessions');

    expect(written).toEqual([]);
  });

  it('takes a floor a client pushed, in both directions', () => {
    const { log, written } = logging();

    log.setLevel('debug');
    log.debug('now this lands');
    log.setLevel('info');
    log.debug('and this does not');

    expect(written).toEqual([`${AT} [debug] now this lands`]);
    expect(log.level()).toBe('info');
  });

  /** A floor drops what is under it and nothing else: warn keeps refusals and failures, error keeps failures alone. */
  it.each([
    ['debug', 3],
    ['info', 3],
    ['warn', 2],
    ['error', 1],
  ] as const)('writes at a floor of %s the lines at or above it', (floor, count) => {
    const { log, written } = logging(floor);

    log.info('listening on 127.0.0.1:51844');
    log.warn('refused GET /hub: an Origin header, https://a.example', 'server');
    log.error('could not listen on 127.0.0.1');

    expect(written).toHaveLength(count);
    expect(written[written.length - 1]).toContain('could not listen');
  });

  it('offers every level as a floor', () => {
    expect([...LOG_FLOORS]).toEqual(['debug', 'info', 'warn', 'error']);
  });
});

describe('who is listening', () => {
  it('sends structured entries to subscribers', () => {
    const { log } = logging();
    const seen: LogEntry[] = [];

    log.watch((entry) => seen.push(entry));
    log.warn('github could not be read after 812ms: offline', 'sources');

    expect(seen).toEqual([
      { at: AT, level: 'warn', source: 'hub', scope: 'sources', message: 'github could not be read after 812ms: offline' },
    ]);
  });

  // Remove the viewer subscription when it closes.
  it('stops delivering once the watcher is undone', () => {
    const { log } = logging();
    const seen: LogEntry[] = [];
    const stop = log.watch((entry) => seen.push(entry));

    log.info('before');
    stop();
    log.info('after');

    expect(seen.map((entry) => entry.message)).toEqual(['before']);
  });

  it('delivers to every watcher, because two boards may each have a viewer open', () => {
    const { log } = logging();
    const one: string[] = [];
    const two: string[] = [];

    log.watch((entry) => one.push(entry.message));
    log.watch((entry) => two.push(entry.message));
    log.info('listening');

    expect([one, two]).toEqual([['listening'], ['listening']]);
  });

  it('never streams a line it did not write, so a watcher sees exactly the file', () => {
    const { log, written } = logging();
    const seen: string[] = [];

    log.watch((entry) => seen.push(entry.message));
    log.debug('under the floor');
    log.info('at the floor');

    expect(seen).toEqual(['at the floor']);
    expect(written).toHaveLength(1);
  });

  // Subscriber failure must not prevent file logging.
  it('isolates subscriber failures from file output and other subscribers', () => {
    const { log, written } = logging();
    const survivor: string[] = [];

    log.watch(() => {
      throw new Error('this stream ended');
    });
    log.watch((entry) => survivor.push(entry.message));
    log.info('listening');

    expect(written).toHaveLength(1);
    expect(survivor).toEqual(['listening']);
  });
});

describe('the file it appends to', () => {
  it('creates hub.log under the home it is given and appends each line', () => {
    const { home, dispose } = tempHome();

    try {
      const write = fileSink(home);

      write('one');
      write('two');

      expect(readFileSync(logPathOf(home), 'utf8')).toBe('one\ntwo\n');
    } finally {
      dispose();
    }
  });

  // Rotate by bytes written so long-running hubs respect log limits without per-line stat calls.
  it('moves the file aside once this run has written the limit, and keeps writing', () => {
    const { home, dispose } = tempHome();

    try {
      const write = fileSink(home);
      const fat = 'x'.repeat(LOG_LIMIT_BYTES);

      write(fat);
      write('after the rotation');

      expect(readFileSync(`${logPathOf(home)}.1`, 'utf8')).toContain(fat);
      expect(readFileSync(logPathOf(home), 'utf8')).toBe('after the rotation\n');
    } finally {
      dispose();
    }
  });
});

describe('the limits the sink follows', () => {
  it('reads the rotation limits on each write, so a setting change applies to the running hub', () => {
    const { home, dispose } = tempHome();

    try {
      let limits = { bytes: LOG_LIMIT_BYTES, kept: 2 };
      const write = fileSink(home, () => limits);

      write('x'.repeat(500));
      expect(existsSync(`${logPathOf(home)}.1`)).toBe(false);

      limits = { bytes: 100, kept: 1 };
      write('y'.repeat(100));
      write('z');

      expect(readFileSync(`${logPathOf(home)}.1`, 'utf8')).toContain('yyyy');
      expect(existsSync(`${logPathOf(home)}.2`)).toBe(false);
      expect(readFileSync(logPathOf(home), 'utf8')).toBe('z\n');
    } finally {
      dispose();
    }
  });
});

describe('the tail a viewer opens on', () => {
  const AT_ONE = '2026-09-06T19:01:24.114Z';
  const AT_TWO = '2026-09-06T19:01:25.114Z';

  function tailOf(text: string | null, bytes = 64) {
    return readLogTail(() => text, 'hub.log', bytes);
  }

  it('reads a file that fits the window whole', () => {
    expect(tailOf(`${AT_ONE} [info] listening\n`, 1000).map((entry) => entry.message)).toEqual(['listening']);
  });

  // A window smaller than the file opens the read mid-line, and half a sentence with no timestamp is not an entry.
  it('drops the fragment a truncated read opens with', () => {
    const text = `tening on 127.0.0.1\n${AT_TWO} [info] stopping: a client asked it to stop\n`;

    expect(tailOf(text, text.length).map((entry) => entry.message)).toEqual(['stopping: a client asked it to stop']);
  });

  it('keeps the first line when the whole file fitted, however short the window looks', () => {
    const text = `${AT_ONE} [info] listening\n`;

    expect(tailOf(text, text.length + 1)).toHaveLength(1);
  });

  // A hub that has never written one, or a home that is not there. Neither is an error a viewer should be shown.
  it('returns no entries for a missing log', () => {
    expect(tailOf(null)).toEqual([]);
  });

  it('returns no entries for an empty log', () => {
    expect(tailOf('', 1000)).toEqual([]);
  });
});
