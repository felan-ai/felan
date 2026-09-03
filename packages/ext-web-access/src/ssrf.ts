import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { WebAccessConfig } from './config.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 5;

export type LookupAddress = { address: string; family: number };
export type Lookup = (hostname: string) => Promise<LookupAddress[]>;

export interface SsrfSettings {
  allowRanges: string[];
  domainPolicy: {
    allow: string[];
    deny: string[];
  };
}

interface ParsedCidr {
  bytes: Uint8Array;
  prefix: number;
}

interface ValidateOptions {
  lookup?: Lookup;
  signal?: AbortSignal;
}

type PinnedFetchInit = RequestInit & { dispatcher?: Dispatcher };
type FetchImplementation = (input: string | URL, init?: PinnedFetchInit) => Promise<Response>;

interface FetchOptions extends ValidateOptions {
  fetchImpl?: FetchImplementation;
  dispatcherFactory?: (hostname: string, addresses: LookupAddress[]) => Dispatcher;
  maxRedirects?: number;
  allowCrossOriginRedirects?: boolean;
  onRedirect?: (from: URL, to: URL, init: RequestInit) => RequestInit;
}

const BLOCKED_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::/128',
  '::1/128',
  '64:ff9b:1::/48',
  '100::/64',
  '2001:db8::/32',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
].map((value) => parseCidr(value)!);

export function ssrfSettings(config: WebAccessConfig): SsrfSettings {
  const allowRanges = stringArray(config.ssrf?.allowRanges, 'ssrf.allowRanges');
  for (const range of allowRanges) {
    if (!parseCidr(range)) throw new Error(`Invalid CIDR in ssrf.allowRanges: ${range}`);
  }
  return {
    allowRanges,
    domainPolicy: {
      allow: domainArray(config.fetchContent?.domainPolicy?.allow, 'fetchContent.domainPolicy.allow'),
      deny: domainArray(config.fetchContent?.domainPolicy?.deny, 'fetchContent.domainPolicy.deny'),
    },
  };
}

export function endpointSsrfSettings(config: WebAccessConfig): SsrfSettings {
  return { ...ssrfSettings(config), domainPolicy: { allow: [], deny: [] } };
}

export async function validateRemoteUrl(
  input: string | URL,
  settings: SsrfSettings,
  options: ValidateOptions = {},
): Promise<URL> {
  return (await resolveRemoteUrl(input, settings, options)).url;
}

async function resolveRemoteUrl(
  input: string | URL,
  settings: SsrfSettings,
  options: ValidateOptions,
): Promise<{ url: URL; addresses: LookupAddress[] }> {
  let url: URL;
  try {
    url = input instanceof URL ? input : new URL(input);
  } catch {
    throw new Error('URL must be an absolute HTTP(S) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only HTTP and HTTPS URLs are supported');
  if (url.username || url.password) throw new Error('URLs with embedded credentials are not supported');

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) throw new Error('URL must include a hostname');
  assertDomainPolicy(hostname, settings.domainPolicy);
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) throw new Error(`Blocked internal hostname: ${hostname}`);

  const allowed = settings.allowRanges.map((value) => {
    const parsed = parseCidr(value);
    if (!parsed) throw new Error(`Invalid CIDR in ssrf.allowRanges: ${value}`);
    return parsed;
  });
  const addresses = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) }]
    : await lookupAddresses(hostname, options.lookup ?? defaultLookup, options.signal);
  if (addresses.length === 0) throw new Error(`Failed to resolve ${hostname}: no addresses returned`);
  for (const address of addresses) assertPublicAddress(address.address, hostname, allowed);
  return { url, addresses };
}

export async function fetchRemoteUrl(
  input: string | URL,
  init: RequestInit,
  settings: SsrfSettings,
  options: FetchOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? (undiciFetch as unknown as FetchImplementation);
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let resolved = await resolveRemoteUrl(input, settings, {
    ...options,
    ...(init.signal ? { signal: init.signal } : {}),
  });
  let url = resolved.url;
  let requestInit = init;

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const dispatcher = (options.dispatcherFactory ?? createPinnedDispatcher)(hostnameForLookup(url), resolved.addresses);
    let response: Response;
    try {
      response = await fetchImpl(url, { ...requestInit, redirect: 'manual', dispatcher });
    } catch (error) {
      await dispatcher.destroy();
      if (requestInit.signal?.aborted) throw requestInit.signal.reason ?? error;
      throw new Error(`Remote request failed for ${url.hostname}`);
    }
    void dispatcher.close().catch(() => undefined);
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    if (redirects === maxRedirects) throw new Error(`Too many redirects fetching ${url.toString()}`);
    await response.body?.cancel();

    const from = url;
    resolved = await resolveRemoteUrl(new URL(location, url), settings, {
      ...options,
      ...(requestInit.signal ? { signal: requestInit.signal } : {}),
    });
    url = resolved.url;
    if (from.origin !== url.origin && options.allowCrossOriginRedirects === false) {
      throw new Error(`Cross-origin redirect blocked: ${from.origin} to ${url.origin}`);
    }
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && requestInit.method?.toUpperCase() === 'POST')) {
      const { body: _body, ...withoutBody } = requestInit;
      requestInit = { ...withoutBody, method: 'GET' };
    }
    requestInit = options.onRedirect
      ? options.onRedirect(from, url, requestInit)
      : stripCrossOriginCredentials(from, url, requestInit);
  }
  throw new Error('Too many redirects');
}

async function defaultLookup(hostname: string): Promise<LookupAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

async function lookupAddresses(
  hostname: string,
  lookup: Lookup,
  signal?: AbortSignal,
): Promise<LookupAddress[]> {
  try {
    return await waitForLookup(lookup(hostname), signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw new Error(`Failed to resolve ${hostname}: ${errorMessage(error)}`);
  }
}

async function waitForLookup<T>(lookup: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return lookup;
  if (signal.aborted) throw signal.reason ?? new Error('DNS lookup was cancelled');
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new Error('DNS lookup was cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    void lookup.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

export function createPinnedLookup(hostname: string, addresses: LookupAddress[]): net.LookupFunction {
  const expected = hostnameForLookup(hostname);
  const pinned = addresses.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
  return ((requested: string, options: { family?: number; all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (hostnameForLookup(requested) !== expected) {
      callback(new Error('Pinned DNS lookup hostname mismatch'), '', 4);
      return;
    }
    const family = options.family;
    const matches = family === 4 || family === 6 ? pinned.filter((entry) => entry.family === family) : pinned;
    if (matches.length === 0) {
      callback(new Error('Pinned DNS lookup has no matching address'), '', 4);
      return;
    }
    if (options.all) callback(null, matches);
    else callback(null, matches[0]!.address, matches[0]!.family);
  }) as net.LookupFunction;
}

function createPinnedDispatcher(hostname: string, addresses: LookupAddress[]): Dispatcher {
  return new Agent({ connect: { lookup: createPinnedLookup(hostname, addresses) } });
}

function assertPublicAddress(address: string, hostname: string, allowed: ParsedCidr[]): void {
  const normalized = normalizeHostname(address);
  const version = net.isIP(normalized);
  if (!version) throw new Error(`Resolved non-IP address for ${hostname}`);
  const bytes = ipBytes(normalized, version);
  if (!bytes) throw new Error(`Resolved invalid address for ${hostname}`);
  if (allowed.some((rule) => rule.bytes.length === bytes.length && prefixMatches(bytes, rule))) return;
  if (version === 6 && bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    assertPublicAddress(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`, hostname, allowed);
    return;
  }
  if (version === 6 && bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes.slice(4, 12).every((byte) => byte === 0)) {
    assertPublicAddress(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`, hostname, allowed);
    return;
  }
  if (version === 6 && bytes[0] === 0x20 && bytes[1] === 0x02) {
    assertPublicAddress(`${bytes[2]}.${bytes[3]}.${bytes[4]}.${bytes[5]}`, hostname, allowed);
    return;
  }
  if (BLOCKED_CIDRS.some((rule) => rule.bytes.length === bytes.length && prefixMatches(bytes, rule))) {
    throw new Error(`Blocked internal address for ${hostname}: ${normalized}`);
  }
}

function stripCrossOriginCredentials(from: URL, to: URL, init: RequestInit): RequestInit {
  if (from.origin === to.origin || !init.headers) return init;
  const headers = new Headers(init.headers);
  for (const name of [...headers.keys()]) {
    const lower = name.toLowerCase();
    if (
      lower === 'authorization'
      || lower === 'proxy-authorization'
      || lower === 'cookie'
      || lower === 'x-api-key'
      || lower === 'x-subscription-token'
      || lower === 'chatgpt-account-id'
      || lower.startsWith('cf-access-')
    ) headers.delete(name);
  }
  return { ...init, headers };
}

function assertDomainPolicy(hostname: string, policy: SsrfSettings['domainPolicy']): void {
  if (policy.deny.some((domain) => matchesDomain(hostname, domain))) {
    throw new Error(`Blocked hostname by fetch_content domain policy: ${hostname}`);
  }
  if (policy.allow.length > 0 && !policy.allow.some((domain) => matchesDomain(hostname, domain))) {
    throw new Error(`Hostname not allowed by fetch_content domain policy: ${hostname}`);
  }
}

function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function domainArray(value: unknown, label: string): string[] {
  const values = stringArray(value, label);
  return values.map((entry) => {
    const normalized = normalizeHostname(entry);
    if (!normalized || /[\s\\/?:#@]/u.test(normalized)) throw new Error(`${label} contains an invalid hostname`);
    return normalized;
  });
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new Error(`${label} must be an array of strings`);
  return value.map((entry) => (entry as string).trim()).filter(Boolean);
}

function parseCidr(value: string): ParsedCidr | undefined {
  const slash = value.lastIndexOf('/');
  const address = slash === -1 ? value : value.slice(0, slash);
  const prefixText = slash === -1 ? undefined : value.slice(slash + 1);
  if (prefixText !== undefined && !/^\d+$/u.test(prefixText)) return undefined;
  const version = net.isIP(address);
  if (!version) return undefined;
  const bytes = ipBytes(address, version);
  if (!bytes) return undefined;
  const maximum = version === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? maximum : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 1 || prefix > maximum) return undefined;
  return { bytes, prefix };
}

function ipBytes(address: string, version: number): Uint8Array | undefined {
  if (version === 4) {
    const values = address.split('.').map(Number);
    return values.length === 4 && values.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
      ? Uint8Array.from(values)
      : undefined;
  }
  const groups = ipv6Groups(address);
  if (!groups) return undefined;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

function ipv6Groups(input: string): number[] | undefined {
  let address = input.toLowerCase();
  if (address.includes('.')) {
    const colon = address.lastIndexOf(':');
    const ipv4 = address.slice(colon + 1);
    const bytes = ipBytes(ipv4, 4);
    if (!bytes) return undefined;
    address = `${address.slice(0, colon)}:${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${((bytes[2]! << 8) | bytes[3]!).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right].map((part) => /^[0-9a-f]{1,4}$/u.test(part) ? Number.parseInt(part, 16) : -1);
  return groups.length === 8 && groups.every((group) => group >= 0) ? groups : undefined;
}

function prefixMatches(address: Uint8Array, rule: ParsedCidr): boolean {
  const fullBytes = Math.floor(rule.prefix / 8);
  const remaining = rule.prefix % 8;
  for (let index = 0; index < fullBytes; index += 1) {
    if (address[index] !== rule.bytes[index]) return false;
  }
  if (remaining === 0) return true;
  const mask = (0xff << (8 - remaining)) & 0xff;
  return (address[fullBytes]! & mask) === (rule.bytes[fullBytes]! & mask);
}

function normalizeHostname(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
}

function hostnameForLookup(value: string | URL): string {
  return normalizeHostname(value instanceof URL ? value.hostname : value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
