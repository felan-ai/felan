import type {
  Classifier,
  ClassifierEvaluationMetadata,
  ClassifierProbabilityQuestions,
  AgentRuntime,
  ExtensionContext,
  FelanExtensionAPI,
  SessionEntry,
} from '@felan-ai/agent-core';
import type { SubagentDescriptor, SubagentHost, SubagentRecord } from './contracts.js';

const ROUTING_THRESHOLD = 0.65;
const ROUTING_PROMPT_SECTION = 'subagent_routing';
const DISCOVERY_AGENT_TYPE = 'explore';
const DISCOVERY_QUESTION = 'broad_discovery';
const MAX_CONVERSATION_ITEMS = 24;
const MAX_CONVERSATION_TEXT = 1_200;
const SMALL_REPOSITORY_FILE_LIMIT = 20;

interface RoutingDecision {
  probability: number;
  discovery: boolean;
  reason?: string;
  classifier?: ClassifierEvaluationMetadata;
}

interface RoutingState {
  request: string;
  image_count: number;
  conversation: readonly { role: string; text: string }[];
  discovery_agent: SubagentDescriptor;
  active_children: readonly { id: string; type: string; status: string; description: string }[];
}

interface PendingClassification {
  prompt: string;
  controller: AbortController;
  decision: Promise<RoutingDecision>;
}

const DISCOVERY_QUESTIONS: ClassifierProbabilityQuestions = {
  [DISCOVERY_QUESTION]: {
    instructions: 'Given `request`, `conversation`, and `active_children`, does answering or completing `request` require broad discovery across many files or locations that are unknown and not already covered by `conversation` or by an active child? Answer yes only when a wide, largely unexplored surface must be read, so a cheaper read-only `discovery_agent` returning a compact summary would replace substantial reading by the parent. Answer no when the conversation already holds the needed facts, the request names or implies a few specific files, the task is small or conversational, or an active child already covers the discovery.',
  },
};

export const DISCOVERY_GUIDANCE = [
  '## Subagent routing decision',
  `This request needs broad discovery across a largely unexplored surface. Delegate that discovery to \`${DISCOVERY_AGENT_TYPE}\` children with bounded, disjoint, read-only questions and a requested summary format. While they run, do not read the delegated scopes yourself; continue only with independent work or yield until their completion notices arrive. Then verify the facts you rely on and inspect only the critical-path files you will change.`,
].join('\n');

export function registerClassifierRouting(pi: FelanExtensionAPI, host: SubagentHost): void {
  const classifier = pi.runtime?.classifier;
  const evaluateProbabilities = classifier?.evaluateProbabilities;
  const logger = pi.runtime?.logger?.child({ component: 'subagent-routing' });
  const discoveryAgent = host.descriptors.find(({ id }) => id === DISCOVERY_AGENT_TYPE);
  if (classifier === undefined || typeof evaluateProbabilities !== 'function' || discoveryAgent === undefined) {
    logger?.debug({
      event: 'configuration',
      mode: 'static',
      reason: discoveryAgent === undefined ? 'discovery-agent-unavailable' : 'probability-classifier-unavailable',
    }, 'subagent routing configured');
    return;
  }

  let pending: PendingClassification | undefined;
  let attempt = 0;

  const start = (prompt: string, imageCount: number, ctx: ExtensionContext): PendingClassification => {
    pending?.controller.abort('superseded');
    const controller = new AbortController();
    const classification: PendingClassification = {
      prompt,
      controller,
      decision: classifyDiscovery(
        classifier,
        evaluateProbabilities,
        host,
        discoveryAgent,
        prompt,
        imageCount,
        ctx,
        controller.signal,
        pi.runtime,
      ),
    };
    classification.decision.catch(() => {});
    pending = classification;
    return classification;
  };

  // Pi awaits before_agent_start handlers sequentially, so classification starts
  // at input to overlap with other extensions' pre-start classifier calls.
  pi.on('input', (event, ctx) => {
    if (event.streamingBehavior !== undefined || isChildSession(ctx) || isOneShotSession(ctx)) return;
    start(event.text, event.images?.length ?? 0, ctx);
  });

  pi.on('before_agent_start', async (event, ctx) => {
    if (isChildSession(ctx) || isOneShotSession(ctx)) return;
    const classification = pending?.prompt === event.prompt
      ? pending
      : start(event.prompt, event.images?.length ?? 0, ctx);
    const routingAttempt = ++attempt;
    const sessionId = ctx.sessionManager.getSessionId();
    try {
      const decision = await classification.decision;
      if (classification.controller.signal.aborted) return;
      logger?.debug({
        event: 'decision',
        sessionId,
        attempt: routingAttempt,
        outcome: decision.reason === undefined ? 'classified' : 'skipped',
        reason: decision.reason,
        threshold: ROUTING_THRESHOLD,
        probability: decision.probability,
        discovery: decision.discovery,
        classifier: decision.classifier,
        guidanceSection: decision.discovery ? ROUTING_PROMPT_SECTION : undefined,
      }, 'subagent routing decision');
      if (decision.discovery) event.systemPromptOptions.sections[ROUTING_PROMPT_SECTION] = DISCOVERY_GUIDANCE;
    } catch (error) {
      if (classification.controller.signal.aborted) return;
      logger?.warn({
        event: 'decision',
        sessionId,
        attempt: routingAttempt,
        outcome: 'failed',
        error: logError(error),
      }, 'subagent routing failed');
    } finally {
      if (pending === classification) pending = undefined;
    }
  });
  pi.on('session_shutdown', () => pending?.controller.abort('session-shutdown'));
}

function isChildSession(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getHeader()?.parentSession !== undefined;
}

function isOneShotSession(ctx: ExtensionContext): boolean {
  return ctx.mode === 'print' || ctx.mode === 'json';
}

async function classifyDiscovery(
  classifier: Classifier,
  evaluateProbabilities: NonNullable<Classifier['evaluateProbabilities']>,
  host: SubagentHost,
  discoveryAgent: SubagentDescriptor,
  prompt: string,
  imageCount: number,
  ctx: ExtensionContext,
  signal: AbortSignal,
  runtime?: AgentRuntime,
): Promise<RoutingDecision> {
  if (runtime && typeof runtime.listFiles === 'function') {
    try {
      const paths = await runtime.listFiles('.', {
        recursive: true,
        limit: SMALL_REPOSITORY_FILE_LIMIT,
        ignore: ['.git', 'node_modules', '.artifacts', 'dist'],
        signal,
      });
      if (paths.length < SMALL_REPOSITORY_FILE_LIMIT) {
        return { probability: 0, discovery: false, reason: 'small-repository' };
      }
    } catch {
      if (signal.aborted) throw new Error('Discovery classification cancelled');
    }
  }
  const activeChildren = await host.list({ includeDescendants: false });
  if (!activeChildren.ok) throw new Error(activeChildren.error.message);
  const state = buildState(prompt, imageCount, ctx, discoveryAgent, activeChildren.value);
  const result = await evaluateProbabilities.call(classifier, state, DISCOVERY_QUESTIONS, signal);
  const probability = result.answers[DISCOVERY_QUESTION]?.probability;
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error('Classifier returned an incomplete discovery answer');
  }
  return {
    probability,
    discovery: probability >= ROUTING_THRESHOLD,
    ...(result.metadata === undefined ? {} : { classifier: result.metadata }),
  };
}

function buildState(
  prompt: string,
  imageCount: number,
  ctx: ExtensionContext,
  discoveryAgent: SubagentDescriptor,
  records: readonly SubagentRecord[],
): RoutingState {
  return {
    request: prompt,
    image_count: imageCount,
    conversation: buildProjectedConversation(ctx),
    discovery_agent: discoveryAgent,
    active_children: records.map(({ agentId, type, status, description }) => ({
      id: agentId,
      type,
      status,
      description,
    })),
  };
}

function buildProjectedConversation(ctx: ExtensionContext): { role: string; text: string }[] {
  const entries = typeof ctx.sessionManager.buildSessionProjection === 'function'
    ? ctx.sessionManager.buildSessionProjection().entries.flatMap(({ sourceEntry, messages }) => {
      if (sourceEntry.type === 'compaction' || sourceEntry.type === 'branch_summary') {
        return sourceEntry.summary.trim() ? [{ role: 'summary', text: sourceEntry.summary }] : [];
      }
      return messages.flatMap((message) => {
        if (message.role !== 'user' && message.role !== 'assistant') return [];
        const text = contentText(message.content);
        return text.trim() ? [{ role: message.role, text }] : [];
      });
    })
    : ctx.sessionManager.buildContextEntries().flatMap(conversationText);
  return entries.slice(-MAX_CONVERSATION_ITEMS).map(({ role, text }) => ({
    role,
    text: text.slice(0, MAX_CONVERSATION_TEXT),
  }));
}

export function formatSubagentDescriptor(descriptor: SubagentDescriptor): string {
  const details = [descriptor.description.replace(/\s+/g, ' ').trim()];
  if (descriptor.model !== undefined) details.push(`model: ${descriptor.model}`);
  if (descriptor.thinking !== undefined) details.push(`thinking: ${descriptor.thinking}`);
  return `${descriptor.id} (${details.join('; ')})`;
}

function conversationText(entry: SessionEntry): { role: string; text: string }[] {
  if (entry.type === 'compaction' || entry.type === 'branch_summary') {
    return entry.summary.trim() ? [{ role: 'summary', text: entry.summary }] : [];
  }
  if (entry.type === 'custom_message') return [];
  if (entry.type !== 'message') return [];
  const message = entry.message;
  if (message.role !== 'user' && message.role !== 'assistant') return [];
  const text = contentText(message.content);
  return text.trim() ? [{ role: message.role, text }] : [];
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: 'text'; text: string } => (
      isRecord(part) && part.type === 'text' && typeof part.text === 'string'
    ))
    .map((part) => part.text)
    .join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function logError(value: unknown): { name: string; message: string; code?: string } {
  if (!(value instanceof Error)) return { name: 'Error', message: String(value) };
  const code = Reflect.get(value, 'code');
  return {
    name: value.name,
    message: value.message,
    ...(typeof code === 'string' ? { code } : {}),
  };
}
