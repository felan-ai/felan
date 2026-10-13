import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { HOST_RUNTIME_SERVICE } from '@felan-ai/agent-core';
import { createConfiguredProviders } from '../../daemon/src/daemon/provider-loader.js';
import { spawnDetachedDaemon, type DaemonLaunchReceipt } from '../../daemon/src/daemon/supervisor.js';
import { acquireDaemonOwnership } from '../../daemon/src/daemon/ownership.js';
import { resolveDaemonTarget } from '../../daemon/src/daemon/target.js';
import { SessionClient } from '../src/client/client.js';
import { FELAN_VERSION } from '../src/version.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function target() {
  const root = await mkdtemp(join(tmpdir(), 'felan-dist-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'isolated');
  await mkdir(directory, { mode: 0o700 });
  return { target: { kind: 'isolated' as const, directory, namespaceId: randomUUID() } };
}

it('loads the packaged Felan runtime provider from its trusted managing-package entry', async () => {
    const manager = { packageName: '@felan-ai/felan', version: FELAN_VERSION,
      resolveFrom: new URL('../dist/daemon-host.js', import.meta.url).href,
      resolveProvider: (specifier: string) => {
        const prefix = '@felan-ai/felan/providers/';
        if (!specifier.startsWith(prefix) || !/^[a-z-]+$/u.test(specifier.slice(prefix.length))) throw new Error(`Unexpected fixture provider: ${specifier}`);
        return new URL(`../dist/providers/${specifier.slice(prefix.length)}.js`, import.meta.url).href;
      },
      packagedDefaultPath: fileURLToPath(new URL('../dist/host.json', import.meta.url)) };
    const loadedConfig = await import('../../daemon/src/daemon/host-config.js').then(({ loadHostConfig }) => loadHostConfig({
      agentDir: `${process.cwd()}/missing-test-agent`, packagedDefaultPath: manager.packagedDefaultPath,
    }));
    const loaded = await createConfiguredProviders({ config: loadedConfig.config, manager,
      requiredDaemonServices: [HOST_RUNTIME_SERVICE.key] });
    expect(typeof loaded.services.get(HOST_RUNTIME_SERVICE)?.create).toBe('function');
    expect(loaded.composition.managerPackage).toBe('@felan-ai/felan');
    await loaded.dispose();
  });

it('launches the emitted installed entrypoint and remains alive after a client detaches', async () => {
  const { target: input } = await target();
  let receipt: DaemonLaunchReceipt;
  try { receipt = await spawnDetachedDaemon({ target: input, entrypoint: fileURLToPath(new URL('../dist/daemon-host.js', import.meta.url)) }); }
  catch (error) {
    const resolved = resolveDaemonTarget(input);
    const stderr = await readFile(join(resolved.runtimeDirectory, 'stderr.log'), 'utf8').catch(() => '');
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`);
  }
  const cleanup = new SessionClient({ target: input, expected: receipt.identity, clientVersion: 'fixture', kind: 'tui' });
  cleanups.push(async () => {
    try {
      await cleanup.connect();
      expect((await cleanup.control('host.stop', { confirmed: true, mode: 'force' })).outcome).toBe('accepted');
      await vi.waitFor(async () => { const owner = await acquireDaemonOwnership(input); await owner.release(); }, { timeout: 5_000 });
    }
    finally { cleanup.close(); }
  });
  const client = new SessionClient({ target: input, expected: receipt.identity, clientVersion: 'fixture', kind: 'tui' });
  await client.connect(); client.close();
  await cleanup.connect();
  expect(await cleanup.control('host.status')).toMatchObject({ outcome: 'accepted', state: 'ready', identity: receipt.identity });
  expect(await cleanup.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { setupNeeds: [{ code: 'provider' }] } });
});

