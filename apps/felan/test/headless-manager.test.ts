import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { acquireDaemonOwnership } from '../../daemon/src/daemon/ownership.js';
import { clientDaemonTarget } from '../src/client-application.js';
import { SessionClient } from '../src/client/client.js';
import { runCli } from '../src/cli-main.js';
import { runDaemonCommand } from '../src/daemon-command.js';

const imports = Object.fromEntries([
  '@felan-ai/agent-core', '@felan-ai/daemon/daemon-bootstrap', '@felan-ai/daemon/provider',
  '@felan-ai/felan/providers/session-runtime', '@felan-ai/felan/providers/models', '@felan-ai/felan/providers/secrets',
].map(specifier => [specifier, JSON.stringify(import.meta.resolve(specifier))]));

const providerSource = `
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HOST_RUNTIME_SERVICE, HostAgentRuntime, MODELS_SERVICE, SECRETS_SERVICE } from ${imports['@felan-ai/agent-core']};
import { defineServiceProvider, SESSION_RUNTIME_SERVICE } from ${imports['@felan-ai/daemon/provider']};
import { createLocalSessionRuntime } from ${imports['@felan-ai/felan/providers/session-runtime']};
import { createLocalModelsService } from ${imports['@felan-ai/felan/providers/models']};
import { createLocalSecretsService } from ${imports['@felan-ai/felan/providers/secrets']};

const root = process.env.HEADLESS_MANAGER_ROOT;
function record(event, detail = {}) {
  appendFileSync(join(root, 'events.jsonl'), JSON.stringify({ event, ...detail }) + '\\n', { mode: 0o600 });
}
record('exports', { names: [createLocalSessionRuntime, createLocalModelsService, createLocalSecretsService].map(fn => fn.name) });

const secretDirectory = join(root, 'file-secrets');
function secretPath(namespace, key) {
  assert.match(namespace, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
  assert.match(key, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
  return join(secretDirectory, Buffer.from(JSON.stringify([namespace, key])).toString('hex'));
}
const storage = {
  async read(namespace, key, signal) {
    signal?.throwIfAborted();
    record('secret-read', { namespace });
    try { return await readFile(secretPath(namespace, key), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  },
  async write(namespace, key, value, signal) {
    signal?.throwIfAborted();
    await mkdir(secretDirectory, { recursive: true, mode: 0o700 });
    await writeFile(secretPath(namespace, key), value, { mode: 0o600 });
    record('secret-write', { namespace });
  },
  async remove(namespace, key, signal) {
    signal?.throwIfAborted();
    await rm(secretPath(namespace, key), { force: true });
    record('secret-remove', { namespace });
  },
};

export const runtimeProvider = defineServiceProvider({
  provides: [HOST_RUNTIME_SERVICE, SESSION_RUNTIME_SERVICE],
  async create() {
    const runtimeService = { create: (cwd, options) => new HostAgentRuntime(cwd, options) };
    const local = createLocalSessionRuntime({ runtimeService });
    return {
      implementations: [
        { contract: HOST_RUNTIME_SERVICE, value: runtimeService },
        { contract: SESSION_RUNTIME_SERVICE, value: { ...local, secretStorage: storage } },
      ],
      async activate() { record('runtime-activate'); },
      async settle(mode) { record('runtime-settle', { mode }); },
      async dispose() { record('runtime-dispose'); },
    };
  },
});

export const sessionProvider = defineServiceProvider({
  scope: 'session', provides: [MODELS_SERVICE, SECRETS_SERVICE],
  async create(context) {
    assert.equal(context.secretStorage, storage);
    const models = createLocalModelsService({ modelRuntime: context.modelRuntime, sessionId: context.sessionId });
    const secrets = createLocalSecretsService({ storage: context.secretStorage, namespaces: ['headless-manager'] });
    return {
      implementations: [{ contract: MODELS_SERVICE, value: models }, { contract: SECRETS_SERVICE, value: secrets }],
      async activate() {
        const available = await models.getAvailable('offline');
        assert.ok(available.some(model => model.id === 'fixture'));
        const address = { namespace: 'headless-manager', key: context.sessionId };
        const saved = await secrets.write(address, { value: 'synthetic-headless-secret', expectedVersion: null });
        assert.deepEqual(await secrets.read(address), saved);
        await secrets.remove(address, saved.version);
        assert.equal(await secrets.read(address), undefined);
        await secrets.write(address, { value: 'synthetic-headless-secret', expectedVersion: null });
        record('session-activate', { sessionId: context.sessionId, models: available.map(model => model.id) });
      },
      async settle(mode) { record('session-settle', { mode }); },
      async dispose() { record('session-dispose'); },
    };
  },
});
`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Headless manager cleanup failed');
});

function deadline<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 10_000);
  })]).finally(() => clearTimeout(timer));
}

function launch(script: string, root: string) {
  const child: ChildProcess = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HEADLESS_MANAGER_ROOT: root, HOME: root, FELAN_AGENT_DIR: join(root, 'agent'),
      PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' },
  });
  let output = ''; let finished = false;
  const append = (bytes: Buffer) => { output = (output + bytes.toString()).slice(-32 * 1024); };
  child.stdout!.on('data', append); child.stderr!.on('data', append);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', error => { finished = true; reject(error); });
    child.once('close', (code, signal) => { finished = true; resolve({ code, signal }); });
  });
  cleanups.push(async () => {
    if (finished) return;
    child.kill('SIGTERM');
    try { await deadline(exited, 'cleanup SIGTERM'); }
    catch (error) { child.kill('SIGKILL'); await deadline(exited, 'cleanup SIGKILL'); throw error; }
  });
  return { child, exited, output: () => output, finished: () => finished };
}

it('runs the public custom-manager bootstrap without a TTY or keyring, then drains and releases ownership', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hm-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const target = clientDaemonTarget({ daemonRuntime: root });
  const packagedDefaultPath = join(root, 'packaged-host.json');
  const providerPaths = {
    '@felan-cloud/agent/providers/runtime': pathToFileURL(join(root, 'runtime.mjs')).href,
    '@felan-cloud/agent/providers/session': pathToFileURL(join(root, 'session.mjs')).href,
  };
  await mkdir(join(root, 'agent'), { mode: 0o700 });
  await writeFile(packagedDefaultPath, JSON.stringify({ version: 1, extensions: [],
    services: [
      ...['felan.runtime', 'felan.session-runtime'].map(id => ({ id, major: 1, use: '@felan-cloud/agent/providers/runtime' })),
      ...['felan.models', 'felan.secrets'].map(id => ({ id, major: 1, use: '@felan-cloud/agent/providers/session' })),
    ], policy: { projectTrust: 'deny', dependencyInstalls: 'deny' },
  }), { mode: 0o600 });
  await writeFile(join(root, 'providers.mjs'), providerSource, { mode: 0o600 });
  await writeFile(join(root, 'runtime.mjs'), "export { runtimeProvider as default } from './providers.mjs';\n", { mode: 0o600 });
  await writeFile(join(root, 'session.mjs'), "export { sessionProvider as default } from './providers.mjs';\n", { mode: 0o600 });
  await writeFile(join(root, 'agent', 'settings.json'), JSON.stringify({ defaultProvider: 'offline', defaultModel: 'fixture' }), { mode: 0o600 });
  await writeFile(join(root, 'agent', 'models.json'), JSON.stringify({ providers: { offline: {
    baseUrl: 'http://127.0.0.1:1', apiKey: 'synthetic-headless-model', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Offline fixture', reasoning: false, input: ['text'], contextWindow: 8192,
      maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }), { mode: 0o600 });

  const worker = launch(`
    import assert from 'node:assert/strict';
    import { appendFileSync } from 'node:fs';
    import { registerHooks } from 'node:module';
    const events = ${JSON.stringify(join(root, 'events.jsonl'))};
    const record = (event, detail = {}) => appendFileSync(events, JSON.stringify({ event, ...detail }) + '\\n', { mode: 0o600 });
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === '@napi-rs/keyring' || specifier.includes('/@napi-rs/keyring/')) {
        record('keyring-attempt'); throw new Error('Headless managers must not use the system keyring');
      }
      return nextResolve(specifier, context);
    } });
    const { runDaemonProcess } = await import(${imports['@felan-ai/daemon/daemon-bootstrap']});
    const providers = ${JSON.stringify(providerPaths)};
    const manager = {
      packageName: '@felan-cloud/agent', version: '0.1.0',
      resolveFrom: ${JSON.stringify(pathToFileURL(join(root, 'cloud-manager.mjs')).href)},
      packagedDefaultPath: ${JSON.stringify(packagedDefaultPath)},
      resolveProvider(specifier) {
        assert.ok(Object.hasOwn(providers, specifier));
        record('resolve-provider', { specifier }); return providers[specifier];
      },
    };
    record('process', { pid: process.pid, uid: process.getuid?.(), platform: process.platform,
      tty: [process.stdin, process.stdout, process.stderr].map(stream => stream.isTTY === true) });
    const signals = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'];
    const before = signals.map(signal => process.listenerCount(signal));
    await runDaemonProcess([${JSON.stringify(JSON.stringify(target))}, '--foreground'], manager);
    assert.deepEqual(signals.map(signal => process.listenerCount(signal)), before);
    record('process-stopped');
  `, root);
  await vi.waitFor(() => {
    expect(worker.finished(), worker.output()).toBe(false);
    expect(worker.output()).toContain('Felan daemon');
    expect(worker.output()).toContain(': ready');
  }, { timeout: 10_000 });
  const client = new SessionClient({ target, clientVersion: 'headless-manager-fixture', kind: 'headless', reconnectAttempts: 0 });
  cleanups.push(async () => { client.close(); });
  await client.connect();
  const status = await client.request('host.status', {});
  expect(status.outcome, JSON.stringify(status)).toBe('accepted');
  if (status.outcome !== 'accepted') throw new Error('Host status unavailable');
  expect(status.result).toMatchObject({ state: 'ready', composition: {
    managerPackage: '@felan-cloud/agent', managerVersion: '0.1.0',
  } });
  expect(status.result.composition?.restartRequired).not.toBe(true);
  const created = await client.request('sessions.create', { cwd: root, model: { provider: 'offline', id: 'fixture' } });
  expect(created.outcome, JSON.stringify(created)).toBe('accepted');
  if (created.outcome !== 'accepted') throw new Error('Headless session unavailable');
  client.close();
  expect(worker.child.kill('SIGTERM')).toBe(true);
  expect(await deadline(worker.exited, 'foreground shutdown'), worker.output()).toEqual({ code: 0, signal: null });

  const events = (await readFile(join(root, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(events).toContainEqual({ event: 'process', pid: worker.child.pid, uid: process.getuid?.(), platform: process.platform, tty: [false, false, false] });
  if (process.getuid && process.getuid() !== 0) expect(events.find(event => event.event === 'process').uid).toBeGreaterThan(0);
  expect(events).toContainEqual({ event: 'exports', names: ['createLocalSessionRuntime', 'createLocalModelsService', 'createLocalSecretsService'] });
  expect(events.filter(event => event.event === 'resolve-provider').map(event => event.specifier)).toEqual(expect.arrayContaining(Object.keys(providerPaths)));
  expect(events).toContainEqual({ event: 'secret-read', namespace: 'remote' });
  expect(events).toContainEqual({ event: 'secret-remove', namespace: 'headless-manager' });
  expect(events).toContainEqual({ event: 'session-activate', sessionId: created.result.sessionId, models: ['fixture'] });
  expect(events).toContainEqual({ event: 'session-settle', mode: 'drain' });
  expect(events).toContainEqual({ event: 'runtime-settle', mode: 'drain' });
  expect(events.filter(event => event.event.endsWith('-dispose')).map(event => event.event)).toEqual(['session-dispose', 'runtime-dispose']);
  expect(events.at(-1)).toEqual({ event: 'process-stopped' });
  expect(events.some(event => event.event === 'keyring-attempt')).toBe(false);
  const secretFile = join(root, 'file-secrets', Buffer.from(JSON.stringify(['headless-manager', created.result.sessionId])).toString('hex'));
  expect(await readFile(secretFile, 'utf8')).toBe('synthetic-headless-secret');
  expect((await stat(secretFile)).mode & 0o777).toBe(0o600);
  await expect(stat(join(root, 'agent', 'host.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(join(root, 'runtime', 'ipc.sock'))).rejects.toMatchObject({ code: 'ENOENT' });
  const owner = await acquireDaemonOwnership(target);
  await owner.release();
}, 30_000);

it('routes the CLI foreground entry with its explicit runtime and host configuration', async () => {
  const args = ['foreground', '--daemon-runtime', '/tmp/headless-manager-cli', '--host-config', '/tmp/headless-manager-host.json'];
  const launchDaemon = vi.fn(async () => 0);
  expect(await runCli(['daemon', ...args], { launchDaemon })).toBe(0);
  expect(launchDaemon).toHaveBeenCalledExactlyOnceWith(args);
  const foreground = vi.fn(async () => 0);
  const io = { writeOutput: vi.fn(), writeError: vi.fn() };
  expect(await runDaemonCommand(args, io, { foreground })).toBe(0);
  expect(foreground).toHaveBeenCalledExactlyOnceWith(clientDaemonTarget({ daemonRuntime: '/tmp/headless-manager-cli' }), '/tmp/headless-manager-host.json');
  expect(io.writeError).not.toHaveBeenCalled();
});
