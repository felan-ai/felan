import { describe, expect, it, vi } from 'vitest';
import { createLogger, type LogRecord } from '../src/logger.js';
import { createClassifierPreflight } from '../src/classifier/preflight.js';

describe('classifier first-turn preflight', () => {
  it('shares one deadline across three calls and leaves later decisions uncapped', async () => {
    vi.useFakeTimers();
    try {
      const records: LogRecord[] = [];
      const scope = createClassifierPreflight(createLogger({ level: 'debug',
        destination: { write: (record) => { records.push(record); } } }));
      expect(await scope.run('background', async () => 'unbounded')).toBe('unbounded');
      scope.startNextTurn();
      const stalled = (_signal: AbortSignal) => new Promise<string>(() => {});
      const first = scope.run('route', stalled);
      const firstFailure = expect(first).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(1_500);
      const second = scope.run('broad_discovery', stalled);
      const third = scope.run('effort', stalled);
      const secondFailure = expect(second).rejects.toMatchObject({ code: 'timeout' });
      const thirdFailure = expect(third).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(500);
      await Promise.all([firstFailure, secondFailure, thirdFailure]);
      scope.finishPreflight();
      expect(records.filter((record) => record.fields.outcome === 'expired')).toHaveLength(3);
      expect(records.filter((record) => record.fields.event === 'turn-start')).toHaveLength(1);
      expect(await scope.run('later', async () => 'unbounded')).toBe('unbounded');
      scope.startNextTurn();
      expect(await scope.run('route', async () => 'fast')).toBe('fast');
      scope.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs provider failures without request text and discards late responses', async () => {
    vi.useFakeTimers();
    try {
      const records: LogRecord[] = [];
      const scope = createClassifierPreflight(createLogger({ level: 'debug',
        destination: { write: (record) => { records.push(record); } } }));
      scope.startNextTurn();
      await expect(scope.run('entry', async () => { throw new Error('secret prompt'); }))
        .rejects.toThrow('secret prompt');
      expect(records[0]?.fields.outcome).toBe('failed');
      let release!: (value: string) => void;
      const slow = scope.run('effort', () => new Promise<string>((resolve) => { release = resolve; }));
      const failure = expect(slow).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(2_000);
      await failure;
      release('stale');
      expect(JSON.stringify(records)).not.toContain('secret prompt');
      scope.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
