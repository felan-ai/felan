import { FUSION_PICKER_HINT, FUSION_REVIEW_HINT } from '@felan-ai/ext-fusion/data';
import { presentFusionPickerView, presentFusionReviewDocument } from './renderers/fusion.js';
import { ASK_USER_FORM_HINT, presentAskUserForm } from './renderers/ask-user.js';
import { PREWALK_FORM_HINT, presentPrewalkForm } from './renderers/prewalk.js';
import { CONTEXT_DOCUMENT_HINT } from '@felan-ai/ext-context-view/data';
import { presentContextDocument } from './renderers/context-view.js';
import { TASKS_HINT, presentTasksElement } from './renderers/tasks.js';
import { PROCESSES_HINT, presentProcessesElement } from './renderers/processes.js';
import { PROMPT_HISTORY_HINT, presentPromptHistoryElement } from './renderers/prompt-history.js';
import { type AgentViewTranscript } from '../subagents/types.js';
import { INSIGHTS_DOCUMENT_HINT } from '@felan-ai/ext-insights/data';
import { presentInsightsDocument } from './renderers/insights.js';
import { type Execution, type UiPresentation } from '@felan-ai/session-protocol';
import { presentUiElement } from '../client/ui.js';
import { createGenericTuiDriver } from './generic-ui.js';
import { ClientInteractionPresenters, type InteractionPresenterUi } from '../client/presenters.js';
import { MEMORY_HISTORY_HINT, presentMemoryHistory } from './renderers/memory.js';
import { createClientAgentViews } from '../client/agents-presenter.js';
import type { AgentToolPresentation } from '../subagents/agent-transcript.js';
import type { TuiSessionController } from './controller.js';

export function createTerminalPresenters(controller: TuiSessionController, ui: InteractionPresenterUi, options: {
  setEditorText(text: string): void;
  settings(): AgentViewTranscript['settings'];
  toolPresentation(name: string): AgentToolPresentation | undefined;
  executionsChanged?(executions: readonly Execution[]): void;
}): { presenters: ClientInteractionPresenters; openExecutions(id?: string): Promise<void>; dispose(): Promise<void> } {
  const lifetime = new AbortController();
  const presenters = new ClientInteractionPresenters(ui);
  const presentationSettings = async () => {
    if (!controller.sessionId || !controller.client.capabilities?.operations.includes('config.get')) return {};
    const response = await controller.perform('config.get', { scope: 'session' }, controller.sessionId);
    if (response.outcome !== 'accepted') throw new Error(controller.notice);
    return response.result.values;
  };
  const genericActions = (source: UiPresentation, signal: AbortSignal, actionId?: string, itemId?: string) => {
    const { hint, ...element } = source;
    return presentUiElement(element, createGenericTuiDriver(ui), signal, true, undefined, actionId ? { actionId, ...(itemId ? { itemId } : {}) } : undefined);
  };
  const remove = [
    presenters.hints.register(ASK_USER_FORM_HINT, { form: async (form, signal) => {
      const settings = await presentationSettings();
      return presentAskUserForm(form, { ui, signal }, {
        displayMode: settings['ask-user-display-mode'] ?? 'inline',
        singleSelectLayout: settings['ask-user-single-select-layout'] ?? 'auto',
        ...(settings['ask-user-overlay-toggle-key'] === undefined ? {} : { overlayToggleKey: settings['ask-user-overlay-toggle-key'] }),
        ...(settings['ask-user-comment-toggle-key'] === undefined ? {} : { commentToggleKey: settings['ask-user-comment-toggle-key'] }),
      });
    } }),
    presenters.hints.register(PREWALK_FORM_HINT, { form: (form, signal) => presentPrewalkForm(form, ui, signal) }),
    presenters.hints.register(CONTEXT_DOCUMENT_HINT, { presentation: (element, signal) => presentContextDocument(element, ui, signal) }),
    presenters.hints.register(MEMORY_HISTORY_HINT, { presentation: (element, signal) => presentMemoryHistory(element, ui, signal) }),
    presenters.hints.register(INSIGHTS_DOCUMENT_HINT, { presentation: (element, signal) => presentInsightsDocument(element, ui, signal) }),
    presenters.hints.register(FUSION_PICKER_HINT, { presentation: (element, signal) => presentFusionPickerView(element, ui, signal) }),
    presenters.hints.register(FUSION_REVIEW_HINT, { presentation: (element, signal) => presentFusionReviewDocument(element, ui, signal) }),
    presenters.hints.register(TASKS_HINT, { presentation: async (element, signal) => presentTasksElement(element, ui, signal, genericActions,
      (await presentationSettings())['tasks-display-mode'] ?? 'inline') }),
    presenters.hints.register(PROCESSES_HINT, { presentation: (element, signal) => presentProcessesElement(element, ui, signal, genericActions) }),
    presenters.hints.register(PROMPT_HISTORY_HINT, { presentation: async (element, signal) => presentPromptHistoryElement(element, ui, signal, genericActions, options.setEditorText,
      (await presentationSettings())['prompt-history-display-mode'] ?? 'inline') }),
  ];
  const agents = new Map<string, ReturnType<typeof createClientAgentViews>>();
  const subscriptions = new Map<string, () => void>();
  const closing = new Set<Promise<void>>(); const errors: unknown[] = [];
  let root = controller.sessionId; let closed = false; let creatingAgents = false;
  const release = (view: ReturnType<typeof createClientAgentViews>) => {
    const work = view.dispose().catch(error => { errors.push(error); });
    closing.add(work); void work.then(() => closing.delete(work));
  };
  const ensureAgents = (parent: string) => {
    let view = agents.get(parent);
    if (!view) {
      creatingAgents = true;
      try { view = createClientAgentViews(controller.client, parent, ui, options.settings, options.toolPresentation); }
      finally { creatingAgents = false; }
      agents.set(parent, view);
      const host = view.host;
      subscriptions.set(parent, host.subscribe(() => options.executionsChanged?.(host.listLocalSubagents())));
      options.executionsChanged?.(host.listLocalSubagents());
    }
    return view;
  };
  const openExecutions = async (id?: string) => {
    const parent = controller.sessionId;
    if (closed || !parent) throw new Error('No session is attached.');
    await ensureAgents(parent).open(id);
  };
  const unsubscribe = controller.subscribe(() => {
    if (controller.sessionId !== root) {
      root = controller.sessionId;
      for (const off of subscriptions.values()) off(); subscriptions.clear();
      for (const view of agents.values()) release(view);
      agents.clear(); options.executionsChanged?.([]);
    }
    if (!creatingAgents && root && controller.client.capabilities?.operations.includes('executions.list')) ensureAgents(root);
  });
  if (root && controller.client.capabilities?.operations.includes('executions.list')) ensureAgents(root);
  return { presenters, openExecutions, async dispose() {
    if (closed) return;
    closed = true; lifetime.abort(); unsubscribe(); for (const unregister of remove.reverse()) unregister();
    for (const off of subscriptions.values()) off(); subscriptions.clear();
    for (const view of agents.values()) release(view);
    agents.clear(); await Promise.all([...closing]);
    if (errors.length) throw new AggregateError(errors, 'Agent presentation cleanup failed.');
  } };
}
