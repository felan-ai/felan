import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

vi.mock('@felan-ai/agent-core', () => {
  throw new Error('The terminal frontend must not initialize the agent runtime.');
});
vi.mock('@felan-ai/daemon', () => {
  throw new Error('The terminal frontend must not load the daemon barrel.');
});
vi.mock('@felan-ai/daemon/daemon-bootstrap', () => {
  throw new Error('The terminal frontend must not load the daemon bootstrap.');
});

it('loads version and host configuration from public subpaths without the daemon runtime', async () => {
  const { DAEMON_VERSION } = await import('@felan-ai/daemon/version');
  const { loadHostConfig, resolveHostComposition } = await import('@felan-ai/daemon/host-config');
  expect(DAEMON_VERSION).toMatch(/^\d+\.\d+\.\d+/u);
  expect(loadHostConfig).toBeTypeOf('function');
  expect(resolveHostComposition).toBeTypeOf('function');
});

it('loads the terminal frontend without evaluating the agent runtime', async () => {
  const { runDaemonTerminal } = await import('../src/tui/run.js');
  expect(runDaemonTerminal).toBeTypeOf('function');
});

it('resolves client identity and host composition without loading the daemon server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'felan-lazy-client-'));
  try {
    const { clientDaemonTarget, runDaemonFelan } = await import('../src/client-application.js');
    const { resolveClientHostComposition } = await import('../src/daemon-entrypoint.js');
    const signal = AbortSignal.abort();
    await runDaemonFelan({ daemonRuntime: root, signal });
    const composition = await resolveClientHostComposition(clientDaemonTarget({ daemonRuntime: root }));
    expect(composition.managerPackage).toBe('@felan-ai/felan');
    expect(composition.configDigest).toMatch(/^[a-f0-9]{64}$/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
