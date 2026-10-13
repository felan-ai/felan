import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import type { Interaction } from '@felan-ai/session-protocol';
import { createRegistryInteractionBroker } from '../../daemon/src/daemon/broker.js';
import { prepareHostInteraction } from '../../daemon/src/setup/open.js';
import { prepareLocalInteractionOpen, openHostUrl } from '../src/providers/setup-open.js';
import { serverFixture } from '../../daemon/test/fixtures/server.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(localConsole = true) {
  const f = await serverFixture({ now: Date.now }); const broker = createRegistryInteractionBroker(f.registry, {  });
  const exec = vi.spyOn(f.root.agentRuntime, 'exec').mockResolvedValue({ code: 0, stdout: '', stderr: '', killed: false });
  cleanup.push(async () => { await broker.drain(); await f.dispose(); });
  broker.connected({ attachment: 'owner', principal: 'local', kind: 'tui', localConsole, sessions: [f.root.sessionId], interactionKinds: ['form'] });
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
});
