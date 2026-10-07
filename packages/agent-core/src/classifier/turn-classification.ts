import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Logger } from '../logger.js';
import { createClassifierPreflight } from './preflight.js';
import { collectClassifierSessionEvidence, sanitizeClassifierText, type ClassifierSessionEvidence } from './session-evidence.js';
import type { Classifier, ClassifierAnswers, ClassifierEvaluationMetadata, ClassifierQuestions } from './types.js';
import { validateClassifierAnswers, validateClassifierRequest } from './validation.js';

export interface TurnClassificationRequest {
  readonly prompt: string;
  readonly imageCount: number;
}

export interface TurnClassificationInput extends TurnClassificationRequest {
  readonly session: ClassifierSessionEvidence;
}

export interface TurnClassificationPreparation {
  readonly state?: Readonly<Record<string, unknown>>;
  readonly questions: ClassifierQuestions;
}

export interface TurnClassificationResult {
  readonly answers: ClassifierAnswers;
  readonly metadata?: ClassifierEvaluationMetadata;
}

export interface TurnClassificationContribution {
  readonly id: string;
  prepare(
    input: TurnClassificationInput,
    context: ExtensionContext,
    signal: AbortSignal,
  ): TurnClassificationPreparation | undefined | Promise<TurnClassificationPreparation | undefined>;
}

export interface TurnClassificationRegistry {
  register(contribution: TurnClassificationContribution): void;
  result(
    id: string,
    request: TurnClassificationRequest,
    context: ExtensionContext,
  ): Promise<TurnClassificationResult | undefined>;
}

interface TurnClassificationCoordinator extends TurnClassificationRegistry {
  start(request: TurnClassificationRequest, context: ExtensionContext): void;
  finish(): void;
  reset(): void;
  dispose(): void;
}

export function createTurnClassificationRegistry(classifier: Classifier, logger: Logger, selectionOwned = () => false) {
  const contributions = new Map<string, TurnClassificationContribution>();
  const preflight = createClassifierPreflight(logger);
  const log = logger.child({ component: 'turn-classification' });
  let started = false;
  let current: {
    request: TurnClassificationRequest;
    sessionId: string;
    modelKey: string;
    controller: AbortController;
    results: Promise<Map<string, TurnClassificationResult>>;
  } | undefined;

  function cancel() {
    current?.controller.abort();
    current = undefined;
    preflight.dispose();
  }

  function matches(request: TurnClassificationRequest, context: ExtensionContext) {
    return current?.request.prompt === request.prompt && current.request.imageCount === request.imageCount
      && current.sessionId === context.sessionManager.getSessionId()
      && (current.modelKey === modelKey(context) || selectionOwned());
  }

  async function classify(input: TurnClassificationInput, context: ExtensionContext, signal: AbortSignal) {
    const results = new Map<string, TurnClassificationResult>();
    const prepared = await Promise.all([...contributions.values()].map(async contribution => {
      try {
        const value = await contribution.prepare(input, context, signal);
        if (!value || signal.aborted) return undefined;
        validateClassifierRequest(value.state ?? {}, value.questions);
        return { id: contribution.id, value };
      } catch {
        log.warn({ event: 'preparation', producer: contribution.id, outcome: 'failed' }, 'turn classification preparation failed');
        return undefined;
      }
    }));
    if (signal.aborted) return results;
    const questions: Record<string, ClassifierQuestions[string]> = Object.create(null);
    const extensions: Record<string, unknown> = Object.create(null);
    const accepted: NonNullable<typeof prepared[number]>[] = [];
    const state = { request: sanitizeClassifierText(input.prompt, 4_096), image_count: input.imageCount,
      session: input.session, extensions };
    for (const item of prepared) {
      if (!item) continue;
      const keys = Object.keys(item.value.questions).map(key => `${item.id}:${key}`);
      for (const [key, question] of Object.entries(item.value.questions)) questions[`${item.id}:${key}`] = question;
      extensions[item.id] = sanitizeState(item.value.state ?? {});
      try {
        validateClassifierRequest(state, questions);
        accepted.push(item);
      } catch {
        for (const key of keys) delete questions[key];
        delete extensions[item.id];
        log.warn({ event: 'preparation', producer: item.id, outcome: 'invalid' }, 'turn classification contribution rejected');
      }
    }
    if (!accepted.length || signal.aborted) return results;
    const response = await classifier.classify(state, questions, signal);
    if (signal.aborted) return results;
    const answers = validateClassifierAnswers(questions, response.answers);
    for (const item of accepted) {
      const own: Record<string, ClassifierAnswers[string]> = Object.create(null);
      for (const key of Object.keys(item.value.questions)) own[key] = answers[`${item.id}:${key}`]!;
      results.set(item.id, { answers: own, ...(response.metadata ? { metadata: response.metadata } : {}) });
    }
    log.debug({ event: 'decision', sessionId: context.sessionManager.getSessionId(), producers: accepted.map(item => item.id),
      answers: sanitizeState(answers), classifier: response.metadata }, 'shared turn classification completed');
    return results;
  }

  const registry: TurnClassificationCoordinator = {
    register(contribution: TurnClassificationContribution) {
      if (started) throw new Error('Turn classification registration is only available during initialization');
      if (!contribution.id.trim() || contribution.id.includes(':') || contributions.has(contribution.id)) {
        throw new Error(`Invalid or duplicate turn classification producer: ${contribution.id}`);
      }
      contributions.set(contribution.id, contribution);
    },
    start(request: TurnClassificationRequest, context: ExtensionContext) {
      if (matches(request, context) && !current?.controller.signal.aborted) return;
      cancel();
      started = true;
      const controller = new AbortController();
      const input = { ...request, prompt: sanitizeClassifierText(request.prompt, 4_096),
        session: collectClassifierSessionEvidence(context.sessionManager) };
      preflight.startNextTurn();
      const results = preflight.run('shared-turn', signal => classify(input, context, signal), controller.signal)
        .catch(() => new Map<string, TurnClassificationResult>());
      current = { request: { ...request }, sessionId: context.sessionManager.getSessionId(),
        modelKey: modelKey(context), controller, results };
    },
    async result(id: string, request: TurnClassificationRequest, context: ExtensionContext) {
      if (!contributions.has(id) || !matches(request, context)) return undefined;
      const active = current!;
      const results = await active.results;
      return current === active && !active.controller.signal.aborted && matches(request, context)
        ? results.get(id) : undefined;
    },
    finish() { cancel(); },
    reset() { cancel(); contributions.clear(); started = false; },
    dispose() { cancel(); contributions.clear(); started = false; },
  };
  return registry;
}

function modelKey(context: ExtensionContext) {
  return context.model ? `${context.model.provider}/${context.model.id}` : '';
}

function sanitizeState(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeClassifierText(value, Buffer.byteLength(value, 'utf8'));
  if (Array.isArray(value)) return value.map(sanitizeState);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitizeState(child)]));
  }
  return value;
}
