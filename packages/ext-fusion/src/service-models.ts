import { parseModelReference, type ModelsService, type TextModelInfo } from '@felan-ai/agent-core';
import type { FusionModelChoice } from './contracts.js';
import type { FusionModelRuntime } from './models.js';

export async function fusionModelCatalogue(models: ModelsService, signal: AbortSignal): Promise<readonly TextModelInfo[]> {
  signal.throwIfAborted();
  const available = await models.getAvailable(undefined, { signal });
  signal.throwIfAborted();
  if (available.length > 10_000) throw new Error('Fusion supports at most 10000 available models. No models were omitted.');
  const seen = new Set<string>();
  for (const model of available) {
    const reference = `${model.provider}/${model.id}`;
    if (!parseModelReference(reference) || new TextEncoder().encode(reference).length > 300 || /\s/u.test(reference) || seen.has(reference)
      || new TextEncoder().encode(`${model.name} (${reference})`).length > 4096) throw new Error('Invalid Fusion model catalogue.');
    seen.add(reference);
  }
  return available.filter(model => model.input.includes('text'));
}

export function fusionModelChoice(model: TextModelInfo): FusionModelChoice {
  return { reference: `${model.provider}/${model.id}`, label: `${model.name} (${model.provider}/${model.id})` };
}

export async function resolveServiceFusionModels(models: ModelsService, participants: readonly string[], comparison: string,
  signal: AbortSignal, track: <T>(work: Promise<T>) => Promise<T>): Promise<FusionModelRuntime> {
  const catalogue = await track(fusionModelCatalogue(models, signal));
  const resolve = (reference: string) => {
    const model = catalogue.find(model => `${model.provider}/${model.id}` === reference);
    if (!model) throw new Error(`Fusion model is no longer available: ${reference}`);
    return fusionModelChoice(model);
  };
  if (participants.length < 2 || participants.length > 8 || new Set(participants).size !== participants.length) {
    throw new Error('Select between two and eight distinct Fusion participants.');
  }
  return {
    participants: participants.map(resolve), fusionModel: resolve(comparison), resolve,
    async complete(request) {
      return track((async () => {
        const current = await fusionModelCatalogue(models, request.signal);
        const selected = current.find(model => `${model.provider}/${model.id}` === request.model.reference);
        if (!selected) throw new Error(`Fusion model is no longer available: ${request.model.reference}`);
        const reference = parseModelReference(request.model.reference)!;
        const started = Date.now();
        const estimate = Math.max(256, Math.ceil(request.maxOutputChars / 3));
        const message = await models.completeSimple(reference, {
          systemPrompt: 'Answer only the user\'s prompt. Do not use tools or claim to have executed actions.',
          messages: [{ role: 'user', content: request.prompt, timestamp: started }],
        }, { signal: request.signal, maxTokens: selected.maxTokens > 0 ? Math.min(selected.maxTokens, estimate) : estimate,
          ...(request.thinking === 'off' ? {} : { reasoning: request.thinking }) });
        request.signal.throwIfAborted();
        const text = message.content.filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text').map(part => part.text).join('\n').trim();
        if (message.stopReason === 'error' || message.stopReason === 'aborted' || !text) throw new Error('Fusion model returned no usable text.');
        const usage = message.usage;
        const cost = usage?.cost?.total;
        const priced = usage && [usage.input, usage.output, usage.totalTokens, cost].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
        return { text, model: `${message.provider}/${message.model}`, durationMs: Date.now() - started,
          ...(priced ? { usage: { input: usage.input, output: usage.output, totalTokens: usage.totalTokens, estimatedCost: cost! } } : {}) };
      })());
    },
  };
}
