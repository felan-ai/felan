import { describe, expect, it, vi } from 'vitest';
import type { AgentSession, AgentToolResult } from '@earendil-works/pi-coding-agent';
import { SessionToolInvoker } from '../src/tool-invocation.js';

describe('SessionToolInvoker', () => {
  it('validates, invokes, and preserves the tool result', async () => {
    const execute = vi.fn(async (_id, params) => result(String(params.value)));
    const session = fakeSession({
      name: 'echo',
      parameters: objectSchema({ value: { type: 'string' } }, ['value']),
      execute,
    });
    const invoker = new SessionToolInvoker();
    invoker.bind(session);

    await expect(invoker.invoke('echo', { value: 'ok' })).resolves.toMatchObject({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    });
    await expect(invoker.invoke('echo', {})).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text' }],
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects inactive tools and forwards updates and hook patches', async () => {
    const execute = vi.fn(async (_id, _params, _signal, onUpdate) => {
      onUpdate?.(result('partial'));
      return result('original');
    });
    const beforeToolCall = vi.fn(async () => undefined);
    const afterToolCall = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'patched' }],
      details: { patched: true },
    }));
    const session = fakeSession({
      name: 'echo',
      parameters: objectSchema({}, []),
      execute,
    }, { beforeToolCall, afterToolCall });
    const invoker = new SessionToolInvoker();
    invoker.bind(session);
    const updates: string[] = [];

    await expect(invoker.invoke('echo', {}, {
      onUpdate: (update) => updates.push(update.content[0]?.type === 'text' ? update.content[0].text : ''),
    })).resolves.toMatchObject({
      content: [{ type: 'text', text: 'patched' }],
      details: { patched: true },
    });
    await expect(invoker.invoke('missing', {})).resolves.toMatchObject({ isError: true });
    expect(updates).toEqual(['partial']);
    expect(beforeToolCall).toHaveBeenCalledOnce();
    expect(afterToolCall).toHaveBeenCalledOnce();
  });

  it('blocks calls and serializes sequential tools', async () => {
    const order: string[] = [];
    let release!: () => void;
    const execute = vi.fn(async (_id, params) => {
      order.push(`start:${params.value}`);
      if (params.value === 'one') await new Promise<void>((resolve) => { release = resolve; });
      order.push(`end:${params.value}`);
      return result(params.value);
    });
    const session = fakeSession({
      name: 'echo',
      parameters: objectSchema({ value: { type: 'string' } }, ['value']),
      executionMode: 'sequential',
      execute,
    });
    const invoker = new SessionToolInvoker();
    invoker.bind(session);
    const first = invoker.invoke('echo', { value: 'one' });
    await vi.waitFor(() => expect(order).toEqual(['start:one']));
    const second = invoker.invoke('echo', { value: 'two' });
    await Promise.resolve();
    expect(order).toEqual(['start:one']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['start:one', 'end:one', 'start:two', 'end:two']);
  });

  it('returns promptly when a queued sequential invocation is aborted', async () => {
    let release!: () => void;
    const execute = vi.fn(async (_id, params) => {
      if (params.value === 'one') await new Promise<void>((resolve) => { release = resolve; });
      return result(params.value);
    });
    const session = fakeSession({
      name: 'echo',
      parameters: objectSchema({ value: { type: 'string' } }, ['value']),
      executionMode: 'sequential',
      execute,
    });
    const invoker = new SessionToolInvoker();
    invoker.bind(session);
    const first = invoker.invoke('echo', { value: 'one' });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const second = invoker.invoke('echo', { value: 'two' }, { signal: controller.signal });

    controller.abort();

    await expect(second).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Operation aborted' }],
    });
    expect(execute).toHaveBeenCalledOnce();
    release();
    await first;
  });

  it('keeps an aborted queue slot behind prior sequential work', async () => {
    const order: string[] = [];
    let release!: () => void;
    const execute = vi.fn(async (_id, params) => {
      order.push(`start:${params.value}`);
      if (params.value === 'one') await new Promise<void>((resolve) => { release = resolve; });
      order.push(`end:${params.value}`);
      return result(params.value);
    });
    const session = fakeSession({
      name: 'echo',
      parameters: objectSchema({ value: { type: 'string' } }, ['value']),
      executionMode: 'sequential',
      execute,
    });
    const invoker = new SessionToolInvoker();
    invoker.bind(session);
    const first = invoker.invoke('echo', { value: 'one' });
    await vi.waitFor(() => expect(order).toEqual(['start:one']));
    const controller = new AbortController();
    const second = invoker.invoke('echo', { value: 'two' }, { signal: controller.signal });
    controller.abort();
    await second;

    const third = invoker.invoke('echo', { value: 'three' });
    await Promise.resolve();
    expect(order).toEqual(['start:one']);
    release();
    await Promise.all([first, third]);
    expect(order).toEqual(['start:one', 'end:one', 'start:three', 'end:three']);
  });

  it('propagates abort to the tool and fails when unbound', async () => {
    const prepareArguments = vi.fn((input) => input);
    const execute = vi.fn(async (_id, _params, signal) => {
      signal?.throwIfAborted();
      return result('done');
    });
    const beforeToolCall = vi.fn(async () => undefined);
    const session = fakeSession({
      name: 'echo',
      parameters: objectSchema({}, []),
      prepareArguments,
      execute,
    }, { beforeToolCall });
    const invoker = new SessionToolInvoker();
    await expect(invoker.invoke('echo', {})).rejects.toThrow('session composition');
    invoker.bind(session);
    const controller = new AbortController();
    controller.abort();
    await expect(invoker.invoke('echo', {}, { signal: controller.signal })).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Operation aborted' }],
    });
    expect(prepareArguments).not.toHaveBeenCalled();
    expect(beforeToolCall).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

function result(text: string): AgentToolResult<unknown> {
  return { content: [{ type: 'text', text }], details: undefined };
}

function fakeSession(
  tool: Record<string, unknown>,
  hooks: Record<string, unknown> = {},
): AgentSession {
  return {
    agent: {
      state: {
        systemPrompt: 'test',
        messages: [{ role: 'assistant' }],
        tools: [{ label: tool.name, description: tool.name, ...tool }],
      },
      ...hooks,
    },
  } as unknown as AgentSession;
}

function objectSchema(
  properties: Record<string, Record<string, string>>,
  required: string[],
): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}
