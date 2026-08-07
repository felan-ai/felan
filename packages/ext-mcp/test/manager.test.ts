import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import type { McpOAuthSession, ResolvedMcpServer } from '../src/contracts.js';
import {
  McpAuthenticationRequiredError,
  McpManager,
  type McpConnection,
  type McpConnectionFactory,
} from '../src/manager.js';

const server: ResolvedMcpServer = {
  name: 'docs',
  url: 'https://mcp.example.test/mcp',
  auth: 'oauth',
  transport: 'auto',
};

describe('MCP manager', () => {
  it('single-flights connections, paginates tools, calls listed tools, and closes', async () => {
    const close = vi.fn(async () => {});
    const callTool = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    const listTools = vi.fn(async (params?: { cursor?: string }) => params?.cursor
      ? { tools: [{ name: 'second', inputSchema: { type: 'object' as const } }] }
      : {
        tools: [{ name: 'first', description: 'First', inputSchema: { type: 'object' as const } }],
        nextCursor: 'page-2',
      });
    const factory = vi.fn<McpConnectionFactory>(async () => connection({ close, callTool, listTools }));
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const manager = new McpManager(
      [server],
      oauthSession(),
      new AbortController().signal,
      factory,
      fetchFn,
    );

    const [first, second] = await Promise.all([
      manager.listTools('docs'),
      manager.listTools('docs'),
    ]);
    expect(first.map((tool) => tool.name)).toEqual(['first', 'second']);
    expect(second).toEqual(first);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0]?.[3]).toBe(fetchFn);
    expect(listTools).toHaveBeenCalledTimes(2);

    await expect(manager.callTool('docs', 'first', { query: 'x' })).resolves.toMatchObject({
      content: [{ type: 'text', text: 'ok' }],
    });
    expect(callTool).toHaveBeenCalledWith(
      { name: 'first', arguments: { query: 'x' } },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await expect(manager.callTool('docs', 'missing', {})).rejects.toThrow('Unknown tool');

    await manager.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('maps SDK authorization failures to a credential-free needs-auth state', async () => {
    const factory: McpConnectionFactory = async () => {
      throw new UnauthorizedError('sensitive provider response');
    };
    const manager = new McpManager([server], oauthSession(), new AbortController().signal, factory);

    await expect(manager.listTools('docs')).rejects.toBeInstanceOf(McpAuthenticationRequiredError);
    expect(manager.statuses()).toEqual([{ server: 'docs', status: 'needs-auth', toolCount: 0 }]);
  });

  it('fences and closes a connection that completes after shutdown begins', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = vi.fn(async () => {});
    const factory: McpConnectionFactory = async () => {
      await gate;
      return connection({
        close,
        callTool: vi.fn(),
        listTools: vi.fn(async () => ({ tools: [] })),
      });
    };
    const manager = new McpManager([server], oauthSession(), new AbortController().signal, factory);
    const listing = manager.listTools('docs');
    const closing = manager.close();
    release();

    await closing;
    await expect(listing).rejects.toThrow();
    expect(close).toHaveBeenCalledOnce();
  });
});

function oauthSession(): McpOAuthSession {
  return {
    providerFor: async () => ({} as OAuthClientProvider),
    authenticate: async () => ({ status: 'authenticated' }),
    logout: async () => {},
    close: async () => {},
  };
}

function connection(client: McpConnection['client']): McpConnection {
  return {
    client,
    transport: { start: async () => {}, send: async () => {}, close: async () => {} },
    transportKind: 'streamable-http',
  };
}
