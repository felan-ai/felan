import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse } from 'node:path';
import { Type, type Static } from 'typebox';
import { JsonValueSchema, assertJson, parseSchema, text } from '@felan-ai/session-protocol';
import { DaemonSecurityError } from './native-ownership.js';

const MAX_HOST_CONFIG_BYTES = 64 * 1024;
const ServiceSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 128, pattern: '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$' }),
  major: Type.Integer({ minimum: 1, maximum: 65_535 }),
  use: text(512, 1),
  options: Type.Optional(JsonValueSchema),
}, { additionalProperties: false });
const ExtensionSchema = Type.Object({
  package: text(256, 1), grants: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 128, uniqueItems: true })),
}, { additionalProperties: false });
const PolicySchema = Type.Object({
  projectTrust: Type.Optional(Type.Union([Type.Literal('allow'), Type.Literal('ask'), Type.Literal('deny')])),
  dependencyInstalls: Type.Optional(Type.Union([Type.Literal('allow'), Type.Literal('ask'), Type.Literal('deny')])),
  requireLocalConsole: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export const HostConfigSchema = Type.Object({
  version: Type.Literal(1),
  services: Type.Array(ServiceSchema, { maxItems: 128 }),
  extensions: Type.Array(ExtensionSchema, { maxItems: 256 }),
  policy: Type.Optional(PolicySchema),
}, { additionalProperties: false, 'x-maxEncodedBytes': MAX_HOST_CONFIG_BYTES });
export type HostConfig = Static<typeof HostConfigSchema>;

export interface HostConfigSource {
  readonly path: string;
  readonly kind: 'explicit' | 'agent-directory' | 'packaged-default';
}

export interface LoadedHostConfig {
  readonly config: HostConfig;
  readonly source: HostConfigSource;
  readonly digest: string;
}

export interface HostManager {
  readonly packageName: string;
  readonly version: string;
  readonly resolveFrom: string;
  readonly resolveProvider?: (specifier: string) => string;
  readonly packagedDefaultPath?: string;
}

export interface ResolvedHostProvider {
  readonly id: string;
  readonly major: number;
  readonly specifier: string;
  readonly moduleUrl: string;
  readonly options?: Static<typeof JsonValueSchema>;
}

export interface HostComposition {
  readonly managerPackage: string;
  readonly managerVersion: string;
  readonly providerDigest: string;
  readonly configDigest: string;
  readonly providers: readonly ResolvedHostProvider[];
}
export type HostCompositionInfo = Pick<HostComposition, 'managerPackage' | 'managerVersion' | 'providerDigest' | 'configDigest'> & { readonly restartRequired?: boolean };

export async function resolveHostComposition(config: LoadedHostConfig, manager: HostManager,
  resolveSpecifier: (specifier: string, resolveFrom: string) => string = (specifier, resolveFrom) => import.meta.resolve(specifier, resolveFrom)): Promise<HostComposition> {
  if (!validPackageSpecifier(manager.packageName) || manager.version.length < 1 || manager.version.length > 128) {
    throw new DaemonSecurityError('invalid_manager', 'Managing package identity is invalid.');
  }
  let anchor: URL;
  try { anchor = new URL(manager.resolveFrom); } catch { throw new DaemonSecurityError('invalid_manager', 'Managing package resolution anchor is invalid.'); }
  if (anchor.protocol !== 'file:') throw new DaemonSecurityError('invalid_manager', 'Managing package resolution anchor must be a file URL.');
  const resolved = new Map<string, string>();
  for (const service of config.config.services) {
    if (!resolved.has(service.use)) {
      let url: string;
      try { url = manager.resolveProvider ? manager.resolveProvider(service.use) : resolveSpecifier(service.use, anchor.href); }
      catch (error) {
        const reason = error instanceof Error ? `${error.name}: ${error.message}`.replace(/[\u0000-\u001f\u007f]/gu, '?').slice(0, 512) : 'resolution failed';
        throw new DaemonSecurityError('provider_unavailable', `Configured provider ${service.use} is not exported by the managing installation (${reason}).`);
      }
      if (!url.startsWith('file:')) throw new DaemonSecurityError('provider_unavailable', `Configured provider ${service.use} did not resolve to an installed file.`);
      resolved.set(service.use, url);
    }
  }
  const providers = config.config.services.map(service => Object.freeze({
    id: service.id, major: service.major, specifier: service.use, moduleUrl: resolved.get(service.use)!,
    ...(service.options === undefined ? {} : { options: service.options }),
  }));
  const resolvedProviders = [...resolved.entries()].sort(([a], [b]) => a.localeCompare(b));
  const providerDigest = createHash('sha256').update(JSON.stringify({ manager: [manager.packageName, manager.version], services: config.config.services, providers: resolvedProviders })).digest('hex');
  const configDigest = createHash('sha256').update(JSON.stringify({ manager: [manager.packageName, manager.version], config: config.config, providers: resolvedProviders })).digest('hex');
  return Object.freeze({ managerPackage: manager.packageName, managerVersion: manager.version, providerDigest, configDigest, providers: Object.freeze(providers) });
}

export async function loadHostConfig(options: {
  agentDir: string;
  explicitPath?: string;
  packagedDefaultPath?: string;
}): Promise<LoadedHostConfig> {
  let source: HostConfigSource;
  if (options.explicitPath !== undefined) {
    if (!isAbsolute(options.explicitPath)) throw new DaemonSecurityError('unsafe_host_config', 'Explicit host configuration must use an absolute path.');
    source = { kind: 'explicit', path: options.explicitPath };
  } else {
    const agentPath = join(options.agentDir, 'host.json');
    try {
      await lstat(agentPath);
      source = { kind: 'agent-directory', path: agentPath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!options.packagedDefaultPath || !isAbsolute(options.packagedDefaultPath)) {
        throw new DaemonSecurityError('host_config_missing', 'No host.json exists and the managing package supplied no default configuration.');
      }
      source = { kind: 'packaged-default', path: options.packagedDefaultPath };
    }
  }
  const bytes = await readTrustedConfigFile(source);
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString('utf8')); }
  catch { throw new DaemonSecurityError('invalid_host_config', 'host.json is not valid JSON.'); }
  let config: HostConfig;
  try { config = parseSchema(HostConfigSchema, raw); }
  catch (error) { throw new DaemonSecurityError('invalid_host_config', error instanceof Error ? error.message : 'host.json does not match the supported schema.'); }
  const providers = new Set<string>();
  for (const service of config.services) {
    if (!validPackageSpecifier(service.use)) throw new DaemonSecurityError('invalid_host_config', `Service ${service.id}@${service.major} must name an installed package export.`);
    const key = `${service.id}@${service.major}`;
    if (providers.has(key)) throw new DaemonSecurityError('invalid_host_config', `Service ${key} has more than one configured provider.`);
    providers.add(key);
  }
  const extensions = new Set<string>();
  for (const extension of config.extensions) {
    if (!validPackageSpecifier(extension.package)) throw new DaemonSecurityError('invalid_host_config', 'Extensions must name installed package exports.');
    if (extensions.has(extension.package)) throw new DaemonSecurityError('invalid_host_config', `Extension ${extension.package} is duplicated.`);
    extensions.add(extension.package);
    if (extension.grants?.some(grant => !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*@[1-9][0-9]{0,4}$/u.test(grant))) {
      throw new DaemonSecurityError('invalid_host_config', `Extension ${extension.package} has an invalid service grant.`);
    }
  }
  assertJson(config, MAX_HOST_CONFIG_BYTES);
  rejectCredentialValues(config);
  const normalized = Buffer.from(JSON.stringify(config));
  return Object.freeze({ config, source, digest: createHash('sha256').update(normalized).digest('hex') });
}

function rejectCredentialValues(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/(?:password|secret|token|api.?key|credential|private.?key)/iu.test(key)) {
      throw new DaemonSecurityError('invalid_host_config', 'host.json cannot contain credential values; configure a host-owned secret service.');
    }
    rejectCredentialValues(child);
  }
}

export function validPackageSpecifier(specifier: string): boolean {
  if (specifier.length > 512 || specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes('\\') || specifier.includes(':')) return false;
  const segments = specifier.split('/');
  if (segments.some(segment => segment === '.' || segment === '..' || segment.length === 0)) return false;
  if (specifier.startsWith('@')) return segments.length >= 2 && /^@[A-Za-z0-9._-]+$/u.test(segments[0]!) && /^[A-Za-z0-9._-]+$/u.test(segments[1]!) && segments.slice(2).every(isExportSegment);
  return /^[A-Za-z0-9._-]+$/u.test(segments[0]!) && segments.slice(1).every(isExportSegment);
}

function isExportSegment(value: string): boolean { return /^[A-Za-z0-9._~-]+$/u.test(value); }

async function readTrustedConfigFile(source: HostConfigSource): Promise<Buffer> {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    throw new DaemonSecurityError('unsupported_platform', 'Host configuration ownership cannot be verified on this platform.');
  }
  const uid = process.getuid();
  const canonical = await realpath(source.path).catch(() => { throw new DaemonSecurityError('unsafe_host_config', 'host.json path is unavailable.'); });
  if (canonical !== source.path) throw new DaemonSecurityError('unsafe_host_config', 'host.json must not traverse symlinked paths.');
  for (let path = dirname(source.path);; path = dirname(path)) {
    const parent = await lstat(path);
    if (!parent.isDirectory() || parent.uid !== uid && parent.uid !== 0 || (parent.mode & 0o022) !== 0) {
      throw new DaemonSecurityError('unsafe_host_config', 'host.json parent directories must be trusted, non-symlinked and not group/world writable.');
    }
    if (path === parse(path).root) break;
  }
  const initial = await lstat(source.path);
  if (!initial.isFile() || initial.nlink !== 1 || initial.size > MAX_HOST_CONFIG_BYTES
    || (initial.uid !== uid && !(source.kind === 'packaged-default' && initial.uid === 0))
    || (initial.mode & 0o022) !== 0) {
    throw new DaemonSecurityError('unsafe_host_config', 'host.json must be a bounded, owner-controlled regular file, not a link.');
  }
  const handle = await open(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino || opened.uid !== initial.uid
      || opened.mode !== initial.mode || (opened.mode & 0o022) !== 0 || opened.size > MAX_HOST_CONFIG_BYTES || opened.nlink !== 1) {
      throw new DaemonSecurityError('unsafe_host_config', 'host.json changed while being opened.');
    }
    const bytes = await handle.readFile();
    if (bytes.length > MAX_HOST_CONFIG_BYTES) throw new DaemonSecurityError('invalid_host_config', 'host.json exceeds 64 KiB.');
    if (!isUtf8(bytes)) throw new DaemonSecurityError('invalid_host_config', 'host.json must be valid UTF-8.');
    return bytes;
  } finally { await handle.close(); }
}
