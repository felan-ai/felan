import type { Interaction } from '@felan-ai/session-protocol';
import type { InteractionBroker } from '../../daemon/src/daemon/broker.js';
import type { SessionUiPort } from '../src/providers/ui/port.js';

export function sessionUiPort(broker: Pick<InteractionBroker, 'request' | 'canPresent' | 'subscribeClients'>, scope: Interaction['scope']): SessionUiPort {
  const audience = (value: 'session' | 'owner' | 'host' | undefined): Interaction['scope'] => value === 'host' ? { kind: 'host' } : scope;
  return {
    request: (request, options) => broker.request(request, audience(options?.audience), { ...options, ...(options?.audience === 'owner' ? { authority: 'owner' } : {}) }),
    canPresent: (request, target) => broker.canPresent(request, audience(target), target === 'owner' ? { authority: 'owner' } : {}),
    subscribeClients: listener => broker.subscribeClients(listener),
  };
}
