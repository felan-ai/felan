import type { BrowserAuthorizationPresentationFactory } from '@felan-ai/ext-browser/presentation';
import { CHROME_ACCESS_MESSAGE, CHROME_READY_MESSAGE } from '@felan-ai/ext-browser/presentation';
import { parseUiForm } from '@felan-ai/session-protocol';
import type { SessionUiPort } from './port.js';

export function createBrowserAuthorizationPresentation(options: {
  port: SessionUiPort;
  openBrowserSetup(applicationPath: string, signal: AbortSignal): Promise<void>;
}): BrowserAuthorizationPresentationFactory {
  const approvalForm = async (audience: 'owner' | 'host', title: string, description: string, actions: readonly { id: string; label: string; cancel?: boolean }[], signal: AbortSignal) => {
    const form = parseUiForm({ title, description: description, fallback: title, input: { fields: [] },
      actions: actions.map(action => ({ id: action.id, label: action.label, target: 'element', outcome: action.cancel ? 'cancel' : 'submit' })) });
    const value = { kind: 'form' as const, form };
    if (!options.port.canPresent(value, audience)) return undefined;
    const detached = new AbortController();
    const release = options.port.subscribeClients(() => {
      if (!options.port.canPresent(value, audience)) detached.abort();
    });
    try {
      const result = await options.port.request(value, { signal: AbortSignal.any([signal, detached.signal]), audience });
      if (result.state !== 'answered' || result.answer.kind !== 'form' || result.answer.outcome !== 'submit') return undefined;
      return result.answer.actionId;
    } finally { release(); }
  };
  return () => ({
        async consent(origin, reason, signal) {
          const choice = await approvalForm('owner', 'Authorize existing Chrome?', `${origin}\n\n${reason ? `${reason}\n\n` : ''}${CHROME_ACCESS_MESSAGE}`,
            [{ id: 'once', label: 'Allow once' }, { id: 'always', label: 'Always allow' }, { id: 'deny', label: 'Deny', cancel: true }], signal);
          return choice === 'once' || choice === 'always' ? choice : undefined;
        },
        async openSetup(applicationPath, signal) {
          const result = await approvalForm('owner', 'Enable Chrome remote debugging', CHROME_READY_MESSAGE,
            [{ id: 'open', label: 'Open Chrome settings' }, { id: 'cancel', label: 'Cancel', cancel: true }], signal);
          if (result !== 'open') return false;
          await options.openBrowserSetup(applicationPath, signal);
          return true;
        },
        async ready(signal) {
          return await approvalForm('owner', 'Continue Chrome authorization?', CHROME_READY_MESSAGE,
            [{ id: 'continue', label: 'Continue' }, { id: 'cancel', label: 'Cancel', cancel: true }], signal) === 'continue';
        },
      });
}
