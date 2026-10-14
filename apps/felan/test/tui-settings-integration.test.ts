import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { configField, defineExtensionConfig } from '@felan-ai/agent-core';
import { stripTerminalSequences, type Component, type TUI } from '@earendil-works/pi-tui';
import { SessionClient } from '../src/client/client.js';
import { DaemonConfiguration } from '../src/providers/configuration.js';
import { TerminalPreferences } from '../src/tui/preferences.js';
import { TuiDialogs } from '../src/tui/dialogs.js';
import type { TuiSessionController } from '../src/tui/controller.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { serverFixture } from '../../daemon/test/fixtures/server.js';

it('renders the unified selector and persists extension changes through the daemon without exposing secrets', async () => {
  const definition = defineExtensionConfig({ id: 'example', title: 'Example extension', fields: {
    enabled: configField.boolean({ default: false, label: 'Enabled', description: 'Enable the example extension.' }),
    count: configField.number({ default: 3, description: 'Positive count', validate: value => typeof value === 'number' && value > 0 ? undefined : 'Must be positive' }),
    token: configField.string({ default: '', description: 'Credential', sensitive: true }),
  } });
  const f = await serverFixture({ now: Date.now, configDefinitions: [definition] });
  const configuration = new DaemonConfiguration({ agentDir: f.owner.target.agentDir, definitions: [definition], assertCurrent: () => f.owner.assertCurrent() });
  const path = join(f.owner.target.agentDir, 'settings.json');
  await writeFile(path, JSON.stringify({ extensionConfig: { example: { token: 'never-render-this-secret' } } }));
  const server = new SessionServer({ registry: f.registry, models: f.root.runtime.session.modelRuntime, version: 'fixture', configuration });
  const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
    clientVersion: 'fixture', kind: 'tui', requestTimeoutMs: 3000, retries: 0 });
  let component!: Component;
  const dialogs = new TuiDialogs({ requestRender() {}, showOverlay(value: Component) { component = value; return { hide() {} }; } } as unknown as TUI);
  const controller = { perform: client.request.bind(client), notice: '', setNotice(value: string) { this.notice = value; } } as unknown as TuiSessionController;
  const preferences = new TerminalPreferences(controller, {}, async () => {});
  const render = () => component.render(90).map(stripTerminalSequences).join('\n');
  let opening: Promise<boolean> | undefined;
  try {
    await server.start(); await client.connect();
    opening = preferences.open(dialogs);
    await vi.waitFor(() => expect(component).toBeDefined());
    const screen = render();
    expect(screen).toContain('General settings'); expect(screen).toContain('Example extension'); expect(screen).toContain('3 settings');
    expect(screen).toContain('Type to search · Enter/Space to change · Esc to cancel');
    expect(screen).not.toContain('Filter choices'); expect(screen).not.toContain('Save');
    expect(screen.split('\n')[0]).toBe('─'.repeat(90)); expect(screen.split('\n').at(-1)).toBe('─'.repeat(90));
    component.handleInput!('example'); component.handleInput!('\r');
    expect(render()).toContain('Enabled'); expect(render()).toContain('false');
    component.handleInput!(' ');
    await vi.waitFor(async () => expect((await configuration.get('global')).values.extensionConfig?.example?.enabled, render()).toBe(true));
    expect(render()).toContain('true');
    component.handleInput!('\x1b[B'); component.handleInput!('\r');
    component.handleInput!('\x0b'); component.handleInput!('0'); component.handleInput!('\r');
    await vi.waitFor(() => expect(render()).toContain('Operation did not complete.'));
    expect((await configuration.get('global')).values.extensionConfig?.example?.count).toBe(3);
    component.handleInput!('\x7f'); component.handleInput!('4'); component.handleInput!('\r');
    await vi.waitFor(async () => expect((await configuration.get('global')).values.extensionConfig?.example?.count).toBe(4));
    expect(render()).not.toContain('never-render-this-secret');
    const response = await client.request('config.get', { scope: 'global' });
    expect(JSON.stringify(response)).not.toContain('never-render-this-secret');
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ extensionConfig: { example: { enabled: true, count: 4, token: 'never-render-this-secret' } } });
    expect(await client.request('config.set', { scope: 'global', values: { extensionConfig: { example: { token: 'forbidden' } } } })).toMatchObject({ outcome: 'rejected' });
    component.handleInput!('\x1b'); component.handleInput!('\x1b');
    expect(await opening).toBe(true);
  } finally {
    dialogs.dispose(); preferences.dispose(); await opening; client.close(); server.close(); await server.settleCommands(); await f.dispose();
  }
});
