import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanups, harness, session, TEST_TIMEOUT_MS } from './fixtures/hold-runs.js';

const WAIT_MS = 30_000;
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

// The felan providers fix the agent directory per process, so this daemon needs its own test file.
it('interrupts a held run whose continue record the next daemon cannot read', async () => {
  const h = await harness(['root-b']);
  let client = await h.connect();
  const b = await session(client, h.cwd, 'ROOT-B start');
  await vi.waitFor(async () => expect(await h.log()).toEqual(['root-b']), { timeout: WAIT_MS });
  const run = h.store().sessionMetadata(b).run.id;
  expect(await h.hold(client)).toMatchObject({ outcome: 'accepted', held: { runs: 1 } });
  await client.close();
  await h.stop();
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(join(h.store().directory, 'control.sqlite'));
  try {
    const row = db.prepare('SELECT data FROM held_runs WHERE session = ?').get(b) as { data: string };
    db.prepare('UPDATE held_runs SET data = ? WHERE session = ?').run(JSON.stringify({ ...JSON.parse(row.data), version: 2 }), b);
  } finally { db.close(); }
  await h.start();
  client = await h.connect();
  await vi.waitFor(() => expect(h.store().sessionMetadata(b).run).toMatchObject({ id: run, state: 'interrupted' }), { timeout: WAIT_MS });
  expect(h.model.calls.filter(call => call.who === 'root-b')).toHaveLength(1);
}, TEST_TIMEOUT_MS);
