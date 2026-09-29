import { describe, expect, it, vi } from 'vitest';
import { createLogger, type LogRecord } from '../../src/logger.js';
import { createJevPreflight } from '../../src/classifier/jev/preflight.js';

describe('Jev first-turn preflight', () => {
  it('shares one deadline across three calls and leaves later decisions uncapped', async () => {
    vi.useFakeTimers();
    try {
      const records: LogRecord[] = [];
      const scope = createJevPreflight(createLogger({ level: 'debug',
        destination: { write: (record) => { records.push(record); } } }));
      expect(await scope.evaluate('background', async () => 'unbounded')).toBe('unbounded');
      scope.startNextTurn();
      const stalled = (_signal: AbortSignal) => new Promise<string>(() => {});
      const first = scope.evaluate('route', stalled);
      const firstFailure = expect(first).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(1_500);
      const second = scope.evaluate('broad_discovery', stalled);
      const third = scope.evaluate('effort', stalled);
      const secondFailure = expect(second).rejects.toMatchObject({ code: 'timeout' });
      const thirdFailure = expect(third).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(500);
      await Promise.all([firstFailure, secondFailure, thirdFailure]);
      scope.finishPreflight();
      expect(records.filter((record) => record.fields.outcome === 'expired')).toHaveLength(3);
      expect(records.filter((record) => record.fields.event === 'turn-start')).toHaveLength(1);
      expect(await scope.evaluate('later', async () => 'unbounded')).toBe('unbounded');
      scope.startNextTurn();
      expect(await scope.evaluate('route', async () => 'fast')).toBe('fast');
      scope.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs provider failures without request text and discards late responses', async () => {
    vi.useFakeTimers();
    try {
      const records: LogRecord[] = [];
      const scope = createJevPreflight(createLogger({ level: 'debug',
        destination: { write: (record) => { records.push(record); } } }));
      scope.startNextTurn();
      await expect(scope.evaluate('entry', async () => { throw new Error('secret prompt'); }))
        .rejects.toThrow('secret prompt');
      expect(records[0]?.fields.outcome).toBe('failed');
      let release!: (value: string) => void;
      const slow = scope.evaluate('effort', () => new Promise<string>((resolve) => { release = resolve; }));
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
