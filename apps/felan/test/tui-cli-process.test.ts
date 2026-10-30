import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { HostAgentRuntime, type AgentRuntimeProcess } from '@felan-ai/agent-core';
import { clientDaemonTarget } from '../src/client-application.js';
import { resolveClientHostComposition } from '../src/daemon-entrypoint.js';
import { SessionClient } from '../src/client/client.js';
import { DaemonConfiguration } from '../src/providers/configuration.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { gate, serverFixture } from '../../daemon/test/fixtures/server.js';
import { DAEMON_VERSION } from '@felan-ai/daemon';
import { stripTerminalSequences } from '@earendil-works/pi-tui';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(hold = false, version = DAEMON_VERSION, compositionMismatch = false) {
  const entered = gate(); const release = gate();
  const f = await serverFixture({ now: Date.now, namespace: directory => {
    const target = clientDaemonTarget({ daemonRuntime: directory });
    if (target.kind !== 'isolated') throw new Error('Expected an isolated target');
    return target.namespaceId;
  }, onStream: async () => { entered.resolve(); if (hold) await release.promise; } });
  let server: SessionServer | undefined;
  const processes: AgentRuntimeProcess[] = []; const clients: SessionClient[] = [];
  cleanups.push(async () => {
    release.resolve();
    const results = await Promise.allSettled(processes.map(async process => { try { await process.terminate('SIGKILL'); } finally { await process.dispose(); } }));
    try { for (const client of clients) client.close(); server?.close(); }
    finally { await f.dispose(); }
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Client process cleanup failed.');
  });
  const runtime = new HostAgentRuntime(f.cwd, { sessionStorageRoot: join(f.directory, 'test-session'), agentStorageRoot: join(f.directory, 'test-agent') });
  const daemonTarget = clientDaemonTarget({ daemonRuntime: f.directory });
  const resolved = await resolveClientHostComposition(daemonTarget);
  const composition = { ...resolved, ...(compositionMismatch ? { providerDigest: '0'.repeat(64) } : {}) };
  server = new SessionServer({ registry: f.registry, models: f.root.runtime.session.modelRuntime, version, composition,
    configuration: new DaemonConfiguration({ agentDir: f.owner.target.agentDir, definitions: [], assertCurrent: () => f.registry.assertAdmission() }) });
  await server.start();
  async function launch(message: string) {
    const command = [process.execPath, fileURLToPath(new URL('../dist/cli.js', import.meta.url)), '--daemon-runtime', f.directory,
      '--session', f.root.sessionId, message].map(quote).join(' ');
    const child = await runtime.terminals!.startShell(`exec ${command}`); processes.push(child); return child;
  }
  async function client() {
    const value = new SessionClient({ target: clientDaemonTarget({ daemonRuntime: f.directory }), expected: f.owner.identity, clientVersion: 'fixture', kind: 'tui' });
    clients.push(value); await value.connect(); await value.attach(f.root.sessionId); return value;
  }
  return { ...f, entered, release, launch, client };
}

it('runs the emitted CLI over a real PTY and detaches without closing its daemon session', async () => {
  const f = await fixture(); const child = await f.launch('real terminal prompt');
  const output = await readUntil(child, text => {
    const visible = stripTerminalSequences(text);
    return visible.includes('Felan') && visible.includes('real terminal prompt')
      && visible.includes('done') && f.store.session(f.root.sessionId).run.state === 'idle';
  });
  expect(output).not.toContain('Runtime: host');
  expect(f.store.session(f.root.sessionId).run.state).toBe('idle');
  await child.write(new TextEncoder().encode('\x04'));
  await readUntil(child, (_text, running) => !running);
  expect(f.store.session(f.root.sessionId).state).toBe('open');
  const observer = await f.client(); expect(observer.getAttachment(f.root.sessionId)?.state.snapshot?.state).toBe('open');
  expect(observer.getAttachment(f.root.sessionId)?.state.snapshot?.run.state).toBe('idle');
}, 20_000);

it('keeps an active daemon run alive after the terminal client is killed', async () => {
  const f = await fixture(true); const child = await f.launch('survive terminal loss');
  await f.entered.promise;
  await child.terminate('SIGKILL');
  expect(f.store.session(f.root.sessionId).run.state).toBe('running');
  const observer = await f.client();
  expect(observer.getAttachment(f.root.sessionId)?.state.snapshot?.run.state).toBe('running');
  f.release.resolve();
}, 20_000);

it('attaches across provider configuration differences without a restart dialog', async () => {
  const f = await fixture(true, DAEMON_VERSION, true);
  const observer = await f.client();
  void observer.request('prompt', { text: 'active run' }, { session: f.root.sessionId });
  await f.entered.promise;
  const child = await f.launch('continue with this configuration');
  const output = await readUntil(child, text => stripTerminalSequences(text).includes('continue with this configuration'));
  expect(stripTerminalSequences(output)).not.toContain('1 active task will be interrupted');
  expect(f.store.session(f.root.sessionId).state).toBe('open');
  await child.write(new TextEncoder().encode('\x04'));
  await readUntil(child, (_text, running) => !running);
}, 20_000);

it('attaches to a busy different-build daemon with a warning instead of a restart dialog', async () => {
  const f = await fixture(true, 'previous-fixture');
  const observer = await f.client();
  void observer.request('prompt', { text: 'active run' }, { session: f.root.sessionId });
  await f.entered.promise;
  const child = await f.launch('continue with this build');
  const output = await readUntil(child, text => {
    const visible = stripTerminalSequences(text);
    return visible.includes('Daemon previous-fixture is running') && visible.includes('continue with this build');
  });
  expect(stripTerminalSequences(output)).toContain('Run /restart to apply the new build.');
  expect(stripTerminalSequences(output)).not.toContain('Restart it now?');
  expect(f.store.session(f.root.sessionId).run.state).toBe('running');
  await child.write(new TextEncoder().encode('\x04'));
  await readUntil(child, (_text, running) => !running);
  expect(f.store.session(f.root.sessionId).state).toBe('open');
}, 20_000);

async function readUntil(process: AgentRuntimeProcess, predicate: (text: string, running: boolean) => boolean): Promise<string> {
  const deadline = performance.now() + 10_000; const decoder = new TextDecoder(); let offset = 0; let text = '';
  while (performance.now() < deadline) {
    const result = await process.read(offset, { waitMs: 500, maxBytes: 64 * 1024 }); offset = result.nextOffset;
    text = (text + decoder.decode(result.output, { stream: result.running })).slice(-256 * 1024);
    if (predicate(text, result.running)) return text;
    if (!result.running) throw new Error(`Terminal exited before the expected output: ${text}`);
  }
  throw new Error(`Terminal did not reach the expected state: ${text}`);
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
