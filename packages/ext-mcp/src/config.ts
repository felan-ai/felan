import type {
  McpConfig,
  McpHttpTransport,
  McpServerConfig,
  ResolvedMcpServer,
} from './contracts.js';

const MAX_SERVERS = 32;
const MAX_REQUEST_TIMEOUT_MS = 5 * 60 * 1_000;
const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const ROOT_FIELDS: ReadonlySet<string> = new Set(['mcpServers', 'settings']);
const SERVER_FIELDS: ReadonlySet<string> = new Set([
  'url',
  'auth',
  'transport',
  'requestTimeoutMs',
]);
const SETTINGS_FIELDS: ReadonlySet<string> = new Set(['requestTimeoutMs']);
const TRANSPORTS: ReadonlySet<string> = new Set(['auto', 'streamable-http', 'sse']);

export function validateMcpConfig(value: unknown, source = 'MCP config'): McpConfig {
  if (!isRecord(value)) throw new Error(`${source} must contain a JSON object`);
  rejectUnknownFields(value, ROOT_FIELDS, source);
  if (!isRecord(value.mcpServers)) throw new Error(`${source}.mcpServers must be an object`);

  const entries = Object.entries(value.mcpServers);
  if (entries.length > MAX_SERVERS) {
    throw new Error(`${source}.mcpServers supports at most ${MAX_SERVERS} servers`);
  }

  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, rawServer] of entries) {
    if (!SERVER_NAME_PATTERN.test(name)) {
      throw new Error(`${source}.mcpServers contains invalid server name: ${JSON.stringify(name)}`);
    }
    mcpServers[name] = validateServer(rawServer, `${source}.mcpServers.${name}`);
  }

  let settings: McpConfig['settings'];
  if (value.settings !== undefined) {
    if (!isRecord(value.settings)) throw new Error(`${source}.settings must be an object`);
    rejectUnknownFields(value.settings, SETTINGS_FIELDS, `${source}.settings`);
    settings = {
      ...(value.settings.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: validateTimeout(value.settings.requestTimeoutMs, `${source}.settings.requestTimeoutMs`) }),
    };
  }

  return {
    mcpServers,
    ...(settings === undefined ? {} : { settings }),
  };
}

export function resolveMcpServers(config: McpConfig): readonly ResolvedMcpServer[] {
  return Object.entries(config.mcpServers).map(([name, server]) => {
    const requestTimeoutMs = server.requestTimeoutMs ?? config.settings?.requestTimeoutMs;
    return {
      name,
      url: server.url,
      auth: 'oauth',
      transport: server.transport ?? 'auto',
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    };
  });
}

function validateServer(value: unknown, source: string): McpServerConfig {
  if (!isRecord(value)) throw new Error(`${source} must be an object`);
  rejectUnknownFields(value, SERVER_FIELDS, source);
  if (value.auth !== 'oauth') {
    throw new Error(`${source}.auth must explicitly be "oauth"`);
  }
  if (typeof value.url !== 'string' || value.url.trim().length === 0) {
    throw new Error(`${source}.url must be a non-empty string`);
  }

  const transport = value.transport === undefined
    ? undefined
    : validateTransport(value.transport, `${source}.transport`);
  return {
    url: validateServerUrl(value.url, `${source}.url`),
    auth: 'oauth',
    ...(transport === undefined ? {} : { transport }),
    ...(value.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: validateTimeout(value.requestTimeoutMs, `${source}.requestTimeoutMs`) }),
  };
}

function validateServerUrl(value: string, source: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch (error) {
    throw new Error(`${source} must be an absolute URL`, { cause: error });
  }
  if (url.username || url.password) throw new Error(`${source} must not contain credentials`);
  if (url.hash) throw new Error(`${source} must not contain a fragment`);
  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`${source} must use HTTPS (HTTP is allowed only for loopback development servers)`);
  }
  return url.toString();
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '[::1]'
    || normalized === '::1';
}

function validateTransport(value: unknown, source: string): McpHttpTransport {
  if (typeof value !== 'string' || !TRANSPORTS.has(value)) {
    throw new Error(`${source} must be auto, streamable-http, or sse`);
  }
  return value as McpHttpTransport;
}

function validateTimeout(value: unknown, source: string): number {
  if (
    typeof value !== 'number'
    || !Number.isInteger(value)
    || value <= 0
    || value > MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new Error(`${source} must be an integer from 1 to ${MAX_REQUEST_TIMEOUT_MS}`);
  }
  return value;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  source: string,
): void {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new Error(`${source} contains unknown field: ${field}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
