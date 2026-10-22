import { afterEach, expect, it } from 'vitest';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BoundedDaemonLogs } from '../src/daemon/supervisor.js';
import { DaemonOperationalLog } from '../src/daemon/operational-log.js';
import { serverFixture } from './fixtures/server.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

it('keeps a bounded persisted rolling tail across reopening the log', async () => {
  const f = await serverFixture(); cleanup.push(() => f.dispose());
  let sink = new BoundedDaemonLogs(f.owner, 256); cleanup.push(async () => sink.close());
  const log = new DaemonOperationalLog(sink, () => 42);
  for (let i = 0; i < 20; i++) log.record('started');
  sink.close(); sink = new BoundedDaemonLogs(f.owner, 256);
  const restored = new DaemonOperationalLog(sink);
  expect(restored.page({}).entries.length).toBeGreaterThan(0);
  expect(restored.page({}).entries.every(row => row.message === 'Daemon is ready.')).toBe(true);
  expect((await stat(join(f.owner.target.runtimeDirectory, 'stdout.log'))).size).toBeLessThanOrEqual(256);
  expect((await stat(join(f.owner.target.runtimeDirectory, 'stdout.log'))).mode & 0o777).toBe(0o600);
});

it('rejects stale pages and does not expose arbitrary persisted text', async () => {
  const f = await serverFixture(); cleanup.push(() => f.dispose());
  let sink = new BoundedDaemonLogs(f.owner); cleanup.push(async () => sink.close());
  const log = new DaemonOperationalLog(sink, () => 42); log.record('started'); log.record('stop_requested');
  const first = log.page({ limit: 1 }); expect(first.cursor).toBeDefined();
  expect(log.page({ cursor: first.cursor!, limit: 1 }).entries[0]?.message).toBe('Explicit daemon stop requested.');
  log.record('drain_blocked'); expect(() => log.page({ cursor: first.cursor! })).toThrow();
  sink.close();
  await writeFile(join(f.owner.target.runtimeDirectory, 'stdout.log'), JSON.stringify({ timestamp: 1, level: 'info', message: 'synthetic private data' }) + '\n');
  sink = new BoundedDaemonLogs(f.owner);
  expect(new DaemonOperationalLog(sink).page({}).entries).toEqual([]);
  sink.close(); expect(() => sink.read('stdout')).toThrow('closed');
});

it('records original projection failures with bounded, redacted diagnostics', async () => {
  const f = await serverFixture(); cleanup.push(() => f.dispose());
  const sink = new BoundedDaemonLogs(f.owner); cleanup.push(async () => sink.close());
  const log = new DaemonOperationalLog(sink, () => 42);
  const error = new Error('projection failed token=private-token\n\u001b[31m' + 'x'.repeat(5000));
  log.failure({ scope: 'projection', session: 'fixture', error });
  const entry = log.page({}).entries.at(-1)!;
  expect(entry.message).toContain('Daemon failure in projection (session fixture): Error: projection failed token=[redacted]');
  expect(entry.message).not.toContain('private-token');
  expect(entry.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
  expect(Buffer.byteLength(entry.message)).toBeLessThanOrEqual(2000);
});
