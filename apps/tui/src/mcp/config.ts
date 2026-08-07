import { join } from 'node:path';
import type { AgentRuntime } from '@felan-ai/agent-core';
import {
  validateMcpConfig,
  type McpConfig,
} from '@felan-ai/ext-mcp';

export interface LocalMcpOAuthConfig {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly clientSecretEnv?: string;
  readonly scope?: string;
  readonly redirectUri?: string;
  readonly clientName?: string;
  readonly clientUri?: string;
  readonly authorizationParams?: Readonly<Record<string, string>>;
}

export interface LocalMcpConfig {
  readonly config: McpConfig;
  readonly oauth: Readonly<Record<string, LocalMcpOAuthConfig>>;
  readonly warnings: readonly string[];
}

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_SERVERS = 32;
const MAX_WARNINGS = 32;
const ROOT_FIELDS: ReadonlySet<string> = new Set(['mcpServers', 'settings']);
const SERVER_FIELDS: ReadonlySet<string> = new Set([
  'url',
  'auth',
  'httpTransport',
  'requestTimeoutMs',
  'oauth',
]);
const PROJECT_SERVER_FIELDS: ReadonlySet<string> = new Set([
  ...SERVER_FIELDS,
  'disabled',
  'type',
]);
const OAUTH_FIELDS: ReadonlySet<string> = new Set([
  'grantType',
  'clientId',
  'clientSecret',
  'clientSecretEnv',
  'scope',
  'redirectUri',
  'clientName',
  'clientUri',
  'authorizationParams',
]);
const RESERVED_AUTHORIZATION_PARAMS: ReadonlySet<string> = new Set([
  'client_id',
  'code_challenge',
  'code_challenge_method',
  'redirect_uri',
  'resource',
  'response_type',
  'scope',
  'state',
]);

export async function readLocalMcpConfig(
  runtime: AgentRuntime,
  agentDir: string,
): Promise<LocalMcpConfig> {
  const agentConfig = await readAgentConfig(runtime, agentDir);
  const projectConfig = await readProjectConfig(runtime);
  return mergeConfigs(agentConfig, projectConfig);
}

async function readAgentConfig(runtime: AgentRuntime, agentDir: string): Promise<LocalMcpConfig> {
  if (!runtime.readAgentFile) return emptyConfig();
  const source = join(agentDir, 'mcp.json');
  let content: Uint8Array;
  try {
    content = await runtime.readAgentFile('mcp.json');
  } catch (error) {
    if (isMissingFile(error)) return emptyConfig();
    throw new Error(`Failed to read ${source}: ${errorMessage(error)}`, { cause: error });
  }
  ensureConfigSize(content, source);

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(content)) as unknown;
  } catch (error) {
    throw new Error(`Invalid ${source}: ${errorMessage(error)}`, { cause: error });
  }
  return validateLocalMcpConfig(parsed, source);
}

async function readProjectConfig(runtime: AgentRuntime): Promise<LocalMcpConfig> {
  const source = join(runtime.cwd, '.mcp.json');
  let content: Uint8Array;
  try {
    content = await runtime.readFile('.mcp.json', { maxBytes: MAX_CONFIG_BYTES });
    ensureConfigSize(content, source);
  } catch (error) {
    if (isMissingFile(error)) return emptyConfig();
    return emptyConfigWithWarning('Skipped project MCP config: unable to read the file');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(content)) as unknown;
  } catch {
    return emptyConfigWithWarning('Skipped project MCP config: invalid JSON');
  }
  return normalizeProjectMcpConfig(parsed, source);
}

export function validateLocalMcpConfig(value: unknown, source = 'mcp.json'): LocalMcpConfig {
  if (!isRecord(value)) throw new Error(`${source} must contain a JSON object`);
  rejectUnknownFields(value, ROOT_FIELDS, source);
  if (!isRecord(value.mcpServers)) throw new Error(`${source}.mcpServers must be an object`);

  const mcpServers: Record<string, unknown> = {};
  const oauth: Record<string, LocalMcpOAuthConfig> = {};
  for (const [name, rawServer] of Object.entries(value.mcpServers)) {
    const serverSource = `${source}.mcpServers.${name}`;
    if (!isRecord(rawServer)) throw new Error(`${serverSource} must be an object`);
    rejectUnknownFields(rawServer, SERVER_FIELDS, serverSource);
    mcpServers[name] = {
      url: rawServer.url,
      auth: rawServer.auth,
      ...(rawServer.httpTransport === undefined
        ? {}
        : { transport: validateHttpTransport(rawServer.httpTransport, `${serverSource}.httpTransport`) }),
      ...(rawServer.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: rawServer.requestTimeoutMs }),
    };
    if (rawServer.oauth !== undefined) {
      oauth[name] = validateOAuthConfig(rawServer.oauth, `${serverSource}.oauth`);
    }
  }

  return {
    config: validateMcpConfig({
      mcpServers,
      ...(value.settings === undefined ? {} : { settings: value.settings }),
    }, source),
    oauth,
    warnings: [],
  };
}

function normalizeProjectMcpConfig(value: unknown, source: string): LocalMcpConfig {
  if (!isRecord(value)) {
    return emptyConfigWithWarning('Skipped project MCP config: root must be an object');
  }
  if (!isRecord(value.mcpServers)) {
    return emptyConfigWithWarning('Skipped project MCP config: mcpServers must be an object');
  }

  const warnings: string[] = [];
  const mcpServers: Record<string, McpConfig['mcpServers'][string]> = {};
  const oauth: Record<string, LocalMcpOAuthConfig> = {};
  for (const [name, rawServer] of Object.entries(value.mcpServers)) {
    const reason = unsupportedProjectServerReason(rawServer);
    if (reason !== undefined) {
      addWarning(warnings, `Skipped project MCP server ${boundedServerName(name)}: ${reason}`);
      continue;
    }

    const rawHttpServer = rawServer as Record<string, unknown>;
    const inferredTransport = rawHttpServer.type === 'sse'
      ? 'sse'
      : rawHttpServer.type === 'streamable-http' ? 'streamable-http' : undefined;
    const normalizedServer = {
      url: rawHttpServer.url,
      auth: rawHttpServer.auth ?? 'oauth',
      ...(rawHttpServer.httpTransport === undefined && inferredTransport === undefined
        ? {}
        : { httpTransport: rawHttpServer.httpTransport ?? inferredTransport }),
      ...(rawHttpServer.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: rawHttpServer.requestTimeoutMs }),
      ...(rawHttpServer.oauth === undefined ? {} : { oauth: rawHttpServer.oauth }),
    };
    try {
      const validated = validateLocalMcpConfig({
        mcpServers: { [name]: normalizedServer },
      }, source);
      const server = validated.config.mcpServers[name];
      if (server === undefined) continue;
      mcpServers[name] = server;
      const serverOAuth = validated.oauth[name];
      if (serverOAuth !== undefined) oauth[name] = serverOAuth;
    } catch {
      addWarning(warnings, `Skipped project MCP server ${boundedServerName(name)}: invalid OAuth HTTP configuration`);
    }
  }

  const settings = normalizeProjectSettings(value.settings, warnings);
  return {
    config: {
      mcpServers,
      ...(settings === undefined ? {} : { settings }),
    },
    oauth,
    warnings,
  };
}

function unsupportedProjectServerReason(value: unknown): string | undefined {
  if (!isRecord(value)) return 'server configuration must be an object';
  if (value.disabled === true) return 'server is disabled';
  if ('command' in value || 'args' in value) return 'stdio transport is unsupported';
  if ('headers' in value) return 'custom headers are unsupported';
  if ('socket' in value) return 'socket transport is unsupported';
  if (
    value.type !== undefined
    && value.type !== 'http'
    && value.type !== 'streamable-http'
    && value.type !== 'sse'
  ) return 'non-HTTP transport is unsupported';
  if (value.auth !== undefined && value.auth !== 'oauth') return 'non-OAuth authentication is unsupported';
  if (value.oauth === false) return 'OAuth is disabled';
  for (const field of Object.keys(value)) {
    if (!PROJECT_SERVER_FIELDS.has(field)) return 'server contains unsupported fields';
  }
  return undefined;
}

function normalizeProjectSettings(
  value: unknown,
  warnings: string[],
): McpConfig['settings'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    addWarning(warnings, 'Ignored project MCP settings: settings must be an object');
    return undefined;
  }
  if (value.requestTimeoutMs === undefined) return undefined;
  try {
    return validateMcpConfig({
      mcpServers: {},
      settings: { requestTimeoutMs: value.requestTimeoutMs },
    }).settings;
  } catch {
    addWarning(warnings, 'Ignored project MCP settings: invalid request timeout');
    return undefined;
  }
}

function mergeConfigs(agent: LocalMcpConfig, project: LocalMcpConfig): LocalMcpConfig {
  const mcpServers = { ...agent.config.mcpServers };
  const oauth = { ...agent.oauth };
  const warnings = [...agent.warnings, ...project.warnings].slice(0, MAX_WARNINGS);
  for (const [name, server] of Object.entries(project.config.mcpServers)) {
    if (!(name in mcpServers) && Object.keys(mcpServers).length >= MAX_SERVERS) {
      addWarning(warnings, 'Skipped project MCP server entry: maximum server count reached');
      continue;
    }
    mcpServers[name] = server;
    delete oauth[name];
    const projectOAuth = project.oauth[name];
    if (projectOAuth !== undefined) oauth[name] = projectOAuth;
  }

  const settings = agent.config.settings === undefined && project.config.settings === undefined
    ? undefined
    : { ...agent.config.settings, ...project.config.settings };
  return {
    config: validateMcpConfig({
      mcpServers,
      ...(settings === undefined ? {} : { settings }),
    }),
    oauth,
    warnings,
  };
}

function validateOAuthConfig(value: unknown, source: string): LocalMcpOAuthConfig {
  if (!isRecord(value)) throw new Error(`${source} must be an object`);
  rejectUnknownFields(value, OAUTH_FIELDS, source);
  if (value.grantType !== undefined && value.grantType !== 'authorization_code') {
    throw new Error(`${source}.grantType must be "authorization_code"`);
  }
  if (value.clientSecret !== undefined && value.clientSecretEnv !== undefined) {
    throw new Error(`${source} cannot set both clientSecret and clientSecretEnv`);
  }
  if (
    value.clientId === undefined
    && (value.clientSecret !== undefined || value.clientSecretEnv !== undefined)
  ) {
    throw new Error(`${source} requires clientId when a client secret is configured`);
  }
  if (
    value.clientSecretEnv !== undefined
    && (typeof value.clientSecretEnv !== 'string'
      || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value.clientSecretEnv.trim()))
  ) {
    throw new Error(`${source}.clientSecretEnv must be an environment variable name`);
  }

  const authorizationParams = value.authorizationParams === undefined
    ? undefined
    : validateAuthorizationParams(value.authorizationParams, `${source}.authorizationParams`);
  return {
    ...optionalString(value.clientId, `${source}.clientId`, 'clientId'),
    ...optionalString(value.clientSecret, `${source}.clientSecret`, 'clientSecret'),
    ...optionalString(value.clientSecretEnv, `${source}.clientSecretEnv`, 'clientSecretEnv'),
    ...optionalString(value.scope, `${source}.scope`, 'scope'),
    ...optionalString(value.redirectUri, `${source}.redirectUri`, 'redirectUri'),
    ...optionalString(value.clientName, `${source}.clientName`, 'clientName'),
    ...optionalString(value.clientUri, `${source}.clientUri`, 'clientUri'),
    ...(authorizationParams === undefined ? {} : { authorizationParams }),
  };
}

function validateAuthorizationParams(value: unknown, source: string): Readonly<Record<string, string>> {
  if (!isRecord(value)) throw new Error(`${source} must be an object`);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key) throw new Error(`${source} keys must not be empty`);
    if (RESERVED_AUTHORIZATION_PARAMS.has(key)) {
      throw new Error(`${source}.${key} cannot override an OAuth flow parameter`);
    }
    if (typeof item !== 'string') throw new Error(`${source}.${key} must be a string`);
    result[key] = item;
  }
  return result;
}

function optionalString<K extends keyof LocalMcpOAuthConfig>(
  value: unknown,
  source: string,
  key: K,
): Pick<LocalMcpOAuthConfig, K> | {} {
  if (value === undefined) return {};
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${source} must be a non-empty string`);
  }
  return { [key]: value.trim() } as Pick<LocalMcpOAuthConfig, K>;
}

function validateHttpTransport(value: unknown, source: string): 'streamable-http' | 'sse' {
  if (value !== 'streamable-http' && value !== 'sse') {
    throw new Error(`${source} must be streamable-http or sse`);
  }
  return value;
}

function emptyConfig(): LocalMcpConfig {
  return { config: { mcpServers: {} }, oauth: {}, warnings: [] };
}

function emptyConfigWithWarning(warning: string): LocalMcpConfig {
  return { config: { mcpServers: {} }, oauth: {}, warnings: [warning] };
}

function ensureConfigSize(content: Uint8Array, source: string): void {
  if (content.byteLength > MAX_CONFIG_BYTES) {
    throw new Error(`${source} exceeds the ${MAX_CONFIG_BYTES}-byte size limit`);
  }
}

function addWarning(warnings: string[], warning: string): void {
  if (warnings.length < MAX_WARNINGS) warnings.push(warning);
}

function boundedServerName(name: string): string {
  return JSON.stringify(name.slice(0, 128));
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

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
