import type { AgentRuntime } from '@felan-ai/agent-core';

const ENV_SOURCE = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/u;
const MAX_CREDENTIAL_BYTES = 16_384;
const COMMAND_TIMEOUT_MS = 5_000;
const COMMAND_ENVIRONMENT_NAMES = [
  'HOME',
  'USER',
  'LOGNAME',
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'SSH_AUTH_SOCK',
] as const;

export interface CredentialOptions {
  provider: string;
  configuredValue?: unknown;
  environmentName: string;
  runtime: AgentRuntime;
  signal?: AbortSignal;
}

export function hasCredentialSource(configuredValue: unknown, environmentName: string): boolean {
  return normalize(configuredValue) !== undefined || normalize(process.env[environmentName]) !== undefined;
}

export async function resolveCredential(options: CredentialOptions): Promise<string | undefined> {
  const configured = normalize(options.configuredValue);
  if (configured?.startsWith('$$') || configured?.startsWith('$!')) return configured.slice(1);

  if (configured?.startsWith('!')) {
    const command = configured.slice(1).trim();
    if (!command) throw new Error(`${options.provider} credential source is empty`);
    const environment = commandEnvironment(process.env);
    const isolatedCommand = [
      'env',
      '-i',
      ...Object.entries(environment).map(([name, value]) => `${name}=${shellQuote(value)}`),
      '/bin/sh',
      '-lc',
      shellQuote(command),
    ].join(' ');
    const result = await options.runtime.shell(isolatedCommand, {
      ...(options.signal ? { signal: options.signal } : {}),
      maxOutputBytes: MAX_CREDENTIAL_BYTES,
      shellFlavor: 'posix',
      timeout: COMMAND_TIMEOUT_MS,
    });
    if (options.signal?.aborted || result.killed) throw new Error(`${options.provider} credential command was aborted`);
    if (result.code !== 0) throw new Error(`${options.provider} credential command failed`);
    if (result.truncated || Buffer.byteLength(result.stdout, 'utf8') > MAX_CREDENTIAL_BYTES) {
      throw new Error(`${options.provider} credential command output is too large`);
    }
    const value = result.stdout.trim();
    if (!value) throw new Error(`${options.provider} credential command returned no value`);
    if (/[\0-\x1f\x7f]/u.test(value)) throw new Error(`${options.provider} credential command returned invalid output`);
    return value;
  }

  if (configured?.startsWith('$')) {
    const match = configured.match(ENV_SOURCE);
    const environmentName = match?.[1] ?? match?.[2];
    if (!environmentName) throw new Error(`${options.provider} credential source is invalid`);
    const value = normalize(process.env[environmentName]);
    if (!value) throw new Error(`${options.provider} credential environment variable is empty`);
    return value;
  }

  return normalize(process.env[options.environmentName]) ?? configured;
}

export function redactCredential(value: string, credential: string | undefined): string {
  return credential ? value.split(credential).join('[redacted]') : value;
}

function normalize(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function commandEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of COMMAND_ENVIRONMENT_NAMES) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && /^OP_SESSION_[A-Za-z0-9_]+$/u.test(name)) environment[name] = value;
  }
  return environment;
}
