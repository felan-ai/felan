import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { startAuthWorker } from '../src/setup/auth-driver.js';
import { serverFixture, gate } from './fixtures/server.js';
import type { AuthWorkerOutput } from '../src/setup/auth-wire.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(provider: string) {
  const f = await serverFixture({ now: Date.now }); const control = new AbortController(); const ready = gate();
  const events: AuthWorkerOutput[] = []; let driver: Awaited<ReturnType<typeof startAuthWorker>> | undefined;
  cleanup.push(async () => { control.abort(); await driver?.done.catch(() => {}); await f.dispose(); });
  driver = await startAuthWorker(f.root.agentRuntime, { kind: 'start', provider, method: 'api_key', agentDir: f.owner.target.agentDir }, {
    signal: control.signal, entrypoint: fileURLToPath(new URL('./fixtures/setup-auth-worker.mjs', import.meta.url)),
    event: value => { events.push(value); if (value.kind === 'prompt') ready.resolve(); },
  });
  await ready.promise;
  return { driver, events, control };
}

it('exchanges a secret over owned stdio without reflecting it into output', async () => {
  const f = await fixture('fixture');
  await f.driver.answer('fixture-key', 'synthetic-private-value'); await f.driver.done;
  expect(f.events.map(event => event.kind)).toEqual(['prompt', 'done']);
  expect(JSON.stringify(f.events)).not.toContain('synthetic-private-value');
});

it('joins cancellation of an owned worker even when it ignores graceful signals', async () => {
  const f = await fixture('hold'); f.control.abort();
  await expect(f.driver.done).rejects.toThrow();
});

it('kills a blocked authentication process after its daemon parent disappears', async () => {
  const f = await serverFixture({ now: Date.now }); let pid: number | undefined;
  const parent = await f.root.agentRuntime.processes!.startStdio!(process.execPath,
    [fileURLToPath(new URL('./fixtures/setup-guard-parent.mjs', import.meta.url))]);
  cleanup.push(async () => {
    if (pid) {
      const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
      if (command.includes('/setup-guard-child.mjs')) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
    await parent.dispose(); await f.dispose();
  });
  let output = ''; let offset = 0;
  for (;;) {
    const next = await parent.readStdout(offset, { waitMs: 100, maxBytes: 1024 }); offset = next.nextOffset;
    output += Buffer.from(next.output).toString('utf8');
    if (!next.running && !next.output.length) break;
  }
  pid = Number(output.trim()); expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
  await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow());
});
