import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLocalFelanHeadless } from '../src/headless.js';
import { HeadlessJsonWriter, resolveHeadlessModel } from '../src/headless.js';
import { type PresentationEvent } from '@felan-ai/session-protocol';
import { configField, defineExtensionConfig } from '@felan-ai/agent-core';
import { gate } from '../../daemon/test/fixtures/server.js';
import { acpDaemonFixture } from './acp-daemon-fixture.js';
import { headlessJsonEvent } from '../../daemon/src/daemon/headless-json.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(options: Parameters<typeof acpDaemonFixture>[0] = {}) {
  const f = await acpDaemonFixture(options); cleanups.push(() => f.dispose());
  const output: string[] = []; const errors: string[] = [];
  const settings = { cwd: f.cwd, createClient: f.createClient, signalSource: new EventEmitter(),
    writeOutput: (text: string) => { output.push(text); }, writeError: (line: string) => { errors.push(line); } };
  return { ...f, output, errors, settings };
}

describe('daemon headless application', () => {
  it('prints only final assistant text and leaves the daemon session open', async () => {
    const f = await fixture();
    const before = { ...process.env };
    expect(await runLocalFelanHeadless({ ...f.settings, sessionId: f.root.sessionId, mode: 'text', initialMessage: 'hello' })).toBe(0);
    expect(f.output).toEqual(['done\n']);
    expect(f.errors).toEqual([]);
    expect(f.store.session(f.root.sessionId).state).toBe('open');
    expect(f.store.session(f.root.sessionId).run.state).toBe('idle');
    expect(process.env).toEqual(before);
    expect(f.clients[0]!.status).toBe('closed');
  });

  it('preserves legacy JSONL event names and completion messages instead of exposing protocol projections', async () => {
    const f = await fixture();
    const header = f.root.runtime.session.sessionManager.getHeader();
    const native: unknown[] = [];
    const unsubscribe = f.root.runtime.session.subscribe(event => { native.push(JSON.parse(JSON.stringify(headlessJsonEvent(event)))); });
    try {
      expect(await runLocalFelanHeadless({ ...f.settings, sessionId: f.root.sessionId, mode: 'json', initialMessage: 'hello' }), f.errors.join('\n')).toBe(0);
    } finally { unsubscribe(); }
    const records = f.output.map(line => JSON.parse(line));
    expect(records[0]).toEqual(header);
    expect(records.slice(1)).toEqual(native);
    expect(records.filter(record => record.type === 'message_end').map(record => record.message.role)).toEqual(['system', 'user', 'assistant']);
    expect(records.find(record => record.type === 'message_end' && record.message.role === 'assistant').message.content).toEqual([{ type: 'text', text: 'done' }]);
    expect(records.find(record => record.type === 'agent_end').messages.map((message: { role: string }) => message.role)).toEqual(['system', 'user', 'assistant']);
    expect(records.at(-1)).toEqual({ type: 'agent_settled', aborted: false });
    expect(records.some(record => ['message', 'run', 'text_delta'].includes(record.type))).toBe(false);
    expect(f.errors).toEqual([]);
  });

  it('selects provider/model and thinking through daemon operations', async () => {
    const f = await fixture();
    expect(await runLocalFelanHeadless({ ...f.settings, sessionId: f.root.sessionId, mode: 'text', initialMessage: 'hello', provider: 'offline', model: 'fixture', thinkingLevel: 'off' })).toBe(0);
    expect(f.store.session(f.root.sessionId).model).toEqual({ provider: 'offline', id: 'fixture' });
    expect(f.errors).toEqual([]);
  });

  it.each([false, true])('applies headless CLI configuration only to its session (resume=%s)', async resume => {
    const definition = defineExtensionConfig({ id: 'codex', title: 'Fixture', fields: { fast: configField.boolean({ default: false, description: 'Fixture' }) } });
    const f = await fixture({ configDefinitions: [definition] });
    const openings = vi.spyOn(f.profile, 'openSession');
    const result = await runLocalFelanHeadless({ ...f.settings, ...(resume ? { sessionId: f.root.sessionId } : {}), mode: 'text', initialMessage: 'configured', config: { extensionConfig: { codex: { fast: true } } } });
    expect(result, f.errors.join('\n')).toBe(0);
    const id = resume ? f.root.sessionId : f.registry.list().find(row => row.id !== f.root.sessionId)!.id;
    expect(f.store.session(id).profile?.extensionConfigOverrides).toEqual(expect.arrayContaining([
      expect.objectContaining({ extensionId: 'codex', values: { fast: true } }),
    ]));
    expect(f.errors).toEqual([]);
    if (resume) expect(openings).toHaveBeenCalledOnce();
  });

  it('finishes session configuration before attaching the native JSON stream', async () => {
    const definition = defineExtensionConfig({ id: 'codex', title: 'Fixture', fields: { fast: configField.boolean({ default: false, description: 'Fixture' }) } });
    const f = await fixture({ configDefinitions: [definition] });
    const result = await runLocalFelanHeadless({ ...f.settings, sessionId: f.root.sessionId, mode: 'json', initialMessage: 'configured', config: { extensionConfig: { codex: { fast: true } } } });
    expect(result, f.errors.join('\n')).toBe(0);
    const records = f.output.map(line => JSON.parse(line));
    expect(records.filter(record => record.type === 'session')).toHaveLength(1);
    expect(records.find(record => record.type === 'agent_end')).toBeDefined();
  });

  it('rejects missing models and incompatible in-process runtime injection without reading client credentials', async () => {
    const f = await fixture();
    expect(await runLocalFelanHeadless({ ...f.settings, sessionId: f.root.sessionId, mode: 'text', initialMessage: 'hello', model: 'missing' })).toBe(1);
    expect(f.errors).toContain('Model "missing" not found');
    f.errors.length = 0;
    const injected = { ...f.settings, mode: 'text' as const, initialMessage: 'hello', sessionManager: {} };
    expect(await runLocalFelanHeadless(injected)).toBe(1);
    expect(f.errors[0]).toContain('in-process runtime option');
  });

  it('does not fall back to a new session when an explicit session ID is missing', async () => {
    const f = await fixture();
    expect(await runLocalFelanHeadless({ ...f.settings, mode: 'text', initialMessage: 'hello', sessionId: 'missing' })).toBe(1);
    expect(f.errors).toHaveLength(1);
    expect(f.output).toEqual([]);
  });

  it('resolves session dialogs during its run with cancelled defaults, like a client without UI', async () => {
    const stream = gate();
    const f = await fixture({ onStream: () => stream.promise });
    cleanups.push(async () => stream.resolve());
    const run = runLocalFelanHeadless({ ...f.settings, mode: 'text', initialMessage: 'hello', sessionId: f.root.sessionId });
    await vi.waitFor(() => expect(f.store.session(f.root.sessionId).run.state).toBe('running'));
    const session = { kind: 'session' as const, session: f.root.sessionId, root: f.root.sessionId };
    await expect(f.broker.request({ kind: 'confirm', title: 'Proceed?', message: 'Fixture' }, session)).resolves.toEqual({ state: 'cancelled', reason: 'user' });
    await expect(f.broker.request({ kind: 'tool_approval', toolCallId: 'call', toolName: 'bash', summary: 'bash',
      options: [{ id: 'allow-once', title: 'Allow once' }] }, session)).resolves.toEqual({ state: 'cancelled', reason: 'user' });
    stream.resolve();
    expect(await run, f.errors.join('\n')).toBe(0);
  });

  it('rejects concurrent prompts rather than creating a second writer', async () => {
    const stream = gate();
    const f = await fixture({ onStream: () => stream.promise });
    cleanups.push(async () => stream.resolve());
    const first = runLocalFelanHeadless({ ...f.settings, mode: 'text', initialMessage: 'one', sessionId: f.root.sessionId });
    await vi.waitFor(() => expect(f.store.session(f.root.sessionId).run.state).toBe('running'));
    expect(await runLocalFelanHeadless({ ...f.settings, mode: 'text', initialMessage: 'two', sessionId: f.root.sessionId })).toBe(1);
    expect(f.store.session(f.root.sessionId).run.state).toBe('running');
    stream.resolve();
    expect(await first).toBe(0);
    expect(f.output).toEqual(['done\n']);
  });

  it('explicit SIGTERM cancels its admitted run and detaches without stopping the daemon', async () => {
    const stream = gate();
    const f = await fixture({ onStream: () => stream.promise });
    cleanups.push(async () => stream.resolve());
    const running = runLocalFelanHeadless({ ...f.settings, sessionId: f.root.sessionId, mode: 'text', initialMessage: 'cancel me' });
    await vi.waitFor(() => expect(f.store.session(f.root.sessionId).run.state).toBe('running'));
    f.settings.signalSource.emit('SIGTERM');
    stream.resolve();
    expect(await running).toBe(143);
    expect(f.store.session(f.root.sessionId).state).toBe('open');
    expect(f.settings.signalSource.listenerCount('SIGTERM')).toBe(0);
  });

  it('continues the latest adopted session through daemon inventory', async () => {
    const f = await fixture();
    expect(await runLocalFelanHeadless({ ...f.settings, mode: 'text', initialMessage: 'continue', continueRecent: true })).toBe(0);
    const runtime = f.registry.binding(f.root.sessionId)!.runtime;
    expect(JSON.stringify(runtime.session.messages)).toContain('continue');
  });

  it('preserves case-insensitive provider aliases, model labels, date preference and thinking suffixes', () => {
    const models = [
      { provider: 'anthropic', id: 'claude-sonnet-20250101', label: 'Claude Sonnet', thinking: ['off', 'high'] as const },
      { provider: 'anthropic', id: 'claude-sonnet-latest', label: 'Claude Sonnet', thinking: ['off', 'high'] as const },
      { provider: 'other', id: 'anthropic/alternate', label: 'Alternate', thinking: ['off'] as const },
    ].map(model => ({ ...model, thinking: [...model.thinking] }));
    expect(resolveHeadlessModel({ provider: 'ANTHROPIC', model: 'Sonnet:high' }, models)).toMatchObject({ model: { id: 'claude-sonnet-latest' }, thinking: 'high' });
    expect(resolveHeadlessModel({ model: 'ANTHROPIC/CLAUDE-SONNET-LATEST' }, models).model.id).toBe('claude-sonnet-latest');
    expect(resolveHeadlessModel({ model: 'Alternate' }, models).model.id).toBe('anthropic/alternate');
    expect(() => resolveHeadlessModel({ model: 'sonnet:invalid-thinking' }, models)).toThrow('not found');
    expect(() => resolveHeadlessModel({ model: 'shared' }, [...models,
      { provider: 'one', id: 'shared', label: 'Shared', thinking: [] },
      { provider: 'two', id: 'shared', label: 'Shared', thinking: [] }])).toThrow('ambiguous');
  });

  it('writes native JSON data unchanged, in order, and waits for a slow sink', async () => {
    const lines: string[] = [];
    const completions: Array<(error?: Error | null) => void> = [];
    const onError = vi.fn();
    const writer = new HeadlessJsonWriter((line, done) => { lines.push(line); completions.push(done); }, onError);
    writer.enqueue({ type: 'session', version: 3, id: 'session', timestamp: '2026-01-01T00:00:00Z' });
    writer.enqueue({ type: 'message_update', usage: { output: 1 }, assistantMessageEvent: { type: 'text_delta', contentIndex: 3, delta: 'hello' } });
    const flushed = writer.flush();
    expect(lines).toHaveLength(1);
    completions[0]!();
    await Promise.resolve();
    expect(lines).toHaveLength(2);
    completions[1]!();
    await flushed;
    expect(lines.map(line => JSON.parse(line))).toEqual([
      { type: 'session', version: 3, id: 'session', timestamp: '2026-01-01T00:00:00Z' },
      { type: 'message_update', usage: { output: 1 }, assistantMessageEvent: { type: 'text_delta', contentIndex: 3, delta: 'hello' } },
    ]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('queues native output for a slow consumer without dropping lines', async () => {
    const onError = vi.fn(); const lines: string[] = [];
    const writer = new HeadlessJsonWriter((line, done) => { lines.push(line); setImmediate(done); }, onError);
    for (let index = 0; index < 5000; index++) writer.enqueue({ index });
    await writer.flush();
    expect(lines).toHaveLength(5000); expect(onError).not.toHaveBeenCalled();
  });

  it('fails native JSON explicitly on a sequence gap without cancelling its admitted run', async () => {
    const stream = gate();
    const f = await fixture({ onStream: () => stream.promise });
    cleanups.push(async () => stream.resolve());
    let listener: ((event: PresentationEvent) => void) | undefined;
    const createClient: typeof f.createClient = options => {
      const client = f.createClient(options);
      if (options.capabilities?.includes('native.events')) {
        const subscribe = client.subscribePresentation.bind(client);
        vi.spyOn(client, 'subscribePresentation').mockImplementation(callback => { listener = callback; return subscribe(callback); });
      }
      return client;
    };
    const running = runLocalFelanHeadless({ ...f.settings, createClient, mode: 'json', initialMessage: 'keep running', sessionId: f.root.sessionId });
    await vi.waitFor(() => expect(f.store.session(f.root.sessionId).run.state).toBe('running'));
    listener!({ v: 1, session: f.root.sessionId, presentationEvent: { sequence: 999, data: {} } });
    expect(await running).toBe(1);
    expect(f.errors.join('\n')).toContain('sequence was interrupted');
    expect(f.store.session(f.root.sessionId).run.state).toBe('running');
    stream.resolve();
  });

  it('keeps a text run through a daemon restart within its bounded reconnect window', async () => {
    const stream = gate();
    const f = await fixture({ onStream: () => stream.promise });
    cleanups.push(async () => stream.resolve());
    const statuses: string[] = []; const limits: Array<number | undefined> = [];
    const createClient: typeof f.createClient = options => {
      limits.push(options.reconnectAttempts);
      const client = f.createClient({ ...options, reconnectDelayMs: 20 });
      client.subscribe(() => statuses.push(client.status));
      return client;
    };
    const running = runLocalFelanHeadless({ ...f.settings, createClient, mode: 'text', initialMessage: 'hello', sessionId: f.root.sessionId });
    await vi.waitFor(() => expect(f.store.session(f.root.sessionId).run.state).toBe('running'));
    f.server.close();
    await vi.waitFor(() => expect(f.clients.at(-1)!.reconnection?.attempt).toBeGreaterThanOrEqual(3));
    await f.restartServer();
    await vi.waitFor(() => expect(f.clients.at(-1)!.status).toBe('ready'));
    stream.resolve();
    expect(await running).toBe(0);
    expect(f.output).toEqual(['done\n']); expect(f.errors).toEqual([]);
    expect(limits).toEqual([8]); expect(statuses).toContain('disconnected'); expect(statuses).not.toContain('blocked');
  });

  it('fails native JSON explicitly on disconnect without cancelling its admitted run', async () => {
    const stream = gate();
    const f = await fixture({ onStream: () => stream.promise });
    cleanups.push(async () => stream.resolve());
    const running = runLocalFelanHeadless({ ...f.settings, mode: 'json', initialMessage: 'keep running', sessionId: f.root.sessionId });
    await vi.waitFor(() => expect(f.store.session(f.root.sessionId).run.state).toBe('running'));
    f.clients.at(-1)!.close();
    expect(await running).toBe(1);
    expect(f.errors.join('\n')).toContain('Client detached; execution may still be running');
    expect(f.store.session(f.root.sessionId).run.state).toBe('running');
    stream.resolve();
  });
});
