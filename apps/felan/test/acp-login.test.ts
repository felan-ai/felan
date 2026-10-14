import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { identityFor } from '../../daemon/src/daemon/target.js';
import type { ClientEnvelope, Operation, OperationParams, OperationResult, SetupCatalog, SetupJob } from '@felan-ai/session-protocol';
import { NodeAcpLoginTerminal, runLocalFelanAcpLogin, type AcpLoginChoice, type AcpLoginTerminal, type RunLocalFelanAcpLoginOptions } from '../src/acp/login.js';
import { SessionClient, type SessionClientOptions } from '../src/client/client.js';
import { FakeTransport } from './client-fixtures.js';

type SetupOperation = Extract<Operation, `host.setup.${string}`>;
type Endpoints = { [O in SetupOperation]: (params: OperationParams<O>) => OperationResult<O> | Promise<OperationResult<O>> };
const waiting: SetupJob = { id: 'job', kind: 'login', state: 'waiting', message: 'Enter credentials', prompt: { id: 'key', kind: 'input', message: 'Enter API key', secret: true } };
const completed: SetupJob = { id: 'job', kind: 'login', state: 'completed', message: 'Saved' };
const catalog: SetupCatalog = { providers: [{ id: 'provider', label: 'Provider', methods: ['api_key'], configured: false, subscription: false, apiKeyLogin: true }], credentials: [], dependencies: [] };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

async function fixture(overrides: Partial<Endpoints> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'acp-login-client-'));
  const requests: ClientEnvelope[] = []; const clients: SessionClient[] = []; const settings: SessionClientOptions[] = [];
  const errors: string[] = [];
  const endpoints: Endpoints = {
    'host.setup.catalog': () => catalog, 'host.setup.start': () => waiting, 'host.setup.read': () => completed,
    'host.setup.answer': () => ({}), 'host.setup.cancel': () => ({}), 'host.setup.open_link': () => ({}), ...overrides,
  };
  const createClient = (options: SessionClientOptions) => {
    settings.push(options); const fake = new FakeTransport();
    const client = new SessionClient({ ...options, connector: fake.connector, requestTimeoutMs: 2_000, retries: 0 }); clients.push(client);
    const identity = identityFor(client.target, 'instance');
    fake.onSend = (request, connection) => {
      requests.push(request);
      if (request.op === 'hello') {
        fake.reply(request, { attachmentId: 'client', principal: 'principal', daemonVersion: options.expectedDaemonVersion ?? options.clientVersion,
          protocol: 1, identity, operations: Object.keys(endpoints), interactionKinds: [] }, connection); return;
      }
      const endpoint = endpoints[request.op as SetupOperation] as (params: unknown) => unknown;
      void Promise.resolve().then(() => endpoint(request.params)).then(result => fake.reply(request, result, connection), error => {
        fake.frame({ v: 1, re: request.id, outcome: 'rejected', error: { code: 'unavailable', message: error instanceof Error ? error.message : 'Failed', retryable: false } }, connection);
      });
    };
    return client;
  };
  cleanup.push(async () => { for (const client of clients) client.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, requests, clients, settings, errors, endpoints, createClient,
    run(terminal: AcpLoginTerminal, extra: Partial<RunLocalFelanAcpLoginOptions> = {}) {
      return runLocalFelanAcpLogin({ daemonRuntime: directory, terminal, createClient, signalSource: new EventEmitter(), writeError: value => errors.push(value), ...extra });
    },
  };
}

describe('finite ACP daemon login', () => {
  it('selects a provider directly, masks API keys and waits for the daemon result without creating a session', async () => {
    const f = await fixture(); const terminal = new TestLoginTerminal([1, 0], ['test-private-key']);
    expect(await f.run(terminal)).toBe(0);
    expect(terminal.inputRequests).toEqual([{ message: 'Enter API key', options: { secret: true } }]);
    expect(f.requests.filter(request => request.op === 'host.setup.start').map(request => request.params)).toEqual([
      { kind: 'login', provider: 'provider', method: 'api_key' },
    ]);
    expect(f.requests.filter(request => request.op === 'host.setup.answer').map(request => request.params)).toEqual([
      { jobId: 'job', promptId: 'key', text: 'test-private-key' },
    ]);
    expect(f.requests.some(request => ['sessions.create', 'attach', 'interaction.answer'].includes(request.op))).toBe(false);
    expect(terminal.lines.join('\n')).not.toContain('test-private-key'); expect(f.errors).toEqual([]);
    expect(terminal.lines).toContain('Authentication saved by the daemon.');
    expect(f.clients[0]?.status).toBe('closed');
    expect(f.settings[0]).toMatchObject({ kind: 'tui', target: { kind: 'isolated', directory: f.directory }, interactionKinds: [] });
    expect(isAbsolute(f.settings[0]!.launch!.entrypoint)).toBe(true);
  });

  it('allows backing out of provider selection before completing authentication', async () => {
    const f = await fixture(); const terminal = new TestLoginTerminal([1, undefined, 1, 0], ['test-key']);
    expect(await f.run(terminal)).toBe(0);
    expect(terminal.selections.map(selection => selection.message)).toEqual([
      'Select authentication method:', 'Select provider to configure:', 'Select authentication method:', 'Select provider to configure:',
    ]);
    expect(f.errors).toEqual([]);
  });

  it('uses OAuth links, typed selection prompts and masked manual codes through host setup only', async () => {
    let answered = 0;
    const first: SetupJob = { ...waiting, links: [{ label: 'Authorize', url: 'https://auth.example/login?state=keep&token=hide' }],
      prompt: { id: 'account', kind: 'select', message: 'Choose account', choices: [{ id: 'first', label: 'First' }, { id: 'second', label: 'Second' }] } };
    const f = await fixture({
      'host.setup.catalog': () => ({ ...catalog, providers: [{ id: 'oauth-provider', label: 'OAuth Provider', methods: ['oauth'], configured: false, subscription: false, apiKeyLogin: true }] }),
      'host.setup.start': () => first,
      'host.setup.read': () => answered < 2 ? { ...waiting, prompt: { id: 'code', kind: 'input', message: 'Paste authorization code', secret: true } } : completed,
      'host.setup.answer': () => { answered++; return {}; },
    });
    const terminal = new TestLoginTerminal([0, 0, 1], ['manual-secret-code']);
    expect(await f.run(terminal)).toBe(0);
    expect(f.requests.some(request => request.op === 'host.setup.open_link')).toBe(false);
    expect(f.requests.filter(request => request.op === 'host.setup.answer').map(request => request.params)).toEqual([
      { jobId: 'job', promptId: 'account', text: 'second' }, { jobId: 'job', promptId: 'code', text: 'manual-secret-code' },
    ]);
    expect(terminal.inputRequests[0]?.options.secret).toBe(true);
    expect(terminal.lines.join('\n')).toContain('state=keep');
    expect(terminal.lines.join('\n')).not.toContain('token=hide');
    expect(terminal.lines.join('\n')).not.toContain('manual-secret-code');
  });

  it('fails safely when the daemon has no provider methods or lacks setup capabilities', async () => {
    const f = await fixture({ 'host.setup.catalog': () => ({ providers: [], credentials: [], dependencies: [] }) });
    expect(await f.run(new TestLoginTerminal([1], []))).toBe(1);
    expect(f.requests.some(request => request.op === 'host.setup.start')).toBe(false);
    expect(f.errors.join('\n')).toContain('No API key providers available.');
    delete (f.endpoints as Partial<Endpoints>)['host.setup.start'];
    expect(await f.run(new TestLoginTerminal([], []))).toBe(1);
    expect(f.errors.at(-1)).toContain('does not support interactive setup');
  });

  it('treats provider and secret-input dismissal as cancellation', async () => {
    for (const selections of [[], [1, 0]]) {
      const f = await fixture(); const terminal = new TestLoginTerminal(selections, []);
      expect(await f.run(terminal)).toBe(1);
      expect(terminal.lines).toContain('Authentication cancelled.'); expect(f.errors).toEqual([]);
      if (selections.length) expect(f.requests.some(request => request.op === 'host.setup.cancel')).toBe(true);
      expect(f.clients[0]?.status).toBe('closed');
    }
  });

  it('replaces existing credentials without an extra confirmation', async () => {
    const f = await fixture({ 'host.setup.catalog': () => ({ ...catalog, providers: [{ ...catalog.providers[0]!, configured: true }] }) });
    const terminal = new TestLoginTerminal([1, 0], ['replacement-key']);
    expect(await f.run(terminal)).toBe(0);
    expect(f.requests.filter(request => request.op === 'host.setup.start')).toHaveLength(1);
    expect(terminal.lines).toContain('Authentication saved by the daemon.');
  });

  it('redacts entered credentials from failing daemon replies and releases the job', async () => {
    const secret = 'unstructured private value';
    const f = await fixture({ 'host.setup.answer': () => { throw new Error(`Rejected ${secret}`); } });
    const terminal = new TestLoginTerminal([1, 0], [secret]);
    expect(await f.run(terminal)).toBe(1);
    expect(f.errors.join('\n')).not.toContain(secret); expect(terminal.lines.join('\n')).not.toContain(secret);
    expect(f.requests.filter(request => request.op === 'host.setup.cancel')).toHaveLength(1);
  });

  it('bounds injected terminal answers before they reach the setup channel', async () => {
    const f = await fixture(); const terminal = new TestLoginTerminal([1, 0], ['x'.repeat(64 * 1024 + 1)]);
    expect(await f.run(terminal)).toBe(1);
    expect(f.requests.some(request => request.op === 'host.setup.answer')).toBe(false);
    expect(f.requests.some(request => request.op === 'host.setup.cancel')).toBe(true);
  });

  it.each([['SIGINT', 130], ['SIGTERM', 143]] as const)('preserves %s exit status and cancels an active daemon job', async (signal, code) => {
    const f = await fixture(); const source = new EventEmitter(); const terminal = new TestLoginTerminal([1, 0], []);
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    let promptSignal: AbortSignal | undefined;
    terminal.input = async (_message, _options, value) => { promptSignal = value; entered(); return new Promise(() => {}); };
    const terminate = vi.fn(); const running = f.run(terminal, { signalSource: source, terminateProcess: terminate });
    await ready; source.emit(signal);
    expect(await running).toBe(code); expect(promptSignal?.aborted).toBe(true);
    expect(f.requests.filter(request => request.op === 'host.setup.cancel')).toHaveLength(1);
    expect(f.clients[0]?.status).toBe('closed'); expect(source.listenerCount('SIGINT')).toBe(0); expect(source.listenerCount('SIGTERM')).toBe(0);
    await vi.waitFor(() => expect(terminate).toHaveBeenCalledExactlyOnceWith(code));
  });

  it('closes a cancelled connection attempt even when an injected connector never settles', async () => {
    const f = await fixture(); const abort = new AbortController(); const terminal = new TestLoginTerminal([], []);
    let connected!: () => void; const started = new Promise<void>(resolve => { connected = resolve; });
    const running = f.run(terminal, { signal: abort.signal, createClient: settings => {
      const client = f.createClient(settings); vi.spyOn(client, 'connect').mockImplementation(() => { connected(); return new Promise(() => {}); }); return client;
    } });
    await started; abort.abort(); expect(await running).toBe(1); expect(f.clients[0]?.status).toBe('closed');
  });

  it('cancels a hung start request, closes the client, and ignores its late response', async () => {
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    let finish!: (value: SetupJob) => void;
    const f = await fixture({ 'host.setup.start': () => { entered(); return new Promise(resolve => { finish = resolve; }); } });
    const terminal = new TestLoginTerminal([1, 0], []); const abort = new AbortController();
    const running = f.run(terminal, { signal: abort.signal }); await ready; abort.abort(); expect(await running).toBe(1);
    const lines = [...terminal.lines]; finish(waiting); await new Promise(resolve => setImmediate(resolve));
    expect(terminal.inputRequests).toEqual([]); expect(terminal.lines).toEqual(lines); expect(f.clients[0]?.status).toBe('closed');
  });

  it('does not echo raw secret input and restores terminal mode', async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY: true;
      isRaw: boolean;
      setRawMode(mode: boolean): typeof input;
    };
    input.isTTY = true;
    input.isRaw = false;
    const rawModes: boolean[] = [];
    input.setRawMode = (mode) => {
      rawModes.push(mode);
      input.isRaw = mode;
      return input;
    };
    const output = new PassThrough();
    let rendered = '';
    output.on('data', (chunk) => { rendered += chunk.toString(); });
    const terminal = new NodeAcpLoginTerminal(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
    );

    const answer = terminal.input('Secret', { secret: true }, new AbortController().signal);
    input.emit('keypress', 'hidden-value', { name: 'h' });
    input.emit('keypress', '\r', { name: 'return' });

    await expect(answer).resolves.toBe('hidden-value');
    expect(rendered).toBe('Secret: \n');
    expect(rawModes).toEqual([true, false]);
    expect(input.isPaused()).toBe(true);

    const closingInput = new PassThrough() as PassThrough & {
      isTTY: true;
      isRaw: boolean;
      setRawMode(mode: boolean): typeof closingInput;
    };
    closingInput.isTTY = true;
    closingInput.isRaw = false;
    const closingRawModes: boolean[] = [];
    closingInput.setRawMode = (mode) => {
      closingRawModes.push(mode);
      closingInput.isRaw = mode;
      return closingInput;
    };
    const closingTerminal = new NodeAcpLoginTerminal(
      closingInput as unknown as NodeJS.ReadStream,
      new PassThrough() as unknown as NodeJS.WriteStream,
    );
    const closedAnswer = closingTerminal.input(
      'Secret',
      { secret: true },
      new AbortController().signal,
    );
    closingInput.emit('close');

    await expect(closedAnswer).resolves.toBeUndefined();
    expect(closingRawModes).toEqual([true, false]);
    expect(closingInput.isPaused()).toBe(true);
  });

  it('rejects visible terminal input before buffering an oversized line', async () => {
    const input = new PassThrough();
    const terminal = new NodeAcpLoginTerminal(
      input as unknown as NodeJS.ReadStream,
      new PassThrough() as unknown as NodeJS.WriteStream,
    );
    const selected = terminal.select(
      'Choose',
      [{ id: 'one', label: 'One' }],
      new AbortController().signal,
    );
    input.write(Buffer.alloc(64 * 1024 + 1, 97));

    await expect(selected).rejects.toThrow('Terminal input exceeds the maximum size');
    expect(input.isPaused()).toBe(true);
  });

  it('refuses to read credentials from a non-interactive stream', async () => {
    const terminal = new NodeAcpLoginTerminal(new PassThrough() as unknown as NodeJS.ReadStream, new PassThrough() as unknown as NodeJS.WriteStream);
    await expect(terminal.input('API key', { secret: true }, new AbortController().signal)).rejects.toThrow('Secret input requires an interactive terminal');
  });

  it('preserves typeahead following a visible line terminator', async () => {
    const input = new PassThrough();
    const terminal = new NodeAcpLoginTerminal(
      input as unknown as NodeJS.ReadStream,
      new PassThrough() as unknown as NodeJS.WriteStream,
    );
    const selected = terminal.select(
      'Choose',
      [{ id: 'one', label: 'One' }],
      new AbortController().signal,
    );
    input.write('1\r\nnext answer\n');

    await expect(selected).resolves.toBe('one');
    await expect(terminal.input(
      'Question',
      { secret: false },
      new AbortController().signal,
    )).resolves.toBe('next answer');
  });
});

class TestLoginTerminal implements AcpLoginTerminal {
  readonly lines: string[] = [];
  readonly selections: Array<{ message: string; options: readonly AcpLoginChoice[] }> = [];
  readonly inputRequests: Array<{ message: string; options: { readonly secret: boolean; readonly placeholder?: string } }> = [];
  readonly #selectionIndexes: Array<number | undefined>;
  readonly #answers: string[];
  constructor(selections: Array<number | undefined>, answers: string[]) { this.#selectionIndexes = [...selections]; this.#answers = [...answers]; }
  async select(message: string, options: readonly AcpLoginChoice[], _signal: AbortSignal): Promise<string | undefined> {
    this.selections.push({ message, options }); const index = this.#selectionIndexes.shift(); return index === undefined ? undefined : options[index]?.id;
  }
  async input(message: string, options: { readonly secret: boolean; readonly placeholder?: string }, _signal: AbortSignal): Promise<string | undefined> {
    this.inputRequests.push({ message, options }); return this.#answers.shift();
  }
  writeLine(message: string): void { this.lines.push(message); }
}
