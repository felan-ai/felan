import { afterEach, expect, it, vi } from 'vitest';
import { SessionClient } from '../src/client/client.js';
import { HostSetupManager } from '../src/providers/setup/manager.js';
import { AuthCleanupError, type startAuthWorker } from '../src/providers/setup/auth-driver.js';
import { DaemonConfiguration } from '../src/providers/configuration.js';
import { isDependencyOnboardingComplete, mergeDaemonGlobalSettings, readDaemonGlobalSettings } from '../src/providers/global-settings.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { serverFixture, gate } from '../../daemon/test/fixtures/server.js';
import type { SetupDependency } from '../../daemon/src/setup/dependencies.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

async function fixture(login?: typeof startAuthWorker, dependencies: readonly SetupDependency[] = []) {
  const f = await serverFixture({ now: Date.now });
  const models = f.root.runtime.session.modelRuntime;
  const provider = models.getProviders().find(provider => provider.auth.apiKey?.login);
  if (!provider) throw new Error('Missing deterministic provider metadata.');
  const refreshModels = vi.fn(async (_provider: string, signal: AbortSignal) => f.registry.refreshModelAvailability(signal));
  const manager = new HostSetupManager({ agentDir: f.owner.target.agentDir, runtime: f.root.agentRuntime, models,
    dependencies, refreshModels, ...(login ? { login } : {}), assertCurrent: () => f.owner.assertCurrent(), open: vi.fn(async () => {}) });
  const server = new SessionServer({ registry: f.registry, models, setup: manager, version: 'fixture',
    configuration: new DaemonConfiguration({ agentDir: f.owner.target.agentDir, definitions: [], assertCurrent: () => f.owner.assertCurrent() }) });
  const clients: SessionClient[] = [];
  cleanup.push(async () => { clients.forEach(client => client.close()); server.close(); await manager.drain(); await server.settleCommands(); await f.dispose(); });
  await server.start();
  async function client() {
    const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
      kind: 'tui', clientVersion: 'fixture', retries: 0 }); clients.push(client); await client.connect(); return client;
  }
  return { ...f, manager, client, refreshModels, start: { kind: 'login' as const, provider: provider.id, method: 'api_key' as const } };
}

it('refreshes the attached session model catalog after authentication and before reporting success', async () => {
  const complete = gate();
  const f = await fixture(async () => ({ done: complete.promise, answer: async () => {} }));
  const client = await f.client();
  const models = f.root.runtime.session.modelRuntime; const model = models.getModels()[0]!;
  let available = false;
  vi.spyOn(models, 'getAvailableSnapshot').mockImplementation(() => available ? [model] : []);
  vi.spyOn(models, 'getAvailable').mockImplementation(async () => { available = true; return [model]; });
  f.registry.projection(f.root.sessionId).refresh();
  expect(f.registry.projection(f.root.sessionId).snapshot().catalog.models).toEqual([]);
  await client.attach(f.root.sessionId);
  const start = await client.request('host.setup.start', f.start);
  if (start.outcome !== 'accepted') throw new Error('Setup did not start.');
  expect(f.refreshModels).not.toHaveBeenCalled(); complete.resolve();
  await vi.waitFor(() => expect(f.manager.read(start.result.id, client.capabilities!.attachmentId).state).toBe('completed'));
  expect(f.refreshModels).toHaveBeenCalledExactlyOnceWith(f.start.provider, expect.any(AbortSignal));
  await vi.waitFor(() => expect(client.getAttachment(f.root.sessionId)?.state.snapshot?.catalog.models)
    .toContainEqual(expect.objectContaining({ provider: model.provider, id: model.id })));
});

it('reports saved credentials and a refresh warning without exposing internal errors', async () => {
  const f = await fixture(async () => ({ done: Promise.resolve(), answer: async () => {} }));
  f.refreshModels.mockRejectedValueOnce(new Error('private-refresh-error'));
  const job = f.manager.start(f.start, 'owner');
  await vi.waitFor(() => expect(f.manager.read(job.id, 'owner').state).toBe('completed'));
  expect(f.manager.read(job.id, 'owner').message).toContain('Model availability could not be refreshed');
  expect(JSON.stringify(f.manager.read(job.id, 'owner'))).not.toContain('private-refresh-error');
});

it('carries secret answers only in ephemeral setup requests and scrubs completed client records', async () => {
  const received: string[] = [];
  const login: typeof startAuthWorker = async (_runtime, _start, options) => {
    const complete = gate();
    options.event({ kind: 'prompt', prompt: { id: 'secret', kind: 'input', message: 'API key', secret: true } });
    const abort = () => complete.resolve(); options.signal.addEventListener('abort', abort, { once: true });
    return { done: complete.promise.finally(() => options.signal.removeEventListener('abort', abort)),
      async answer(_id, text) { received.push(text); complete.resolve(); } };
  };
  const f = await fixture(login); const client = await f.client(); const other = await f.client();
  const start = await client.request('host.setup.start', f.start);
  if (start.outcome !== 'accepted') throw new Error('Setup did not start.');
  const jobId = start.result.id;
  await vi.waitFor(async () => expect(await client.request('host.setup.read', { jobId })).toMatchObject({ result: { state: 'waiting' } }));
  expect(await other.request('host.setup.read', { jobId })).toMatchObject({ outcome: 'rejected', error: { code: 'forbidden' } });
  const secret = 'synthetic-key-must-not-be-retained';
  expect(await client.request('host.setup.answer', { jobId, promptId: 'secret', text: secret })).toMatchObject({ outcome: 'accepted' });
  expect(received).toEqual([secret]);
  await vi.waitFor(async () => expect(await client.request('host.setup.read', { jobId })).toMatchObject({ result: { state: 'completed' } }));
  expect(JSON.stringify(f.store.snapshot())).not.toContain(secret);
  expect(f.store.snapshot().requests.some(request => request.op === 'host.setup.answer')).toBe(false);
  const retained = Reflect.get(client, 'records') as Map<string, unknown>;
  expect(JSON.stringify([...retained.values()])).not.toContain(secret);
});

it('cancels active setup on owner disconnect and does not transfer it to another client', async () => {
  const cancelled = gate();
  const login: typeof startAuthWorker = async (_runtime, _start, options) => {
    options.event({ kind: 'prompt', prompt: { id: 'code', kind: 'input', message: 'Code', secret: true } });
    options.signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
    return { done: cancelled.promise, answer: async () => {} };
  };
  const f = await fixture(login); const client = await f.client();
  const start = await client.request('host.setup.start', f.start);
  if (start.outcome !== 'accepted') throw new Error('Setup did not start.');
  await vi.waitFor(() => expect(f.manager.read(start.result.id, client.capabilities!.attachmentId).state).toBe('waiting'));
  client.close(); await cancelled.promise; await f.manager.drain();
  const other = await f.client();
  expect(await other.request('host.setup.read', { jobId: start.result.id })).toMatchObject({ outcome: 'rejected' });
});

it('never installs on catalog reads or without an explicit selected action', async () => {
  let installed = false; const install = vi.fn(async () => { installed = true; });
  const dependency: SetupDependency = { id: 'fixture', extension: 'browser', revision: 2, label: 'Fixture', description: 'Fixture dependency',
    check: async () => ({ available: installed }), install };
  const f = await fixture(undefined, [dependency]);
  expect((await f.manager.catalog()).dependencies).toMatchObject([{ available: false, needsSetup: true }]); expect(install).not.toHaveBeenCalled();
  expect(() => f.manager.start({ kind: 'dependencies', choices: [{ id: 'fixture', action: 'install' }], confirmed: false } as never, 'owner')).toThrow();
  const skipped = f.manager.start({ kind: 'dependencies', choices: [{ id: 'fixture', action: 'skip' }] }, 'owner');
  await vi.waitFor(() => expect(f.manager.read(skipped.id, 'owner').state).toBe('completed'));
  expect(install).not.toHaveBeenCalled();
  expect((await f.manager.catalog()).dependencies).toMatchObject([{ available: false, enabled: true }]);
  const selected = f.manager.start({ kind: 'dependencies', choices: [{ id: 'fixture', action: 'install' }] }, 'owner');
  await vi.waitFor(() => expect(f.manager.read(selected.id, 'owner').state).toBe('completed'));
  expect(install).toHaveBeenCalledOnce();
  expect((await f.manager.catalog()).dependencies).toMatchObject([{ available: true, enabled: true, needsSetup: false }]);
  const unchanged = f.manager.start({ kind: 'dependencies', choices: [{ id: 'fixture', action: 'skip' }] }, 'owner');
  await vi.waitFor(() => expect(f.manager.read(unchanged.id, 'owner').state).toBe('completed'));
  expect((await f.manager.catalog()).dependencies).toMatchObject([{ available: true, enabled: true }]);
  expect(install).toHaveBeenCalledOnce();
});

it('installs selected dependencies concurrently with a status line each and keeps failures pending', async () => {
  const release = gate(); const started: string[] = []; let installed = false;
  const good: SetupDependency = { id: 'good', extension: 'browser', revision: 2, label: 'Good', description: 'Good dependency',
    check: async () => ({ available: installed }),
    install: async (_runtime, progress) => { started.push('good'); progress('Downloading…'); await release.promise; installed = true; } };
  const bad: SetupDependency = { id: 'bad', extension: 'markitdown', revision: 1, label: 'Bad', description: 'Bad dependency',
    check: async () => ({ available: false }),
    install: async () => { started.push('bad'); await release.promise; return { available: false, reason: 'Download refused.' }; } };
  const f = await fixture(undefined, [good, bad]);
  const job = f.manager.start({ kind: 'dependencies', choices: [{ id: 'good', action: 'install' }, { id: 'bad', action: 'install' }] }, 'owner');
  await vi.waitFor(() => expect(started).toEqual(['good', 'bad']));
  expect(f.manager.read(job.id, 'owner').message).toBe('Good: Downloading…\nBad: Installing…');
  release.resolve();
  await vi.waitFor(() => expect(f.manager.read(job.id, 'owner').state).toBe('failed'));
  expect(f.manager.read(job.id, 'owner').message).toBe('Good: installed\nBad: failed: Download refused.\nFailed items remain pending. Retry them with /dependencies.');
  expect((await f.manager.catalog()).dependencies).toMatchObject([{ id: 'good', available: true, needsSetup: false }, { id: 'bad', needsSetup: true }]);
});

it.each([
  { name: 'an enabled old runtime', available: false, enabled: true, revision: 1, needsSetup: true },
  { name: 'an approved old runtime', available: false, enabled: true, revision: 1, version: '0.3.322', needsSetup: false },
  { name: 'a disabled old runtime', available: false, enabled: false, revision: 1, needsSetup: false },
  { name: 'the current installed runtime', available: true, enabled: true, revision: 1, needsSetup: false },
  { name: 'a first-time missing runtime', available: false, enabled: true, revision: 0, needsSetup: true },
  { name: 'a first-time installed runtime', available: true, enabled: true, revision: 0, needsSetup: true },
  { name: 'a stale numeric revision', available: true, enabled: true, revision: 2, needsSetup: true },
])('applies runtime-specific startup approval for $name', async ({ available, enabled, revision, version, needsSetup }) => {
  const install = vi.fn();
  const dependency: SetupDependency = { id: 'claude-code', extension: 'claudeCode', revision: 1, requiredVersion: '0.3.322', label: 'Claude Code',
    description: 'Reviewed Claude Agent SDK 0.3.322 installer.', install,
    check: async () => available ? { available: true, version: '0.3.322' }
      : { available: false, version: '0.3.293', reason: 'Claude Agent SDK 0.3.293 is installed; 0.3.322 is required.' } };
  const f = await fixture(undefined, [dependency]);
  if (revision) await mergeDaemonGlobalSettings(f.owner.target.agentDir, { extensions: [], dependencyDecisions: [
    { extension: 'claudeCode', enabled, revision, ...(version ? { version } : {}) },
  ] }, () => f.owner.assertCurrent());
  const client = await f.client();
  expect(await client.request('host.setup.catalog', {})).toMatchObject({ outcome: 'accepted', result: { dependencies: [{
    id: 'claude-code', available, enabled, needsSetup, version: available ? '0.3.322' : '0.3.293',
    ...(!available ? { reason: 'Claude Agent SDK 0.3.293 is installed; 0.3.322 is required.' } : {}),
  }] } });
  expect(install).not.toHaveBeenCalled();
});

it('remembers a confirmed skip only for its required runtime version and saves a later successful install', async () => {
  let available = false;
  const install = vi.fn(async () => { available = true; });
  const dependency: SetupDependency = { id: 'claude-code', extension: 'claudeCode', revision: 1, requiredVersion: '0.3.322',
    label: 'Claude Code', description: 'Reviewed installer.', check: async () => ({ available }), install };
  const f = await fixture(undefined, [dependency]);
  await mergeDaemonGlobalSettings(f.owner.target.agentDir, { extensions: [], dependencyDecisions: [{ extension: 'claudeCode', revision: 1, enabled: true }] }, () => f.owner.assertCurrent());
  expect((await f.manager.catalog()).dependencies[0]?.needsSetup).toBe(true);
  const skipped = f.manager.start({ kind: 'dependencies', choices: [{ id: 'claude-code', action: 'skip' }] }, 'owner');
  await vi.waitFor(() => expect(f.manager.read(skipped.id, 'owner').state).toBe('completed'));
  expect((await f.manager.catalog()).dependencies[0]).toMatchObject({ needsSetup: false, enabled: true, available: false });
  expect(install).not.toHaveBeenCalled();
  let settings = await readDaemonGlobalSettings(f.owner.target.agentDir, () => f.owner.assertCurrent());
  expect(isDependencyOnboardingComplete(settings, 'claudeCode', 1, '0.3.322')).toBe(true);
  dependency.requiredVersion = '0.3.323';
  expect((await f.manager.catalog()).dependencies[0]?.needsSetup).toBe(true);
  const installed = f.manager.start({ kind: 'dependencies', choices: [{ id: 'claude-code', action: 'install' }] }, 'owner');
  await vi.waitFor(() => expect(f.manager.read(installed.id, 'owner').state).toBe('completed'));
  expect(install).toHaveBeenCalledOnce();
  settings = await readDaemonGlobalSettings(f.owner.target.agentDir, () => f.owner.assertCurrent());
  expect(isDependencyOnboardingComplete(settings, 'claudeCode', 1, '0.3.323')).toBe(true);
  expect((await f.manager.catalog()).dependencies[0]).toMatchObject({ needsSetup: false, available: true, enabled: true });
});

it.each(['enable', 'disable'] as const)('saves the required runtime version for an explicit %s choice', async action => {
  const dependency: SetupDependency = { id: 'claude-code', extension: 'claudeCode', revision: 1, requiredVersion: '0.3.322',
    label: 'Claude Code', description: 'Reviewed installer.', check: async () => ({ available: true }) };
  const f = await fixture(undefined, [dependency]);
  const job = f.manager.start({ kind: 'dependencies', choices: [{ id: 'claude-code', action }] }, 'owner');
  await vi.waitFor(() => expect(f.manager.read(job.id, 'owner').state).toBe('completed'));
  const settings = await readDaemonGlobalSettings(f.owner.target.agentDir, () => f.owner.assertCurrent());
  expect(isDependencyOnboardingComplete(settings, 'claudeCode', 1, '0.3.322')).toBe(true);
  expect((await f.manager.catalog()).dependencies[0]?.enabled).toBe(action === 'enable');
});

it.each(['failed', 'cancelled'] as const)('does not save runtime approval after a %s install', async state => {
  const release = gate();
  const install = vi.fn(async () => { await release.promise; return { reason: 'Download refused.' }; });
  const dependency: SetupDependency = { id: 'claude-code', extension: 'claudeCode', revision: 1, requiredVersion: '0.3.322',
    label: 'Claude Code', description: 'Reviewed installer.', check: async () => ({ available: false, version: '0.3.293' }), install };
  const f = await fixture(undefined, [dependency]);
  await mergeDaemonGlobalSettings(f.owner.target.agentDir, { extensions: [], dependencyDecisions: [{ extension: 'claudeCode', revision: 1, enabled: true }] }, () => f.owner.assertCurrent());
  const before = await readDaemonGlobalSettings(f.owner.target.agentDir, () => f.owner.assertCurrent());
  const job = f.manager.start({ kind: 'dependencies', choices: [{ id: 'claude-code', action: 'install' }] }, 'owner');
  await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
  if (state === 'cancelled') f.manager.cancel(job.id, 'owner');
  release.resolve();
  await vi.waitFor(() => expect(f.manager.read(job.id, 'owner').state).toBe(state));
  expect(await readDaemonGlobalSettings(f.owner.target.agentDir, () => f.owner.assertCurrent())).toEqual(before);
  expect((await f.manager.catalog()).dependencies[0]?.needsSetup).toBe(true);
});

it('reports a model provider only for an enabled, available model dependency', async () => {
  let available = true; let failing = false;
  const check = vi.fn(async () => { if (failing) throw new Error('private-detection-error'); return { available }; });
  const models: SetupDependency = { id: 'models', extension: 'claudeCode', revision: 1, label: 'Models', description: 'Model dependency', providesModels: true, check };
  const tool: SetupDependency = { id: 'tool', extension: 'browser', revision: 2, label: 'Tool', description: 'Tool dependency', check: async () => ({ available: true }) };
  const toolsOnly = await fixture(undefined, [tool]);
  expect(await toolsOnly.manager.modelProviderReady()).toBe(false);
  const f = await fixture(undefined, [tool, models]);
  expect(await f.manager.modelProviderReady()).toBe(true);
  available = false; expect(await f.manager.modelProviderReady()).toBe(false);
  available = true; failing = true; expect(await f.manager.modelProviderReady()).toBe(false);
  failing = false;
  const disabled = f.manager.start({ kind: 'dependencies', choices: [{ id: 'models', action: 'disable' }] }, 'owner');
  await vi.waitFor(() => expect(f.manager.read(disabled.id, 'owner').state).toBe('completed'));
  check.mockClear();
  expect(await f.manager.modelProviderReady()).toBe(false); expect(check).not.toHaveBeenCalled();
});

it('blocks further work and shutdown completion when an auth child cannot be cleaned up', async () => {
  const f = await serverFixture({ now: Date.now }); cleanup.push(() => f.dispose());
  const models = f.root.runtime.session.modelRuntime;
  const provider = models.getProviders().find(provider => provider.auth.apiKey?.login)!;
  const manager = new HostSetupManager({ agentDir: f.owner.target.agentDir, runtime: f.root.agentRuntime, models,
    assertCurrent: () => f.owner.assertCurrent(), dependencies: [], open: async () => {},
    login: async () => ({ done: Promise.reject(new AuthCleanupError('Failed to stop owned test process')), answer: async () => {} }) });
  const request = { kind: 'login' as const, provider: provider.id, method: 'api_key' as const };
  const job = manager.start(request, 'owner');
  await vi.waitFor(() => expect(manager.read(job.id, 'owner').state).toBe('failed'));
  await expect(manager.drain()).rejects.toBeInstanceOf(AuthCleanupError);
  expect(() => manager.start(request, 'owner')).toThrow();
});

it('reports authentication requirements before creating a session or starting a run', async () => {
  const f = await fixture(); const client = await f.client();
  vi.spyOn(f.root.runtime.session.modelRuntime, 'getAvailable').mockResolvedValue([]);
  const before = f.registry.list().length;
  expect(await client.request('sessions.create', { cwd: f.cwd })).toMatchObject({ outcome: 'rejected', error: { code: 'authentication_required' } });
  expect(f.registry.list()).toHaveLength(before);
  await client.attach(f.root.sessionId);
  expect(await client.request('prompt', { text: 'do not dispatch' }, { session: f.root.sessionId }))
    .toMatchObject({ outcome: 'rejected', error: { code: 'authentication_required' } });
  expect(f.store.session(f.root.sessionId).run.state).toBe('idle');
});


it('catalogs ambient methods, OAuth labels, subscriptions and safe configured sources', async () => {
  const f = await fixture(); const models = f.root.runtime.session.modelRuntime;
  const base = models.getProviders().find(provider => provider.auth.apiKey?.login)!;
  const oauth = models.getProviders().find(provider => provider.auth.oauth)!.auth.oauth!;
  const { login: _login, ...ambient } = base.auth.apiKey!;
  vi.spyOn(models, 'getProviders').mockReturnValue([
    { ...base, id: 'ambient', name: 'Zulu Ambient', auth: { apiKey: { ...ambient, name: 'Cloud credentials' } } },
    { ...base, id: 'dual', name: 'Alpha Dual', auth: { apiKey: base.auth.apiKey!, oauth: { ...oauth, isSubscription: true, loginLabel: 'Use subscription' } } },
  ]);
  vi.spyOn(models, 'getProviderAuthStatus').mockReturnValue({ configured: true, source: 'env', label: 'FIXTURE_API_KEY' });
  vi.spyOn(models, 'isUsingOAuth').mockImplementation(id => id === 'dual');
  vi.spyOn(models, 'listCredentials').mockResolvedValue([{ providerId: 'dual', type: 'oauth' }]);
  const catalog = await f.manager.catalog();
  expect(catalog.providers).toEqual([
    expect.objectContaining({ id: 'dual', methods: ['oauth', 'api_key'], apiKeyLogin: true, subscription: true, oauthLabel: 'Use subscription',
      status: { type: 'oauth', source: 'FIXTURE_API_KEY' } }),
    expect.objectContaining({ id: 'ambient', methods: ['api_key'], apiKeyLogin: false, apiKeyName: 'Cloud credentials',
      status: { type: 'api_key', source: 'FIXTURE_API_KEY' } }),
  ]);
  expect(catalog.credentials).toEqual([{ id: 'dual', label: 'Alpha Dual', type: 'oauth', subscription: true }]);
  expect(() => f.manager.start({ kind: 'login', provider: 'ambient', method: 'api_key' }, 'owner')).toThrow();
});

it('removes only stored credentials through the daemon and refreshes model availability', async () => {
  const f = await fixture(); const models = f.root.runtime.session.modelRuntime;
  vi.spyOn(models, 'listCredentials').mockResolvedValue([{ providerId: f.start.provider, type: 'api_key' }]);
  const logout = vi.spyOn(models, 'logout').mockResolvedValue(undefined);
  const client = await f.client();
  const response = await client.request('host.setup.start', { kind: 'logout', provider: f.start.provider });
  if (response.outcome !== 'accepted') throw new Error('Logout did not start.');
  await vi.waitFor(async () => expect(await client.request('host.setup.read', { jobId: response.result.id })).toMatchObject({ result: {
    kind: 'logout', state: 'completed', message: expect.stringContaining('Environment variables and models.json config are unchanged.'),
  } }));
  expect(logout).toHaveBeenCalledExactlyOnceWith(f.start.provider, { signal: expect.any(AbortSignal) });
  expect(f.refreshModels).toHaveBeenCalledExactlyOnceWith(f.start.provider, expect.any(AbortSignal));
});

it('does not invoke logout for providers without a stored credential', async () => {
  const f = await fixture(); const models = f.root.runtime.session.modelRuntime;
  vi.spyOn(models, 'listCredentials').mockResolvedValue([]);
  const logout = vi.spyOn(models, 'logout').mockResolvedValue(undefined);
  const job = f.manager.start({ kind: 'logout', provider: f.start.provider }, 'owner');
  await vi.waitFor(() => expect(f.manager.read(job.id, 'owner').state).toBe('failed'));
  expect(logout).not.toHaveBeenCalled();
});
