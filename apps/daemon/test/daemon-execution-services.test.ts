import { dirname } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRegistryInteractionBroker, type InteractionBroker } from '../src/daemon/broker.js';
import { createDaemonExecutionServices } from '../src/daemon/execution-services.js';
import { SESSION_UI_PRESENTERS } from '../src/daemon/extension-ui.js';
import type { RegistryOpenRequest } from '../src/daemon/registry.js';
import type { LocalSubagentHost } from '../src/subagents/host.js';
import { serverFixture } from './fixtures/server.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(builtins = ['subagents', 'askUser']) {
  let broker: InteractionBroker | undefined;
  const requests: RegistryOpenRequest[] = [];
  const f = await serverFixture({ now: Date.now, deferActivation: true, builtins,
    servicesFactory: registry => {
      broker = createRegistryInteractionBroker(registry, { presenters: SESSION_UI_PRESENTERS });
      const services = createDaemonExecutionServices(registry, broker, { homeDir: dirname(registry.options.owner.target.agentDir), version: 'fixture' });
      return input => { requests.push(input.request); return services(input); };
    } });
  cleanups.push(async () => { await broker!.drain(); await f.dispose(); });
  return { ...f, broker: broker!, requests };
}

it('assembles real root tools and a registered root subagent host', async () => {
  const f = await fixture();
  expect(f.root.runtime.session.getAllTools().map(tool => tool.name)).toEqual(expect.arrayContaining(['Agent', 'ask_user']));
  const host = f.registry.subagentView(f.root.sessionId) as LocalSubagentHost;
  expect(host.descriptors.some(item => item.id === 'general')).toBe(true);
  expect(host.hasActiveJobs()).toBe(false);
});

it('passes the actual child-scoped host through profile opening, not the root host', async () => {
  const f = await fixture(); const host = f.registry.subagentView(f.root.sessionId) as LocalSubagentHost;
  const first = await host.spawn({ type: 'general', description: 'first child', prompt: 'first', model: 'offline/fixture' });
  expect(first.ok).toBe(true); if (!first.ok) return;
  const second = await host.spawn({ type: 'general', description: 'second child', prompt: 'second', model: 'offline/fixture' });
  expect(second.ok).toBe(true); if (!second.ok) return;
  await vi.waitFor(() => expect(host.getLocalSubagent(first.value.agentId)?.status).toBe('completed'));
  await vi.waitFor(() => expect(host.getLocalSubagent(second.value.agentId)?.status).toBe('completed'));
  await host.settle();
  const childId = host.getLocalSubagent(first.value.agentId)!.sessionId!;
  const childHost = f.registry.subagentView(childId) as LocalSubagentHost;
  expect(childHost).not.toBe(host);
  expect(f.requests.find(request => request.parentSessionId && request.subagentHost === childHost)).toBeDefined();
  expect((await childHost.getResult(second.value.agentId)).ok).toBe(false);
  expect((await host.scopeToSession(childId).getResult(second.value.agentId)).ok).toBe(false);
  expect(() => host.scopeToSession('unknown-session')).toThrow();
});

it('disposes explicitly idle-safe services during eviction and rebuilds them on restore', async () => {
  const f = await fixture(); const original = f.registry.subagentView(f.root.sessionId);
  expect(await f.registry.evictIdle()).toContain(f.root.sessionId);
  expect(f.registry.binding(f.root.sessionId)).toBeUndefined();
  await f.registry.restore(f.root.sessionId);
  expect(f.registry.subagentView(f.root.sessionId)).not.toBe(original);
  expect(f.registry.binding(f.root.sessionId)?.runtime.session.getAllTools().map(tool => tool.name)).toContain('Agent');
});

it('keeps a root host alive while a child runtime remains warm', async () => {
  const f = await fixture(); const host = f.registry.subagentView(f.root.sessionId) as LocalSubagentHost;
  const child = await host.spawn({ type: 'general', description: 'attached child', prompt: 'child', model: 'offline/fixture' });
  expect(child.ok).toBe(true); if (!child.ok) return;
  await vi.waitFor(() => expect(host.getLocalSubagent(child.value.agentId)?.status).toBe('completed')); await host.settle();
  const childId = host.getLocalSubagent(child.value.agentId)!.sessionId!;
  const attachment = await f.registry.attach(childId, { principal: 'fixture', kind: 'tui' });
  expect(await f.registry.evictIdle()).not.toContain(f.root.sessionId);
  expect(f.registry.subagentView(f.root.sessionId)).toBe(host);
  f.registry.detach(childId, attachment.attachment);
});

it('installs the memory control command with daemon-owned memory services', async () => {
  const f = await fixture(['memory', 'subagents']);
  expect(f.root.runtime.session.extensionRunner?.getRegisteredCommands().some(command => command.name === 'memory')).toBe(true);
  await f.registry.beginDrain(); await f.registry.waitForDrain();
});
