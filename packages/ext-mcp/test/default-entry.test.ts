import {
  createExtensionServiceAccess, createFelanServiceRegistry, SECRETS_SERVICE,
  type AgentRuntime, type ExtensionContext, type ExtensionUi, type FelanExtensionAPI, type ToolDefinition,
} from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import extension from '../src/extension.js';
import { createAuthorizationPresenter } from '../src/authorization.js';
import { MCP_OAUTH_CALLBACK_SERVICE } from '../src/service.js';

describe('MCP core-service entry', () => {
  it('requires only Secrets and makes the loopback service optional', () => {
    expect(extension.serviceRequirements).toEqual({ required: [SECRETS_SERVICE], optional: [MCP_OAUTH_CALLBACK_SERVICE] });
  });

  it('rejects missing Secrets before reading configuration or registering behavior', async () => {
    const harness = createHarness(false);
    await expect(extension(harness.pi)).rejects.toThrow('Required service felan.secrets@1 has no configured provider.');
    expect(harness.readFile).not.toHaveBeenCalled();
    expect(harness.tools.size).toBe(0);
  });

  it('loads global and project servers through Runtime without a loopback service', async () => {
    const harness = createHarness();
    await extension(harness.pi);
    expect(harness.readFile).toHaveBeenCalledWith('.mcp.json', { maxBytes: 256 * 1024 });
    await harness.emit('session_start');
    const result = await harness.execute({ action: 'status' });
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('"server": "docs"') }]);
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('"server": "project"') }]);
    const auth = await harness.execute({ action: 'authenticate', server: 'docs' });
    expect(JSON.stringify(auth)).toContain('requires a configured host authorization console');
    await harness.emit('session_shutdown');
  });
});

describe('MCP host authorization form', () => {
  it('shows the authorization URL only in a host-audience, nondeferrable form', async () => {
    const request = vi.fn<ExtensionUi['request']>(async () => ({ state: 'cancelled', reason: 'user' }));
    const signal = new AbortController().signal;
    await createAuthorizationPresenter({ request } as unknown as ExtensionUi)({
      server: 'docs', url: 'https://auth.example.test/authorize?state=fixture', signal,
    });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining('Open the authorization page in a browser on this machine'),
      markdown: '[Open the authorization page](https://auth.example.test/authorize?state=fixture)',
      input: { fields: [] },
      actions: [{ id: 'cancel', label: 'Cancel authorization', target: 'element', outcome: 'cancel' }],
    }), { audience: 'host', signal, deferrable: false, transient: true });
  });

  it('opens the authorization URL on the host before showing the waiting form', async () => {
    const calls: string[] = [];
    const request = vi.fn<ExtensionUi['request']>(async () => { calls.push('request'); return { state: 'cancelled', reason: 'abort' }; });
    const openUrl = vi.fn(async () => { calls.push('open'); });
    const signal = new AbortController().signal;
    const url = 'https://auth.example.test/authorize?redirect=(x)&state=a\\b_';
    await createAuthorizationPresenter({ request } as unknown as ExtensionUi, openUrl)({ server: 'docs', url, signal });
    expect(openUrl).toHaveBeenCalledWith(url, signal);
    expect(calls).toEqual(['open', 'request']);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining('Your browser was opened to authorize the docs MCP server.'),
      markdown: '[Open the authorization page](https://auth.example.test/authorize?redirect=\\(x\\)&state=a\\\\b_)',
    }), expect.anything());
  });

  it('falls back to manual opening when the host cannot open a browser', async () => {
    const request = vi.fn<ExtensionUi['request']>(async () => ({ state: 'cancelled', reason: 'abort' }));
    const openUrl = vi.fn(async () => { throw new Error('No browser'); });
    await createAuthorizationPresenter({ request } as unknown as ExtensionUi, openUrl)({
      server: 'docs', url: 'https://auth.example.test/authorize', signal: new AbortController().signal,
    });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining('Open the authorization page in a browser on this machine'),
      markdown: '[Open the authorization page](https://auth.example.test/authorize)',
    }), expect.anything());
  });

  it('keeps bracketed URLs as plain text because UI markdown links cannot carry them', async () => {
    const request = vi.fn<ExtensionUi['request']>(async () => ({ state: 'cancelled', reason: 'abort' }));
    const url = 'http://[::1]:3118/authorize';
    await createAuthorizationPresenter({ request } as unknown as ExtensionUi)({ server: 'docs', url, signal: new AbortController().signal });
    const form = request.mock.calls[0]![0];
    expect(form.description).toContain(url);
    expect(form).not.toHaveProperty('markdown');
  });

  it('does not silently accept an unavailable local console', async () => {
    const request = vi.fn<ExtensionUi['request']>(async () => ({ state: 'cancelled', reason: 'unsupported' }));
    await expect(createAuthorizationPresenter({ request } as unknown as ExtensionUi)({
      server: 'docs', url: 'https://auth.example.test/authorize', signal: new AbortController().signal,
    })).rejects.toThrow('MCP authorization requires an eligible local console.');
  });
});

function createHarness(withSecrets = true) {
  const registry = createFelanServiceRegistry();
  if (withSecrets) registry.set(SECRETS_SERVICE, {
    read: async () => undefined,
    write: async () => { throw new Error('Unexpected write'); },
    remove: async () => {},
  });
  const tools = new Map<string, ToolDefinition<any, any, any>>();
  const handlers = new Map<string, ((event: unknown, context: ExtensionContext) => unknown)[]>();
  const encode = (name: string) => new TextEncoder().encode(JSON.stringify({
    mcpServers: { [name]: { url: `https://${name}.example.test/mcp`, auth: 'oauth' } },
  }));
  const readFile = vi.fn(async () => encode('project'));
  const context = {
    ...({ sessionManager: { getSessionId: () => 'mcp-test' } } as unknown as ExtensionContext),
    tools: [], executeTool: vi.fn(async () => { throw new Error('Unexpected nested tool'); }),
  } satisfies Parameters<ToolDefinition['execute']>[4];
  const pi = {
    runtime: { cwd: '/workspace', readAgentFile: async () => encode('docs'), readFile } as unknown as AgentRuntime,
    agentDir: '/agent',
    services: createExtensionServiceAccess(registry, extension.serviceRequirements),
    ui: { notify: vi.fn() },
    registerCapability: vi.fn(), registerCommand: vi.fn(),
    registerTool: (tool: ToolDefinition<any, any, any>) => tools.set(tool.name, tool),
    on: (event: string, handler: (event: unknown, context: ExtensionContext) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as FelanExtensionAPI;
  return {
    pi, tools, readFile,
    emit: async (event: string) => { for (const handler of handlers.get(event) ?? []) await handler({}, context); },
    execute: (params: Record<string, unknown>) => tools.get('mcp')!.execute('test', params, undefined, undefined, context),
  };
}
