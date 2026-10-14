import {
  createExtensionServiceAccess,
  createFelanServiceRegistry,
  SECRETS_SERVICE,
  type ExtensionContext,
  type FelanExtensionAPI,
  type ToolDefinition,
} from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import {
  createMcpExtension,
  type CreateMcpExtensionOptions,
  type McpOAuthAuthenticationContext,
  type McpOAuthSession,
  type McpOAuthSessionContext,
  type ResolvedMcpServer,
} from '../src/extension.js';

describe('MCP explicitly composed lifecycle', () => {
  it('uses only the explicit server snapshot and OAuth session', async () => {
    const oauth = createOAuthSession();
    const createSession = vi.fn(async (_context: McpOAuthSessionContext) => oauth);
    const harness = createHarness({
      config: { mcpServers: { docs: { url: 'https://mcp.example.test/mcp', auth: 'oauth' } } },
      oauthHost: { createSession },
    });
    harness.load();
    expect(createSession).not.toHaveBeenCalled();
    await harness.emit('session_start');
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'service-session', signal: expect.any(AbortSignal),
    }));
    expect(await harness.execute({ action: 'status' })).toMatchObject({
      content: [{ text: expect.stringContaining('"server": "docs"') }],
    });
    await harness.execute({ action: 'authenticate', server: 'docs' });
    expect(oauth.authenticate).toHaveBeenCalledWith(expect.objectContaining({ name: 'docs' }), expect.objectContaining({
      reason: 'explicit', extensionContext: harness.context,
    }));
    await harness.emit('session_shutdown');
    await harness.emit('session_shutdown');
    expect(createSession.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(oauth.close).toHaveBeenCalledOnce();
  });

  it.each(['caller', 'shutdown'] as const)('propagates %s cancellation to configured OAuth work', async cancellation => {
    const entered = deferred<AbortSignal>();
    const oauth = createOAuthSession();
    oauth.authenticate = vi.fn(async (_server: ResolvedMcpServer, context: McpOAuthAuthenticationContext) => {
      entered.resolve(context.signal);
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('OAuth work aborted')), { once: true });
      });
      return { status: 'cancelled' as const, message: 'Cancelled.' };
    });
    const harness = createHarness({
      config: { mcpServers: { docs: { url: 'https://mcp.example.test/mcp', auth: 'oauth' } } },
      oauthHost: { createSession: async () => oauth },
    });
    harness.load();
    await harness.emit('session_start');
    const controller = new AbortController();
    const pending = harness.execute({ action: 'authenticate', server: 'docs' }, controller.signal);
    const signal = await entered.promise;
    if (cancellation === 'caller') {
      const rejected = expect(pending).rejects.toThrow('OAuth work aborted');
      controller.abort();
      await rejected;
      await harness.emit('session_shutdown');
    } else {
      await harness.emit('session_shutdown');
      expect(await pending).toMatchObject({ isError: true });
    }
    expect(signal.aborted).toBe(true);
    expect(oauth.close).toHaveBeenCalledOnce();
  });

  it('aborts pending startup before waiting and disposes a late session exactly once', async () => {
    const entered = deferred<McpOAuthSessionContext>();
    const initializing = deferred<McpOAuthSession>();
    const closing = deferred<void>();
    const closeEntered = deferred<void>();
    const operations: string[] = [];
    const oauth = createOAuthSession();
    oauth.close = vi.fn(async () => {
      operations.push('close');
      closeEntered.resolve();
      await closing.promise;
    });
    const harness = createHarness({
      config: { mcpServers: { docs: { url: 'https://mcp.example.test/mcp', auth: 'oauth' } } },
      oauthHost: {
        createSession: context => {
          context.signal.addEventListener('abort', () => operations.push('abort'), { once: true });
          entered.resolve(context);
          return initializing.promise;
        },
      },
    });
    harness.load();
    const started = harness.emit('session_start');
    const context = await entered.promise;
    let stopped = false;
    const shutdown = harness.emit('session_shutdown').then(() => { stopped = true; });
    const repeatedShutdown = harness.emit('session_shutdown');
    expect(context.signal.aborted).toBe(true);
    expect(operations).toEqual(['abort']);
    expect(stopped).toBe(false);

    initializing.resolve(oauth);
    await closeEntered.promise;
    expect(operations).toEqual(['abort', 'close']);
    expect(stopped).toBe(false);
    closing.resolve();
    await Promise.all([started, shutdown, repeatedShutdown]);
    await harness.emit('session_shutdown');
    expect(oauth.close).toHaveBeenCalledOnce();
    expect(oauth.providerFor).not.toHaveBeenCalled();
    expect(await harness.execute({ action: 'status' })).toMatchObject({ isError: true });
  });

  it.each(['on abort', 'after abort'] as const)('settles shutdown when pending initialization rejects %s', async timing => {
    const entered = deferred<McpOAuthSessionContext>();
    const initializing = deferred<McpOAuthSession>();
    const failure = new Error('OAuth initialization failed');
    const oauth = createOAuthSession();
    const createSession = vi.fn((context: McpOAuthSessionContext): Promise<McpOAuthSession> => {
      if (createSession.mock.calls.length > 1) return Promise.resolve(oauth);
      if (timing === 'on abort') {
        context.signal.addEventListener('abort', () => initializing.reject(failure), { once: true });
      }
      entered.resolve(context);
      return initializing.promise;
    });
    const harness = createHarness({
      config: { mcpServers: { docs: { url: 'https://mcp.example.test/mcp', auth: 'oauth' } } },
      oauthHost: { createSession },
    });
    harness.load();
    const failedStart = expect(harness.emit('session_start')).rejects.toBe(failure);
    const context = await entered.promise;
    const shutdown = harness.emit('session_shutdown');
    expect(context.signal.aborted).toBe(true);
    if (timing === 'after abort') initializing.reject(failure);
    await failedStart;
    await shutdown;
    await harness.emit('session_shutdown');
    expect(oauth.close).not.toHaveBeenCalled();

    await harness.emit('session_start');
    expect(await harness.execute({ action: 'status' })).not.toMatchObject({ isError: true });
    await harness.emit('session_shutdown');
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(oauth.close).toHaveBeenCalledOnce();
  });

  it('drains superseded startup when shutdown cancels its queued replacement', async () => {
    const entered = deferred<McpOAuthSessionContext>();
    const initializing = deferred<McpOAuthSession>();
    const oauth = createOAuthSession();
    const createSession = vi.fn((context: McpOAuthSessionContext): Promise<McpOAuthSession> => {
      entered.resolve(context);
      return initializing.promise;
    });
    const harness = createHarness({
      config: { mcpServers: { docs: { url: 'https://mcp.example.test/mcp', auth: 'oauth' } } },
      oauthHost: { createSession },
    });
    harness.load();
    const started = harness.emit('session_start');
    const context = await entered.promise;
    const replacement = harness.emit('session_start');
    expect(context.signal.aborted).toBe(true);
    expect(createSession).toHaveBeenCalledOnce();
    let stopped = false;
    const shutdown = harness.emit('session_shutdown').then(() => { stopped = true; });
    expect(stopped).toBe(false);
    initializing.resolve(oauth);
    await Promise.all([started, replacement, shutdown]);
    expect(createSession).toHaveBeenCalledOnce();
    expect(oauth.close).toHaveBeenCalledOnce();
    expect(await harness.execute({ action: 'status' })).toMatchObject({ isError: true });
  });

  it('disposes superseded startup before activating its replacement', async () => {
    const entered = deferred<McpOAuthSessionContext>();
    const initializing = deferred<McpOAuthSession>();
    const closing = deferred<void>();
    const closeEntered = deferred<void>();
    const oldSession = createOAuthSession();
    const nextSession = createOAuthSession();
    oldSession.close = vi.fn(async () => {
      closeEntered.resolve();
      await closing.promise;
    });
    const createSession = vi.fn((context: McpOAuthSessionContext): Promise<McpOAuthSession> => {
      if (createSession.mock.calls.length > 1) return Promise.resolve(nextSession);
      entered.resolve(context);
      return initializing.promise;
    });
    const harness = createHarness({
      config: { mcpServers: { docs: { url: 'https://mcp.example.test/mcp', auth: 'oauth' } } },
      oauthHost: { createSession },
    });
    harness.load();
    const started = harness.emit('session_start');
    const context = await entered.promise;
    const replacement = harness.emit('session_start');
    expect(context.signal.aborted).toBe(true);
    initializing.resolve(oldSession);
    await closeEntered.promise;
    expect(createSession).toHaveBeenCalledOnce();
    closing.resolve();
    await Promise.all([started, replacement]);
    await harness.execute({ action: 'authenticate', server: 'docs' });
    expect(oldSession.authenticate).not.toHaveBeenCalled();
    expect(nextSession.authenticate).toHaveBeenCalledOnce();
    await harness.emit('session_shutdown');
    expect(oldSession.close).toHaveBeenCalledOnce();
    expect(nextSession.close).toHaveBeenCalledOnce();
  });
});

function createOAuthSession(): McpOAuthSession {
  return {
    providerFor: vi.fn(async () => { throw new Error('Unexpected remote connection'); }),
    authenticate: vi.fn(async () => ({ status: 'unavailable' as const, message: 'Complete authorization in the host.' })),
    logout: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

function createHarness(service: CreateMcpExtensionOptions) {
  const registry = createFelanServiceRegistry();
  registry.set(SECRETS_SERVICE, {
    read: async () => undefined,
    write: async () => { throw new Error('Unexpected credential write'); },
    remove: async () => { throw new Error('Unexpected credential removal'); },
  });
  const tools = new Map<string, ToolDefinition<any, any, any>>();
  const handlers = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();
  const extensionContext = { sessionManager: { getSessionId: () => 'service-session' } } as unknown as ExtensionContext;
  const context = {
    ...extensionContext,
    tools: [],
    executeTool: vi.fn(async () => { throw new Error('Unexpected nested tool execution'); }),
  } satisfies Parameters<ToolDefinition['execute']>[4];
  const pi = {
    services: createExtensionServiceAccess(registry, {}),
    registerCapability: vi.fn(),
    registerTool: (tool: ToolDefinition<any, any, any>) => tools.set(tool.name, tool),
    registerCommand: vi.fn(),
    on: (event: string, handler: (event: unknown, context: ExtensionContext) => unknown) => handlers.set(event, handler),
  } as unknown as FelanExtensionAPI;
  return {
    pi, tools, handlers, context,
    load: () => createMcpExtension(service)(pi),
    emit: async (event: string) => { await handlers.get(event)?.({}, context); },
    execute: (params: Record<string, unknown>, signal?: AbortSignal) => tools.get('mcp')!.execute('test', params, signal, undefined, context),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
