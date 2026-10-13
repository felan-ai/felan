import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { HostAgentRuntime } from '@felan-ai/agent-core';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { serverFixture } from '../../daemon/test/fixtures/server.js';
import { SessionClient } from '../src/client/client.js';
import { createLocalSessionRuntime } from '../src/providers/session-runtime.js';
import { TuiSessionController } from '../src/tui/controller.js';
import { createCommandAutocomplete, submitTuiInput } from '../src/tui/commands.js';
import type { TuiDialogHost } from '../src/tui/dialogs.js';

const home = vi.hoisted(() => ({ path: '' }));
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), homedir: () => home.path }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('loads and invokes every workspace and home skill even when daemon storage uses a separate home', async () => {
  home.path = await realpath(await mkdtemp(join(tmpdir(), 'skill-home-')));
  cleanups.push(() => rm(home.path, { recursive: true, force: true }));
  for (const name of ['alpha', 'beta', 'explicit-only']) {
    const directory = join(home.path, '.agents', 'skills', name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} instructions\n${name === 'explicit-only' ? 'disable-model-invocation: true\n' : ''}---\nLoaded ${name} instructions.\n`);
  }
  const f = await serverFixture({ now: Date.now, skill: true, createComposition: runtimeFactory => createLocalSessionRuntime({
    runtimeFactory, runtimeService: { create: (cwd, options) => new HostAgentRuntime(cwd, options) },
    initializeProcess: async () => ({ diagnostics: [], assertConfiguration: () => [] }),
  }) });
  cleanups.push(f.dispose);
  const server = new SessionServer({ registry: f.registry, models: f.root.runtime.session.modelRuntime, version: 'fixture' });
  cleanups.push(async () => { server.close(); });
  await server.start();
  const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
    expected: f.owner.identity, clientVersion: 'fixture', kind: 'tui' });
  const controller = new TuiSessionController(client);
  cleanups.push(() => controller.dispose());
  await client.connect(); await controller.attach(f.root.sessionId);
  const skills = controller.snapshot!.catalog.commands.filter(command => command.kind === 'skill');
  expect(skills.map(command => command.name).sort()).toEqual(['skill:alpha', 'skill:beta', 'skill:explicit-only', 'skill:shared-test-skill']);
  expect(skills.every(command => command.description.length > 0)).toBe(true);
  expect(skills.find(command => command.name === 'skill:alpha')?.source).toContain(home.path);
  const provider = createCommandAutocomplete(controller);
  const options = { signal: new AbortController().signal };
  expect((await provider.getSuggestions(['/skill:'], 0, 7, options))?.items.map(item => item.value).sort()).toEqual(skills.map(command => command.name).sort());
  expect((await provider.getSuggestions(['/alpa'], 0, 5, options))?.items).toEqual([
    { label: 'skill:alpha', value: 'skill:alpha', description: 'alpha instructions' },
  ]);
  const dialogs: TuiDialogHost = { select: async () => undefined, input: async () => undefined, confirm: async () => false };
  for (const skill of skills) {
    const accepted = await submitTuiInput(controller, dialogs, `/${skill.name} literal argument`, { cwd: f.cwd, exit() {} });
    expect(accepted, controller.notice).toBe(true);
    await vi.waitFor(() => expect(f.store.session(f.root.sessionId).run.state).toBe('idle'));
    const users = f.root.runtime.session.sessionManager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'user');
    const last = JSON.stringify(users.at(-1));
    expect(last).toContain(skill.name.slice('skill:'.length));
    expect(last).toContain('Loaded'); expect(last).toContain('literal argument');
  }
});
