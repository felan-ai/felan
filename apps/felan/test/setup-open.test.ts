import { afterEach, expect, it, vi } from 'vitest';
import type { AgentRuntime } from '@felan-ai/agent-core';
import type { Interaction } from '@felan-ai/session-protocol';
import { createRegistryInteractionBroker } from '../../daemon/src/daemon/broker.js';
import { prepareHostInteraction } from '../../daemon/src/setup/open.js';
import { prepareLocalInteractionOpen, openHostUrl, openBrowserSetup } from '../src/providers/setup-open.js';
import { serverFixture } from '../../daemon/test/fixtures/server.js';

const nativeOpen = vi.hoisted(() => vi.fn((_command: string, _args: readonly string[], _options: unknown,
  callback: (error: Error | null, stdout: string, stderr: string) => void) => { callback(null, '', ''); }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), execFile: nativeOpen }));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); nativeOpen.mockClear(); for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const f = await serverFixture({ now: Date.now }); const broker = createRegistryInteractionBroker(f.registry, {  });
  const exec = vi.spyOn(f.root.agentRuntime, 'exec').mockResolvedValue({ code: 0, stdout: '', stderr: '', killed: false });
  cleanup.push(async () => { await broker.drain(); await f.dispose(); });
  broker.connected({ attachment: 'owner', principal: 'local', kind: 'tui', sessions: [f.root.sessionId], interactionKinds: ['form'] });
  return { ...f, broker, exec, options: { broker, assertCurrent: () => f.owner.assertCurrent(),
    prepareOpen: (request: Interaction['request'], signal: AbortSignal) => prepareLocalInteractionOpen({ runtime: f.root.agentRuntime,
      assertOwnsPath: (path: string) => f.owner.assertOwnsPath(path) }, request, signal) } };
}

it('does not turn an ordinary form into external-application authority', async () => {
  const f = await fixture();
  const waiting = f.broker.request({ kind: 'form', form: { title: 'Sign in', fallback: 'Sign in',
    description: 'https://example.invalid/authorize', input: { fields: [] },
    actions: [{ id: 'cancel', label: 'Cancel', target: 'element', outcome: 'cancel' }] } }, { kind: 'host', recipient: 'owner' });
  const item = f.broker.pending()[0]!;
  expect(() => prepareHostInteraction(f.options, item.id, 'owner', new AbortController().signal)).toThrow('cannot open');
  expect(f.exec).not.toHaveBeenCalled();
  f.broker.cancel(item.id, 'abort'); await waiting;
});

it('rejects credential-bearing URLs, non-web schemes and terminal control bytes', async () => {
  const f = await fixture(); const signal = new AbortController().signal;
  for (const value of ['javascript:alert(1)', 'https://user:password@example.invalid', 'https://example.invalid/\n']) {
    await expect(openHostUrl(f.root.agentRuntime, value, signal)).rejects.toThrow();
  }
  expect(f.exec).not.toHaveBeenCalled();
  expect(nativeOpen).not.toHaveBeenCalled();
});

it.runIf(process.platform === 'win32')('uses the absolute Windows launcher despite an untrusted working directory and PATH', async () => {
  vi.stubEnv('SystemRoot', 'C:\\Windows'); vi.stubEnv('PATH', '.'); vi.spyOn(process, 'cwd').mockReturnValue('C:\\untrusted');
  const exec = vi.fn(); const runtime = { kind: 'host', exec } as unknown as AgentRuntime;
  const signal = new AbortController().signal; const url = 'https://example.invalid/?one=1&two=%22hello%22';
  await openHostUrl(runtime, url, signal);
  expect(nativeOpen).toHaveBeenCalledExactlyOnceWith('C:\\Windows\\System32\\rundll32.exe', ['url.dll,FileProtocolHandler', url], {
    signal, timeout: 5000, maxBuffer: 4096, windowsHide: false,
  }, expect.any(Function));
  expect(exec).not.toHaveBeenCalled();
});

it.runIf(process.platform === 'win32').each([undefined, 'relative', '\\Windows'])('refuses an unqualified Windows system directory %j', async root => {
  vi.stubEnv('SystemRoot', root);
  await expect(openHostUrl({ kind: 'host' } as AgentRuntime, 'https://example.invalid/', new AbortController().signal)).rejects.toThrow('system directory is unavailable');
  expect(nativeOpen).not.toHaveBeenCalled();
});

it.runIf(process.platform === 'win32')('does not open Windows applications for remote runtimes or cancelled requests', async () => {
  const signal = new AbortController().signal;
  await expect(openHostUrl({ kind: 'docker' } as AgentRuntime, 'https://example.invalid/', signal)).rejects.toThrow('host runtime');
  const controller = new AbortController(); controller.abort();
  await expect(openHostUrl({ kind: 'host' } as AgentRuntime, 'https://example.invalid/', controller.signal)).rejects.toThrow();
  await expect(openBrowserSetup({ kind: 'host' } as AgentRuntime, 'C:\\Chrome.exe', signal)).rejects.toThrow('not supported');
  expect(nativeOpen).not.toHaveBeenCalled();
});

it.runIf(process.platform === 'win32')('reports a failed native browser launch without exposing its output', async () => {
  nativeOpen.mockImplementationOnce((_command, _args, _options, callback) => { callback(new Error('private launcher output'), '', ''); });
  await expect(openHostUrl({ kind: 'host' } as AgentRuntime, 'https://example.invalid/', new AbortController().signal)).rejects.toThrow('The local application could not be opened.');
});
