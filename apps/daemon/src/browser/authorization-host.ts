import type { BrowserAuthorizationHost, BrowserAuthorizationRequest } from '@felan-ai/ext-browser';
import type { BrowserAuthorizationPolicy } from '@felan-ai/ext-browser';
import type { AgentRuntime } from '@felan-ai/agent-core';
import type { BrowserAuthorizationPresentationFactory } from '@felan-ai/ext-browser/presentation';
import { assertAgentBrowserEnvironment, inspectChromeRemoteDebugging, type ChromePreflight } from './chrome-devtools.js';
import { createChromeConnectionLease, type ChromeConnectionLease } from './connection-lease.js';

export interface LocalBrowserAuthorizationDependencies {
  readonly runtime?: AgentRuntime;
  readonly authorizationPolicy?: BrowserAuthorizationPolicy;
  readonly getAuthorizationPolicy?: () => BrowserAuthorizationPolicy;
  readonly persistAuthorizationPolicy?: (policy: BrowserAuthorizationPolicy) => Promise<void>;
  readonly onAttention?: (active: boolean, label?: string) => void;
  readonly presentation?: BrowserAuthorizationPresentationFactory;
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
  const presentation = dependencies.presentation?.(context);
  if (!context.hasUI || !presentation) {
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
    dependencies.onAttention?.(true, 'Authorize existing Chrome');
    const policy = dependencies.getAuthorizationPolicy?.() ?? dependencies.authorizationPolicy ?? 'ask';
    if (policy !== 'always-allow') {
      const selected = await presentation.consent(request.origin, request.reason, request.signal);
      if (!selected || request.signal.aborted) {
        return { status: 'cancelled', message: 'Existing-browser authorization was declined.' };
      }
      if (selected === 'always') {
        try {
          await dependencies.persistAuthorizationPolicy?.('always-allow');
        } catch {
          context.ui.notify('Always-allow could not be saved; this authorization will apply once.', 'warning');
        }
      }
    }
    context.ui.setStatus('browser-authorization', `… Checking Chrome for ${request.origin}`);
    const inspect = dependencies.inspect ?? ((signal: AbortSignal) => inspectChromeRemoteDebugging(signal, {
      ...(dependencies.runtime ? { runtime: dependencies.runtime } : {}),
    }));
    let preflight = await inspect(request.signal);
    request.signal.throwIfAborted();
    if (preflight.state === 'disabled') {
      const processId = preflight.processId;
      context.ui.notify('Chrome remote debugging is disabled. Enable it once in Chrome, then continue.', 'info');
      if (!await presentation.openSetup(preflight.applicationPath, request.signal)) return { status: 'cancelled', message: 'Chrome setup was cancelled.' };
      request.signal.throwIfAborted();
      const retry = await presentation.ready(request.signal);
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

