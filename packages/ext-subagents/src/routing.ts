import type {
  ClassifierQuestions,
  ExtensionContext,
  FelanExtensionAPI,
} from '@felan-ai/agent-core';
import type { SubagentDescriptor, SubagentHost } from './contracts.js';

const ROUTING_THRESHOLD = 0.65;
const ROUTING_PROMPT_SECTION = 'subagent_routing';
const DISCOVERY_AGENT_TYPE = 'explore';
const DISCOVERY_QUESTION = 'broad_discovery';
const ROUTING_CONTRIBUTION = 'subagents';
const SMALL_REPOSITORY_FILE_LIMIT = 20;

const DISCOVERY_QUESTIONS: ClassifierQuestions = {
  [DISCOVERY_QUESTION]: {
    type: 'bool',
    instructions: 'Given `request`, `session.conversation`, and `extensions.subagents.active_children`, does answering or completing `request` require broad discovery across many files or locations that are unknown and not already covered by `session.conversation` or by an active child? Answer yes only when a wide, largely unexplored surface must be read, so a cheaper read-only `extensions.subagents.discovery_agent` returning a compact summary would replace substantial reading by the parent. Answer no when the conversation already holds the needed facts, the request names or implies a few specific files, the task is small or conversational, or an active child already covers the discovery.',
    criteria: { true: 'Broad discovery is required', false: 'Broad discovery is not required' },
  },
};

export const DISCOVERY_GUIDANCE = [
  '## Subagent routing decision',
  `This request needs broad discovery across a largely unexplored surface. Delegate that discovery to \`${DISCOVERY_AGENT_TYPE}\` children with bounded, disjoint, read-only questions and a requested summary format. While they run, do not read the delegated scopes yourself; continue only with independent work or yield until their completion notices arrive. Then verify the facts you rely on and inspect only the critical-path files you will change.`,
].join('\n');

export function registerClassifierRouting(pi: FelanExtensionAPI, host: SubagentHost): void {
  const registry = pi.turnClassification;
  const logger = pi.runtime?.logger?.child({ component: 'subagent-routing' });
  const discoveryAgent = host.descriptors.find(({ id }) => id === DISCOVERY_AGENT_TYPE);
  if (registry === undefined || discoveryAgent === undefined) {
    logger?.debug({
      event: 'configuration',
      mode: 'static',
      reason: discoveryAgent === undefined ? 'discovery-agent-unavailable' : 'turn-classification-unavailable',
    }, 'subagent routing configured');
    return;
  }

  let attempt = 0;
  registry.register({
    id: ROUTING_CONTRIBUTION,
    async prepare(_input, ctx, signal) {
      if (isChildSession(ctx) || isOneShotSession(ctx) || signal.aborted) return;
      if (typeof pi.runtime?.listFiles === 'function') {
        try {
          const paths = await pi.runtime.listFiles('.', {
            recursive: true,
            limit: SMALL_REPOSITORY_FILE_LIMIT,
            ignore: ['.git', 'node_modules', '.artifacts', 'dist'],
            signal,
          });
          if (signal.aborted) return;
          if (paths.length < SMALL_REPOSITORY_FILE_LIMIT) {
            logger?.debug({
              event: 'decision',
              sessionId: ctx.sessionManager.getSessionId(),
              outcome: 'skipped',
              reason: 'small-repository',
              discovery: false,
            }, 'subagent routing decision');
            return;
          }
        } catch {
          if (signal.aborted) return;
        }
      }
      const activeChildren = await host.list({ includeDescendants: false });
      if (signal.aborted) return;
      if (!activeChildren.ok) throw new Error(activeChildren.error.message);
      return {
        questions: DISCOVERY_QUESTIONS,
        state: {
          discovery_agent: discoveryAgent,
          active_children: activeChildren.value.map(({ agentId, type, status, description }) => ({
            id: agentId, type, status, description,
          })),
        },
      };
    },
  });

  pi.on('before_agent_start', async (event, ctx) => {
    if (isChildSession(ctx) || isOneShotSession(ctx)) return;
    const routingAttempt = ++attempt;
    const sessionId = ctx.sessionManager.getSessionId();
    try {
      const result = await registry.result(ROUTING_CONTRIBUTION, {
        prompt: event.prompt,
        imageCount: event.images?.length ?? 0,
      }, ctx);
      if (result === undefined) return;
      const answer = result.answers[DISCOVERY_QUESTION];
      const probability = answer?.type === 'bool' ? answer.probability : undefined;
      if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new Error('Classifier returned an incomplete discovery answer');
      }
      const discovery = probability >= ROUTING_THRESHOLD;
      logger?.debug({
        event: 'decision',
        sessionId,
        attempt: routingAttempt,
        outcome: 'classified',
        threshold: ROUTING_THRESHOLD,
        probability,
        discovery,
        classifier: result.metadata,
        guidanceSection: discovery ? ROUTING_PROMPT_SECTION : undefined,
      }, 'subagent routing decision');
      if (discovery) event.systemPromptOptions.sections[ROUTING_PROMPT_SECTION] = DISCOVERY_GUIDANCE;
    } catch (error) {
      logger?.warn({
        event: 'decision',
        sessionId,
        attempt: routingAttempt,
        outcome: 'failed',
        error: logError(error),
      }, 'subagent routing failed');
    }
  });
}

function isChildSession(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getHeader()?.parentSession !== undefined;
}

function isOneShotSession(ctx: ExtensionContext): boolean {
  return ctx.mode === 'print' || ctx.mode === 'json';
}

export function formatSubagentDescriptor(descriptor: SubagentDescriptor): string {
  const details = [descriptor.description.replace(/\s+/g, ' ').trim()];
  if (descriptor.model !== undefined) details.push(`model: ${descriptor.model}`);
  if (descriptor.thinking !== undefined) details.push(`thinking: ${descriptor.thinking}`);
  return `${descriptor.id} (${details.join('; ')})`;
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
