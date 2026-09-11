import type { BrowserAuthorizationHost, BrowserAuthorizationRequest } from '@felan-ai/ext-browser';
import type { AgentRuntime } from '@felan-ai/agent-core';
import { assertAgentBrowserEnvironment, inspectChromeRemoteDebugging, type ChromePreflight } from './chrome-devtools.js';
import { createChromeConnectionLease, type ChromeConnectionLease } from './connection-lease.js';

const CHROME_REMOTE_DEBUGGING_URL = 'chrome://inspect/#remote-debugging';

export interface LocalBrowserAuthorizationDependencies {
  readonly runtime?: AgentRuntime;
  readonly onAttention?: (active: boolean, label?: string) => void;
  readonly openSetup?: (applicationPath: string, signal: AbortSignal) => Promise<void>;
  readonly inspect?: (signal: AbortSignal) => Promise<ChromePreflight>;
  readonly createLease?: typeof createChromeConnectionLease;
}

export function createLocalBrowserAuthorizationHost(
  dependencies: LocalBrowserAuthorizationDependencies = {},
): BrowserAuthorizationHost {
  return {
    checkExecution: () => assertAgentBrowserEnvironment(),
    authorize: (request) => authorize(request, dependencies),
  };
}

async function authorize(
  request: BrowserAuthorizationRequest,
  dependencies: LocalBrowserAuthorizationDependencies,
): Promise<{ status: 'authorized' | 'cancelled' | 'unavailable'; message?: string }> {
  const context = request.extensionContext;
  if (!context.hasUI || context.mode !== 'tui') {
    return {
      status: 'unavailable',
      message: 'Existing-browser authorization requires the local interactive TUI.',
    };
  }
  if (dependencies.runtime && dependencies.runtime.kind !== 'host') {
    return { status: 'unavailable', message: 'Existing-Chrome authorization requires the local host runtime.' };
  }

  if (request.signal.aborted) return { status: 'cancelled' };
  let lease: ChromeConnectionLease | undefined;
  let authorized = false;
  try {
    dependencies.onAttention?.(true, `Authorize Chrome for ${request.origin}`);
    const approved = await context.ui.confirm(
      'Authorize existing Chrome?',
      `Allow Felan to use your current Chrome for ${request.origin}? Chrome grants browser-wide debugging authority; Felan restricts its tools to one fresh tab. Approve the single Chrome prompt when it appears.`,
      { signal: request.signal },
    );
    if (!approved || request.signal.aborted) return { status: 'cancelled', message: 'Existing-browser authorization was declined.' };
    context.ui.setStatus('browser-authorization', `… Checking Chrome for ${request.origin}`);
    const inspect = dependencies.inspect ?? ((signal: AbortSignal) => inspectChromeRemoteDebugging(signal, {
      ...(dependencies.runtime ? { runtime: dependencies.runtime } : {}),
    }));
    let preflight = await inspect(request.signal);
    request.signal.throwIfAborted();
    if (preflight.state === 'disabled') {
      const processId = preflight.processId;
      context.ui.notify('Chrome remote debugging is disabled. Enable it once in Chrome, then continue.', 'info');
      const openSetup = dependencies.openSetup ?? ((applicationPath: string, signal: AbortSignal) => (
        openChromeRemoteDebuggingSettings(dependencies.runtime, applicationPath, signal)
      ));
      await openSetup(preflight.applicationPath, request.signal);
      request.signal.throwIfAborted();
      const retry = await context.ui.confirm(
        'Continue Chrome authorization?',
        'Enable remote debugging if it is off. Leave an already-enabled setting unchanged. Continue when ready for one connection attempt.',
        { signal: request.signal },
      );
      if (!retry) return { status: 'cancelled', message: 'Existing-browser authorization retry was cancelled.' };
      request.signal.throwIfAborted();
      preflight = await inspect(request.signal);
      if (preflight.state !== 'unavailable' && preflight.processId !== processId) {
        return { status: 'unavailable', message: 'Chrome was replaced during setup. Request authorization again.' };
      }
    }
    request.signal.throwIfAborted();
    if (preflight.state !== 'ready') {
      const message = preflight.state === 'unavailable' ? preflight.reason : 'Chrome remote debugging is still disabled.';
      context.ui.notify(message, 'warning');
      return { status: 'unavailable', message };
    }
    lease = await (dependencies.createLease ?? createChromeConnectionLease)(preflight.connection, request.signal);
    request.signal.throwIfAborted();
    context.ui.setStatus('browser-authorization', `… Waiting for Chrome approval for ${request.origin}`);
    const attached = await request.attach(lease.connection, lease);
    request.signal.throwIfAborted();
    if (!attached.ready || !lease.connected || lease.signal.aborted) {
      return { status: 'unavailable', message: attached.reason ?? 'Chrome rejected the connection.' };
    }
    authorized = true;
    return { status: 'authorized' };
  } catch {
    if (request.signal.aborted) return { status: 'cancelled', message: 'Existing-browser authorization was cancelled.' };
    return { status: 'unavailable', message: 'Chrome authorization could not be completed.' };
  } finally {
    let closing: Promise<void> | undefined;
    let cleanupFailed = false;
    if (!authorized && lease) {
      try { closing = lease.close(); }
      catch { cleanupFailed = true; }
    }
    try { context.ui.setStatus('browser-authorization', undefined); } catch {}
    try { dependencies.onAttention?.(false); } catch {}
    try { await closing; } catch { cleanupFailed = true; }
    if (cleanupFailed) throw new Error('Chrome connection cleanup could not be confirmed.');
  }
}

async function openChromeRemoteDebuggingSettings(runtime: AgentRuntime | undefined, applicationPath: string, signal: AbortSignal): Promise<void> {
  if (!runtime || runtime.kind !== 'host') throw new Error('Chrome setup requires the local host runtime.');
  signal.throwIfAborted();
  const result = await runtime.exec('/usr/bin/open', ['-a', applicationPath, CHROME_REMOTE_DEBUGGING_URL], {
    signal, timeout: 5_000, maxOutputBytes: 4_096,
  });
  signal.throwIfAborted();
  if (result.code !== 0 || result.killed || result.truncated) throw new Error('Chrome setup could not be opened.');
}
