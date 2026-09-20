import { describe, expect, it, vi } from 'vitest';
import {
  LOG_LEVELS,
  createLogger,
  createSilentLogger,
  isLogLevel,
  isLoggerLevel,
  type LogRecord,
} from '../src/index.js';

describe('Agent Core logger', () => {
  it('exports ordered levels and silent loggers emit nothing', () => {
    expect(LOG_LEVELS).toEqual(['debug', 'info', 'warn', 'error']);
    expect(isLogLevel('debug')).toBe(true);
    expect(isLoggerLevel('off')).toBe(true);
    expect(isLoggerLevel('trace')).toBe(false);
    const destination = { write: vi.fn() };
    createSilentLogger().error({ ok: true }, 'nope');
    createLogger({ level: 'off', destination }).info('nope');
    expect(destination.write).not.toHaveBeenCalled();
  });

  it('filters by level, binds child fields, and omits undefined message', () => {
    const records: LogRecord[] = [];
    const logger = createLogger({
      level: 'info',
      destination: { write: (record) => { records.push(record); } },
      bindings: { component: 'core' },
      now: () => new Date('2026-09-19T12:00:00.000Z'),
    });

    logger.debug('hidden');
    logger.info({ count: 2 }, 'kept');
    logger.child({ request: 'prune' }).warn('child');
    logger.error('plain');

    expect(records).toEqual([
      {
        level: 'info',
        time: '2026-09-19T12:00:00.000Z',
        fields: { component: 'core', count: 2 },
        msg: 'kept',
      },
      {
        level: 'warn',
        time: '2026-09-19T12:00:00.000Z',
        fields: { component: 'core', request: 'prune' },
        msg: 'child',
      },
      {
        level: 'error',
        time: '2026-09-19T12:00:00.000Z',
        fields: { component: 'core' },
        msg: 'plain',
      },
    ]);
  });

  it('drops unsafe values and never throws when a destination fails', async () => {
    const records: LogRecord[] = [];
    const logger = createLogger({
      destination: {
        write(record) {
          records.push(record);
          throw new Error('sink failed');
        },
      },
    });
    expect(() => logger.info({
      ok: true,
      skip: undefined,
      fn: () => 1,
      err: Object.assign(new Error('boom'), { name: 'Boom' }),
    })).not.toThrow();
    expect(records).toEqual([
      expect.objectContaining({
        level: 'info',
        fields: { ok: true, err: { name: 'Boom', message: 'boom' } },
      }),
    ]);
    const asyncLogger = createLogger({
      destination: {
        write: () => Promise.reject(new Error('async sink failed')),
      },
    });
    expect(() => asyncLogger.warn('still ok')).not.toThrow();
    await Promise.resolve();
  });
});
