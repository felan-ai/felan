import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentRuntime } from '@felan-ai/agent-core';
import type { BrowserAuthorizationConnection } from '@felan-ai/ext-browser';

const MAX_ACTIVE_PORT_BYTES = 4_096;
const MAX_LOCAL_STATE_BYTES = 2 * 1024 * 1024;

export type ChromePreflight =
  | { readonly state: 'ready'; readonly processId: number; readonly connection: BrowserAuthorizationConnection }
  | { readonly state: 'disabled'; readonly processId: number; readonly applicationPath: string }
  | { readonly state: 'unavailable'; readonly reason: string };

export interface ChromeDevToolsDiscoveryOptions {
  readonly runtime?: AgentRuntime;
  readonly homeDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly operatingSystem?: NodeJS.Platform;
  readonly userId?: number;
  readonly run?: (command: string, args: readonly string[], signal: AbortSignal) => Promise<string>;
}

export function assertAgentBrowserEnvironment(environment: Readonly<Record<string, string | undefined>> = process.env): void {
  if (Object.entries(environment).some(([name, value]) => name.toUpperCase().startsWith('AGENT_BROWSER_') && value !== undefined)) {
    throw new Error('Browser execution is unavailable with inherited agent-browser configuration. Start Felan without those overrides.');
  }
}

export async function inspectChromeRemoteDebugging(
  signal: AbortSignal,
  options: ChromeDevToolsDiscoveryOptions = {},
): Promise<ChromePreflight> {
  signal.throwIfAborted();
  const os = options.operatingSystem ?? platform();
  const userId = options.userId ?? process.getuid?.();
  if (os !== 'darwin' || userId === undefined) {
    return unavailable('Existing-Chrome ownership verification is currently available only on macOS.');
  }
  const env = options.environment ?? process.env;
  try { assertAgentBrowserEnvironment(env); }
  catch { return unavailable('Existing-Chrome access is unavailable with inherited agent-browser configuration. Start Felan without those overrides.'); }
  const home = options.homeDirectory ?? homedir();
  const runtime = options.runtime;
  const run = options.run ?? (runtime?.kind === 'host'
    ? (command: string, args: readonly string[], currentSignal: AbortSignal) => runReadOnlyCommand(runtime, command, args, currentSignal)
    : undefined);
  if (!run) return unavailable('This host cannot verify ownership of local Chrome.');
  try {
    const processes = await run('/bin/ps', ['-ww', '-u', String(userId), '-o', 'pid=,uid=,comm='], signal);
    const applications = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    ];
    const ids = processes.split('\n').flatMap(line => {
      const match = /^\s*([0-9]+)\s+([0-9]+)\s+(.+)$/u.exec(line);
      return match && Number(match[2]) === userId && applications.includes(match[3]!)
        ? [{ processId: Number(match[1]), executable: match[3]! }] : [];
    });
    if (ids.length !== 1) return unavailable(ids.length ? 'More than one Chrome instance was found. Keep only the intended instance available before authorizing.' : 'Your regular Chrome is not running. Open it before requesting authorization.');
    const { processId, executable } = ids[0]!;
    const applicationPath = dirname(dirname(dirname(executable)));
    if (!Number.isSafeInteger(processId) || processId <= 0) return unavailable('Chrome process ownership could not be verified.');
    const command = await run('/bin/ps', ['-ww', '-p', String(processId), '-o', 'command='], signal);
    if (/(?:^|\s)--user-data-dir(?:=|\s|$)/u.test(command)) return unavailable('Custom Chrome user-data directories are not supported by this authorization flow.');
    if (/(?:^|\s)--remote-debugging-(?:port|pipe)(?:=|\s|$)/u.test(command)) return unavailable('Use Chrome’s permission-based remote-debugging setting, not command-line debugging, for this authorization flow.');
    const version = (await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(dirname(dirname(executable)), 'Info.plist')], signal)).trim();
    if (!/^\d+\.\d+\.\d+\.\d+$/u.test(version) || Number(version.split('.')[0]) < 144) {
      return unavailable('Existing-browser authorization requires Chrome 144 or later.');
    }

    const root = join(await realpath(home), 'Library', 'Application Support', 'Google', 'Chrome');
    const rootMetadata = await lstat(root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || rootMetadata.uid !== userId || await realpath(root) !== root) {
      return unavailable('Chrome’s default data directory ownership or location could not be verified.');
    }
    const preferences = await readPrivateFile(join(root, 'Local State'), MAX_LOCAL_STATE_BYTES, userId);
    if (!preferences) return unavailable('Chrome debugging settings could not be verified. Check the remote-debugging page without changing an already-enabled setting.');
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(preferences));
    if (!record(parsed)) return unavailable('Chrome debugging settings are invalid.');
    const devtools = record(parsed)?.devtools;
    if (devtools !== undefined && !record(devtools)) return unavailable('Chrome debugging settings are invalid.');
    const rawDebugging = record(devtools)?.remote_debugging;
    if (rawDebugging !== undefined && !record(rawDebugging)) return unavailable('Chrome debugging settings are invalid.');
    const debugging = record(record(devtools)?.remote_debugging);
    if (debugging?.allowed === false) return unavailable('Chrome remote debugging is disabled by policy.');
    if (debugging?.allowed !== undefined && typeof debugging.allowed !== 'boolean') return unavailable('Chrome debugging settings are invalid.');
    const enabled = debugging?.['user-enabled'];
    if (enabled !== undefined && typeof enabled !== 'boolean') return unavailable('Chrome debugging settings are invalid.');

    const listeners = await run('/usr/sbin/lsof', ['-nP', '-a', '-p', String(processId), '-iTCP', '-sTCP:LISTEN', '-Fpn'], signal);
    let owner: number | undefined;
    const ports = [...new Set(listeners.split('\n').flatMap(line => {
      if (/^p[0-9]+$/u.test(line)) owner = Number(line.slice(1));
      const match = /^n127\.0\.0\.1:([0-9]+)$/u.exec(line);
      const port = match ? Number(match[1]) : 0;
      return owner === processId && port > 0 && port <= 65_535 ? [port] : [];
    }))];
    if (enabled !== true) {
      return ports.length ? unavailable('Chrome settings and its running listener disagree. No settings were changed; check Chrome before authorizing again.') : { state: 'disabled', processId, applicationPath };
    }
    if (!listeners.split('\n').includes(`p${processId}`) || ports.length === 0) {
      return unavailable('Chrome debugging is enabled, but its loopback listener is unavailable. Leave the setting enabled; no connection was attempted.');
    }
    const content = await readPrivateFile(join(root, 'DevToolsActivePort'), MAX_ACTIVE_PORT_BYTES, userId);
    const advertised = content ? parseDevToolsActivePort(content) : undefined;
    if (advertised && ports.includes(advertised.port)) {
      signal.throwIfAborted();
      return { state: 'ready', processId, connection: advertised };
    }
    if (ports.length !== 1) return unavailable('Chrome has multiple loopback listeners and the debugging endpoint cannot be identified safely.');
    signal.throwIfAborted();
    return { state: 'ready', processId, connection: { port: ports[0]!, webSocketPath: '/devtools/browser' } };
  } catch {
    signal.throwIfAborted();
    return unavailable('Chrome debugging readiness could not be verified. No connection was attempted.');
  }
}

export function parseDevToolsActivePort(content: Uint8Array | string): BrowserAuthorizationConnection | undefined {
  try {
    const text = typeof content === 'string' ? content : new TextDecoder('utf-8', { fatal: true }).decode(content);
    if (new TextEncoder().encode(text).byteLength > MAX_ACTIVE_PORT_BYTES || /[\0\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) return undefined;
    const lines = text.replace(/\r\n?/gu, '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines.length !== 2 || !/^[1-9][0-9]{0,4}$/u.test(lines[0]!)
      || !/^\/devtools\/browser(?:\/(?!\.{1,2}$)[A-Za-z0-9._-]+)?$/u.test(lines[1]!)) return undefined;
    const port = Number(lines[0]);
    return port <= 65_535 ? { port, webSocketPath: lines[1]! } : undefined;
  } catch { return undefined; }
}

async function readPrivateFile(path: string, maximum: number, userId: number): Promise<Uint8Array | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Chrome metadata is inaccessible.');
  }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.uid !== userId || metadata.nlink !== 1 || metadata.size > maximum) throw new Error('Chrome metadata is unsafe.');
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > maximum) throw new Error('Chrome metadata exceeds its size limit.');
    return buffer.subarray(0, length);
  } finally { await file.close(); }
}

async function runReadOnlyCommand(runtime: AgentRuntime, command: string, args: readonly string[], signal: AbortSignal): Promise<string> {
  const result = await runtime.exec(command, args, { signal, timeout: 3_000, maxOutputBytes: 65_536 });
  signal.throwIfAborted();
  if (result.killed || result.truncated) throw new Error('Chrome process inspection was interrupted.');
  if (result.code === 0) return result.stdout;
  if (command === '/usr/sbin/lsof' && result.code === 1 && !result.stdout) return '';
  throw new Error('Chrome process inspection failed.');
}

function unavailable(reason: string): ChromePreflight {
  return { state: 'unavailable', reason };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
