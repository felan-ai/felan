import type { ContextViewPresentationHost } from '@felan-ai/ext-context-view';
import { CONTEXT_VIEW_PRESENTER, createContextViewRequest, parseContextViewResult } from '@felan-ai/ext-context-view/view';
import { JsonValueSchema, parseSchema, type Interaction } from '@felan-ai/session-protocol';
import type { BrokerOutcome } from './broker.js';

export function createBrokerContextViewHost(options: {
  signal: AbortSignal;
  request(value: Interaction['request'], dialog: { signal: AbortSignal }): Promise<BrokerOutcome>;
  unsupported(surface: string): never;
}): ContextViewPresentationHost {
  return { async show(_ui, report, displayMode, callerSignal) {
    const signal = AbortSignal.any([options.signal, callerSignal]);
    if (signal.aborted) return;
    const request = createContextViewRequest(report, displayMode);
    const result = await options.request({ kind: 'custom', presenter: CONTEXT_VIEW_PRESENTER, data: parseSchema(JsonValueSchema, request) }, { signal });
    if (signal.aborted) return;
    if (result.state !== 'answered') {
      if (result.state === 'cancelled' && result.reason === 'unsupported') options.unsupported('context view');
      return;
    }
    if (result.answer.kind !== 'custom') throw new Error('Invalid context view answer.');
    parseContextViewResult(result.answer.data);
  } };
}
