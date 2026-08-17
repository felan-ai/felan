import type {
  ExtensionContext,
  FelanExtension,
  ToolDefinition,
} from '@felan-ai/agent-core';
import { StringEnum } from '@felan-ai/agent-core';
import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';
import {
  formatMcpToolResult,
  MCP_UNTRUSTED_INSTRUCTION,
  safeMcpErrorMessage,
  untrustedMcpMetadata,
  type McpResultDetails,
} from './boundary.js';
import { resolveMcpServers, validateMcpConfig } from './config.js';
import type {
  CreateMcpExtensionOptions,
  McpOAuthAuthenticationOutcome,
  McpOAuthSession,
  ResolvedMcpServer,
} from './contracts.js';
import {
  McpAuthenticationRequiredError,
  McpManager,
  type McpStatusEntry,
  type McpTool,
} from './manager.js';

export type {
  CreateMcpExtensionOptions,
  McpConfig,
  McpHttpTransport,
  McpOAuthAuthenticationContext,
  McpOAuthAuthenticationOutcome,
  McpOAuthHost,
  McpOAuthSession,
  McpOAuthSessionContext,
  McpServerConfig,
  McpSettings,
  ResolvedMcpServer,
} from './contracts.js';
export { validateMcpConfig } from './config.js';

const ACTIONS = [
  'status',
  'reconnect',
  'list',
  'search',
  'describe',
  'call',
  'authenticate',
  'logout',
] as const;

const MCP_COMMANDS = [
  { value: 'status', label: 'status — Show configured server status' },
  { value: 'tools', label: 'tools — List tools exposed by a server' },
  { value: 'reconnect', label: 'reconnect — Reconnect one or all servers' },
  { value: 'auth', label: 'auth — Authenticate with a server' },
  { value: 'logout', label: 'logout — Clear a server’s credentials' },
] as const;

const MCP_PANEL_LIST_TOOLS = 'List tools';
const MCP_PANEL_AUTHENTICATE = 'Authenticate';
const MCP_PANEL_RECONNECT = 'Reconnect';
const MCP_PANEL_LOGOUT = 'Logout';

const MCP_CONNECTION_GUIDANCE = [
  'MCP connections are session-scoped and lazy:',
  '"disconnected" reports only the current transport state and does not indicate whether OAuth credentials are available or persisted.',
  'The list, search, describe, and call actions connect automatically;',
  'use action "reconnect" with the server name to force a fresh connection.',
  'Authenticate only after status is "needs-auth" or a result reports that authentication is required.',
].join(' ');

const McpParameters = Type.Object({
  action: Type.Optional(StringEnum(ACTIONS, {
    description: 'Action to perform. Defaults to status.',
  })),
  server: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 64,
    description: 'Configured MCP server name. Required except for status.',
  })),
  tool: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 256,
    description: 'Original MCP tool name. Required for describe and call.',
  })),
  query: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 500,
    description: 'Case-insensitive tool name or description search text.',
  })),
  args: Type.Optional(Type.Union([
    Type.Record(Type.String(), Type.Unknown()),
    Type.String({ description: 'Tool arguments as a JSON object string.' }),
  ], { description: 'Arguments for call, as an object or JSON object string.' })),
}, { additionalProperties: false });

type McpParams = Static<typeof McpParameters>;

interface McpToolErrorDetails {
  readonly error: string;
  readonly server?: string;
}

class InvalidNestedMcpRequestError extends Error {
  constructor() {
    super('Invalid MCP gateway request nested inside args');
    this.name = 'InvalidNestedMcpRequestError';
  }
}

interface SessionState {
  readonly controller: AbortController;
  readonly oauth: McpOAuthSession;
  readonly manager: McpManager;
  readonly extensionContext: ExtensionContext;
}

export function createMcpExtension(options: CreateMcpExtensionOptions): FelanExtension {
  const config = validateMcpConfig(options.config);
  const servers = resolveMcpServers(config);
  const serverNames = servers.map(({ name }) => JSON.stringify(name)).join(', ');
  const configuredServers = `Configured MCP servers: ${serverNames}.`;

  return (pi) => {
    let state: SessionState | undefined;
    let initializing: Promise<void> = Promise.resolve();
    let generation = 0;

    const closeState = async (current: SessionState | undefined): Promise<void> => {
      if (!current) return;
      current.controller.abort(new Error('MCP session stopped'));
      const results = [];
      results.push(await Promise.resolve(current.manager.close()).then(
        () => ({ status: 'fulfilled' as const }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      ));
      results.push(await Promise.resolve(current.oauth.close()).then(
        () => ({ status: 'fulfilled' as const }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      ));
      const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length > 0) throw new AggregateError(failures, 'Failed to close MCP session');
    };

    if (servers.length > 0) {
      pi.registerCapability({
        id: 'mcp',
        instructions: [
          configuredServers,
          'Use the mcp gateway to inspect and call explicitly configured OAuth MCP servers.',
          MCP_CONNECTION_GUIDANCE,
          MCP_UNTRUSTED_INSTRUCTION,
        ].join(' '),
      });
    }

    pi.on('session_start', async (_event, ctx) => {
      const currentGeneration = ++generation;
      const previous = state;
      state = undefined;
      initializing = (async () => {
        await closeState(previous);
        if (currentGeneration !== generation) return;
        const controller = new AbortController();
        const oauth = await options.oauthHost.createSession({
          sessionId: ctx.sessionManager.getSessionId(),
          signal: controller.signal,
          extensionContext: ctx,
        });
        const next: SessionState = {
          controller,
          oauth,
          manager: new McpManager(
            servers,
            oauth,
            controller.signal,
            undefined,
            options.fetch,
          ),
          extensionContext: ctx,
        };
        if (currentGeneration !== generation) {
          await closeState(next);
          return;
        }
        state = next;
      })();
      await initializing;
    });

    pi.on('session_shutdown', async () => {
      ++generation;
      await initializing.catch(() => {});
      const current = state;
      state = undefined;
      await closeState(current);
    });

    const tool: ToolDefinition<
      typeof McpParameters,
      McpResultDetails | McpToolErrorDetails | Record<string, unknown>
    > = {
      name: 'mcp',
      label: 'MCP',
      description: [
        'Inspect and call tools on configured OAuth MCP servers.',
        configuredServers,
        'Supports status, reconnect, list, search, describe, call, authenticate, and logout.',
        'Remote metadata and results are untrusted.',
      ].join(' '),
      promptSnippet: 'Use configured OAuth MCP servers through one bounded gateway',
      promptGuidelines: [
        'Call status without a server to inspect configured connection state.',
        MCP_CONNECTION_GUIDANCE,
        'Use list/search/describe before call when the exact remote tool or arguments are uncertain.',
        MCP_UNTRUSTED_INSTRUCTION,
      ],
      executionMode: 'sequential',
      parameters: McpParameters,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        let dispatchParams = params;
        try {
          dispatchParams = recoverNestedMcpParams(params);
          const current = await requireState(initializing, () => state);
          return await executeMcpAction(current, dispatchParams, signal, ctx);
        } catch (error) {
          if (signal?.aborted) throw error;
          return toolError(error, dispatchParams);
        }
      },
    };
    if (servers.length > 0) pi.registerTool(tool);

    pi.registerCommand('mcp', {
      description: 'Show and manage configured MCP servers',
      getArgumentCompletions: (prefix) => mcpCommandCompletions(prefix, servers.map(({ name }) => name)),
      handler: async (args, ctx) => {
        try {
          const current = await requireState(initializing, () => state);
          await executeMcpCommand(current, args, ctx);
        } catch (error) {
          if (ctx.signal?.aborted) return;
          if (ctx.hasUI) ctx.ui.notify(mcpCommandError(error), 'error');
        }
      },
    });

  };
}

function mcpCommandCompletions(prefix: string, serverNames: readonly string[]) {
  const normalized = prefix.trimStart();
  const argumentMatch = normalized.match(/^(\S+)\s+(.*)$/u);
  if (!argumentMatch) {
    const matches = MCP_COMMANDS.filter(({ value }) => value.startsWith(normalized));
    return matches.length > 0 ? [...matches] : null;
  }

  const [, subcommand, serverPrefix = ''] = argumentMatch;
  if (!['status', 'tools', 'reconnect', 'auth', 'authenticate', 'logout'].includes(subcommand ?? '')) {
    return null;
  }
  const normalizedServerPrefix = serverPrefix.trimStart();
  const matches = serverNames
    .filter((name) => name.startsWith(normalizedServerPrefix))
    .map((name) => ({ value: `${subcommand} ${name}`, label: name }));
  return matches.length > 0 ? matches : null;
}

async function executeMcpCommand(
  state: SessionState,
  args: string | undefined,
  ctx: ExtensionContext,
): Promise<void> {
  const parts = args?.trim().split(/\s+/u).filter(Boolean) ?? [];
  const subcommand = parts[0] ?? '';
  const serverName = parts.slice(1).join(' ') || undefined;

  if (!subcommand) {
    await openMcpPanel(state, ctx);
    return;
  }
  if (subcommand === 'status') {
    showMcpStatus(state, ctx, serverName);
    return;
  }
  if (subcommand === 'tools') {
    await showMcpTools(state, ctx, serverName);
    return;
  }
  if (subcommand === 'reconnect') {
    await reconnectMcpServers(state, ctx, serverName);
    return;
  }
  if (subcommand === 'auth' || subcommand === 'authenticate') {
    const selected = serverName ?? await selectMcpServer(state, ctx, 'Authenticate with MCP server');
    if (!selected) return;
    const notification = await authenticateMcpCommand(state, selected, ctx);
    if (ctx.hasUI) {
      ctx.ui.notify(notification.text, notification.type);
    }
    return;
  }
  if (subcommand === 'logout') {
    const selected = serverName ?? await selectMcpServer(state, ctx, 'Log out of MCP server');
    if (!selected) return;
    await logoutMcpServer(state, selected, ctx.signal);
    if (ctx.hasUI) ctx.ui.notify(`Logged out of MCP server ${selected}.`, 'info');
    return;
  }

  if (ctx.hasUI) {
    ctx.ui.notify('Usage: /mcp [status|tools|reconnect|auth|logout] [server]', 'error');
  }
}

async function openMcpPanel(state: SessionState, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;
  const serverName = await selectMcpServer(state, ctx, 'MCP servers');
  if (!serverName) return;
  const action = await ctx.ui.select(
    `MCP server: ${serverName}`,
    [MCP_PANEL_LIST_TOOLS, MCP_PANEL_AUTHENTICATE, MCP_PANEL_RECONNECT, MCP_PANEL_LOGOUT],
    ctx.signal ? { signal: ctx.signal } : undefined,
  );
  if (action === MCP_PANEL_LIST_TOOLS) {
    await showMcpTools(state, ctx, serverName);
  } else if (action === MCP_PANEL_AUTHENTICATE) {
    const notification = await authenticateMcpCommand(state, serverName, ctx);
    ctx.ui.notify(notification.text, notification.type);
  } else if (action === MCP_PANEL_RECONNECT) {
    await reconnectMcpServers(state, ctx, serverName);
  } else if (action === MCP_PANEL_LOGOUT) {
    await logoutMcpServer(state, serverName, ctx.signal);
    ctx.ui.notify(`Logged out of MCP server ${serverName}.`, 'info');
  }
}

async function selectMcpServer(
  state: SessionState,
  ctx: ExtensionContext,
  title: string,
): Promise<string | undefined> {
  if (!ctx.hasUI) return undefined;
  const statuses = state.manager.statuses();
  if (statuses.length === 0) {
    ctx.ui.notify('No OAuth HTTP MCP servers are configured. Add one to the agent or project MCP config and run /reload.', 'info');
    return undefined;
  }
  const options = statuses.map((entry) => mcpStatusLabel(entry));
  const selected = await ctx.ui.select(
    title,
    options,
    ctx.signal ? { signal: ctx.signal } : undefined,
  );
  const index = selected === undefined ? -1 : options.indexOf(selected);
  return index < 0 ? undefined : statuses[index]?.server;
}

function showMcpStatus(state: SessionState, ctx: ExtensionContext, serverName?: string): void {
  if (!ctx.hasUI) return;
  if (serverName !== undefined) state.manager.server(serverName);
  const statuses = state.manager.statuses().filter(({ server }) => serverName === undefined || server === serverName);
  if (statuses.length === 0) {
    ctx.ui.notify('No OAuth HTTP MCP servers are configured. Add one to the agent or project MCP config and run /reload.', 'info');
    return;
  }
  ctx.ui.notify(['MCP servers', ...statuses.map((entry) => `• ${mcpStatusLabel(entry)}`)].join('\n'), 'info');
}

async function showMcpTools(state: SessionState, ctx: ExtensionContext, serverName?: string): Promise<void> {
  if (!ctx.hasUI) return;
  const serverNames = serverName === undefined
    ? state.manager.statuses().map(({ server }) => server)
    : [state.manager.server(serverName).name];
  if (serverNames.length === 0) {
    showMcpStatus(state, ctx);
    return;
  }

  const lines: string[] = ['MCP tools (remote untrusted metadata)'];
  for (const name of serverNames) {
    try {
      const tools = await state.manager.listTools(name, ctx.signal);
      lines.push(`\n${name} — ${tools.length} tools`);
      lines.push(...tools.slice(0, 250).map((tool) => `• ${boundedUiString(tool.name)}`));
      if (tools.length > 250) lines.push(`• … ${tools.length - 250} more omitted`);
    } catch (error) {
      lines.push(error instanceof McpAuthenticationRequiredError
        ? `\n${name} — authentication required (run /mcp auth ${name})`
        : `\n${name} — failed to load tools`);
    }
  }
  ctx.ui.notify(lines.join('\n').slice(0, 20_000), 'info');
}

async function reconnectMcpServers(
  state: SessionState,
  ctx: ExtensionContext,
  serverName?: string,
): Promise<void> {
  const serverNames = serverName === undefined
    ? state.manager.statuses().map(({ server }) => server)
    : [state.manager.server(serverName).name];
  if (serverNames.length === 0) {
    showMcpStatus(state, ctx);
    return;
  }

  const messages: string[] = [];
  for (const name of serverNames) {
    await state.manager.closeServer(name);
    try {
      const tools = await state.manager.listTools(name, ctx.signal);
      messages.push(`${name}: connected (${tools.length} tools)`);
    } catch (error) {
      messages.push(error instanceof McpAuthenticationRequiredError
        ? `${name}: authentication required`
        : `${name}: connection failed`);
    }
  }
  if (ctx.hasUI) ctx.ui.notify(messages.join('\n'), messages.some((message) => !message.includes(': connected')) ? 'warning' : 'info');
}

async function logoutMcpServer(
  state: SessionState,
  serverName: string,
  signal?: AbortSignal,
): Promise<void> {
  const server = state.manager.server(serverName);
  await state.manager.closeServer(serverName);
  await state.oauth.logout(server, effectiveSignal(state, signal));
}

async function authenticateMcpCommand(
  state: SessionState,
  serverName: string,
  ctx: ExtensionContext,
): Promise<{ text: string; type: 'info' | 'warning' }> {
  const outcome = await authenticate(state, serverName, ctx.signal, ctx, 'explicit');
  if (outcome.status !== 'authenticated') {
    return { text: authenticationText(serverName, outcome), type: 'warning' };
  }
  try {
    const tools = await state.manager.listTools(serverName, ctx.signal);
    return {
      text: `Authenticated and connected to MCP server ${serverName} (${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}).`,
      type: 'info',
    };
  } catch {
    return {
      text: `Authenticated with MCP server ${serverName}, but reconnecting failed. Run /mcp reconnect ${serverName} to retry.`,
      type: 'warning',
    };
  }
}

function mcpStatusLabel(entry: McpStatusEntry): string {
  return `${entry.server} — ${entry.status} — ${entry.toolCount} ${entry.toolCount === 1 ? 'tool' : 'tools'}`;
}

function boundedUiString(value: string): string {
  return JSON.stringify(value.slice(0, 500));
}

function mcpCommandError(error: unknown): string {
  if (error instanceof McpAuthenticationRequiredError) {
    return `MCP server ${error.serverName} requires authentication. Run /mcp auth ${error.serverName}.`;
  }
  if (error instanceof Error && error.message.startsWith('Unknown MCP server:')) {
    return safeMcpErrorMessage(error);
  }
  return 'MCP command failed. Check the configured server and retry.';
}

async function executeMcpAction(
  state: SessionState,
  params: McpParams,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
) {
  const action = params.action ?? 'status';
  if (action === 'status') {
    if (params.server !== undefined) state.manager.server(params.server);
    const statuses = state.manager.statuses().filter(({ server }) => params.server === undefined || server === params.server);
    return textResult(JSON.stringify({ servers: statuses, guidance: MCP_CONNECTION_GUIDANCE }, null, 2), { action: 'status' });
  }

  const serverName = requireParameter(params.server, 'server', action);
  if (action === 'authenticate') {
    const outcome = await authenticate(state, serverName, signal, ctx, 'explicit');
    return textResult(authenticationText(serverName, outcome), {
      server: serverName,
      status: outcome.status,
      ...('interactionId' in outcome && outcome.interactionId !== undefined
        ? { interactionId: outcome.interactionId }
        : {}),
    });
  }
  if (action === 'logout') {
    const server = state.manager.server(serverName);
    await state.manager.closeServer(serverName);
    await state.oauth.logout(server, effectiveSignal(state, signal));
    return textResult(`Logged out of MCP server ${serverName}.`, { server: serverName, status: 'logged-out' });
  }

  if (action === 'reconnect') {
    effectiveSignal(state, signal).throwIfAborted();
    await state.manager.closeServer(serverName);
  }

  let tools: readonly McpTool[];
  try {
    tools = await state.manager.listTools(serverName, signal);
  } catch (error) {
    if (error instanceof McpAuthenticationRequiredError) {
      return authRequired(serverName);
    }
    throw error;
  }

  if (action === 'reconnect') {
    return textResult(
      `Connected to MCP server ${serverName} (${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}).`,
      { action: 'reconnect', server: serverName, status: 'connected', toolCount: tools.length },
    );
  }

  if (action === 'list') {
    return textResult(
      untrustedMcpMetadata('tools', serverName, tools.map((tool) => toolSummary(tool))),
      { action: 'list', server: serverName },
    );
  }
  if (action === 'search') {
    const query = requireParameter(params.query, 'query', action).toLowerCase();
    const matches = tools.filter((tool) => (
      tool.name.toLowerCase().includes(query)
      || tool.description?.toLowerCase().includes(query)
    )).slice(0, 50).map((tool) => toolSummary(tool));
    return textResult(
      untrustedMcpMetadata('search', serverName, matches),
      { action: 'search', server: serverName },
    );
  }
  if (action === 'describe') {
    const toolName = requireParameter(params.tool, 'tool', action);
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool) throw new Error(`Unknown tool ${JSON.stringify(toolName)} on MCP server ${serverName}`);
    return textResult(
      untrustedMcpMetadata('describe', serverName, toolSummary(tool, true)),
      { action: 'describe', server: serverName, tool: toolName },
    );
  }
  if (action === 'call') {
    const toolName = requireParameter(params.tool, 'tool', action);
    const args = parseArguments(params.args);
    try {
      const result = await state.manager.callTool(serverName, toolName, args, signal);
      return formatMcpToolResult(serverName, toolName, result);
    } catch (error) {
      if (error instanceof McpAuthenticationRequiredError) return authRequired(serverName);
      throw error;
    }
  }
  throw new Error(`Unsupported MCP action: ${action}`);
}

async function authenticate(
  state: SessionState,
  serverName: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  reason: 'explicit' | 'connection-required',
): Promise<McpOAuthAuthenticationOutcome> {
  const server = state.manager.server(serverName);
  const outcome = await state.oauth.authenticate(server, {
    reason,
    signal: effectiveSignal(state, signal),
    extensionContext: ctx,
  });
  if (outcome.status === 'authenticated') await state.manager.closeServer(serverName);
  return outcome;
}

function authenticationText(serverName: string, outcome: McpOAuthAuthenticationOutcome): string {
  if (outcome.status === 'authenticated') {
    return `Authenticated with MCP server ${serverName}. Retry the requested MCP operation.`;
  }
  if (outcome.status === 'pending') {
    return `${outcome.message} Authentication for ${serverName} is pending; do not retry until the consumer reports completion.`;
  }
  return outcome.message;
}

function authRequired(serverName: string) {
  return {
    content: [{
      type: 'text' as const,
      text: `MCP server ${serverName} requires OAuth authentication. Call mcp with action "authenticate" and server "${serverName}", then retry after authentication succeeds.`,
    }],
    isError: true,
    details: { error: 'authentication_required', server: serverName },
  };
}

function toolSummary(tool: McpTool, includeSchema = false): Record<string, unknown> {
  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(includeSchema ? { inputSchema: tool.inputSchema } : {}),
  };
}

function parseArguments(value: McpParams['args']): Record<string, unknown> {
  if (value === undefined) return {};
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch (error) {
      throw new Error(`Invalid MCP args JSON: ${safeMcpErrorMessage(error)}`, { cause: error });
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('MCP args must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function recoverNestedMcpParams(params: McpParams): McpParams {
  if (params.action !== undefined || params.args === undefined) return params;
  if (params.server !== undefined || params.tool !== undefined || params.query !== undefined) {
    throw new InvalidNestedMcpRequestError();
  }

  let nested: unknown;
  try {
    nested = typeof params.args === 'string'
      ? JSON.parse(params.args) as unknown
      : params.args;
  } catch {
    throw new InvalidNestedMcpRequestError();
  }

  if (!Check(McpParameters, nested) || nested.action === undefined || !isCompleteMcpRequest(nested)) {
    throw new InvalidNestedMcpRequestError();
  }
  return nested;
}

function isCompleteMcpRequest(params: McpParams): boolean {
  const hasServer = params.server !== undefined && params.server.trim().length > 0;
  const hasTool = params.tool !== undefined && params.tool.trim().length > 0;
  const hasQuery = params.query !== undefined && params.query.trim().length > 0;
  switch (params.action) {
    case 'status':
      return params.server === undefined || hasServer;
    case 'reconnect':
    case 'list':
    case 'authenticate':
    case 'logout':
      return hasServer;
    case 'search':
      return hasServer && hasQuery;
    case 'describe':
    case 'call':
      return hasServer && hasTool;
    default:
      return false;
  }
}

function requireParameter(value: string | undefined, name: string, action: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`MCP action ${action} requires ${name}`);
  return normalized;
}

function effectiveSignal(state: SessionState, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([state.controller.signal, signal]) : state.controller.signal;
}

async function requireState(
  initializing: Promise<void>,
  current: () => SessionState | undefined,
): Promise<SessionState> {
  await initializing;
  const state = current();
  if (!state) throw new Error('MCP session is not initialized');
  return state;
}

function textResult(text: string, details: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
  };
}

function toolError(error: unknown, params: McpParams) {
  if (error instanceof InvalidNestedMcpRequestError) {
    return {
      content: [{
        type: 'text' as const,
        text: [
          'MCP gateway parameters nested inside "args" were invalid.',
          'Pass "action" and its gateway parameters at the top level;',
          'reserve "args" for remote tool arguments when action is "call".',
        ].join(' '),
      }],
      isError: true,
      details: { error: 'invalid_nested_mcp_request' },
    };
  }
  const action = params.action ?? 'status';
  const server = params.server;
  if (action === 'reconnect' && server !== undefined) {
    return {
      content: [{
        type: 'text' as const,
        text: [
          `MCP reconnect for server ${JSON.stringify(server)} failed.`,
          'Call status for this server; authenticate only if it reports "needs-auth",',
          'otherwise retry reconnect once and inspect the host MCP configuration or network policy.',
        ].join(' '),
      }],
      isError: true,
      details: { error: 'mcp_reconnect_failed', action, server },
    };
  }
  const details: McpToolErrorDetails = {
    error: 'mcp_error',
    ...(server === undefined ? {} : { server }),
  };
  return {
    content: [{
      type: 'text' as const,
      text: server === undefined
        ? 'MCP request failed. Check the action parameters or host MCP configuration and retry.'
        : [
          `MCP request for server ${JSON.stringify(server)} failed.`,
          'Retry once; if it persists, call status and authenticate only if it reports "needs-auth";',
          'otherwise inspect the host MCP configuration or network policy.',
        ].join(' '),
    }],
    isError: true,
    details,
  };
}
