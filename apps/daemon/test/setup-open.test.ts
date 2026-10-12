import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { INSIGHTS_REPORT_PRESENTER } from '@felan-ai/ext-insights/view';
import { createRegistryInteractionBroker } from '../src/daemon/broker.js';
import { SESSION_UI_PRESENTERS } from '../src/daemon/extension-ui.js';
import { prepareHostInteraction, openHostUrl } from '../src/setup/open.js';
import { serverFixture } from './fixtures/server.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const f = await serverFixture({ now: Date.now }); const broker = createRegistryInteractionBroker(f.registry, { presenters: SESSION_UI_PRESENTERS });
  const exec = vi.spyOn(f.root.agentRuntime, 'exec').mockResolvedValue({ code: 0, stdout: '', stderr: '', killed: false });
  cleanup.push(async () => { await broker.drain(); await f.dispose(); });
  broker.connected({ attachment: 'owner', principal: 'local', kind: 'tui', sessions: [f.root.sessionId], interactionKinds: ['oauth', 'custom'], presenters: [INSIGHTS_REPORT_PRESENTER] });
  return { ...f, broker, exec, options: { runtime: f.root.agentRuntime, broker, assertCurrent: () => f.owner.assertCurrent(), assertOwnsPath: (path: string) => f.owner.assertOwnsPath(path) } };
}

it('opens only an eligible pending OAuth interaction without resolving or persisting its URL', async () => {
  const f = await fixture(); const url = 'https://example.invalid/authorize?state=synthetic-private-state';
  const waiting = f.broker.request({ kind: 'oauth', provider: 'fixture', provisioningId: 'flow', url, instructions: 'Authorize' }, { kind: 'host', recipient: 'owner' });
  const item = f.broker.pending()[0]!;
  expect(() => prepareHostInteraction(f.options, item.id, 'other', new AbortController().signal)).toThrow();
  expect(f.exec).not.toHaveBeenCalled();
  await prepareHostInteraction(f.options, item.id, 'owner', new AbortController().signal)();
  expect(f.exec.mock.calls[0]?.[1]).toContain(url); expect(f.broker.pending()).toHaveLength(1);
  expect(JSON.stringify(f.store.snapshot())).not.toContain('synthetic-private-state');
  f.broker.cancel(item.id, 'abort'); await waiting;
});

it('requires an owned report path and validates before invoking an application', async () => {
  const f = await fixture(); const scope = { kind: 'session' as const, session: f.root.sessionId, root: f.root.sessionId };
  const outside = f.broker.request({ kind: 'custom', presenter: INSIGHTS_REPORT_PRESENTER, data: { path: '/outside/insights-reports/felan-insights.html' } }, scope);
  const item = f.broker.pending()[0]!;
  expect(() => prepareHostInteraction(f.options, item.id, 'owner', new AbortController().signal)).toThrow('Outside private server fixture');
  expect(f.exec).not.toHaveBeenCalled(); f.broker.cancel(item.id, 'abort'); await outside;
  const path = join(f.directory, 'insights-reports', 'felan-insights.html');
  const inside = f.broker.request({ kind: 'custom', presenter: INSIGHTS_REPORT_PRESENTER, data: { path } }, scope);
  const next = f.broker.pending()[0]!; await prepareHostInteraction(f.options, next.id, 'owner', new AbortController().signal)();
  expect(f.exec.mock.calls[0]?.[1]).toContain(path); f.broker.cancel(next.id, 'abort'); await inside;
});

it('rejects credential-bearing URLs, non-web schemes and terminal control bytes', async () => {
  const f = await fixture(); const signal = new AbortController().signal;
  for (const value of ['javascript:alert(1)', 'https://user:password@example.invalid', 'https://example.invalid/\n']) {
    await expect(openHostUrl(f.root.agentRuntime, value, signal)).rejects.toThrow();
  }
  expect(f.exec).not.toHaveBeenCalled();
});
