import {
  FELAN_THINKING_LEVELS,
  MODEL_TIERS,
  type Classifier,
  type ClassifierQuestions,
  type ExtensionContext,
  type FelanExtensionAPI,
  type FelanThinkingLevel,
  type ModelTier,
} from '@felan-ai/agent-core';

export type ExplorationDepth = 'sufficient' | 'targeted' | 'deep';
export type CompletionVerdict = 'done' | 'gap' | 'unsure';
export type ImplementationTier = Extract<ModelTier, 'low' | 'medium' | 'high'>;
export type ImplementationThinking = Extract<FelanThinkingLevel, 'low' | 'medium' | 'high'>;

export interface ImplementationProfile {
  tier: ImplementationTier;
  thinking: ImplementationThinking;
}

export interface RunContext {
  request: string;
  plan?: string;
  tasks: readonly string[];
}

export interface PrewalkClassifier {
  needsPrewalk(request: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<boolean>;
  explorationDepth(run: RunContext, ctx: ExtensionContext): Promise<ExplorationDepth | undefined>;
  implementationProfile(run: RunContext, ctx: ExtensionContext): Promise<ImplementationProfile | undefined>;
  completion(run: RunContext, finalMessage: string, ctx: ExtensionContext): Promise<CompletionVerdict | undefined>;
}

const MAX_CONVERSATION_ITEMS = 24;
const MAX_CONVERSATION_TEXT = 1_200;
const MAX_TOOL_ACTIVITY = 40;
const MAX_TOOL_INPUT = 160;
const MAX_PLAN_TEXT = 6_000;
const MAX_FINAL_MESSAGE = 3_000;

const ENTRY_QUESTIONS: ClassifierQuestions = {
  route: {
    type: 'choice',
    instructions: 'Given `request` and `session`, should this request run through Prewalk, a plan-then-implement workflow in which a stronger model explores and records a task graph before a cheaper model implements and verifies it?',
    criteria: {
      prewalk: 'The request asks for repository changes that span several files or layers, need dependency-aware planning, carry meaningful regression risk, or need broad verification, and `session` has not already planned or started that work.',
      regular: 'The request is read-only, conversational, a small localized edit or routine one-file fix, a continuation of work already in progress, or otherwise gains nothing from a separate planning phase.',
    },
  },
};

const DEPTH_QUESTIONS: ClassifierQuestions = {
  depth: {
    type: 'choice',
    instructions: 'Given `request` and `session` (prior conversation and tool activity), how much repository exploration does planning `request` still need?',
    criteria: {
      sufficient: '`session` already contains the findings needed to plan: the relevant files, symbols, and constraints were inspected or explained.',
      targeted: 'Some findings exist or the relevant locations are known or named, and only a few specific files or symbols remain to inspect.',
      deep: 'The relevant surface is broad and largely unexplored in `session`; many unknown files or areas must be read to plan correctly.',
    },
  },
};

const IMPLEMENTATION_QUESTIONS: ClassifierQuestions = {
  tier: {
    type: 'choice',
    instructions: 'Given `request`, the approved `plan`, and `tasks`, which model tier does implementing and verifying this plan need? The plan already fixes the approach.',
    criteria: {
      low: 'Mechanical or well-specified changes that follow existing patterns closely.',
      medium: 'Ordinary implementation with some judgment across a few files or tests.',
      high: 'Subtle logic, concurrency, security, migrations, cross-cutting or risky changes, or difficult debugging even with the plan in hand.',
    },
  },
  thinking: {
    type: 'choice',
    instructions: 'Given `request`, the approved `plan`, and `tasks`, how much reasoning effort does the implementation need?',
    criteria: {
      low: 'Straightforward edits where the plan spells out each change.',
      medium: 'Normal implementation requiring moderate reasoning.',
      high: 'Intricate reasoning about correctness, edge cases, or failures.',
    },
  },
};

const COMPLETION_QUESTIONS: ClassifierQuestions = {
  verdict: {
    type: 'choice',
    instructions: 'Given `request`, the approved `plan`, `tasks`, `session` tool activity, and the implementer\'s `final_message`, is the requested work complete and verified? Judge from evidence in the activity (edits, commands, errors), not from claims in `final_message` alone.',
    criteria: {
      done: 'Every requested change and task is addressed, relevant verification ran after the last edit, and nothing indicates failures, skipped scope, or unresolved errors.',
      gap: 'Evidence shows missing scope, skipped tasks, failing or missing verification, unresolved errors, or the final message admits unfinished work.',
      unsure: 'The evidence is insufficient to confirm completion and an independent review is needed to decide.',
    },
  },
};

export function createPrewalkClassifier(pi: FelanExtensionAPI): PrewalkClassifier | undefined {
  const classifier = pi.runtime?.classifier;
  if (classifier === undefined) return undefined;
  const logger = pi.runtime?.logger?.child({ component: 'prewalk-classifier' });

  async function ask(
    decision: string,
    state: unknown,
    questions: ClassifierQuestions,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<Record<string, string> | undefined> {
    const sessionId = ctx.sessionManager.getSessionId();
    try {
      const result = await (classifier as Classifier).evaluate(state, questions, signal);
      const choices: Record<string, string> = {};
      for (const [id, question] of Object.entries(questions)) {
        const choice = result.answers[id]?.choice;
        if (choice === undefined || !Object.hasOwn(question.criteria, choice)) {
          throw new Error(`Classifier returned no valid ${id} choice`);
        }
        choices[id] = choice;
      }
      logger?.debug({ event: 'decision', decision, sessionId, choices, classifier: result.metadata }, 'prewalk classifier decision');
      return choices;
    } catch (error) {
      if (signal?.aborted) return undefined;
      logger?.warn({ event: 'decision', decision, sessionId, outcome: 'failed', error: errorFields(error) }, 'prewalk classifier failed');
      return undefined;
    }
  }

  return {
    async needsPrewalk(request, ctx, signal) {
      const choices = await ask('entry', { request, session: snapshotSession(ctx) }, ENTRY_QUESTIONS, ctx, signal);
      return choices?.route === 'prewalk';
    },
    async explorationDepth(run, ctx) {
      const choices = await ask('exploration-depth', runState(run, ctx), DEPTH_QUESTIONS, ctx);
      return choices?.depth as ExplorationDepth | undefined;
    },
    async implementationProfile(run, ctx) {
      const choices = await ask('implementation-profile', runState(run, ctx, false), IMPLEMENTATION_QUESTIONS, ctx);
      return choices === undefined
        ? undefined
        : { tier: choices.tier as ImplementationTier, thinking: choices.thinking as ImplementationThinking };
    },
    async completion(run, finalMessage, ctx) {
      const state = {
        ...runState(run, ctx, false),
        session: snapshotSession(ctx),
        final_message: truncate(finalMessage, MAX_FINAL_MESSAGE),
      };
      const choices = await ask('completion', state, COMPLETION_QUESTIONS, ctx);
      const verdict = choices?.verdict as CompletionVerdict | undefined;
      if (verdict !== 'done') return verdict;
      return state.session.verification_after_last_mutation && !state.session.failed_verification
        ? verdict
        : 'unsure';
    },
  };
}

export function strongerTier(configured: ModelTier, chosen: ImplementationTier): ModelTier {
  return MODEL_TIERS.indexOf(chosen) < MODEL_TIERS.indexOf(configured) ? chosen : configured;
}

export function strongerThinking(configured: FelanThinkingLevel, chosen: ImplementationThinking): FelanThinkingLevel {
  return FELAN_THINKING_LEVELS.indexOf(chosen) > FELAN_THINKING_LEVELS.indexOf(configured) ? chosen : configured;
}

export function isChildSession(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getHeader()?.parentSession !== undefined;
}

function runState(run: RunContext, ctx: ExtensionContext, includeSession = true) {
  return {
    request: run.request,
    ...(run.plan === undefined ? {} : { plan: truncate(run.plan, MAX_PLAN_TEXT) }),
    tasks: run.tasks,
    ...(includeSession ? { session: snapshotSession(ctx) } : {}),
  };
}

interface SessionSnapshot {
  conversation: { role: string; text: string }[];
  tool_activity: { tool: string; input: string; result?: 'ok' | 'failed'; exit_code?: number; task_status?: string }[];
  verification_after_last_mutation: boolean;
  failed_verification: boolean;
}

function snapshotSession(ctx: ExtensionContext): SessionSnapshot {
  const conversation: SessionSnapshot['conversation'] = [];
  const activity: SessionSnapshot['tool_activity'] = [];
  const activityByCallId = new Map<string, SessionSnapshot['tool_activity'][number]>();
  for (const message of sessionMessages(ctx)) {
    if (!isRecord(message)) continue;
    if (message.role === 'summary') {
      conversation.push({ role: 'summary', text: truncate(String(message.text), MAX_CONVERSATION_TEXT) });
      continue;
    }
    if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
      const entry = activityByCallId.get(message.toolCallId);
      if (entry) {
        const exitCode = exitCodeFromResult(message);
        entry.result = message.isError === true || (exitCode !== undefined && exitCode !== 0) ? 'failed' : 'ok';
        if (exitCode !== undefined) entry.exit_code = exitCode;
        const details = message.details;
        if (isRecord(details) && isRecord(details.task) && typeof details.task.status === 'string') {
          entry.task_status = details.task.status;
        }
      }
      continue;
    }
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = contentText(message.content);
    if (text.trim()) conversation.push({ role: message.role, text: truncate(text, MAX_CONVERSATION_TEXT) });
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== 'toolCall' || typeof part.name !== 'string') continue;
      const entry = { tool: part.name, input: summarizeInput(part.arguments) };
      activity.push(entry);
      if (typeof part.id === 'string') activityByCallId.set(part.id, entry);
    }
  }
  const lastMutation = activity.map(({ tool, result }) => (
    ['edit', 'write', 'apply_patch'].includes(tool) && result === 'ok'
  )).lastIndexOf(true);
  const verification = activity.slice(lastMutation + 1).filter(({ tool, input }) => (
    tool === 'bash' && /\b(build|test|type-check|typecheck|verify|lint|check)\b/i.test(input)
  ));
  const latestVerification = new Map(verification.map(({ input, result }) => [input, result]));
  return {
    conversation: conversation.slice(-MAX_CONVERSATION_ITEMS),
    tool_activity: activity.slice(-MAX_TOOL_ACTIVITY),
    verification_after_last_mutation: lastMutation >= 0 && verification.some(({ result }) => result === 'ok'),
    failed_verification: [...latestVerification.values()].some((result) => result === 'failed'),
  };
}

function exitCodeFromResult(message: Record<string, unknown>): number | undefined {
  const details = message.details;
  if (isRecord(details) && typeof details.exitCode === 'number') return details.exitCode;
  const text = contentText(message.content);
  const match = /(?:Exit(?: code)?):\s*(\d+)/i.exec(text);
  return match ? Number(match[1]) : undefined;
}

function sessionMessages(ctx: ExtensionContext): unknown[] {
  const manager = ctx.sessionManager;
  if (typeof manager.buildSessionProjection === 'function') {
    return manager.buildSessionProjection().entries.flatMap(({ sourceEntry, messages }): unknown[] => (
      sourceEntry.type === 'compaction' || sourceEntry.type === 'branch_summary'
        ? [{ role: 'summary', text: sourceEntry.summary }]
        : messages
    ));
  }
  return manager.buildContextEntries().flatMap((entry): unknown[] => {
    if (entry.type === 'compaction' || entry.type === 'branch_summary') return [{ role: 'summary', text: entry.summary }];
    return entry.type === 'message' ? [entry.message] : [];
  });
}

function summarizeInput(input: unknown): string {
  if (!isRecord(input)) return '';
  for (const key of ['path', 'file_path', 'command', 'pattern', 'query', 'description', 'title']) {
    const value = input[key];
    if (typeof value === 'string') return truncate(value, MAX_TOOL_INPUT);
  }
  return truncate(JSON.stringify(input), MAX_TOOL_INPUT);
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

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function errorFields(error: unknown): { name: string; message: string } {
  return error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
