import type { AgentRuntime } from '@felan-ai/agent-core';
import { stripVTControlCharacters } from 'node:util';
import { CHROME_ACCESS_MESSAGE, CHROME_READY_MESSAGE, type BrowserAuthorizationPresentationFactory } from '@felan-ai/ext-browser/presentation';

export function createLegacyBrowserPresentation(runtime: AgentRuntime): BrowserAuthorizationPresentationFactory {
  return context => {
    if (!context.hasUI || context.mode !== 'tui') return undefined;
    return {
      async consent(origin, reason, signal) {
        const message = stripVTControlCharacters(`${origin}\n\n${reason ? `${reason}\n\n` : ''}${CHROME_ACCESS_MESSAGE}`)
          .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '');
        if (typeof context.ui.select !== 'function') return await context.ui.confirm('Authorize existing Chrome?', message, { signal }) ? 'once' : undefined;
        const choice = await context.ui.select(`Authorize existing Chrome?\n\n${message}`, ['Allow once', 'Always allow', 'Deny'], { signal });
        return choice === 'Allow once' ? 'once' : choice === 'Always allow' ? 'always' : undefined;
      },
      async openSetup(path, signal) { await openChromeSetup(runtime, path, signal); return true; },
      ready: signal => context.ui.confirm('Continue Chrome authorization?', CHROME_READY_MESSAGE, { signal }),
    };
  };
}

export async function openChromeSetup(runtime: AgentRuntime, applicationPath: string, signal: AbortSignal): Promise<void> {
  if (runtime.kind !== 'host' || !applicationPath.startsWith('/') || /[\u0000-\u001f\u007f]/u.test(applicationPath)) throw new Error('Chrome setup requires a valid local application.');
  signal.throwIfAborted();
  const result = await runtime.exec('/usr/bin/open', ['-a', applicationPath, 'chrome://inspect/#remote-debugging'], {
    signal, timeout: 5_000, maxOutputBytes: 4_096,
  });
  signal.throwIfAborted();
  if (result.code !== 0 || result.killed || result.truncated) throw new Error('Chrome setup could not be opened.');
}
