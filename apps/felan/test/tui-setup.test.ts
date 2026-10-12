import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Operation, OperationParams, OperationResult, ResponseFor, SetupCatalog, SetupJob } from '@felan-ai/session-protocol';
import { TerminalSetup } from '../src/tui/setup.js';
import type { TerminalSetupUi } from '../src/tui/setup-ui.js';
import type { TuiSessionController } from '../src/tui/controller.js';

type SetupOperation = Extract<Operation, `host.setup.${string}`>;
type Endpoints = { [O in SetupOperation]: (params: OperationParams<O>) => OperationResult<O> | Promise<OperationResult<O>> };
type Call = { [O in SetupOperation]: { op: O; params: OperationParams<O> } }[SetupOperation];
const operations: SetupOperation[] = ['host.setup.catalog', 'host.setup.start', 'host.setup.read', 'host.setup.answer', 'host.setup.cancel', 'host.setup.open_link'];
const catalog: SetupCatalog = { providers: [{ id: 'provider', label: 'Fixture provider', configured: false, methods: ['oauth', 'api_key'] }], dependencies: [] };
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

function fixture(overrides: Partial<Endpoints> = {}, supported: SetupOperation[] = operations) {
  const calls: Call[] = [];
  const endpoints: Endpoints = {
    'host.setup.catalog': () => structuredClone(catalog), 'host.setup.start': () => structuredClone(waiting),
    'host.setup.read': () => structuredClone(finished), 'host.setup.answer': () => ({}), 'host.setup.cancel': () => ({}),
    'host.setup.open_link': () => ({}), ...overrides,
  };
  const client = {
    capabilities: { operations: supported },
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
    select: vi.fn<TerminalSetupUi['select']>(async (title) => title.startsWith('Log in') ? 'provider' : 'api_key'),
    input: vi.fn<TerminalSetupUi['input']>(async () => 'ephemeral-test-secret'),
    confirm: vi.fn<TerminalSetupUi['confirm']>(async () => true),
    checklist: vi.fn<TerminalSetupUi['checklist']>(async () => undefined),
    progress: vi.fn<TerminalSetupUi['progress']>((_job, signal) => pending<'links'>(signal)),
  };
  const setup = new TerminalSetup(controller as unknown as TuiSessionController, ui);
  cleanups.push(() => setup.dispose());
  return { setup, calls, endpoints, controller, ui };
}

it('negotiates setup explicitly and never opens an automatic modal when support is absent', async () => {
  const f = fixture({}, []);
  expect(await f.setup.dependencies(true)).toBe(false);
  expect(f.calls).toEqual([]); expect(f.ui.checklist).not.toHaveBeenCalled(); expect(f.controller.setNotice).not.toHaveBeenCalled();
  expect(await f.setup.login()).toBe(false); expect(f.controller.setNotice).toHaveBeenCalledWith(expect.stringContaining('does not support'));
});

it('uses provider/method confirmation and sends secrets only through the ephemeral setup endpoint', async () => {
  const f = fixture(); const work = f.setup.login();
  await vi.advanceTimersByTimeAsync(500);
  expect(await work).toBe(true);
  expect(f.calls.find(call => call.op === 'host.setup.start')).toEqual({ op: 'host.setup.start', params: { kind: 'login', provider: 'provider', method: 'api_key', confirmed: true } });
  expect(f.ui.input).toHaveBeenCalledWith('API key', '', expect.objectContaining({ secret: true, signal: expect.any(AbortSignal) }));
  expect(f.calls.filter(call => call.op === 'host.setup.answer')).toEqual([{ op: 'host.setup.answer', params: { jobId: 'job', promptId: 'secret', text: 'ephemeral-test-secret' } }]);
  expect(JSON.stringify(f.controller.setNotice.mock.calls)).not.toContain('ephemeral-test-secret');
  expect(f.calls.some(call => call.op === 'host.setup.cancel')).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not start login after confirmation dismissal', async () => {
  const f = fixture(); f.ui.confirm.mockResolvedValueOnce(false);
  expect(await f.setup.login()).toBe(false);
  expect(f.calls.map(call => call.op)).toEqual(['host.setup.catalog']);
});

it('uses prompt-specific selection IDs instead of labels', async () => {
  const f = fixture({ 'host.setup.start': () => ({ ...waiting, prompt: { id: 'selection', kind: 'select', message: 'Choose account', choices: [{ id: 'account-id', label: 'Account label' }] } }) });
  f.ui.select.mockImplementation(async title => title.startsWith('Log in') ? 'provider' : title.startsWith('Login method') ? 'oauth' : 'account-id');
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
    { id: 'enable', label: 'Installed', description: '', enabled: false, available: true, installable: true, needsSetup: true },
    { id: 'disable', label: 'Enabled', description: '', enabled: true, available: true, installable: true, needsSetup: false },
    { id: 'skip', label: 'Fallback', description: '', enabled: false, available: false, installable: false, needsSetup: true },
  ];
  const f = fixture({ 'host.setup.catalog': () => ({ ...catalog, dependencies }), 'host.setup.start': () => ({ ...finished, kind: 'dependencies' }) });
  let submit!: (value: readonly string[] | undefined) => void;
  f.ui.checklist.mockImplementation((_options, signal) => new Promise(resolve => { submit = resolve; signal.addEventListener('abort', () => resolve(undefined), { once: true }); }));
  const work = f.setup.dependencies(); await vi.advanceTimersByTimeAsync(0);
  expect(f.calls.some(call => call.op === 'host.setup.start')).toBe(false);
  submit(['install', 'enable', 'disable']); expect(await work).toBe(true);
  expect(f.calls.find(call => call.op === 'host.setup.start')?.params).toEqual({ kind: 'dependencies', confirmed: true,
    choices: [{ id: 'install', action: 'install' }, { id: 'enable', action: 'enable' }, { id: 'disable', action: 'disable' }, { id: 'skip', action: 'skip' }] });
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

it('opens links only through an explicitly confirmed daemon request', async () => {
  const f = fixture({ 'host.setup.start': () => ({ ...waiting, links: [{ label: 'Provider login', url: 'https://example.test/login' }] }) });
  f.ui.select.mockResolvedValueOnce('provider').mockResolvedValueOnce('oauth').mockResolvedValueOnce('link:0').mockResolvedValueOnce('respond');
  const work = f.setup.login(); await vi.advanceTimersByTimeAsync(500); expect(await work).toBe(true);
  expect(f.ui.confirm).toHaveBeenCalledWith('Open in the daemon browser', 'https://example.test/login', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(f.calls.filter(call => call.op === 'host.setup.open_link')).toEqual([{ op: 'host.setup.open_link', params: { jobId: 'job', index: 0, confirmed: true } }]);
});

it('never opens a dismissed link confirmation and requests job cancellation', async () => {
  const f = fixture({ 'host.setup.start': () => ({ ...waiting, links: [{ label: 'Login', url: 'https://example.test' }] }) });
  f.ui.select.mockResolvedValueOnce('provider').mockResolvedValueOnce('oauth').mockResolvedValueOnce('link:0');
  f.ui.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  expect(await f.setup.login()).toBe(false);
  expect(f.calls.some(call => call.op === 'host.setup.open_link')).toBe(false);
  expect(f.calls.filter(call => call.op === 'host.setup.cancel')).toHaveLength(1);
});

it('cancels on progress dismissal and releases polling timers', async () => {
  const f = fixture({ 'host.setup.start': () => running }); f.ui.progress.mockResolvedValueOnce(undefined);
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
