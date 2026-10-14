import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Operation, OperationParams, OperationResult, ResponseFor, SetupCatalog, SetupJob } from '@felan-ai/session-protocol';
import { TerminalSetup } from '../src/tui/setup.js';
import type { TerminalSetupUi } from '../src/tui/setup-ui.js';
import type { TuiSessionController } from '../src/tui/controller.js';

type SetupOperation = Extract<Operation, `host.setup.${string}`>;
type Endpoints = { [O in SetupOperation]: (params: OperationParams<O>) => OperationResult<O> | Promise<OperationResult<O>> };
type Call = { [O in SetupOperation]: { op: O; params: OperationParams<O> } }[SetupOperation];
const operations: SetupOperation[] = ['host.setup.catalog', 'host.setup.start', 'host.setup.read', 'host.setup.answer', 'host.setup.cancel', 'host.setup.open_link'];
const catalog: SetupCatalog = { providers: [{ id: 'provider', label: 'Fixture provider', configured: false, subscription: false, apiKeyLogin: true, methods: ['oauth', 'api_key'] }], credentials: [], dependencies: [] };
const running: SetupJob = { id: 'job', kind: 'login', state: 'running', message: 'Waiting for authorization' };
const waiting: SetupJob = { ...running, state: 'waiting', prompt: { id: 'secret', kind: 'input', message: 'API key', secret: true } };
const finished: SetupJob = { ...running, state: 'completed', message: 'Done' };
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); });

function pending<T>(signal?: AbortSignal): Promise<T | undefined> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(undefined); return; }
    signal?.addEventListener('abort', () => resolve(undefined), { once: true });
  });
}

function fixture(overrides: Partial<Endpoints> = {}, supported: SetupOperation[] = operations, localConsole = true) {
  const calls: Call[] = [];
  const endpoints: Endpoints = {
    'host.setup.catalog': () => structuredClone(catalog), 'host.setup.start': () => structuredClone(waiting),
    'host.setup.read': () => structuredClone(finished), 'host.setup.answer': () => ({}), 'host.setup.cancel': () => ({}),
    'host.setup.open_link': () => ({}), ...overrides,
  };
  const client = {
    capabilities: { operations: supported, localConsole },
    async request<O extends Operation>(op: O, params: OperationParams<O>): Promise<ResponseFor<O>> {
      calls.push({ op, params: structuredClone(params) } as Call);
      const endpoint = endpoints[op as SetupOperation] as (value: OperationParams<O>) => OperationResult<O> | Promise<OperationResult<O>>;
      const result = await endpoint(params);
      return { v: 1, re: 'request', outcome: 'accepted', result } as ResponseFor<O>;
    },
  };
  const controller = { client, setNotice: vi.fn() };
  const ui = {
    isIdle: vi.fn(() => true),
    login: vi.fn<TerminalSetupUi['login']>(),
    select: vi.fn<TerminalSetupUi['select']>().mockResolvedValueOnce('api_key').mockResolvedValue(undefined),
    providers: vi.fn<TerminalSetupUi['providers']>(async (_title, choices) => choices[0]?.value),
    input: vi.fn<TerminalSetupUi['input']>(async () => 'ephemeral-test-secret'),
    confirm: vi.fn<TerminalSetupUi['confirm']>(async () => true),
    checklist: vi.fn<TerminalSetupUi['checklist']>(async () => undefined),
    progress: vi.fn<TerminalSetupUi['progress']>((_job, signal) => pending<'links'>(signal)),
  };
  ui.login.mockImplementation(async (job, _provider, signal) => {
    const prompt = job.prompt;
    if (!prompt) { await ui.progress(job, signal); return undefined; }
    return prompt.kind === 'select'
      ? ui.select(prompt.message, prompt.choices.map(value => ({ value: value.id, label: value.label })), { signal })
      : ui.input(prompt.message, '', { signal, secret: prompt.secret });
  });
  const openBrowser = vi.fn(async (_url: string) => {});
  const setup = new TerminalSetup(controller as unknown as TuiSessionController, ui, openBrowser);
  cleanups.push(() => setup.dispose());
  return { setup, calls, endpoints, controller, ui, openBrowser };
}

it('negotiates setup explicitly and never opens an automatic modal when support is absent', async () => {
  const f = fixture({}, []);
  expect(await f.setup.dependencies(true)).toBe(false);
  expect(f.calls).toEqual([]); expect(f.ui.checklist).not.toHaveBeenCalled(); expect(f.controller.setNotice).not.toHaveBeenCalled();
  expect(await f.setup.login()).toBe(false); expect(f.controller.setNotice).toHaveBeenCalledWith(expect.stringContaining('does not support'));
});

it('asks for an auth type before a provider and sends secrets only through the ephemeral setup endpoint', async () => {
  const f = fixture(); const work = f.setup.login();
  await vi.advanceTimersByTimeAsync(500);
  expect(await work).toBe(true);
  expect(f.calls.find(call => call.op === 'host.setup.start')).toEqual({ op: 'host.setup.start', params: { kind: 'login', provider: 'provider', method: 'api_key', confirmed: true } });
  expect(f.ui.select).toHaveBeenCalledExactlyOnceWith('Select authentication method:', [
    { value: 'oauth', label: 'Sign in with an account' }, { value: 'api_key', label: 'Sign in with an API key' },
  ], expect.any(Object));
  expect(f.ui.providers).toHaveBeenCalledOnce();
  expect(f.ui.select.mock.invocationCallOrder[0]).toBeLessThan(f.ui.providers.mock.invocationCallOrder[0]!);
  expect(f.ui.confirm).not.toHaveBeenCalled();
  expect(f.ui.input).toHaveBeenCalledWith('API key', '', expect.objectContaining({ secret: true, signal: expect.any(AbortSignal) }));
  expect(f.calls.filter(call => call.op === 'host.setup.answer')).toEqual([{ op: 'host.setup.answer', params: { jobId: 'job', promptId: 'secret', text: 'ephemeral-test-secret' } }]);
  expect(JSON.stringify(f.controller.setNotice.mock.calls)).not.toContain('ephemeral-test-secret');
  expect(f.calls.some(call => call.op === 'host.setup.cancel')).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not start login after confirmation dismissal', async () => {
  const f = fixture({ 'host.setup.catalog': () => ({ ...catalog, providers: [{ ...catalog.providers[0]!, configured: true }] }) }); f.ui.confirm.mockResolvedValueOnce(false);
  expect(await f.setup.login()).toBe(false);
  expect(f.calls.map(call => call.op)).toEqual(['host.setup.catalog']);
});

it.each(['oauth', 'api_key'] as const)('starts a single-method %s provider directly', async method => {
  const f = fixture({ 'host.setup.catalog': () => ({ ...catalog, providers: [{ ...catalog.providers[0]!, methods: [method] }] }) });
  const work = f.setup.login('Fixture provider'); await vi.advanceTimersByTimeAsync(500); expect(await work).toBe(true);
  expect(f.ui.select).not.toHaveBeenCalled(); expect(f.ui.providers).not.toHaveBeenCalled(); expect(f.ui.confirm).not.toHaveBeenCalled();
  expect(f.calls.find(call => call.op === 'host.setup.start')?.params).toMatchObject({ method });
});

it('confirms replacement only for configured providers and preserves provider method labels', async () => {
  const f = fixture({ 'host.setup.catalog': () => ({ ...catalog, providers: [{ ...catalog.providers[0]!, configured: true, status: { type: 'oauth', source: 'OAuth' }, oauthLabel: 'Use subscription' }] }) });
  const work = f.setup.login('PROVIDER'); await vi.advanceTimersByTimeAsync(500); expect(await work).toBe(true);
  expect(f.ui.select.mock.calls[0]?.[0]).toBe('Select authentication method for Fixture provider:');
  expect(f.ui.select.mock.calls[0]?.[1]).toEqual([{ value: 'oauth', label: 'Use subscription' }, { value: 'api_key', label: 'Sign in with an API key' }]);
  expect(f.ui.providers).not.toHaveBeenCalled();
  expect(f.ui.confirm).toHaveBeenCalledExactlyOnceWith('Replace credentials', 'Replace existing credentials for Fixture provider?', expect.any(Object));
});

it('uses prompt-specific selection IDs instead of labels', async () => {
  const f = fixture({ 'host.setup.start': () => ({ ...waiting, prompt: { id: 'selection', kind: 'select', message: 'Choose account', choices: [{ id: 'account-id', label: 'Account label' }] } }) });
  f.ui.select.mockImplementation(async title => title.startsWith('Select authentication') ? 'oauth' : 'account-id');
  const work = f.setup.login(); await vi.advanceTimersByTimeAsync(500); expect(await work).toBe(true);
  expect(f.calls.find(call => call.op === 'host.setup.answer')?.params).toEqual({ jobId: 'job', promptId: 'selection', text: 'account-id' });
});

it('aborts a stale secret dialog when polling reports job completion', async () => {
  const f = fixture(); let promptSignal: AbortSignal | undefined;
  f.ui.input.mockImplementation((_title, _initial, options) => { promptSignal = options?.signal; return pending<string>(promptSignal); });
  const work = f.setup.login(); await vi.advanceTimersByTimeAsync(500);
  expect(await work).toBe(true); expect(promptSignal?.aborted).toBe(true);
  expect(f.calls.some(call => call.op === 'host.setup.answer')).toBe(false); expect(vi.getTimerCount()).toBe(0);
});

it('replaces changed prompts and never sends an answer from the dismissed prompt', async () => {
  let reads = 0;
  const f = fixture({ 'host.setup.read': () => ++reads === 1
    ? { ...waiting, prompt: { id: 'new-prompt', kind: 'input', message: 'New challenge', secret: false } } : finished });
  let oldSignal: AbortSignal | undefined;
  f.ui.input.mockImplementation((_title, _initial, options) => {
    if (f.ui.input.mock.calls.length === 1) { oldSignal = options?.signal; return pending<string>(oldSignal); }
    return Promise.resolve('new response');
  });
  const work = f.setup.login(); await vi.advanceTimersByTimeAsync(1_000); expect(await work).toBe(true);
  expect(oldSignal?.aborted).toBe(true);
  expect(f.calls.filter(call => call.op === 'host.setup.answer')).toEqual([{ op: 'host.setup.answer', params: { jobId: 'job', promptId: 'new-prompt', text: 'new response' } }]);
});

it('does not reopen the same prompt after an accepted answer while the daemon is still waiting', async () => {
  let reads = 0; const f = fixture({ 'host.setup.read': () => ++reads < 3 ? waiting : finished });
  const work = f.setup.login(); await vi.advanceTimersByTimeAsync(1_500); expect(await work).toBe(true);
  expect(f.ui.input).toHaveBeenCalledTimes(1); expect(f.calls.filter(call => call.op === 'host.setup.answer')).toHaveLength(1);
});

it('requires explicit unchecked checklist submission and maps unchecked choices to skip', async () => {
  const dependencies: SetupCatalog['dependencies'] = [
    { id: 'install', label: 'Installable', description: '', enabled: true, available: false, installable: true, needsSetup: true },
    { id: 'enable', label: 'Installed', description: 'Verify the installer and install Installed.', enabled: false, available: true, installable: true, needsSetup: true },
    { id: 'disable', label: 'Enabled', description: 'Verify the installer and install Enabled.', enabled: true, available: true, installable: true, needsSetup: false },
    { id: 'skip', label: 'Fallback', description: '', enabled: false, available: false, installable: false, needsSetup: true },
  ];
  const f = fixture({ 'host.setup.catalog': () => ({ ...catalog, dependencies }), 'host.setup.start': () => ({ ...finished, kind: 'dependencies' }) });
  let submit!: (value: readonly string[] | undefined) => void;
  f.ui.checklist.mockImplementation((_options, signal) => new Promise(resolve => { submit = resolve; signal.addEventListener('abort', () => resolve(undefined), { once: true }); }));
  const work = f.setup.dependencies(); await vi.advanceTimersByTimeAsync(0);
  expect(f.calls.some(call => call.op === 'host.setup.start')).toBe(false);
  submit(['install', 'enable', 'disable']); expect(await work).toBe(true);
  expect(f.ui.checklist.mock.calls[0]?.[0].map(row => row.description)).toEqual(expect.arrayContaining([expect.stringContaining('Unchecked: leave unchanged.')]));
  const rows = f.ui.checklist.mock.calls[0]![0];
  expect(rows.find(row => row.id === 'disable')?.description).toBe('Disable Enabled; installed software is kept. Checked: disable. Unchecked: leave unchanged.');
  expect(rows.find(row => row.id === 'enable')?.description).toBe('Enable the installed Installed extension. Checked: enable. Unchecked: leave unchanged.');
  expect(rows.find(row => row.id === 'skip')?.description).toContain('No changes are available');
  expect(f.ui.confirm).toHaveBeenCalledWith('Apply extension changes?', 'install: Installable\nenable: Installed\ndisable: Enabled\nunchanged: Fallback', expect.anything());
  expect(f.calls.find(call => call.op === 'host.setup.start')?.params).toEqual({ kind: 'dependencies', confirmed: true,
    choices: [{ id: 'install', action: 'install' }, { id: 'enable', action: 'enable' }, { id: 'disable', action: 'disable' }, { id: 'skip', action: 'skip' }] });
});

it('does not start dependency changes when their confirmation is declined', async () => {
  const f = fixture({ 'host.setup.catalog': () => ({ ...catalog, dependencies: [
    { id: 'ready', label: 'Ready', description: '', enabled: true, available: true, installable: true, needsSetup: false },
  ] }) });
  f.ui.checklist.mockResolvedValueOnce(['ready']); f.ui.confirm.mockResolvedValueOnce(false);
  expect(await f.setup.dependencies()).toBe(false);
  expect(f.ui.confirm).toHaveBeenCalledWith('Apply extension changes?', 'disable: Ready', expect.anything());
  expect(f.calls.some(call => call.op === 'host.setup.start')).toBe(false);
});

it('offers only needsSetup dependencies automatically and treats dismissal as no decision', async () => {
  const f = fixture({ 'host.setup.catalog': () => ({ ...catalog, dependencies: [
    { id: 'needs', label: 'Needs setup', description: '', enabled: true, available: false, installable: true, needsSetup: true },
    { id: 'ready', label: 'Ready', description: '', enabled: true, available: true, installable: true, needsSetup: false },
  ] }) });
  expect(await f.setup.dependencies(true)).toBe(false);
  expect(f.ui.checklist.mock.calls[0]?.[0].map(row => row.id)).toEqual(['needs']);
  expect(f.calls.some(call => call.op === 'host.setup.start')).toBe(false);
});

it('does not stack automatic dependency onboarding over another active dialog', async () => {
  const f = fixture({ 'host.setup.catalog': () => ({ ...catalog, dependencies: [
    { id: 'needs', label: 'Needs setup', description: '', enabled: true, available: false, installable: true, needsSetup: true },
  ] }) });
  f.ui.isIdle.mockReturnValue(false);
  expect(await f.setup.dependencies(true)).toBe(false); expect(f.ui.checklist).not.toHaveBeenCalled();
  expect(f.calls.some(call => call.op === 'host.setup.start')).toBe(false);
});

it('submits skip for every unchecked dependency only after Enter', async () => {
  const f = fixture({ 'host.setup.catalog': () => ({ ...catalog, dependencies: [
    { id: 'needs', label: 'Needs setup', description: '', enabled: true, available: false, installable: true, needsSetup: true },
  ] }), 'host.setup.start': () => ({ ...finished, kind: 'dependencies' }) });
  f.ui.checklist.mockResolvedValueOnce([]);
  expect(await f.setup.dependencies(true)).toBe(true);
  expect(f.calls.find(call => call.op === 'host.setup.start')?.params).toEqual({ kind: 'dependencies', confirmed: true, choices: [{ id: 'needs', action: 'skip' }] });
});

it.each([true, false])('auto-opens authorization URLs once only for a local console (%s)', async localConsole => {
  const links = [{ label: 'Enter code: TEST-CODE', url: 'https://example.test/login', autoOpen: true as const },
    { label: 'Documentation', url: 'https://example.test/docs' }];
  let reads = 0;
  const f = fixture({ 'host.setup.start': () => ({ ...running, links }),
    'host.setup.read': () => ++reads < 3 ? { ...running, links } : finished }, operations, localConsole);
  const work = f.setup.login(); await vi.advanceTimersByTimeAsync(1_500); expect(await work).toBe(true);
  expect(f.openBrowser.mock.calls).toEqual(localConsole ? [['https://example.test/login']] : []);
  expect(f.ui.login).toHaveBeenCalledWith(expect.objectContaining({ links }), 'Fixture provider', expect.any(AbortSignal));
  expect(f.calls.some(call => call.op === 'host.setup.open_link')).toBe(false);
});

it('keeps the link and manual input available when the browser cannot open', async () => {
  const links = [{ label: 'Authorize', url: 'https://example.test/login', autoOpen: true as const }];
  const f = fixture({ 'host.setup.start': () => ({ ...waiting, links }) });
  f.openBrowser.mockRejectedValueOnce(new Error('No browser'));
  const work = f.setup.login(); await vi.advanceTimersByTimeAsync(500); expect(await work).toBe(true);
  expect(f.ui.login).toHaveBeenCalledWith(expect.objectContaining({ links, prompt: waiting.prompt }), 'Fixture provider', expect.any(AbortSignal));
  expect(f.calls.filter(call => call.op === 'host.setup.answer')).toHaveLength(1);
});

it.each(['javascript:alert(1)', 'https://user:pass@example.test', 'https://example.test/\n'])('does not open unsafe URLs: %s', async url => {
  const f = fixture({ 'host.setup.start': () => ({ ...waiting, links: [{ label: 'Login', url, autoOpen: true }] }) });
  const work = f.setup.login(); await vi.advanceTimersByTimeAsync(500); await work;
  expect(f.openBrowser).not.toHaveBeenCalled();
});

it('cancels on progress dismissal and releases polling timers', async () => {
  const f = fixture({ 'host.setup.start': () => running }); f.ui.progress.mockResolvedValueOnce(undefined);
  f.ui.providers.mockResolvedValueOnce('provider:api_key').mockResolvedValue(undefined);
  expect(await f.setup.login()).toBe(false);
  expect(f.calls.filter(call => call.op === 'host.setup.cancel')).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
});

it('disposes active prompts and cancels the owned job before client shutdown', async () => {
  const f = fixture(); let signal: AbortSignal | undefined;
  f.ui.input.mockImplementation((_title, _initial, options) => { signal = options?.signal; return pending<string>(signal); });
  const work = f.setup.login(); await vi.advanceTimersByTimeAsync(0);
  await f.setup.dispose(); expect(await work).toBe(false); expect(signal?.aborted).toBe(true);
  expect(f.calls.filter(call => call.op === 'host.setup.cancel')).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
});

it('bounds cleanup even when cancellation has no reply', async () => {
  const f = fixture({ 'host.setup.start': () => running, 'host.setup.cancel': () => new Promise(() => {}) });
  const work = f.setup.login(); await vi.advanceTimersByTimeAsync(0);
  const closed = f.setup.dispose(); await vi.advanceTimersByTimeAsync(1_500); await closed;
  expect(await work).toBe(false); expect(vi.getTimerCount()).toBe(0);
});

it('cancels a start reply arriving after disposal without reopening any dialog', async () => {
  let reply!: (job: SetupJob) => void;
  const f = fixture({ 'host.setup.start': () => new Promise(resolve => { reply = resolve; }) });
  const work = f.setup.login(); await vi.advanceTimersByTimeAsync(0); await f.setup.dispose();
  expect(await work).toBe(false); reply(waiting); await vi.advanceTimersByTimeAsync(0);
  expect(f.calls.filter(call => call.op === 'host.setup.cancel')).toHaveLength(1); expect(f.ui.input).not.toHaveBeenCalled();
});

it('bounds a stalled setup request and does not leak secret-bearing errors into notices', async () => {
  const f = fixture({ 'host.setup.answer': async () => { throw new Error('ephemeral-test-secret'); } });
  expect(await f.setup.login()).toBe(false);
  expect(JSON.stringify(f.controller.setNotice.mock.calls)).not.toContain('ephemeral-test-secret');
  expect(f.calls.filter(call => call.op === 'host.setup.cancel')).toHaveLength(1);
  const stalled = fixture({ 'host.setup.catalog': () => new Promise(() => {}) });
  const work = stalled.setup.login(); await vi.advanceTimersByTimeAsync(15_000); expect(await work).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});


it.each(['oauth', 'api_key'] as const)('filters %s providers and sorts their names', async type => {
  const base = catalog.providers[0]!;
  const f = fixture({ 'host.setup.catalog': () => ({ ...catalog, providers: [
    { ...base, id: 'z', label: 'Zulu', methods: [type] },
    { ...base, id: 'other', label: 'Other', methods: [type === 'oauth' ? 'api_key' : 'oauth'] },
    { ...base, id: 'a', label: 'Alpha', methods: [type] },
  ] }) });
  f.ui.select.mockReset().mockResolvedValueOnce(type).mockResolvedValue(undefined);
  f.ui.providers.mockResolvedValue(undefined);
  expect(await f.setup.login()).toBe(false);
  expect(f.ui.providers.mock.calls[0]?.[1].map(value => value.value)).toEqual([`a:${type}`, `z:${type}`]);
  expect(f.ui.select).toHaveBeenCalledTimes(2);
  expect(f.calls.some(call => call.op === 'host.setup.start')).toBe(false);
});

it.each([
  [{ type: 'oauth', source: 'OAuth' }, true, ' • subscription configured'],
  [{ type: 'oauth', source: 'OAuth' }, false, ' • account configured'],
  [{ type: 'api_key', source: 'stored credential' }, false, ' ✓ configured'],
  [{ type: 'api_key', source: 'API_KEY, OTHER_KEY' }, false, ' ✓ env: API_KEY, OTHER_KEY'],
  [{ type: 'api_key', source: 'models.json' }, false, ' ✓ models.json'],
] as const)('preserves provider status %j with subscription=%s', async (status, subscription, suffix) => {
  const f = fixture({ 'host.setup.catalog': () => ({ ...catalog, providers: [{ ...catalog.providers[0]!, configured: true, status, subscription }] }) });
  f.ui.providers.mockResolvedValue(undefined);
  expect(await f.setup.login()).toBe(false);
  expect(f.ui.providers.mock.calls[0]?.[1][0]?.label).toBe(`Fixture provider${suffix}`);
});

it('offers Radius directly at the top level, without a provider selector', async () => {
  const f = fixture({ 'host.setup.catalog': () => ({ ...catalog, providers: [
    ...catalog.providers, { ...catalog.providers[0]!, id: 'radius', label: 'Radius', methods: ['oauth'], subscription: true },
  ] }) });
  f.ui.select.mockReset().mockResolvedValueOnce('radius');
  const work = f.setup.login(); await vi.advanceTimersByTimeAsync(500); expect(await work).toBe(true);
  expect(f.ui.select.mock.calls[0]?.[1].at(-1)).toEqual({ value: 'radius', label: 'Sign in with Radius • not configured' });
  expect(f.ui.providers).not.toHaveBeenCalled();
  expect(f.calls.find(call => call.op === 'host.setup.start')?.params).toMatchObject({ provider: 'radius', method: 'oauth' });
});

it('opens the unfiltered provider search for an unknown shortcut with both type labels', async () => {
  const f = fixture(); f.ui.providers.mockResolvedValue(undefined);
  expect(await f.setup.login('partial')).toBe(false);
  expect(f.ui.select).not.toHaveBeenCalled();
  expect(f.ui.providers).toHaveBeenCalledWith('Select provider to configure:', [
    { value: 'provider:oauth', label: 'Fixture provider [account] • not configured', description: 'provider oauth ' },
    { value: 'provider:api_key', label: 'Fixture provider [API key] • not configured', description: 'provider api_key ' },
  ], 'partial', expect.any(AbortSignal));
});

it('shows ambient authentication instructions without starting or confirming a job and returns back', async () => {
  const f = fixture({ 'host.setup.catalog': () => ({ ...catalog, providers: [
    { ...catalog.providers[0]!, methods: ['api_key'], apiKeyLogin: false, apiKeyName: 'Cloud credentials', configured: true },
  ] }) });
  f.ui.select.mockReset().mockResolvedValueOnce('api_key').mockResolvedValue(undefined);
  f.ui.providers.mockResolvedValueOnce('provider:api_key').mockResolvedValue(undefined);
  expect(await f.setup.login()).toBe(false);
  expect(f.ui.select).toHaveBeenCalledWith('Fixture provider setup', [{ value: 'back', label: 'Cloud credentials is configured outside Felan.' }], expect.any(Object));
  expect(f.ui.providers).toHaveBeenCalledTimes(2);
  expect(f.ui.confirm).not.toHaveBeenCalled(); expect(f.calls.map(call => call.op)).toEqual(['host.setup.catalog']);
});

it('returns from a cancelled login to its provider selector, then to the auth type selector', async () => {
  const f = fixture({ 'host.setup.start': () => running });
  f.ui.progress.mockResolvedValueOnce(undefined);
  f.ui.providers.mockResolvedValueOnce('provider:api_key').mockResolvedValue(undefined);
  expect(await f.setup.login()).toBe(false);
  expect(f.ui.providers).toHaveBeenCalledTimes(2); expect(f.ui.select).toHaveBeenCalledTimes(2);
  expect(f.calls.filter(call => call.op === 'host.setup.cancel')).toHaveLength(1);
});

it('returns a cancelled provider shortcut to its own auth type selector', async () => {
  const f = fixture({ 'host.setup.start': () => running }); f.ui.progress.mockResolvedValueOnce(undefined);
  expect(await f.setup.login('provider')).toBe(false);
  expect(f.ui.select.mock.calls.map(call => call[0])).toEqual([
    'Select authentication method for Fixture provider:', 'Select authentication method for Fixture provider:',
  ]);
  expect(f.ui.providers).not.toHaveBeenCalled();
});

it('lists only stored credentials for logout and starts the daemon removal job', async () => {
  const f = fixture({ 'host.setup.catalog': () => ({ ...catalog, credentials: [
    { id: 'key', label: 'Zulu', type: 'api_key', subscription: false },
    { id: 'account', label: 'Alpha', type: 'oauth', subscription: true },
  ] }), 'host.setup.start': () => ({ ...finished, kind: 'logout', message: 'Logged out of Alpha' }) });
  expect(await f.setup.logout()).toBe(true);
  expect(f.ui.providers.mock.calls[0]?.[1]).toEqual([
    { value: 'account', label: 'Alpha [subscription] ✓ configured' }, { value: 'key', label: 'Zulu [API key] ✓ configured' },
  ]);
  expect(f.calls.find(call => call.op === 'host.setup.start')?.params).toEqual({ kind: 'logout', provider: 'account', confirmed: true });
  expect(f.controller.setNotice).toHaveBeenLastCalledWith('Logged out of Alpha');
  expect(f.ui.confirm).not.toHaveBeenCalled();
});

it('explains that logout does not remove ambient configuration', async () => {
  const f = fixture(); expect(await f.setup.logout()).toBe(false);
  expect(f.ui.providers).not.toHaveBeenCalled();
  expect(f.controller.setNotice).toHaveBeenCalledWith(expect.stringContaining('environment variables and models.json config are unchanged'));
});
