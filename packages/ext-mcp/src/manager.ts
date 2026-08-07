import {
  Client,
  SdkHttpError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type CallToolResult,
  type FetchLike,
  type ListToolsResult,
  type OAuthClientProvider,
  type RequestOptions,
  type Transport,
} from '@modelcontextprotocol/client';
import type {
  McpOAuthSession,
  ResolvedMcpServer,
} from './contracts.js';

const MAX_TOOL_PAGES = 100;
const MAX_TOOLS_PER_SERVER = 1_000;

export type McpTool = ListToolsResult['tools'][number];
export type McpServerStatus = 'disconnected' | 'connecting' | 'connected' | 'needs-auth' | 'failed';

export interface McpStatusEntry {
  readonly server: string;
  readonly status: McpServerStatus;
  readonly toolCount: number;
}

export interface McpConnection {
  readonly client: Pick<Client, 'listTools' | 'callTool' | 'close'>;
  readonly transport: Transport;
  readonly transportKind: 'streamable-http' | 'sse';
}

export type McpConnectionFactory = (
  server: ResolvedMcpServer,
  provider: OAuthClientProvider,
  signal: AbortSignal,
  fetchFn?: FetchLike,
) => Promise<McpConnection>;

interface ServerState {
  status: McpServerStatus;
  generation: number;
  tools: McpTool[];
  connection: McpConnection | undefined;
  connecting: Promise<McpConnection> | undefined;
  connectController: AbortController | undefined;
}

export class McpAuthenticationRequiredError extends Error {
  constructor(readonly serverName: string) {
    super(`MCP server ${serverName} requires OAuth authentication`);
    this.name = 'McpAuthenticationRequiredError';
  }
}

export class McpManager {
  readonly #servers: ReadonlyMap<string, ResolvedMcpServer>;
  readonly #states = new Map<string, ServerState>();
  readonly #sessionSignal: AbortSignal;
  readonly #oauth: McpOAuthSession;
  readonly #connectionFactory: McpConnectionFactory;
  readonly #fetch: FetchLike | undefined;
  #closed = false;

  constructor(
    servers: readonly ResolvedMcpServer[],
    oauth: McpOAuthSession,
    sessionSignal: AbortSignal,
    connectionFactory: McpConnectionFactory = connectMcpServer,
    fetchFn?: FetchLike,
  ) {
    this.#servers = new Map(servers.map((server) => [server.name, server]));
    this.#oauth = oauth;
    this.#sessionSignal = sessionSignal;
    this.#connectionFactory = connectionFactory;
    this.#fetch = fetchFn;
    for (const server of servers) {
      this.#states.set(server.name, {
        status: 'disconnected',
        generation: 0,
        tools: [],
        connection: undefined,
        connecting: undefined,
        connectController: undefined,
      });
    }
  }

  server(name: string): ResolvedMcpServer {
    const server = this.#servers.get(name);
    if (!server) throw new Error(`Unknown MCP server: ${name}`);
    return server;
  }

  statuses(): readonly McpStatusEntry[] {
    return [...this.#servers.keys()].map((server) => {
      const state = this.#states.get(server)!;
      return { server, status: state.status, toolCount: state.tools.length };
    });
  }

  async listTools(serverName: string, signal?: AbortSignal): Promise<readonly McpTool[]> {
    const connection = await this.connect(serverName, signal);
    return this.#states.get(serverName)?.connection === connection
      ? [...this.#states.get(serverName)!.tools]
      : [];
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const server = this.server(serverName);
    const connection = await this.connect(serverName, signal);
    const tool = this.#states.get(serverName)!.tools.find((candidate) => candidate.name === toolName);
    if (!tool) throw new Error(`Unknown tool ${JSON.stringify(toolName)} on MCP server ${serverName}`);
    try {
      return await connection.client.callTool(
        { name: tool.name, arguments: args },
        requestOptions(server, combineSignals(this.#sessionSignal, signal)),
      );
    } catch (error) {
      if (isUnauthorized(error)) {
        await this.closeServer(serverName);
        this.#states.get(serverName)!.status = 'needs-auth';
        throw new McpAuthenticationRequiredError(serverName);
      }
      try {
        await this.closeServer(serverName);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Failed to clean up MCP server ${serverName}`);
      }
      throw error;
    }
  }

  async connect(serverName: string, signal?: AbortSignal): Promise<McpConnection> {
    this.#assertOpen();
    const server = this.server(serverName);
    const state = this.#states.get(serverName)!;
    if (state.connection) return state.connection;
    if (state.connecting) return abortable(state.connecting, signal);

    const generation = state.generation;
    const controller = new AbortController();
    const connectSignal = combineSignals(this.#sessionSignal, controller.signal, signal);
    state.connectController = controller;
    state.status = 'connecting';
    let connecting!: Promise<McpConnection>;
    connecting = (async () => {
      let connection: McpConnection | undefined;
      try {
        const provider = await this.#oauth.providerFor(server, connectSignal);
        connection = await this.#connectionFactory(server, provider, connectSignal, this.#fetch);
        const tools = await fetchAllTools(connection.client, requestOptions(server, connectSignal));
        if (
          this.#closed
          || state.generation !== generation
          || controller.signal.aborted
          || this.#sessionSignal.aborted
        ) {
          throw abortReason(connectSignal);
        }
        state.connection = connection;
        state.tools = tools;
        state.status = 'connected';
        return connection;
      } catch (error) {
        let reportedError = error;
        if (connection && state.connection !== connection) {
          try {
            await closeConnection(connection);
          } catch (cleanupError) {
            reportedError = new AggregateError(
              [error, cleanupError],
              'Failed to clean up MCP connection attempt',
            );
          }
        }
        if (state.generation === generation && !this.#closed) {
          state.status = connectSignal.aborted
            ? 'disconnected'
            : isUnauthorized(reportedError) ? 'needs-auth' : 'failed';
        }
        if (isUnauthorized(reportedError)) throw new McpAuthenticationRequiredError(serverName);
        throw reportedError;
      } finally {
        if (state.connectController === controller) state.connectController = undefined;
        if (state.connecting === connecting) state.connecting = undefined;
      }
    })();
    state.connecting = connecting;
    return abortable(connecting, signal);
  }

  async closeServer(serverName: string): Promise<void> {
    const state = this.#states.get(serverName);
    if (!state) return;
    state.generation += 1;
    const connecting = state.connecting;
    state.connectController?.abort(new Error(`MCP server ${serverName} connection closed`));
    const connection = state.connection;
    state.connection = undefined;
    state.connecting = undefined;
    state.tools = [];
    state.status = 'disconnected';
    if (connection) await closeConnection(connection);
    if (connecting) await connecting.catch(() => {});
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const closings = [...this.#servers.keys()].map((name) => this.closeServer(name));
    const results = await Promise.allSettled(closings);
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, 'Failed to close MCP connections');
  }

  #assertOpen(): void {
    if (this.#closed || this.#sessionSignal.aborted) throw abortReason(this.#sessionSignal);
  }
}

export async function connectMcpServer(
  server: ResolvedMcpServer,
  provider: OAuthClientProvider,
  signal: AbortSignal,
  fetchFn?: FetchLike,
): Promise<McpConnection> {
  const kinds: Array<'streamable-http' | 'sse'> = server.transport === 'auto'
    ? ['streamable-http', 'sse']
    : [server.transport];
  let previousError: unknown;

  for (const kind of kinds) {
    signal.throwIfAborted();
    const client = new Client({ name: 'felan-mcp', version: '0.1.0' });
    const transport: Transport = kind === 'streamable-http'
      ? new StreamableHTTPClientTransport(new URL(server.url), {
        authProvider: provider,
        ...(fetchFn === undefined ? {} : { fetch: fetchFn }),
      })
      : new SSEClientTransport(new URL(server.url), {
        authProvider: provider,
        ...(fetchFn === undefined ? {} : { fetch: fetchFn }),
      });
    try {
      await client.connect(transport, requestOptions(server, signal));
      return { client, transport, transportKind: kind };
    } catch (error) {
      try {
        await closeConnection({ client, transport, transportKind: kind });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Failed to clean up MCP ${kind} connection`);
      }
      previousError = error;
      if (kind !== 'streamable-http' || !shouldFallbackToSse(error)) throw error;
    }
  }
  throw previousError instanceof Error ? previousError : new Error(String(previousError));
}

async function fetchAllTools(
  client: Pick<Client, 'listTools'>,
  options?: RequestOptions,
): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    if (++pages > MAX_TOOL_PAGES) throw new Error('MCP tool listing exceeded the page limit');
    const result = await client.listTools(cursor ? { cursor } : undefined, options);
    tools.push(...result.tools);
    if (tools.length > MAX_TOOLS_PER_SERVER) {
      throw new Error(`MCP server exposed more than ${MAX_TOOLS_PER_SERVER} tools`);
    }
    cursor = result.nextCursor;
  } while (cursor);
  return tools;
}

function requestOptions(server: ResolvedMcpServer, signal?: AbortSignal): RequestOptions | undefined {
  if (!signal && server.requestTimeoutMs === undefined) return undefined;
  return {
    ...(signal ? { signal } : {}),
    ...(server.requestTimeoutMs === undefined ? {} : { timeout: server.requestTimeoutMs }),
  };
}

function shouldFallbackToSse(error: unknown): boolean {
  return error instanceof SdkHttpError && [404, 405, 406, 415].includes(error.status);
}

function isUnauthorized(error: unknown): boolean {
  if (error instanceof McpAuthenticationRequiredError || error instanceof UnauthorizedError) return true;
  if (error instanceof SdkHttpError && error.status === 401) return true;
  return false;
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) return new AbortController().signal;
  if (present.length === 1) return present[0]!;
  return AbortSignal.any(present);
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('MCP operation aborted');
}

async function closeConnection(connection: McpConnection): Promise<void> {
  try {
    await connection.client.close();
  } catch (clientError) {
    try {
      await connection.transport.close();
    } catch (transportError) {
      throw new AggregateError([clientError, transportError], 'Failed to close MCP client and transport');
    }
    throw clientError;
  }
}
