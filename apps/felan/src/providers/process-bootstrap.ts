import { resolve } from 'node:path';
import type { AgentSessionRuntimeDiagnostic } from '@felan-ai/agent-core';
import { createDaemonSettingsManager } from './global-settings.js';

interface PiHttpBootstrap {
  readonly DEFAULT_HTTP_IDLE_TIMEOUT_MS: number;
  applyHttpProxySettings(proxy: string | undefined): void;
  configureHttpDispatcher(timeoutMs: number): void;
  parseHttpIdleTimeoutMs(value: unknown): number | undefined;
}

export interface DaemonProcessConfiguration {
  readonly diagnostics: readonly AgentSessionRuntimeDiagnostic[];
  assertConfiguration(settings: {
    readonly httpProxy?: unknown;
    readonly httpIdleTimeoutMs?: unknown;
  }): readonly AgentSessionRuntimeDiagnostic[];
}

let startup: { agentDir: string; promise: Promise<DaemonProcessConfiguration> } | undefined;

export function initializeLocalDaemonProcess(
  agentDir: string,
  loadHttp: () => Promise<PiHttpBootstrap> = loadPiHttpBootstrap,
): Promise<DaemonProcessConfiguration> {
  const directory = resolve(agentDir);
  if (startup) {
    if (startup.agentDir !== directory) throw new Error('The process agent directory is fixed; restart to change it');
    return startup.promise;
  }
  const promise = initialize(directory, loadHttp).catch((error) => {
    if (startup?.promise === promise) startup = undefined;
    throw error;
  });
  startup = { agentDir: directory, promise };
  return promise;
}

async function loadPiHttpBootstrap(): Promise<PiHttpBootstrap> {
  // Pinned Pi ships this private adapter but does not export it; the smoke test guards that boundary.
  return import(new URL('./core/http-dispatcher.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href);
}

async function initialize(
  agentDir: string,
  loadHttp: () => Promise<PiHttpBootstrap>,
): Promise<DaemonProcessConfiguration> {
  const settingsManager = createDaemonSettingsManager(agentDir, agentDir);
  const settings = settingsManager.getGlobalSettings();
  const diagnostics: AgentSessionRuntimeDiagnostic[] = settingsManager.drainErrors().map(({ scope }) => ({
    type: 'warning',
    message: `${scope} settings could not be loaded; using HTTP defaults.`,
  }));
  const http = await loadHttp();
  if (typeof http.applyHttpProxySettings !== 'function' || typeof http.configureHttpDispatcher !== 'function'
    || typeof http.parseHttpIdleTimeoutMs !== 'function' || !Number.isFinite(http.DEFAULT_HTTP_IDLE_TIMEOUT_MS)
    || http.DEFAULT_HTTP_IDLE_TIMEOUT_MS < 0) {
    throw new Error('The installed Pi HTTP bootstrap is incompatible with Felan');
  }
  const proxy = normalizeHttpProxy(settings.httpProxy, diagnostics);
  const timeoutMs = normalizeHttpIdleTimeout(settings.httpIdleTimeoutMs, http, diagnostics);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_SKIP_VERSION_CHECK = '1';
  process.env.PI_TELEMETRY = '0';
  http.applyHttpProxySettings(proxy);
  http.configureHttpDispatcher(timeoutMs);
  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    assertConfiguration(current: { readonly httpProxy?: unknown; readonly httpIdleTimeoutMs?: unknown }) {
      const proxyWarnings: AgentSessionRuntimeDiagnostic[] = [];
      const timeoutWarnings: AgentSessionRuntimeDiagnostic[] = [];
      const currentProxy = normalizeHttpProxy(current.httpProxy, proxyWarnings);
      const currentTimeoutMs = normalizeHttpIdleTimeout(current.httpIdleTimeoutMs, http, timeoutWarnings);
      if (proxyWarnings.length === 0 && currentProxy !== proxy) {
        throw new Error('HTTP proxy configuration changed; restart the daemon to apply it');
      }
      if (timeoutWarnings.length === 0 && currentTimeoutMs !== timeoutMs) {
        throw new Error('HTTP idle timeout configuration changed; restart the daemon to apply it');
      }
      return [...proxyWarnings, ...timeoutWarnings];
    },
  });
}

function normalizeHttpProxy(value: unknown, diagnostics?: AgentSessionRuntimeDiagnostic[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    const proxy = value.trim();
    if (!proxy) return undefined;
    try {
      const url = new URL(proxy);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname && !/[\x00-\x20\x7f]/u.test(proxy)) {
        return proxy;
      }
    } catch {}
  }
  diagnostics?.push({ type: 'warning', message: 'settings.json.httpProxy must be an HTTP(S) URL; ignoring it.' });
  return undefined;
}

function normalizeHttpIdleTimeout(
  value: unknown,
  http: PiHttpBootstrap,
  diagnostics?: AgentSessionRuntimeDiagnostic[],
): number {
  const timeoutMs = http.parseHttpIdleTimeoutMs(value);
  if (timeoutMs !== undefined) return timeoutMs;
  if (value !== undefined) {
    diagnostics?.push({ type: 'warning', message: 'settings.json.httpIdleTimeoutMs is invalid; using the default.' });
  }
  return http.DEFAULT_HTTP_IDLE_TIMEOUT_MS;
}
