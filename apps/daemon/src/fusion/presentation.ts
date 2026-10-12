import type { FusionHost, FusionReview, FusionReviewActions, FusionReviewDecision } from '@felan-ai/ext-fusion';
import {
  FUSION_PICKER_PRESENTER, FUSION_REVIEW_PRESENTER, parseFusionPickerRequest, parseFusionPickerResult,
  parseFusionReview, parseFusionReviewDecision,
} from '@felan-ai/ext-fusion';
import type { Interaction, JsonValue } from '@felan-ai/session-protocol';
import type { BrokerOutcome } from '../daemon/broker.js';

export function createBrokerFusionPresentation(options: {
  request(value: Interaction['request'], dialog?: { signal?: AbortSignal }): Promise<BrokerOutcome>;
  signal: AbortSignal;
  unsupported(surface: string): never;
}): Pick<FusionHost, 'configure' | 'review'> {
  const answer = async (request: Interaction['request'], signal?: AbortSignal) => {
    const result = await options.request(request, signal ? { signal } : undefined);
    if (result.state !== 'answered') {
      if (result.state === 'cancelled' && result.reason === 'unsupported') options.unsupported('Fusion');
      return undefined;
    }
    if (result.answer.kind !== 'custom') throw new Error('Fusion answer kind changed.');
    return result.answer.data;
  };
  const choose = async (value: Parameters<typeof parseFusionPickerRequest>[0], signal?: AbortSignal) => {
    const request = parseFusionPickerRequest(value);
    const result = await answer({ kind: 'custom', presenter: FUSION_PICKER_PRESENTER, data: null, document: { ...request, models: request.models.map(model => ({ ...model })), participants: [...request.participants] } }, signal);
    return result === undefined ? undefined : parseFusionPickerResult(result, request);
  };
  const decide = async (review: FusionReview, busy: boolean, signal: AbortSignal): Promise<FusionReviewDecision | undefined> => {
    const result = await answer({ kind: 'custom', presenter: FUSION_REVIEW_PRESENTER, data: { busy }, document: structuredClone(parseFusionReview(review)) as unknown as JsonValue }, signal);
    return result === undefined ? undefined : parseFusionReviewDecision(result, review, busy);
  };

  return {
    configure: (context, models, participants, fusionModel) => choose({ mode: 'lineup', models, participants, fusionModel }, context.signal),
    async review(context, getReview, actions) {
      const signal = context.signal ? AbortSignal.any([options.signal, context.signal]) : options.signal;
      const cancel = () => actions.cancel();
      if (signal.aborted) return;
      signal.addEventListener('abort', cancel, { once: true });
      try {
        while (!signal.aborted) {
          const review = getReview();
          const decision = await decide(review, false, signal);
          if (!decision || decision.action === 'close' || signal.aborted) return;
          if (decision.action === 'fuse') { await actions.fuse(); return; }
          if (decision.action === 'choose_model') {
            const models = context.scopedModels.length === 0 ? context.modelRegistry.getAvailable()
              : context.scopedModels.map(item => item.model).filter(model => context.modelRegistry.hasConfiguredAuth(model));
            const selected = await choose({ mode: 'fusion', participants: review.participants, fusionModel: review.fusionModel,
              models: models.map(model => ({ reference: `${model.provider}/${model.id}`, label: `${model.name} (${model.provider}/${model.id})` })) }, signal);
            if (signal.aborted) return;
            if (!selected) continue;
            await actions.fuse(decision.instruction, selected.fusionModel); return;
          }
          if (!await retry(decision.action === 'retry_participants' ? () => actions.retryParticipants() : () => actions.retryComparison(), review, actions, signal)) return;
        }
      } finally { signal.removeEventListener('abort', cancel); }
    },
  };

  async function retry(action: () => Promise<void>, review: FusionReview, actions: FusionReviewActions, signal: AbortSignal): Promise<boolean> {
    const completed = new AbortController();
    const choice = decide(review, true, AbortSignal.any([signal, completed.signal])).then(
      value => ({ source: 'choice' as const, value }), error => ({ source: 'choice-error' as const, error }));
    const work = Promise.resolve().then(() => { signal.throwIfAborted(); return action(); }).then(
      () => ({ source: 'work' as const }), error => ({ source: 'work-error' as const, error }));
    try {
      const first = await Promise.race([choice, work]);
      if (first.source === 'choice' || first.source === 'choice-error') {
        actions.cancel();
        const settled = await work;
        if (first.source === 'choice-error') throw first.error;
        if (settled.source === 'work-error') throw settled.error;
        return false;
      }
      completed.abort();
      const settled = await choice;
      if (first.source === 'work-error') throw first.error;
      if (settled.source === 'choice-error') throw settled.error;
      return !signal.aborted;
    } finally { completed.abort(); }
  }
}
