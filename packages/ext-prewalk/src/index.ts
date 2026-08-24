import {
  formatModelReference,
  isModelTier,
  parseModelReference,
  selectModelForTier,
  type ModelReference,
  type ModelTier,
  type ExtensionContext,
  type FelanExtension,
  type FelanExtensionAPI,
} from '@felan-ai/agent-core';
import { Type } from 'typebox';
import {
  CONTINUATION_INSTRUCTION,
  CONTINUATION_MESSAGE_TYPE,
  CONTROL_MESSAGE_PREFIX,
  IMPLEMENTATION_MESSAGE_TYPE,
  PLANNING_INSTRUCTION,
  PLANNING_MESSAGE_TYPE,
  VERIFICATION_INSTRUCTION,
} from './prompts.js';
import {
  beginTurn,
  createRunState,
  recordToolCall,
  reduceTurn,
  validateArmingTools,
  type PrewalkPhase,
  type PrewalkState,
} from './state.js';

type PlannerModel = NonNullable<ExtensionContext['model']>;
type PlannerThinkingLevel = ReturnType<FelanExtensionAPI['getThinkingLevel']>;
type NotificationType = 'info' | 'warning' | 'error';

interface PrewalkConfig {
  targetModel: string;
  restorePlanner: boolean;
}

type TargetModel =
  | { readonly kind: 'tier'; readonly tier: ModelTier; readonly key: string }
  | { readonly kind: 'model'; readonly model: ModelReference; readonly key: string };

interface PlannerSnapshot {
  model: PlannerModel;
  modelKey: string;
  thinkingLevel: PlannerThinkingLevel;
}

interface ModelTransition {
  expectedModelKey: string;
  externalModel?: PlannerModel;
  externalThinkingLevel?: PlannerThinkingLevel;
}

type GuidedPhase = Extract<PrewalkPhase, 'planning' | 'implementing'>;

interface PhaseContextAnchor {
  phase: GuidedPhase;
  afterKey?: string;
  fallbackIndex: number;
  instructionTimestamp: number;
}

interface ContextBuildResult {
  messages: unknown[];
  anchor?: PhaseContextAnchor;
}

const DEFAULT_CONFIG: PrewalkConfig = {
  targetModel: 'low',
  restorePlanner: true,
};
const TARGET_MODEL_FLAG = 'prewalk-target-model';
const RESTORE_PLANNER_FLAG = 'prewalk-restore-planner';
const HEADLESS_TASK_MESSAGE_TYPE = 'pi-prewalk-task';
const ENTER_PREWALK_TOOL = 'enter_prewalk';
const EnterPrewalkParams = Type.Object({}, { additionalProperties: false });

const prewalkExtension: FelanExtension = (pi): void => {
  pi.registerCapability({
    id: 'prewalk',
    instructions: 'Use Prewalk for complex repository work that benefits from substantial exploration, coordinated multi-file changes, dependency-aware planning, or broad verification. Do not use it for small localized edits, routine one-file fixes, read-only requests, or when injected planning or implementation guidance is already present. When a complex file-changing task begins without that guidance, call enter_prewalk as the first and only tool call before repository exploration or mutation. The tool is available in the root session and mutation-capable subagents. During an active run, follow the injected planning, task-tracking, implementation, and verification guidance. The user can exit with /prewalk exit (or /prewalk off).',
  });

  pi.registerFlag(TARGET_MODEL_FLAG, {
    description: 'Model tier or exact provider/model-id used to implement a planned Prewalk task',
    type: 'string',
    default: DEFAULT_CONFIG.targetModel,
  });
  pi.registerFlag(RESTORE_PLANNER_FLAG, {
    description: 'Restore the planner model and thinking level after implementation',
    type: 'boolean',
    default: DEFAULT_CONFIG.restorePlanner,
  });

  let loadedConfig: ReturnType<typeof loadConfig> = { config: { ...DEFAULT_CONFIG } };
  let config = loadedConfig.config;
  let targetModel = parseTargetModel(config.targetModel)!;
  let configWarningShown = false;
  let state: PrewalkState = { phase: 'idle' };
  let plannerSnapshot: PlannerSnapshot | undefined;
  let exitRequested = false;
  let modelTransition: ModelTransition | undefined;
  let handoffPromise: Promise<void> | undefined;
  let restorationPromise: Promise<boolean> | undefined;
  let phaseContextAnchor: PhaseContextAnchor | undefined;

  function refreshConfig(): void {
    loadedConfig = loadConfig(pi);
    config = loadedConfig.config;
    targetModel = parseTargetModel(config.targetModel)!;
  }

  function notify(ctx: ExtensionContext, message: string, type: NotificationType = 'info'): void {
    if (ctx.hasUI) {
      ctx.ui.notify(message, type);
    } else {
      console.error(message);
    }
  }

  function publishConfigWarning(ctx: ExtensionContext): void {
    if (!loadedConfig.warning || configWarningShown) return;
    configWarningShown = true;
    notify(ctx, `Prewalk flag warning: ${loadedConfig.warning} Using defaults.`, 'warning');
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (state.phase === 'idle') {
      ctx.ui.setStatus('prewalk', undefined);
      return;
    }

    const continuationCount = state.run?.continuationCount ?? 0;
    const continuationText = state.phase === 'planning' && continuationCount > 0
      ? ` · ${continuationCount}/3`
      : '';
    const exitText = exitRequested ? ' · exit pending' : '';
    ctx.ui.setStatus('prewalk', `Prewalk ${state.phase}${continuationText}${exitText}`);
  }

  function publishStatus(ctx: ExtensionContext): void {
    publishConfigWarning(ctx);
    const planner = plannerSnapshot ? ` | planner ${plannerSnapshot.modelKey}` : '';
    const exit = exitRequested ? ' | exit pending' : '';
    notify(
      ctx,
      `Prewalk: ${state.phase} | target ${targetModel.key} | restore planner ${config.restorePlanner ? 'on' : 'off'}${planner}${exit}`,
    );
  }

  function clearAutomation(ctx: ExtensionContext): void {
    state = { phase: 'idle' };
    plannerSnapshot = undefined;
    phaseContextAnchor = undefined;
    exitRequested = false;
    updateStatus(ctx);
  }

  function failAutomation(ctx: ExtensionContext, message: string): void {
    clearAutomation(ctx);
    notify(ctx, message, 'error');
  }

  async function arm(ctx: ExtensionContext): Promise<boolean> {
    publishConfigWarning(ctx);
    if (state.phase !== 'idle') {
      notify(ctx, `Prewalk is already ${state.phase}. Use /prewalk off before starting another run.`, 'warning');
      return false;
    }
    if (!ctx.isIdle()) {
      notify(ctx, 'Prewalk can only be armed while the agent is idle.', 'warning');
      return false;
    }

    const validation = validateArmingTools(pi.getActiveTools());
    if (!validation.ok) {
      notify(ctx, validation.reason, 'error');
      return false;
    }

    state = { phase: 'armed' };
    updateStatus(ctx);
    notify(ctx, `Prewalk armed. The next task will plan, initialize Tasks when both task tools are active, make one mutation, then hand off to ${targetModel.key}.`);
    return true;
  }

  function startRun(ctx: ExtensionContext, handoffArmed = true): boolean {
    if (!ctx.model) {
      failAutomation(ctx, 'Prewalk requires a selected planner model.');
      return false;
    }

    plannerSnapshot = {
      model: ctx.model,
      modelKey: modelKey(ctx.model),
      thinkingLevel: pi.getThinkingLevel(),
    };
    phaseContextAnchor = undefined;
    exitRequested = false;
    const activeTools = pi.getActiveTools();
    state = {
      phase: 'planning',
      run: createRunState({
        handoffArmed,
        taskGateRequired: activeTools.includes('TaskCreate') && activeTools.includes('TaskUpdate'),
      }),
    };
    updateStatus(ctx);
    return true;
  }

  function beginRun(ctx: ExtensionContext): void {
    if (state.phase !== 'armed') return;
    startRun(ctx);
  }

  async function switchToTarget(ctx: ExtensionContext): Promise<void> {
    if (state.phase !== 'planning' || !state.run || !plannerSnapshot) return;

    const run = state.run;
    const snapshot = plannerSnapshot;
    state = { phase: 'handoff', run };
    phaseContextAnchor = undefined;
    updateStatus(ctx);

    let target: PlannerModel;
    if (targetModel.kind === 'tier') {
      const availableModels = ctx.scopedModels.length > 0
        ? ctx.scopedModels.map(({ model }) => model)
        : ctx.modelRegistry.getAvailable();
      const selected = selectModelForTier(targetModel.tier, availableModels, {
        preferredModel: snapshot.model,
      });
      if (!selected) {
        failAutomation(ctx, `Prewalk has no authenticated model for the ${targetModel.tier} tier.`);
        return;
      }
      target = selected.model;
    } else {
      const exactReference = targetModel.model;
      const registeredTarget = ctx.modelRegistry.find(exactReference.provider, exactReference.id);
      if (!registeredTarget) {
        failAutomation(ctx, `Prewalk target model is unavailable: ${targetModel.key}.`);
        return;
      }
      const scopedTarget = ctx.scopedModels.find(({ model }) => (
        model.provider === exactReference.provider && model.id === exactReference.id
      ))?.model;
      if (ctx.scopedModels.length > 0 && !scopedTarget) {
        failAutomation(ctx, `Prewalk target model is outside the current session model scope: ${targetModel.key}.`);
        return;
      }
      target = scopedTarget ?? registeredTarget;
      if (!ctx.modelRegistry.hasConfiguredAuth(target)) {
        failAutomation(ctx, `Prewalk target model is not authenticated: ${targetModel.key}.`);
        return;
      }
    }
    const targetKey = formatModelReference(target);
    if (sameModel(ctx.model, target)) {
      clearAutomation(ctx);
      notify(ctx, `Prewalk target ${targetKey} already matches the planner model; continuing without a model handoff.`);
      return;
    }

    try {
      const switched = await setModelPreservingExternalSelection(target, ctx);
      if (state.phase !== 'handoff' || plannerSnapshot !== snapshot) return;
      if (!switched) {
        failAutomation(ctx, `Prewalk could not switch to ${targetKey}.`);
        return;
      }

      state = { phase: 'implementing', run };
      updateStatus(ctx);
      notify(ctx, `Prewalk handed implementation to ${targetKey}.`);
    } catch (error) {
      if (state.phase === 'handoff' && plannerSnapshot === snapshot) {
        failAutomation(ctx, `Prewalk could not switch to ${targetKey}: ${errorMessage(error)}`);
      }
    }
  }

  function restorePlanner(ctx: ExtensionContext): Promise<boolean> {
    if (restorationPromise) return restorationPromise;

    const restoration = performPlannerRestoration(ctx).finally(() => {
      if (restorationPromise === restoration) restorationPromise = undefined;
    });
    restorationPromise = restoration;
    return restoration;
  }

  async function performPlannerRestoration(ctx: ExtensionContext): Promise<boolean> {
    if (handoffPromise) await handoffPromise;

    const snapshot = plannerSnapshot;
    if (!snapshot) {
      clearAutomation(ctx);
      return true;
    }

    state = { phase: 'restoring', run: state.run! };
    updateStatus(ctx);

    try {
      if (modelKey(ctx.model) !== snapshot.modelKey) {
        const restored = await setModelPreservingExternalSelection(snapshot.model, ctx);
        if (state.phase !== 'restoring' || plannerSnapshot !== snapshot) return false;
        if (!restored) throw new Error(`model ${snapshot.modelKey} is not authenticated`);
      }

      if (state.phase !== 'restoring' || plannerSnapshot !== snapshot) return false;
      pi.setThinkingLevel(snapshot.thinkingLevel);
      clearAutomation(ctx);
      return true;
    } catch (error) {
      if (state.phase !== 'idle') {
        clearAutomation(ctx);
        notify(ctx, `Prewalk could not restore ${snapshot.modelKey}: ${errorMessage(error)}`, 'error');
      }
      return false;
    }
  }

  async function setModelPreservingExternalSelection(
    model: PlannerModel,
    ctx: ExtensionContext,
  ): Promise<boolean> {
    if (modelTransition) throw new Error('another Prewalk model transition is already active');

    const transition: ModelTransition = { expectedModelKey: modelKey(model) };
    modelTransition = transition;
    try {
      let switched: boolean;
      try {
        switched = await pi.setModel(model);
      } finally {
        await reapplyExternalModel(ctx, transition);
      }
      return switched;
    } finally {
      if (modelTransition === transition) modelTransition = undefined;
    }
  }

  async function reapplyExternalModel(
    ctx: ExtensionContext,
    transition: ModelTransition,
  ): Promise<void> {
    while (
      transition.externalModel
      && modelKey(ctx.model) !== modelKey(transition.externalModel)
    ) {
      const externalModel = transition.externalModel;
      transition.expectedModelKey = modelKey(externalModel);
      const restored = await pi.setModel(externalModel);
      if (!restored) throw new Error(`could not retain manual model ${modelKey(externalModel)}`);
    }
    if (
      transition.externalModel
      && transition.externalThinkingLevel !== undefined
      && modelKey(ctx.model) === modelKey(transition.externalModel)
    ) {
      pi.setThinkingLevel(transition.externalThinkingLevel);
    }
  }

  async function turnOff(ctx: ExtensionContext): Promise<void> {
    if (state.phase === 'idle') {
      notify(ctx, 'Prewalk is already off.');
      return;
    }

    if (state.phase === 'restoring') {
      const restored = await restorePlanner(ctx);
      if (restored) notify(ctx, 'Prewalk is off and the planner model has been restored.');
      return;
    }

    const targetIsActive = state.phase === 'handoff'
      || state.phase === 'implementing';
    if (targetIsActive && config.restorePlanner && plannerSnapshot) {
      if (state.phase === 'handoff' || !ctx.isIdle()) {
        if (!exitRequested) {
          exitRequested = true;
          updateStatus(ctx);
          notify(ctx, 'Prewalk will exit and restore the planner when the current agent run settles.');
        } else {
          notify(ctx, 'Prewalk exit is already pending.');
        }
        return;
      }

      const restored = await restorePlanner(ctx);
      if (restored) notify(ctx, 'Prewalk is off and the planner model has been restored.');
      return;
    }

    clearAutomation(ctx);
    notify(ctx, 'Prewalk is off.');
  }

  pi.registerTool({
    name: ENTER_PREWALK_TOOL,
    label: 'Enter Prewalk',
    description: 'Enter same-session Prewalk for a complex repository task that requires substantial exploration, coordinated multi-file changes, dependency-aware planning, or broad verification. Do not call it for small localized edits, routine one-file fixes, read-only work, or when injected guidance already directs planning or implementation. Call this once, as the only tool call in the response and before exploration or mutation.',
    promptSnippet: 'Enter Prewalk for complex repository work before exploration',
    executionMode: 'sequential',
    parameters: EnterPrewalkParams,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (state.phase === 'idle') refreshConfig();
      publishConfigWarning(ctx);

      if (state.phase !== 'idle') {
        return prewalkToolError(
          `Prewalk is already ${state.phase}; continue the active run without calling ${ENTER_PREWALK_TOOL} again.`,
          state.phase,
        );
      }

      const validation = validateArmingTools(pi.getActiveTools());
      if (!validation.ok) return prewalkToolError(validation.reason, state.phase);
      if (!ctx.model) return prewalkToolError('Prewalk requires a selected planner model.', state.phase);

      startRun(ctx, false);
      return {
        content: [{
          type: 'text',
          text: `Prewalk entered for the current task. Follow the injected planning guidance, initialize Tasks when both task tools are active, keep the task graph concise, and make one focused mutation before the handoff to ${targetModel.key}.`,
        }],
        details: { phase: 'planning', targetModel: targetModel.key },
      };
    },
  });

  pi.registerCommand('prewalk', {
    description: 'Enter Prewalk, inspect status, or exit its model-routing lifecycle',
    handler: async (args, ctx) => {
      if (state.phase === 'idle') refreshConfig();
      const command = args.trim();
      if (command === 'status') {
        publishStatus(ctx);
        return;
      }
      if (command === 'off' || command === 'exit' || command === 'cancel') {
        await turnOff(ctx);
        return;
      }
      if (!(await arm(ctx))) return;
      if (!command) return;

      if (!ctx.hasUI) {
        beginRun(ctx);
        if (state.phase !== 'planning') return;
        pi.sendMessage(
          {
            customType: HEADLESS_TASK_MESSAGE_TYPE,
            content: command,
            display: true,
          },
          { triggerTurn: true },
        );
        await ctx.waitForIdle();
        return;
      }

      pi.sendUserMessage(command);
    },
  });

  pi.on('session_start', (_event, ctx) => {
    if (state.phase === 'idle') refreshConfig();
    publishConfigWarning(ctx);
    updateStatus(ctx);
  });

  pi.on('before_agent_start', (_event, ctx) => {
    beginRun(ctx);
  });

  pi.on('context', (event) => {
    const result = buildContextMessages(event.messages, state.phase, phaseContextAnchor);
    phaseContextAnchor = result.anchor;
    return { messages: result.messages as typeof event.messages };
  });

  pi.on('turn_start', () => {
    if (state.phase !== 'planning' || !state.run) return;
    state = { phase: 'planning', run: beginTurn(state.run) };
  });

  pi.on('tool_call', (event) => {
    if (state.phase !== 'planning' || !state.run) return;

    state = {
      phase: 'planning',
      run: recordToolCall(
        state.run,
        { toolCallId: event.toolCallId, toolName: event.toolName, input: event.input },
      ),
    };
  });

  pi.on('turn_end', async (event, ctx) => {
    if (state.phase !== 'planning' || !state.run) return;

    const decision = reduceTurn(state.run, event.toolResults, {
      allowContinuation: isTextOnlyCompletion(event.message),
    });
    state = { phase: 'planning', run: decision.state };
    updateStatus(ctx);

    if (decision.shouldHandoff) {
      const handoff = switchToTarget(ctx).finally(() => {
        if (handoffPromise === handoff) handoffPromise = undefined;
      });
      handoffPromise = handoff;
      await handoff;
      return;
    }

    if (decision.shouldContinue) {
      pi.sendMessage(
        {
          customType: CONTINUATION_MESSAGE_TYPE,
          content: CONTINUATION_INSTRUCTION,
          display: false,
        },
        { deliverAs: 'followUp' },
      );
    }
  });

  pi.on('model_select', (event, ctx) => {
    const selectedModelKey = modelKey(event.model);
    if (modelTransition?.expectedModelKey === selectedModelKey) return;
    if (modelTransition) {
      modelTransition.externalModel = event.model;
      modelTransition.externalThinkingLevel = pi.getThinkingLevel();
    }
    if (state.phase === 'idle') return;

    clearAutomation(ctx);
    notify(ctx, `Prewalk cancelled after the model changed to ${selectedModelKey}.`, 'warning');
  });

  pi.on('agent_settled', async (_event, ctx) => {
    if (state.phase === 'implementing' || state.phase === 'handoff') {
      if (config.restorePlanner && plannerSnapshot) {
        const snapshot = plannerSnapshot;
        const restored = await restorePlanner(ctx);
        if (restored) notify(ctx, `Prewalk restored ${snapshot.modelKey}.`);
      } else {
        clearAutomation(ctx);
      }
      return;
    }

    if (state.phase === 'planning') {
      clearAutomation(ctx);
      notify(ctx, 'Prewalk ended before a qualifying first mutation.', 'warning');
    }
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    const targetIsActive = state.phase === 'handoff'
      || state.phase === 'implementing'
      || state.phase === 'restoring';
    if (targetIsActive && config.restorePlanner && plannerSnapshot) {
      await restorePlanner(ctx);
    } else if (state.phase !== 'idle') {
      clearAutomation(ctx);
    }
  });
};

function buildContextMessages(
  messages: readonly unknown[],
  phase: PrewalkPhase,
  currentAnchor?: PhaseContextAnchor,
): ContextBuildResult {
  const successfulEntries = successfulEntryCallIds(messages);
  const filtered: unknown[] = [];
  for (const message of structuredClone(messages)) {
    if (isControlMessage(message)) {
      if (phase === 'planning' && isCurrentContinuationMessage(message)) filtered.push(message);
      continue;
    }
    if (isSuccessfulEntryResult(message, successfulEntries)) continue;
    const stripped = stripSuccessfulEntryCall(message, successfulEntries);
    if (stripped !== undefined) filtered.push(stripped);
  }
  const guidedPhase = phase === 'planning' || phase === 'implementing' ? phase : undefined;
  const instruction = guidedPhase === 'planning'
    ? { customType: PLANNING_MESSAGE_TYPE, content: PLANNING_INSTRUCTION }
    : guidedPhase === 'implementing'
      ? {
          customType: IMPLEMENTATION_MESSAGE_TYPE,
          content: VERIFICATION_INSTRUCTION,
        }
      : undefined;

  if (guidedPhase === undefined || instruction === undefined) return { messages: filtered };

  const { anchor, index } = resolvePhaseContextAnchor(filtered, guidedPhase, currentAnchor);
  const phaseMessage = {
    role: 'custom',
    customType: instruction.customType,
    content: instruction.content,
    display: false,
    timestamp: anchor.instructionTimestamp,
  };

  return {
    messages: [...filtered.slice(0, index), phaseMessage, ...filtered.slice(index)],
    anchor,
  };
}

function resolvePhaseContextAnchor(
  messages: readonly unknown[],
  phase: GuidedPhase,
  currentAnchor?: PhaseContextAnchor,
): { anchor: PhaseContextAnchor; index: number } {
  if (currentAnchor?.phase === phase) {
    if (currentAnchor.afterKey !== undefined) {
      const anchoredIndex = messages.findIndex(
        (message) => contextMessageKey(message) === currentAnchor.afterKey,
      );
      if (anchoredIndex >= 0) return { anchor: currentAnchor, index: anchoredIndex + 1 };
    } else if (currentAnchor.fallbackIndex <= messages.length) {
      return { anchor: currentAnchor, index: currentAnchor.fallbackIndex };
    }
  }

  const fallbackIndex = messages.length;
  const afterKey = fallbackIndex > 0 ? contextMessageKey(messages[fallbackIndex - 1]) : undefined;
  const anchor: PhaseContextAnchor = {
    phase,
    fallbackIndex,
    instructionTimestamp: Date.now(),
    ...(afterKey === undefined ? {} : { afterKey }),
  };
  return { anchor, index: fallbackIndex };
}

function contextMessageKey(message: unknown): string | undefined {
  if (!isRecord(message) || typeof message.role !== 'string') return undefined;
  const timestamp = message.timestamp;
  if (typeof timestamp !== 'number' && typeof timestamp !== 'string') return undefined;

  return JSON.stringify([
    message.role,
    timestamp,
    typeof message.toolCallId === 'string' ? message.toolCallId : '',
    typeof message.customType === 'string' ? message.customType : '',
  ]);
}

function isTextOnlyCompletion(message: unknown): boolean {
  return isRecord(message)
    && message.role === 'assistant'
    && message.stopReason === 'stop'
    && Array.isArray(message.content)
    && !message.content.some((content) => isRecord(content) && content.type === 'toolCall');
}

function isControlMessage(message: unknown): boolean {
  return isRecord(message)
    && message.role === 'custom'
    && typeof message.customType === 'string'
    && message.customType.startsWith(CONTROL_MESSAGE_PREFIX);
}

function isCurrentContinuationMessage(message: unknown): boolean {
  return isRecord(message)
    && message.role === 'custom'
    && message.customType === CONTINUATION_MESSAGE_TYPE
    && message.content === CONTINUATION_INSTRUCTION;
}

function successfulEntryCallIds(messages: readonly unknown[]): ReadonlySet<string> {
  const callIds = new Set<string>();
  for (const message of messages) {
    if (
      isRecord(message)
      && message.role === 'toolResult'
      && message.toolName === ENTER_PREWALK_TOOL
      && message.isError !== true
      && typeof message.toolCallId === 'string'
    ) {
      callIds.add(message.toolCallId);
    }
  }
  return callIds;
}

function isSuccessfulEntryResult(message: unknown, callIds: ReadonlySet<string>): boolean {
  return isRecord(message)
    && message.role === 'toolResult'
    && message.toolName === ENTER_PREWALK_TOOL
    && typeof message.toolCallId === 'string'
    && callIds.has(message.toolCallId);
}

function stripSuccessfulEntryCall(
  message: unknown,
  callIds: ReadonlySet<string>,
): unknown | undefined {
  if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.content)) {
    return message;
  }

  const isEntryCall = (item: unknown): boolean => (
    isRecord(item)
    && item.type === 'toolCall'
    && item.name === ENTER_PREWALK_TOOL
    && typeof item.id === 'string'
    && callIds.has(item.id)
  );
  if (!message.content.some(isEntryCall)) return message;

  const hasOtherToolCalls = message.content.some((item) => (
    isRecord(item) && item.type === 'toolCall' && !isEntryCall(item)
  ));
  if (!hasOtherToolCalls) return undefined;

  const content = message.content.filter((item) => !isEntryCall(item));
  return content.length === 0 ? undefined : { ...message, content };
}

function modelKey(model: ExtensionContext['model']): string {
  return model ? `${model.provider}/${model.id}` : 'none';
}

function sameModel(left: ExtensionContext['model'], right: ModelReference): boolean {
  return left !== undefined
    && left.provider.toLowerCase() === right.provider.toLowerCase()
    && left.id.toLowerCase() === right.id.toLowerCase();
}

function parseTargetModel(value: string): TargetModel | undefined {
  const normalized = value.trim();
  if (isModelTier(normalized)) return { kind: 'tier', tier: normalized, key: normalized };
  const model = parseModelReference(normalized);
  return model ? { kind: 'model', model, key: formatModelReference(model) } : undefined;
}

function loadConfig(pi: FelanExtensionAPI): { config: PrewalkConfig; warning?: string } {
  const targetModel = pi.getFlag(TARGET_MODEL_FLAG);
  const restorePlanner = pi.getFlag(RESTORE_PLANNER_FLAG);
  const parsedTarget = typeof targetModel === 'string' ? parseTargetModel(targetModel) : undefined;

  if (!parsedTarget) {
    return invalidConfig(`${TARGET_MODEL_FLAG} must be high, medium, low, or an exact provider/model-id`);
  }
  if (typeof restorePlanner !== 'boolean') return invalidConfig(`${RESTORE_PLANNER_FLAG} must be a boolean`);

  return {
    config: {
      targetModel: parsedTarget.key,
      restorePlanner,
    },
  };
}

function invalidConfig(reason: string): { config: PrewalkConfig; warning: string } {
  return { config: { ...DEFAULT_CONFIG }, warning: `${reason}.` };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function prewalkToolError(message: string, phase: PrewalkPhase) {
  return {
    content: [{ type: 'text' as const, text: message }],
    details: { error: message, phase },
    isError: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export default prewalkExtension;
