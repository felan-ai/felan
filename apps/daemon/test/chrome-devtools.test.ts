import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectChromeRemoteDebugging, parseDevToolsActivePort } from '../src/browser/chrome-devtools.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('Chrome debugging preflight', () => {
  it.each(['/devtools/browser', '/devtools/browser/test-id'])('accepts browser path %s', (webSocketPath) => {
    expect(parseDevToolsActivePort(`9222\n${webSocketPath}\n`)).toEqual({ port: 9222, webSocketPath });
  });

  it.each(['', '0\n/devtools/browser/id', '65536\n/devtools/browser/id', '9222x\n/devtools/browser/id',
    '9222\n/devtools/page/id', '9222\n/devtools/browser/id\nextra', '9222\n/devtools/browser/id?secret=x',
    '9222\n/devtools/browser/..', '9222\n/devtools/browser/.'])('rejects unsafe metadata %j', value => {
    expect(parseDevToolsActivePort(value)).toBeUndefined();
  });

  it('uses root metadata only when its port belongs to the intended Chrome', async () => {
    const fixture = await setup();
    await writeFile(fixture.portFile, '4141\n/devtools/browser/live\n');
    await expect(fixture.inspect()).resolves.toEqual({ state: 'ready', processId: 123, connection: { port: 4141, webSocketPath: '/devtools/browser/live' } });
    expect(fixture.run).toHaveBeenCalledTimes(4);
  });

  it('uses the sole verified listener when the port file is missing, without probing it', async () => {
    const fixture = await setup();
    await expect(fixture.inspect()).resolves.toEqual({ state: 'ready', processId: 123, connection: { port: 4141, webSocketPath: '/devtools/browser' } });
    expect(fixture.run.mock.calls.every(([command]) => ['/bin/ps', '/usr/sbin/lsof', '/usr/bin/plutil'].includes(command))).toBe(true);
  });

  it('ignores stale root and profile-level port hints without deleting them', async () => {
    const fixture = await setup();
    await writeFile(fixture.portFile, '5151\n/devtools/browser/stale\n');
    await mkdir(join(fixture.root, 'Default'));
    const profileFile = join(fixture.root, 'Default', 'DevToolsActivePort');
    await writeFile(profileFile, '6161\n/devtools/browser/profile\n');
    await expect(fixture.inspect()).resolves.toMatchObject({ state: 'ready', connection: { port: 4141, webSocketPath: '/devtools/browser' } });
    expect(await readFile(fixture.portFile, 'utf8')).toContain('5151');
    expect(await readFile(profileFile, 'utf8')).toContain('6161');
  });

  it('distinguishes disabled from enabled-but-unavailable', async () => {
    const fixture = await setup();
    fixture.state.listeners = '';
    await expect(fixture.inspect()).resolves.toMatchObject({ state: 'unavailable', reason: expect.stringContaining('enabled') });
    await fixture.preferences(false);
    await expect(fixture.inspect()).resolves.toEqual({ state: 'disabled', processId: 123, applicationPath: '/Applications/Google Chrome.app' });
  });

  it('does not call a live listener disabled when persisted settings disagree', async () => {
    const fixture = await setup();
    await fixture.preferences(false);
    await expect(fixture.inspect()).resolves.toMatchObject({ state: 'unavailable', reason: expect.stringContaining('disagree') });
  });

  it('does not guess among multiple listeners or accept another process listener', async () => {
    const fixture = await setup();
    fixture.state.listeners += '\nn127.0.0.1:4242';
    await expect(fixture.inspect()).resolves.toMatchObject({ state: 'unavailable', reason: expect.stringContaining('multiple') });
    fixture.state.listeners = 'p999\nn127.0.0.1:4141\np123';
    await expect(fixture.inspect()).resolves.toMatchObject({ state: 'unavailable' });
  });

  it('does not guess a Chrome instance, user or custom data directory', async () => {
    const fixture = await setup();
    const initial = fixture.state.processes;
    fixture.state.processes = '';
    await expect(fixture.inspect()).resolves.toMatchObject({ state: 'unavailable' });
    fixture.state.processes = `${initial}\n${initial.replace('123 ', '124 ')}`;
    await expect(fixture.inspect()).resolves.toMatchObject({ state: 'unavailable' });
    fixture.state.processes = `123 ${fixture.uid + 1} ${CHROME}`;
    await expect(fixture.inspect()).resolves.toMatchObject({ state: 'unavailable' });
    fixture.state.processes = initial;
    fixture.state.command = `${CHROME} --user-data-dir=/not-the-personal-profile`;
    await expect(fixture.inspect()).resolves.toMatchObject({ state: 'unavailable', reason: expect.stringContaining('Custom') });
  });

  it('rejects older Chrome and legacy debugging mode instead of silently attaching', async () => {
    const fixture = await setup();
    fixture.state.version = '143.0.0.0';
    await expect(fixture.inspect()).resolves.toMatchObject({ state: 'unavailable', reason: expect.stringContaining('144') });
    fixture.state.version = '152.0.0.0';
    fixture.state.command = `${CHROME} --remote-debugging-port=4141`;
    await expect(fixture.inspect()).resolves.toMatchObject({ state: 'unavailable', reason: expect.stringContaining('command-line') });
  });

  it('fails closed on a symlink, oversized file or foreign ownership', async () => {
    const fixture = await setup();
    const outside = join(fixture.home, 'outside');
    await writeFile(outside, '4141\n/devtools/browser/private\n');
    await symlink(outside, fixture.portFile);
    await expect(fixture.inspect()).resolves.toMatchObject({ state: 'unavailable' });
    await rm(fixture.portFile);
    await writeFile(fixture.portFile, 'x'.repeat(4_097));
    await expect(fixture.inspect()).resolves.toMatchObject({ state: 'unavailable' });
    await rm(fixture.portFile);
    fixture.state.processes = `123 ${fixture.uid + 1} ${CHROME}`;
    await expect(inspectChromeRemoteDebugging(new AbortController().signal, { ...fixture.options, userId: fixture.uid + 1 })).resolves.toMatchObject({ state: 'unavailable' });
  });

  it('rejects a redirected default data root even when its metadata is user-owned', async () => {
    const fixture = await setup();
    const redirected = join(fixture.home, 'redirected');
    await rename(fixture.root, redirected);
    await symlink(redirected, fixture.root);
    await expect(fixture.inspect()).resolves.toMatchObject({ state: 'unavailable', reason: expect.stringContaining('ownership or location') });
  });

  it('rejects hard-linked setup metadata before reading its content', async () => {
    const fixture = await setup();
    const outside = join(fixture.home, 'outside-port');
    await writeFile(outside, '4141\n/devtools/browser/linked\n');
    await link(outside, fixture.portFile);
    await expect(fixture.inspect()).resolves.toMatchObject({ state: 'unavailable' });
  });

  it('rejects redirection through a parent of the default data root', async () => {
    const fixture = await setup();
    const google = join(fixture.root, '..');
    const redirected = join(fixture.home, 'redirected-google');
    await rename(google, redirected);
    await symlink(redirected, google);
    await expect(fixture.inspect()).resolves.toMatchObject({ state: 'unavailable', reason: expect.stringContaining('ownership or location') });
  });

  it.each(['null', '[]', '{"devtools":"invalid"}', '{"devtools":{"remote_debugging":{"user-enabled":"yes"}}}', 'not json'])('rejects malformed setup state without exposing it', async content => {
    const fixture = await setup();
    await writeFile(join(fixture.root, 'Local State'), content);
    const outcome = await fixture.inspect();
    expect(outcome.state).toBe('unavailable');
    expect(JSON.stringify(outcome)).not.toContain(fixture.home);
  });

  it('respects policy and rejects ambient agent-browser configuration before inspection', async () => {
    const fixture = await setup();
    await writeFile(join(fixture.root, 'Local State'), '{"devtools":{"remote_debugging":{"allowed":false,"user-enabled":true}}}');
    await expect(fixture.inspect()).resolves.toMatchObject({ state: 'unavailable', reason: expect.stringContaining('policy') });
    fixture.run.mockClear();
    await expect(inspectChromeRemoteDebugging(new AbortController().signal, { ...fixture.options, environment: { AGENT_BROWSER_AUTO_CONNECT: '' } })).resolves.toMatchObject({ state: 'unavailable' });
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it.each(['linux', 'win32'] as const)('fails closed where ownership cannot be verified on %s', async operatingSystem => {
    const run = vi.fn();
    await expect(inspectChromeRemoteDebugging(new AbortController().signal, { operatingSystem, environment: {}, run })).resolves.toMatchObject({ state: 'unavailable' });
    expect(run).not.toHaveBeenCalled();
  });

  it('propagates cancellation without inspecting Chrome', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn();
    await expect(inspectChromeRemoteDebugging(controller.signal, { run })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'felan-chrome-test-'));
  directories.push(home);
  const root = join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  await mkdir(root, { recursive: true });
  const uid = process.getuid?.() ?? 0;
  const state = { processes: `123 ${uid} ${CHROME}`, command: CHROME, version: '152.0.0.0', listeners: 'p123\nn127.0.0.1:4141' };
  const run = vi.fn(async (command: string, args: readonly string[], _signal: AbortSignal) => {
    if (command === '/usr/sbin/lsof') return state.listeners;
    if (command === '/usr/bin/plutil') return state.version;
    return args.includes('command=') ? state.command : state.processes;
  });
  const preferences = (enabled: boolean) => writeFile(join(root, 'Local State'), JSON.stringify({ devtools: { remote_debugging: { 'user-enabled': enabled } } }));
  await preferences(true);
  const options = { homeDirectory: home, environment: {}, operatingSystem: 'darwin' as const, userId: uid, run };
  return { home, root, uid, run, state, options, preferences, portFile: join(root, 'DevToolsActivePort'), inspect: () => inspectChromeRemoteDebugging(new AbortController().signal, options) };
}
