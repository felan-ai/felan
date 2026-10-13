import type { Interaction } from '@felan-ai/session-protocol';
import type { InteractionBroker } from '../daemon/broker.js';

export function prepareHostInteraction(options: {
  broker: InteractionBroker;
  assertCurrent(): void;
  prepareOpen?: (request: Interaction['request'], signal: AbortSignal) => () => Promise<void>;
}, interactionId: string, client: string, signal: AbortSignal): () => Promise<void> {
  options.assertCurrent(); signal.throwIfAborted();
  const request = options.broker.presentationRequest(interactionId, client);
  if (!options.prepareOpen) throw new Error('External application opening is unavailable.');
  const open = options.prepareOpen(request, signal);
  return async () => {
    options.assertCurrent(); signal.throwIfAborted();
    await open();
    options.assertCurrent(); signal.throwIfAborted();
  };
}
