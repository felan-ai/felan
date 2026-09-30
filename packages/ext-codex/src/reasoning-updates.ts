import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  clampThinkingLevel,
  type Api,
  type ExtensionContext,
  type FelanExtensionAPI,
  type Model,
} from '@felan-ai/agent-core';

const UPDATE_TYPE = 'codex-reasoning-update';
type ThinkingLevel = ReturnType<FelanExtensionAPI['getThinkingLevel']>;
type SessionEntry = ReturnType<ExtensionContext['sessionManager']['getBranch']>[number];

interface ReasoningUpdate {
  protocol: 1;
  id: string;
  lane: string;
  initialEffort: string;
  effort: string;
}

interface PendingUpdates {
  sessionId: string;
  compactionId: string | undefined;
  updates: ReasoningUpdate[];
}

export function supportsReasoningUpdates(model: Model<Api> | undefined): model is Model<Api> {
  return (model?.provider === 'openai' || model?.provider === 'openai-codex')
    && (model.api === 'openai-codex-responses'
      || (model.provider === 'openai' && model.api === 'openai-responses'))
    && (model.id === 'gpt-6-astra' || model.id === 'gpt-6-sol' || model.id === 'gpt-6.1-sol' || model.id === 'gpt-6-luna');
}

function isEffort(value: unknown): value is string {
  return value === 'none' || value === 'low' || value === 'medium' || value === 'high'
    || value === 'xhigh' || value === 'max';
}

function effortForLevel(model: Model<Api>, level: ThinkingLevel): string {
  const clamped = clampThinkingLevel(model, level);
  const effort = model.thinkingLevelMap?.[clamped] ?? (clamped === 'minimal' ? 'low' : clamped);
  if (!isEffort(effort)) throw new Error(`Unsupported GPT-6 reasoning effort: ${effort}`);
  return effort;
}

function laneForModel(model: Model<Api>): string {
  return JSON.stringify([model.provider, model.api, model.id]);
}

function readUpdate(value: unknown, model: Model<Api>): ReasoningUpdate {
  if (!isRecord(value)
    || value.protocol !== 1
    || typeof value.id !== 'string' || !value.id
    || typeof value.lane !== 'string' || !value.lane
    || !isEffort(value.initialEffort) || !isEffort(value.effort)) {
    throw new Error('Malformed persisted Codex reasoning update');
  }
  if (value.lane === laneForModel(model)
    && (value.initialEffort === 'none' || value.effort === 'none')
    && model.thinkingLevelMap?.off !== 'none') {
    throw new Error('Malformed persisted Codex reasoning update');
  }
  return value as unknown as ReasoningUpdate;
}

function activeEntries(ctx: ExtensionContext): SessionEntry[] {
  const branch = ctx.sessionManager.getBranch();
  let lastCompaction = -1;
  for (let index = branch.length - 1; index >= 0; index--) {
    if (branch[index]?.type === 'compaction') {
      lastCompaction = index;
      break;
    }
  }
  return branch.slice(lastCompaction + 1);
}

function activeUpdates(ctx: ExtensionContext, model: Model<Api>): ReasoningUpdate[] {
  const lane = laneForModel(model);
  return activeEntries(ctx).flatMap((entry) => {
    if (entry.type !== 'custom' || entry.customType !== UPDATE_TYPE) return [];
    const update = readUpdate(entry.data, model);
    return update.lane === lane ? [update] : [];
  });
}

function currentCompactionId(ctx: ExtensionContext): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    if (branch[index]?.type === 'compaction') return branch[index]?.id;
  }
  return undefined;
}

function messageKey(message: { role: string; timestamp?: number; toolCallId?: string }): string {
  return JSON.stringify([message.role, message.timestamp, message.toolCallId]);
}

function markerFromInput(value: unknown): string | undefined {
  if (!isRecord(value) || value.role !== 'user') return undefined;
  if (typeof value.content === 'string') return value.content;
  if (!Array.isArray(value.content) || value.content.length !== 1) return undefined;
  const part: unknown = value.content[0];
  return isRecord(part) && part.type === 'input_text' && typeof part.text === 'string'
    ? part.text : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isConfigurationUpdate(value: unknown): boolean {
  return isRecord(value) && value.type === 'configuration_update';
}

function containsCarrier(value: unknown, carriers: ReadonlyMap<string, ReasoningUpdate>): boolean {
  if (carriers.size === 0) return false;
  if (typeof value === 'string') return carriers.has(value);
  if (Array.isArray(value)) return value.some((item: unknown) => containsCarrier(item, carriers));
  return isRecord(value) && Object.values(value).some((item) => containsCarrier(item, carriers));
}

export function registerReasoningUpdates(pi: FelanExtensionAPI): {
  project<T extends { role: string; timestamp?: number; toolCallId?: string }>(
    messages: readonly T[], ctx: ExtensionContext,
  ): T[];
  rewrite(payload: unknown, model: Model<Api> | undefined): unknown;
} {
  const secret = randomBytes(32);
  const carriers = new Map<string, ReasoningUpdate>();
  let pending: PendingUpdates | undefined;
  let observedLevel: ThinkingLevel | undefined;

  const flush = (ctx: ExtensionContext): void => {
    const queued = pending;
    pending = undefined;
    if (!queued || queued.sessionId !== ctx.sessionManager.getSessionId()
      || queued.compactionId !== currentCompactionId(ctx)
      || !supportsReasoningUpdates(ctx.model)) return;
    const lane = laneForModel(ctx.model);
    for (const update of queued.updates) {
      if (update.lane === lane) pi.appendEntry(UPDATE_TYPE, update);
    }
  };

  const record = (ctx: ExtensionContext, previousLevel?: ThinkingLevel): void => {
    const model = ctx.model;
    if (!supportsReasoningUpdates(model)) return;
    const effort = effortForLevel(model, pi.getThinkingLevel());
    const lane = laneForModel(model);
    const sessionId = ctx.sessionManager.getSessionId();
    const compactionId = currentCompactionId(ctx);
    const queued = pending?.sessionId === sessionId && pending.compactionId === compactionId
      ? pending.updates.filter((update) => update.lane === lane) : [];
    const persisted = activeUpdates(ctx, model);
    if (persisted.length === 0 && queued.length === 0
      && !activeEntries(ctx).some((entry) => entry.type === 'message'
        && entry.message.role === 'assistant'
        && entry.message.api === model.api
        && entry.message.provider === model.provider
        && entry.message.model === model.id)) return;
    const previous = previousLevel === undefined
      ? queued.at(-1)?.effort ?? persisted.at(-1)?.effort
      : effortForLevel(model, previousLevel);
    if (previous === undefined || previous === effort
      || (queued.length === 0 && persisted.at(-1)?.effort === effort)) return;
    const initialEffort = persisted[0]?.initialEffort ?? queued[0]?.initialEffort ?? previous;
    const update: ReasoningUpdate = { protocol: 1, id: randomUUID(), lane, initialEffort, effort };
    if (ctx.isIdle()) {
      flush(ctx);
      pi.appendEntry(UPDATE_TYPE, update);
    } else {
      pending = { sessionId, compactionId, updates: [...queued, update] };
    }
  };

  pi.on('thinking_level_select', (event, ctx) => {
    record(ctx, event.previousLevel);
    observedLevel = event.level;
  });
  pi.on('before_agent_start', (_event, ctx) => {
    observedLevel = pi.getThinkingLevel();
    record(ctx);
  });
  pi.on('agent_settled', (_event, ctx) => { flush(ctx); observedLevel = pi.getThinkingLevel(); });
  pi.on('session_start', () => { pending = undefined; observedLevel = undefined; carriers.clear(); });
  pi.on('session_shutdown', () => { pending = undefined; observedLevel = undefined; carriers.clear(); });
  pi.on('model_select', () => { pending = undefined; observedLevel = pi.getThinkingLevel(); });
  pi.on('session_compact', () => { pending = undefined; observedLevel = pi.getThinkingLevel(); });

  return {
    project(messages, ctx) {
      const model = ctx.model;
      if (!supportsReasoningUpdates(model)) return [...messages];
      const currentLevel = pi.getThinkingLevel();
      if (pending === undefined && observedLevel !== undefined && currentLevel !== observedLevel) {
        record(ctx, observedLevel);
        observedLevel = currentLevel;
      }
      if (pending) {
        const entries = activeEntries(ctx);
        const assistant = entries.reduce((last, entry, index) => (
          entry.type === 'message' && entry.message.role === 'assistant' ? index : last
        ), -1);
        const user = entries.reduce((last, entry, index) => (
          entry.type === 'message' && entry.message.role === 'user' ? index : last
        ), -1);
        if (assistant >= 0 && user > assistant) flush(ctx);
      }
      const lane = laneForModel(model);
      const positions = new Map<string, number[]>();
      messages.forEach((message, index) => {
        const key = messageKey(message);
        const indices = positions.get(key) ?? [];
        indices.push(index);
        positions.set(key, indices);
      });
      const insertions = new Map<number, typeof messages[number][]>();
      let waiting: typeof messages[number][] = [];
      let lastMatched = -1;
      let lastUserIndex: number | undefined;
      const insertWaiting = (index: number) => {
        if (waiting.length === 0) return;
        insertions.set(index, [...(insertions.get(index) ?? []), ...waiting]);
        waiting = [];
      };
      for (const entry of activeEntries(ctx)) {
        if (entry.type === 'custom' && entry.customType === UPDATE_TYPE) {
          const update = readUpdate(entry.data, model);
          if (update.lane !== lane) continue;
          const marker = `<codex-reasoning-update:${createHmac('sha256', secret).update(update.id).digest('base64url')}>`;
          carriers.set(marker, update);
          waiting.push({
            role: 'custom', customType: UPDATE_TYPE, content: marker, details: update,
            timestamp: Date.parse(entry.timestamp),
          } as unknown as typeof messages[number]);
          if (lastUserIndex !== undefined) insertWaiting(lastUserIndex);
        } else if (entry.type === 'message') {
          const index = positions.get(messageKey(entry.message))?.shift();
          if (index !== undefined) {
            insertWaiting(index);
            lastMatched = index;
          }
          if (entry.message.role === 'user') lastUserIndex = index;
          else if (entry.message.role === 'assistant' || entry.message.role === 'toolResult') lastUserIndex = undefined;
        }
      }
      insertWaiting(lastMatched + 1);
      return messages.flatMap((message, index) => [...(insertions.get(index) ?? []), message])
        .concat(insertions.get(messages.length) ?? []);
    },
    rewrite(payload, model) {
      if (!supportsReasoningUpdates(model)) return payload;
      if (!isRecord(payload) || !Array.isArray(payload.input)) {
        if (containsCarrier(payload, carriers)) throw new Error('Codex reasoning update carrier requires a Responses input array');
        return payload;
      }
      const lane = laneForModel(model);
      let initialEffort: string | undefined;
      const input: unknown[] = [];
      for (const item of payload.input) {
        const update = carriers.get(markerFromInput(item) ?? '');
        if (!update || update.lane !== lane) {
          input.push(item);
          continue;
        }
        initialEffort ??= update.initialEffort;
        const next = { type: 'configuration_update', reasoning: { effort: update.effort } };
        input.push(next);
      }
      if (containsCarrier(input, carriers)) throw new Error('Codex reasoning update carrier reached an unsupported Responses input shape');
      if (!input.some(isConfigurationUpdate)) return payload;
      if (payload.truncation === 'auto'
        || (Array.isArray(payload.context_management) && payload.context_management.length > 0)) {
        throw new Error('Codex reasoning updates cannot use automatic truncation or compaction');
      }
      const normalized: unknown[] = [];
      for (const item of input) {
        if (isConfigurationUpdate(item) && isConfigurationUpdate(normalized.at(-1))) normalized.pop();
        normalized.push(item);
      }
      if (!initialEffort) return { ...payload, input: normalized };
      const reasoning = isRecord(payload.reasoning) ? payload.reasoning : {};
      return { ...payload, input: normalized, reasoning: { ...reasoning, effort: initialEffort } };
    },
  };
}
