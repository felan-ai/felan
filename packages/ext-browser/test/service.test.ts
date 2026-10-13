import {
  createExtensionServiceAccess,
  createFelanServiceRegistry,
  getExtensionConfigDefinition,
  type ExtensionContext,
  type FelanExtensionAPI,
  type ToolDefinition,
} from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import extension, { BROWSER_CONFIG, createBrowserExtension } from '../src/extension.js';
import {
  BROWSER_AUTHORIZATION_SERVICE,
  type BrowserAuthorizationService,
  type BrowserAuthorizationServiceRequest,
} from '../src/service.js';
import { BrowserTestRuntime, result } from './test-runtime.js';

describe('browser service-backed package entry', () => {
  it('declares optional authorization and preserves config and factory exports', () => {
    expect(BROWSER_AUTHORIZATION_SERVICE).toMatchObject({
      id: 'felan.browser.authorization', major: 1, key: 'felan.browser.authorization@1',
    });
    expect(extension.serviceRequirements.optional).toEqual([BROWSER_AUTHORIZATION_SERVICE]);
    expect(getExtensionConfigDefinition(extension)).toBe(BROWSER_CONFIG);
    expect(typeof createBrowserExtension).toBe('function');
  });

  it('keeps isolated browsing and skills without authorization or startup I/O', async () => {
    const harness = createHarness();
    extension(harness.pi);
    expect(harness.runtime.calls).toEqual([]);
    expect([...harness.tools.keys()]).toEqual(['browser']);
    await harness.execute('browser', { operation: 'skill', skill: 'core' });
    await harness.execute('browser', { operation: 'run', args: ['open', 'https://example.com'] });
    const opened = harness.runtime.calls.find(call => call.args[0] === 'open');
    expect(opened?.args).toContain('--session');
    expect(opened?.args).toContain('--namespace');
    expect(opened?.args).not.toContain('--cdp');
    await harness.emit('session_shutdown');
    expect(harness.runtime.calls.some(call => call.args[0] === 'close')).toBe(true);
  });

  it.each([undefined, 'ask', 'always-allow'] as const)('passes config policy %s to the configured authorization service', async policy => {
    const authorize = vi.fn(async (_request: BrowserAuthorizationServiceRequest) => ({ status: 'cancelled' as const }));
    const harness = createHarness({ authorize }, policy);
    extension(harness.pi);
    expect(harness.runtime.calls).toEqual([]);
    expect(authorize).not.toHaveBeenCalled();
    await harness.execute('browser_authorize', {
      operation: 'authorize', origin: 'https://example.com/private', reason: 'Read the authenticated page.',
    });
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      origin: 'https://example.com', reason: 'Read the authenticated page.',
      authorizationPolicy: policy ?? 'ask', extensionContext: harness.context,
    }));
    expect(harness.runtime.calls).toEqual([]);
    await harness.emit('session_shutdown');
  });

  it('fails closed on an invalid policy before registering behavior', () => {
    const authorize = vi.fn(async () => ({ status: 'cancelled' as const }));
    const harness = createHarness({ authorize }, 'invalid');
    expect(() => extension(harness.pi)).toThrow('Invalid browser authorization policy.');
    expect(harness.tools.size).toBe(0);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('preserves the configured execution guard and its receiver', async () => {
    const service: BrowserAuthorizationService = {
      checkExecution() { expect(this).toBe(service); throw new Error('Browser execution denied'); },
      authorize: async () => ({ status: 'cancelled' }),
    };
    const harness = createHarness(service);
    extension(harness.pi);
    await expect(harness.execute('browser', { operation: 'run', args: ['open', 'https://example.com'] }))
      .rejects.toThrow('Browser execution denied');
    expect(harness.runtime.calls).toEqual([]);
  });

  it.each(['caller', 'shutdown'] as const)('propagates %s cancellation to authorization', async cancellation => {
    const entered = deferred<BrowserAuthorizationServiceRequest>();
    const authorize = vi.fn(async (request: BrowserAuthorizationServiceRequest) => {
      entered.resolve(request);
      await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { status: 'cancelled' as const };
    });
    const harness = createHarness({ authorize });
    extension(harness.pi);
    const controller = new AbortController();
    const pending = harness.execute('browser_authorize', {
      operation: 'authorize', origin: 'https://example.com', reason: 'Read the authenticated page.',
    }, controller.signal);
    const request = await entered.promise;
    if (cancellation === 'caller') controller.abort();
    else await harness.emit('session_shutdown');
    expect(await pending).toMatchObject({ details: { state: 'cancelled' } });
    expect(request.signal.aborted).toBe(true);
    expect(harness.runtime.calls).toEqual([]);
    if (cancellation === 'caller') await harness.emit('session_shutdown');
  });
});

function createHarness(service?: BrowserAuthorizationService, policy?: string) {
  const registry = createFelanServiceRegistry();
  if (service) registry.set(BROWSER_AUTHORIZATION_SERVICE, service);
  const runtime = new BrowserTestRuntime(async (_command, args) => args[0] === '--version'
    ? result('agent-browser 0.37.1')
    : args[0] === 'skills' ? result('# core skill') : result('{"success":true}'));
  const tools = new Map<string, ToolDefinition<any, any, any>>();
  const handlers = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();
  const extensionContext = { sessionManager: { getSessionId: () => 'service-session' } } as unknown as ExtensionContext;
  const context = {
    ...extensionContext,
    tools: [],
    executeTool: vi.fn(async () => { throw new Error('Unexpected nested tool execution'); }),
  } satisfies Parameters<ToolDefinition['execute']>[4];
  const pi = {
    runtime,
    config: policy === undefined ? {} : { authorizationPolicy: policy },
    services: createExtensionServiceAccess(registry, extension.serviceRequirements),
    registerCapability: vi.fn(),
    registerTool: (tool: ToolDefinition<any, any, any>) => tools.set(tool.name, tool),
    on: (event: string, handler: (event: unknown, context: ExtensionContext) => unknown) => handlers.set(event, handler),
  } as unknown as FelanExtensionAPI;
  return {
    pi, tools, runtime, context,
    emit: async (event: string) => { await handlers.get(event)?.({}, context); },
    execute: (name: string, params: Record<string, unknown>, signal?: AbortSignal) => tools.get(name)!.execute('test', params, signal, undefined, context),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
