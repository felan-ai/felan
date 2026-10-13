import { expect, it, vi } from 'vitest';
import type { InteractionBroker } from '../../../daemon/src/daemon/broker.js';
import { createBrowserAuthorizationPresentation } from '../../src/providers/ui/extension-ui.js';
import { sessionUiPort } from '../session-ui-fixture.js';

it.each(['open', 'cancel'] as const)('opens Chrome setup only after an owner form submits open (%s)', async actionId => {
  const request = vi.fn<InteractionBroker['request']>(async () => ({ state: 'answered', answer: {
    kind: 'form', actionId, outcome: actionId === 'open' ? 'submit' : 'cancel', values: {},
  } }));
  const openBrowserSetup = vi.fn(async () => {});
  const presentation = createBrowserAuthorizationPresentation({ openBrowserSetup, port: sessionUiPort({ request, canPresent: () => true, subscribeClients: () => () => {} },
    { kind: 'session', session: 'session', root: 'root' }) });
  {
    const browser = presentation({} as Parameters<typeof presentation>[0])!;
    const signal = new AbortController().signal;
    expect(await browser.openSetup('/Applications/Chrome.app', signal)).toBe(actionId === 'open');
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'form', form: expect.objectContaining({
      actions: [{ id: 'open', label: 'Open Chrome settings', target: 'element', outcome: 'submit' },
        { id: 'cancel', label: 'Cancel', target: 'element', outcome: 'cancel' }],
    }) }), { kind: 'session', session: 'session', root: 'root' }, expect.objectContaining({ authority: 'owner' }));
    if (actionId === 'open') expect(openBrowserSetup).toHaveBeenCalledWith('/Applications/Chrome.app', signal);
    else expect(openBrowserSetup).not.toHaveBeenCalled();
  }
});
