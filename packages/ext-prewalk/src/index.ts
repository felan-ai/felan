import {
  associateExtensionConfig,
  configField,
  defineExtensionConfig,
  clampThinkingLevel,
  isFelanThinkingLevel,
  formatModelReference,
  isModelTier,
  parseModelReference,
  selectModelForTier,
  type FelanThinkingLevel,
  type ModelReference,
  type ModelTier,
  type AssistantMessage,
  type ExtensionContext,
  type FelanExtension,
  type FelanExtensionAPI,
  type SavingsModelReference,
  type SavingsReporter,
  type SavingsTokenUsage,
} from '@felan-ai/agent-core';
import { Type } from 'typebox';
import {
  CONTINUATION_INSTRUCTION,
  CONTINUATION_MESSAGE_TYPE,
  CONTROL_MESSAGE_PREFIX,
  IMPLEMENTATION_MESSAGE_TYPE,
  PLAN_APPROVED_INSTRUCTION,
  PLAN_APPROVED_MESSAGE_TYPE,
  PLAN_REVIEW_MESSAGE_TYPE,
  PLAN_REVIEW_PLANNING_INSTRUCTION,
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
  targetThinking: FelanThinkingLevel;
  restorePlanner: boolean;
  entryApproval: PrewalkEntryApprovalPolicy;
  planReview: PrewalkPlanReviewPolicy;
}

export type PrewalkEntryApprovalPolicy = 'ask' | 'allow' | 'deny';
export type PrewalkPlanReviewPolicy = 'inherit' | 'ask' | 'skip';
export const PREWALK_CONFIG = defineExtensionConfig({
  id: 'prewalk',
  title: 'Prewalk',
  fields: {
    targetModel: configField.string({
      default: 'low',
      description: 'Implementation model tier or exact model',
      validate: (value) => parseTargetModel(String(value)) ? undefined : 'must be a model tier or provider/model-id',
    }),
    targetThinking: configField.enum(['off', 'low', 'medium', 'high', 'xhigh', 'max'], {
      default: 'medium', description: 'Implementation thinking level',
    }),
    restorePlanner: configField.boolean({ default: true, description: 'Restore the planner after implementation' }),
    entryApproval: configField.enum(['ask', 'allow', 'deny'], {
      default: 'ask', description: 'Approval policy for model-entered Prewalk',
    }),
    planReview: configField.enum(['inherit', 'ask', 'skip'], {
      default: 'inherit', description: 'Plan review policy; inherit asks when entry approval asks',
    }),
  },
});

type TargetModel =
  | { readonly kind: 'tier'; readonly tier: ModelTier; readonly key: string }
  | { readonly kind: 'model'; readonly model: ModelReference; readonly key: string };

interface PlannerSnapshot {
  model: PlannerModel;
  modelKey: string;
  thinkingLevel: PlannerThinkingLevel;
}

interface ImplementationSavingsModels {
  planner: SavingsModelReference;
  target: SavingsModelReference;
}

interface ModelTransition {
  expectedModelKey: string;
  initialThinkingLevel: PlannerThinkingLevel;
  modelSelectObserved: boolean;
  externalModel?: PlannerModel;
  externalThinkingLevel?: PlannerThinkingLevel;
}

interface ModelTransitionResult {
  switched: boolean;
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

const HEADLESS_TASK_MESSAGE_TYPE = 'pi-prewalk-task';
const ENTER_PREWALK_TOOL = 'enter_prewalk';
const EXIT_PLAN_MODE_TOOL = 'exit_plan_mode';
const APPROVE_PLAN_OPTION = 'Approve plan';
const FEEDBACK_PLAN_OPTION = 'Provide feedback';
const CANCEL_PREWALK_OPTION = 'Cancel Prewalk';
const MAX_PLAN_LENGTH = 32_000;
const IMPLEMENTATION_BASELINE_RATIO = 2 / 3;
const EnterPrewalkParams = Type.Object({}, { additionalProperties: false });
const ExitPlanModeParams = Type.Object({
  plan: Type.String({
    minLength: 1,
    maxLength: MAX_PLAN_LENGTH,
    description: 'The complete plan to present to the user for review.',
  }),
}, { additionalProperties: false });

function registerPrewalk(pi: FelanExtensionAPI): void {
  pi.registerCapability({
    id: 'prewalk',
    instructions: 'Use Prewalk for complex repository work that benefits from substantial exploration, coordinated multi-file changes, dependency-aware planning, or broad verification. Do not use it for small localized edits, routine one-file fixes, read-only requests, or when injected planning or implementation guidance is already present. For a new complex file-changing task without that guidance, call enter_prewalk as the only tool call in the response. Conversation or repository activity from earlier requests does not prevent entry. Prefer to enter before exploring the current task; if its complexity becomes clear after read-only exploration, enter before its first mutation. Depending on the configured entry policy, the tool may ask the user for approval or decline model-requested entry; if declined, continue on the regular path. The tool is available in the root session and mutation-capable subagents. During an active run, follow the injected planning, task-tracking, implementation, and verification guidance. The user can enter explicitly with /prewalk or exit with /prewalk exit (or /prewalk off).',
  });

  let config = pi.config as unknown as PrewalkConfig;
  let targetModel = parseTargetModel(config.targetModel)!;
  let state: PrewalkState = { phase: 'idle' };
  let plannerSnapshot: PlannerSnapshot | undefined;
  let exitRequested = false;
  let modelTransition: ModelTransition | undefined;
  let handoffPromise: Promise<void> | undefined;
  let restorationPromise: Promise<boolean> | undefined;
  let phaseContextAnchor: PhaseContextAnchor | undefined;
  let implementationSavingsModels: ImplementationSavingsModels | undefined;
  let internalThinkingChange = false;

  function refreshConfig(): void {
    config = pi.config as unknown as PrewalkConfig;
    targetModel = parseTargetModel(config.targetModel)!;
  }

  function notify(ctx: ExtensionContext, message: string, type: NotificationType = 'info'): void {
    if (ctx.hasUI) {
      ctx.ui.notify(message, type);
    } else {
      console.error(message);
    }
  }

  function publishConfigWarning(_ctx: ExtensionContext): void {}

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
      `Prewalk: ${state.phase} | target ${targetModel.key} | target thinking ${config.targetThinking} | restore planner ${config.restorePlanner ? 'on' : 'off'} | model entry ${config.entryApproval} | plan review ${config.planReview} (${effectivePlanReview(config)})${planner}${exit}`,
    );
  }

  function clearAutomation(ctx: ExtensionContext): void {
    state = { phase: 'idle' };
    plannerSnapshot = undefined;
    phaseContextAnchor = undefined;
    implementationSavingsModels = undefined;
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
    const planningSteps = effectivePlanReview(config) === 'ask'
      ? 'initialize Tasks when both task tools are active, review the plan with you, make one mutation'
      : 'initialize Tasks when both task tools are active, make one mutation';
    notify(ctx, `Prewalk armed. The next task will plan, ${planningSteps}, then hand off to ${targetModel.key} at ${config.targetThinking} thinking.`);
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
        reviewRequired: effectivePlanReview(config) === 'ask',
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
    const targetThinkingLevel = effectiveThinkingLevel(target, config.targetThinking);
    const modelAlreadyActive = sameModel(ctx.model, target);
    const plannerThinkingLevel = pi.getThinkingLevel();

    try {
      const transition = modelAlreadyActive
        ? { switched: true } satisfies ModelTransitionResult
        : await setModelPreservingExternalSelection(target, ctx);
      if (state.phase !== 'handoff' || plannerSnapshot !== snapshot) return;
      if (!transition.switched) {
        failAutomation(ctx, `Prewalk could not switch to ${targetKey}.`);
        return;
      }
      if (transition.externalModel || transition.externalThinkingLevel !== undefined) {
        clearAutomation(ctx);
        if (transition.externalModel) {
          notify(ctx, `Prewalk cancelled after the model changed to ${modelKey(transition.externalModel)}.`, 'warning');
        } else {
          notify(ctx, `Prewalk cancelled after the thinking level changed to ${transition.externalThinkingLevel}.`, 'warning');
        }
        return;
      }

      if (modelAlreadyActive && targetThinkingLevel === plannerThinkingLevel) {
        clearAutomation(ctx);
        notify(ctx, `Prewalk target ${targetKey} at ${targetThinkingLevel} thinking already matches the planner; continuing without a handoff.`);
        return;
      }

      setThinkingLevelInternally(targetThinkingLevel);
      const effectiveThinkingLevel = pi.getThinkingLevel();

      implementationSavingsModels = modelAlreadyActive
        ? undefined
        : {
            planner: savingsModelReference(snapshot.model),
            target: savingsModelReference(target),
          };
      state = { phase: 'implementing', run };
      updateStatus(ctx);
      const modelText = modelAlreadyActive ? ' without changing models' : '';
      notify(ctx, `Prewalk handed implementation to ${targetKey} at ${effectiveThinkingLevel} thinking${modelText}.`);
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
        const transition = await setModelPreservingExternalSelection(snapshot.model, ctx);
        if (state.phase !== 'restoring' || plannerSnapshot !== snapshot) return false;
        if (!transition.switched) throw new Error(`model ${snapshot.modelKey} is not authenticated`);
        if (transition.externalModel || transition.externalThinkingLevel !== undefined) {
          clearAutomation(ctx);
          return true;
        }
      }

      if (state.phase !== 'restoring' || plannerSnapshot !== snapshot) return false;
      setThinkingLevelInternally(snapshot.thinkingLevel);
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
  ): Promise<ModelTransitionResult> {
    if (modelTransition) throw new Error('another Prewalk model transition is already active');

    const transition: ModelTransition = {
      expectedModelKey: modelKey(model),
      initialThinkingLevel: pi.getThinkingLevel(),
      modelSelectObserved: false,
    };
    modelTransition = transition;
    try {
      let switched: boolean;
      try {
        switched = await pi.setModel(model, { updateDefault: false });
      } finally {
        await reapplyExternalModel(ctx, transition);
      }
      return {
        switched,
        ...(transition.externalModel === undefined ? {} : { externalModel: transition.externalModel }),
        ...(transition.externalThinkingLevel === undefined
          ? {}
          : { externalThinkingLevel: transition.externalThinkingLevel }),
      };
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
      transition.initialThinkingLevel = pi.getThinkingLevel();
      transition.modelSelectObserved = false;
      const restored = await pi.setModel(externalModel, { updateDefault: false });
      if (!restored) throw new Error(`could not retain manual model ${modelKey(externalModel)}`);
    }
    if (
      transition.externalThinkingLevel !== undefined
      && (transition.externalModel === undefined || modelKey(ctx.model) === modelKey(transition.externalModel))
    ) {
      setThinkingLevelInternally(transition.externalThinkingLevel);
    }
  }

  function setThinkingLevelInternally(level: PlannerThinkingLevel): void {
    internalThinkingChange = true;
    try {
      pi.setThinkingLevel(level, { updateDefault: false });
    } finally {
      internalThinkingChange = false;
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

  async function approveModelEntry(ctx: ExtensionContext): Promise<{ approved: true } | { approved: false; reason: string }> {
    if (config.entryApproval === 'allow') return { approved: true };
    if (config.entryApproval === 'deny') {
      return {
        approved: false,
        reason: 'Model-requested Prewalk entry is disabled. Continue the current task without Prewalk.',
      };
    }
    if (!ctx.hasUI) {
      return {
        approved: false,
        reason: `Prewalk entry requires user approval, but interactive approval is unavailable in ${ctx.mode} mode. Continue the current task without Prewalk.`,
      };
    }

    const approved = await ctx.ui.confirm(
      'Enter Prewalk?',
      `The model wants to enter Prewalk for this task. Prewalk will plan in the current session and may hand implementation to ${targetModel.key} at ${config.targetThinking} thinking.`,
    );
    return approved
      ? { approved: true }
      : {
          approved: false,
          reason: 'The user declined Prewalk entry. Continue the current task without Prewalk.',
        };
  }

  function beginPlanReview(ctx: ExtensionContext): PrewalkState['run'] | undefined {
    if (
      state.phase !== 'planning'
      || !state.run
      || !state.run.reviewRequired
      || state.run.reviewApproved
    ) return undefined;
    if (state.run.taskGateRequired && !state.run.taskGraphReady) return undefined;
    const reviewRun = { ...state.run };
    state = {
      phase: 'reviewing',
      run: reviewRun,
    };
    phaseContextAnchor = undefined;
    updateStatus(ctx);
    return reviewRun;
  }

  function resumePlanningAfterReview(
    ctx: ExtensionContext,
    reviewRun: NonNullable<PrewalkState['run']>,
    approved: boolean,
  ): boolean {
    if (state.phase !== 'reviewing' || state.run !== reviewRun) return false;
    state = {
      phase: 'planning',
      run: {
        ...reviewRun,
        mutationCallIds: [],
        taskCreateCallIds: [],
        taskClaimCallIds: [],
        handoffArmed: false,
        reviewRequired: true,
        reviewApproved: approved,
      },
    };
    phaseContextAnchor = undefined;
    updateStatus(ctx);
    return true;
  }

  function isActivePlanReview(reviewRun: NonNullable<PrewalkState['run']>): boolean {
    return state.phase === 'reviewing' && state.run === reviewRun;
  }

  pi.registerTool({
    name: ENTER_PREWALK_TOOL,
    label: 'Enter Prewalk',
    description: 'Enter same-session Prewalk for a complex repository task that requires substantial exploration, coordinated multi-file changes, dependency-aware planning, or broad verification. Do not call it for small localized edits, routine one-file fixes, read-only work, or when injected guidance already directs planning or implementation. Call this once, as the only tool call in the response. Conversation or repository activity from earlier requests does not prevent entry. Prefer to enter before exploring the current task; if its complexity becomes clear after read-only exploration, enter before its first mutation.',
    promptSnippet: 'Enter Prewalk for complex repository work before mutation',
    executionMode: 'sequential',
    parameters: EnterPrewalkParams,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (state.phase === 'idle') refreshConfig();
      publishConfigWarning(ctx);

      if (state.phase !== 'idle') {
        return prewalkToolError(
          `Prewalk is already ${state.phase}; continue the active run without calling ${ENTER_PREWALK_TOOL} again.`,
        );
      }

      const validation = validateArmingTools(pi.getActiveTools());
      if (!validation.ok) return prewalkToolError(validation.reason);
      if (!ctx.model) return prewalkToolError('Prewalk requires a selected planner model.');
      const approval = await approveModelEntry(ctx);
      if (!approval.approved) return prewalkToolError(approval.reason);

      startRun(ctx, false);
      const reviewText = effectivePlanReview(config) === 'ask'
        ? ` submit the plan through ${EXIT_PLAN_MODE_TOOL} for user review,`
        : '';
      return {
        content: [{
          type: 'text',
          text: `Prewalk entered for the current task. Follow the injected planning guidance, initialize Tasks when both task tools are active, keep the task graph concise,${reviewText} and make one focused mutation before the handoff to ${targetModel.key} at ${config.targetThinking} thinking.`,
        }],
        details: {
          phase: 'planning',
          targetModel: targetModel.key,
          targetThinking: config.targetThinking,
        },
      };
    },
  });

  pi.registerTool({
    name: EXIT_PLAN_MODE_TOOL,
    label: 'Exit Plan Mode',
    description: 'Present the completed Prewalk plan for user review. Pass the full plan and call this as the only tool in the response. Approval returns to planning so the first focused mutation can trigger the implementation-model handoff. Feedback keeps planning active; cancellation exits Prewalk.',
    promptSnippet: 'Present a completed Prewalk plan for approval, feedback, or cancellation',
    executionMode: 'sequential',
    parameters: ExitPlanModeParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (params.plan.trim().length === 0) {
        return prewalkToolError('exit_plan_mode requires a non-empty plan.');
      }
      if (params.plan.length > MAX_PLAN_LENGTH) {
        return prewalkToolError(`exit_plan_mode plan must not exceed ${MAX_PLAN_LENGTH} characters.`);
      }
      if (state.phase !== 'planning' || !state.run) {
        return prewalkToolError(
          `exit_plan_mode requires an active Prewalk planning run; current phase is ${state.phase}.`,
        );
      }
      if (state.run.reviewApproved) {
        return prewalkToolError(
          'The Prewalk plan is already approved. Make the focused mutation that triggers implementation handoff.',
        );
      }
      if (!state.run.reviewRequired) {
        return prewalkToolError('Plan review is disabled for the active Prewalk run. Continue the configured focused-mutation flow.');
      }
      if (state.run.taskGateRequired && !state.run.taskGraphReady) {
        return prewalkToolError(
          'Complete the required TaskCreate and in-progress TaskUpdate calls before presenting the Prewalk plan.',
        );
      }
      const reviewRun = beginPlanReview(ctx);
      if (!reviewRun) {
        return prewalkToolError('Prewalk could not enter plan review from the current state.');
      }

      if (!ctx.hasUI) {
        notify(ctx, `Prewalk auto-approved plan review because interactive input is unavailable in ${ctx.mode} mode.`, 'warning');
        if (!resumePlanningAfterReview(ctx, reviewRun, true)) {
          return stalePlanReviewResult(state.phase);
        }
        return approvedPlanResult();
      }

      const dialogOptions = signal ? { signal } : undefined;
      try {
        const action = await ctx.ui.select(
          `Review Prewalk plan\n\n${params.plan}`,
          [APPROVE_PLAN_OPTION, FEEDBACK_PLAN_OPTION, CANCEL_PREWALK_OPTION],
          dialogOptions,
        );

        if (action === APPROVE_PLAN_OPTION) {
          if (!resumePlanningAfterReview(ctx, reviewRun, true)) {
            return stalePlanReviewResult(state.phase);
          }
          return approvedPlanResult();
        }

        if (action === FEEDBACK_PLAN_OPTION) {
          if (!isActivePlanReview(reviewRun)) {
            return stalePlanReviewResult(state.phase);
          }
          const feedback = await ctx.ui.input(
            'Feedback on Prewalk plan',
            'Tell the planner what to change...',
            dialogOptions,
          );
          if (!resumePlanningAfterReview(ctx, reviewRun, false)) {
            return stalePlanReviewResult(state.phase);
          }
          const normalizedFeedback = feedback?.trim();
          if (normalizedFeedback) {
            return {
              content: [{
                type: 'text',
                text: `The user requested plan changes:\n\n${normalizedFeedback}\n\nRevise the plan and call exit_plan_mode again with the complete updated plan. Do not modify the repository before approval.`,
              }],
              details: { phase: 'planning', decision: 'feedback', feedback: normalizedFeedback },
            };
          }
          return dismissedPlanResult();
        }

        if (action === CANCEL_PREWALK_OPTION) {
          if (!isActivePlanReview(reviewRun)) {
            return stalePlanReviewResult(state.phase);
          }
          await turnOff(ctx);
          return {
            content: [{ type: 'text', text: 'The user cancelled Prewalk. Stop this run and wait for new instructions.' }],
            details: { phase: 'idle', decision: 'cancelled' },
            terminate: true,
          };
        }

        if (!resumePlanningAfterReview(ctx, reviewRun, false)) {
          return stalePlanReviewResult(state.phase);
        }
        return dismissedPlanResult();
      } catch (error) {
        if (!isActivePlanReview(reviewRun)) {
          return stalePlanReviewResult(state.phase);
        }
        resumePlanningAfterReview(ctx, reviewRun, false);
        throw error;
      }
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
    const result = buildContextMessages(event.messages, state, phaseContextAnchor);
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
    if (state.phase === 'implementing') {
      if (event.message.role === 'assistant') {
        await reportImplementationSavings(pi.savings, implementationSavingsModels, event.message);
      }
      return;
    }
    if (state.phase !== 'planning' || !state.run) return;

    const textOnlyCompletion = isTextOnlyCompletion(event.message);
    const decision = reduceTurn(state.run, event.toolResults, {
      allowContinuation: textOnlyCompletion,
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
    if (modelTransition?.expectedModelKey === selectedModelKey) {
      modelTransition.modelSelectObserved = true;
      return;
    }
    if (modelTransition) {
      modelTransition.externalModel = event.model;
      modelTransition.externalThinkingLevel = pi.getThinkingLevel();
    }
    if (state.phase === 'idle') return;

    clearAutomation(ctx);
    notify(ctx, `Prewalk cancelled after the model changed to ${selectedModelKey}.`, 'warning');
  });

  pi.on('thinking_level_select', (event, ctx) => {
    if (internalThinkingChange) return;
    if (
      modelTransition
      && modelKey(ctx.model) === modelTransition.expectedModelKey
      && !modelTransition.modelSelectObserved
    ) {
      const transition = modelTransition;
      // Pi's setModel clamps the carried effort before emitting model_select.
      // The canonical clamp lets us recognize that event even when a manual
      // effort change wins the race and arrives before Pi's own clamp event.
      const internalClamp = clampPiThinkingLevel(ctx.model!, transition.initialThinkingLevel);
      // Pi's event has no source field, so a manual selection of exactly the
      // same level as the automatic clamp is observationally indistinguishable
      // from that clamp; preserve the canonical internal interpretation.
      if (
        internalClamp === transition.initialThinkingLevel
        || event.level !== internalClamp
      ) {
        transition.externalThinkingLevel = event.level;
      }
      return;
    }
    if (modelTransition) {
      modelTransition.externalThinkingLevel = event.level;
      return;
    }
    if (state.phase === 'idle') return;

    clearAutomation(ctx);
    notify(ctx, `Prewalk cancelled after the thinking level changed to ${event.level}.`, 'warning');
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

    if (state.phase === 'reviewing') return;

    if (state.phase === 'planning') {
      if (state.run?.reviewRequired && !state.run.reviewApproved) return;
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
}

function approvedPlanResult() {
  return {
    content: [{
      type: 'text' as const,
      text: 'The user approved the Prewalk plan. On the next model turn, make one focused mutation that establishes the implementation direction before handoff.',
    }],
    details: { phase: 'planning' as const, decision: 'approved' as const },
  };
}

function dismissedPlanResult() {
  return {
    content: [{
      type: 'text' as const,
      text: 'Plan review was dismissed. Prewalk remains in planning; wait for the user or call exit_plan_mode again with the complete plan.',
    }],
    details: { phase: 'planning' as const, decision: 'dismissed' as const },
    terminate: true,
  };
}

function stalePlanReviewResult(phase: PrewalkPhase) {
  return {
    content: [{
      type: 'text' as const,
      text: `The plan review is no longer active; Prewalk is ${phase}. Ignore the stale selection and stop this tool turn.`,
    }],
    details: { phase, decision: 'stale' as const },
    terminate: true,
  };
}

async function reportImplementationSavings(
  reporter: SavingsReporter | undefined,
  models: ImplementationSavingsModels | undefined,
  message: AssistantMessage,
): Promise<void> {
  if (!reporter || !models) return;
  if (message.stopReason === 'error' || message.stopReason === 'aborted') return;
  const actualTokens = savingsTokens(message);
  if (!actualTokens) return;

  try {
    await reporter.report({
      category: 'model-routing',
      operation: 'implementation-turn',
      baseline: {
        model: models.planner,
        tokens: scaleSavingsTokens(actualTokens, IMPLEMENTATION_BASELINE_RATIO),
      },
      actual: {
        model: models.target,
        tokens: actualTokens,
      },
      basis: {
        kind: 'estimated-baseline',
        method: 'planner-two-thirds-usage-v1',
      },
    });
  } catch {}
}

function savingsTokens(message: AssistantMessage): SavingsTokenUsage | undefined {
  const { usage } = message;
  const values = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
  if (
    !values.every((value) => Number.isSafeInteger(value) && value >= 0)
    || (usage.cacheWrite1h !== undefined
      && (!Number.isSafeInteger(usage.cacheWrite1h) || usage.cacheWrite1h < 0))
    || values.every((value) => value === 0)
  ) {
    return undefined;
  }

  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
  };
}

function scaleSavingsTokens(tokens: SavingsTokenUsage, ratio: number): SavingsTokenUsage {
  return {
    input: Math.round(tokens.input * ratio),
    output: Math.round(tokens.output * ratio),
    ...(tokens.cacheRead === undefined ? {} : { cacheRead: Math.round(tokens.cacheRead * ratio) }),
    ...(tokens.cacheWrite === undefined ? {} : { cacheWrite: Math.round(tokens.cacheWrite * ratio) }),
    ...(tokens.cacheWrite1h === undefined ? {} : { cacheWrite1h: Math.round(tokens.cacheWrite1h * ratio) }),
  };
}

function savingsModelReference(model: PlannerModel): SavingsModelReference {
  return { provider: model.provider, id: model.id };
}

export const createPrewalkExtension = (): FelanExtension => registerPrewalk;

function buildContextMessages(
  messages: readonly unknown[],
  state: PrewalkState,
  currentAnchor?: PhaseContextAnchor,
): ContextBuildResult {
  const { phase } = state;
  const successfulControls = successfulControlCallIds(messages);
  const filtered: unknown[] = [];
  for (const message of structuredClone(messages)) {
    if (isControlMessage(message)) {
      if (phase === 'planning' && isCurrentContinuationMessage(message)) filtered.push(message);
      continue;
    }
    if (isSuccessfulControlResult(message, successfulControls)) continue;
    const stripped = stripSuccessfulControlCalls(message, successfulControls);
    if (stripped !== undefined) filtered.push(stripped);
  }
  const guidedPhase = phase === 'planning' || phase === 'implementing'
    ? phase
    : undefined;
  const instruction = guidedPhase === 'planning'
    ? state.run?.reviewRequired && !state.run.reviewApproved
      ? { customType: PLAN_REVIEW_MESSAGE_TYPE, content: PLAN_REVIEW_PLANNING_INSTRUCTION }
      : state.run?.reviewApproved
        ? { customType: PLAN_APPROVED_MESSAGE_TYPE, content: PLAN_APPROVED_INSTRUCTION }
        : { customType: PLANNING_MESSAGE_TYPE, content: PLANNING_INSTRUCTION }
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

function successfulControlCallIds(messages: readonly unknown[]): ReadonlyMap<string, ReadonlySet<string>> {
  const callIds = new Map<string, Set<string>>();
  for (const message of messages) {
    if (
      isRecord(message)
      && message.role === 'toolResult'
      && message.toolName === ENTER_PREWALK_TOOL
      && message.isError !== true
      && typeof message.toolCallId === 'string'
    ) {
      const ids = callIds.get(message.toolName) ?? new Set<string>();
      ids.add(message.toolCallId);
      callIds.set(message.toolName, ids);
    }
  }
  return callIds;
}

function isSuccessfulControlResult(
  message: unknown,
  callIds: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  return isRecord(message)
    && message.role === 'toolResult'
    && typeof message.toolName === 'string'
    && typeof message.toolCallId === 'string'
    && callIds.get(message.toolName)?.has(message.toolCallId) === true;
}

function stripSuccessfulControlCalls(
  message: unknown,
  callIds: ReadonlyMap<string, ReadonlySet<string>>,
): unknown | undefined {
  if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.content)) {
    return message;
  }

  const isControlCall = (item: unknown): boolean => (
    isRecord(item)
    && item.type === 'toolCall'
    && typeof item.name === 'string'
    && typeof item.id === 'string'
    && callIds.get(item.name)?.has(item.id) === true
  );
  if (!message.content.some(isControlCall)) return message;

  const hasOtherToolCalls = message.content.some((item) => (
    isRecord(item) && item.type === 'toolCall' && !isControlCall(item)
  ));
  if (!hasOtherToolCalls) return undefined;

  const content = message.content.filter((item) => !isControlCall(item));
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

function effectivePlanReview(config: PrewalkConfig): Exclude<PrewalkPlanReviewPolicy, 'inherit'> {
  if (config.planReview !== 'inherit') return config.planReview;
  return config.entryApproval === 'ask' ? 'ask' : 'skip';
}

function effectiveThinkingLevel(
  model: PlannerModel,
  targetThinking: FelanThinkingLevel,
): PlannerThinkingLevel {
  return clampPiThinkingLevel(model, targetThinking);
}

function clampPiThinkingLevel(
  model: PlannerModel,
  level: PlannerThinkingLevel,
): PlannerThinkingLevel {
  if (level === 'off') return 'off';
  return clampThinkingLevel(model, level as Parameters<typeof clampThinkingLevel>[1]) as PlannerThinkingLevel;
}


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function prewalkToolError(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const prewalkExtension = createPrewalkExtension();

associateExtensionConfig(prewalkExtension, PREWALK_CONFIG);

export default prewalkExtension;
