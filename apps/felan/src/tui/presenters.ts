import { PREWALK_REVIEW_PRESENTER } from '@felan-ai/ext-prewalk/tui';
import { FUSION_PICKER_PRESENTER, FUSION_REVIEW_PRESENTER } from '@felan-ai/ext-fusion/tui';
import { TASKS_PRESENTER } from '@felan-ai/ext-tasks/view';
import { PROCESS_VIEW_PRESENTER } from '@felan-ai/ext-background-bash/view';
import { CONTEXT_VIEW_PRESENTER } from '@felan-ai/ext-context-view/view';
import { MEMORY_VIEW_PRESENTER } from '@felan-ai/ext-memory/view';
import { PROMPT_HISTORY_PRESENTER } from '@felan-ai/ext-prompt-history/view';
import { AGENT_VIEW_PRESENTER, type AgentViewTranscript } from '@felan-ai/ext-subagents/view';
import { POWERLINE_PRESENTER } from '@felan-ai/ext-powerline/view';
import { BROWSER_SETUP_PRESENTER, BrowserSetupRequestSchema } from '@felan-ai/ext-browser/presentation';
import { INSIGHTS_REPORT_PRESENTER, parseInsightsReportRequest } from '@felan-ai/ext-insights/view';
import { RUNTIME_UI_PRESENTER, parseSchema, type Interaction } from '@felan-ai/session-protocol';
import { ClientInteractionPresenters, type InteractionPresenterUi, type PresentationUpdates } from '../client/presenters.js';
import { registerPrewalkPresenter } from '../client/prewalk-presenter.js';
import { registerFusionPresenters } from '../client/fusion-presenter.js';
import { registerTasksPresenter } from '../client/tasks-presenter.js';
import { registerProcessesPresenter } from '../client/processes-presenter.js';
import { registerContextViewPresenter } from '../client/context-view-presenter.js';
import { registerMemoryPresenter } from '../client/memory-presenter.js';
import { registerPromptHistoryPresenter } from '../client/prompt-history-presenter.js';
import { createClientAgentViews } from '../client/agents-presenter.js';
import type { AgentToolPresentation } from '../subagents/agent-transcript.js';
import type { TuiSessionController } from './controller.js';

export const TERMINAL_PRESENTERS = [RUNTIME_UI_PRESENTER, POWERLINE_PRESENTER, PREWALK_REVIEW_PRESENTER,
  FUSION_PICKER_PRESENTER, FUSION_REVIEW_PRESENTER, TASKS_PRESENTER, PROCESS_VIEW_PRESENTER,
  CONTEXT_VIEW_PRESENTER, MEMORY_VIEW_PRESENTER, PROMPT_HISTORY_PRESENTER, AGENT_VIEW_PRESENTER,
  BROWSER_SETUP_PRESENTER, INSIGHTS_REPORT_PRESENTER];

export function createTerminalPresenters(controller: TuiSessionController, ui: InteractionPresenterUi, options: {
  setEditorText(text: string): void;
  settings(): AgentViewTranscript['settings'];
  toolPresentation(name: string): AgentToolPresentation | undefined;
}): { presenters: ClientInteractionPresenters; dispose(): Promise<void> } {
  const lifetime = new AbortController();
  const open = async (title: string, message: string, caller: AbortSignal, interaction?: Interaction): Promise<boolean> => {
    const signal = AbortSignal.any([caller, lifetime.signal]);
    if (signal.aborted) return false;
    if (!interaction) throw new Error('The daemon opening request has no interaction identity.');
    if (!controller.client.capabilities?.operations.includes('host.open_interaction')) throw new Error('This daemon does not support host.open_interaction.');
    if (!await ui.confirm(title, message, { signal }) || signal.aborted) return false;
    const result = await controller.perform('host.open_interaction', { interactionId: interaction.id, confirmed: true });
    if (result.outcome !== 'accepted') throw new Error('The daemon could not confirm opening this item.');
    return !signal.aborted;
  };
  const presenters = new ClientInteractionPresenters(ui, {
    openOAuthUrl: (url, signal, interaction) => open('Open OAuth authorization on the daemon host?', url, signal, interaction),
  });
  const updates = (interaction: Interaction): PresentationUpdates => {
    if (interaction.scope.kind !== 'session') throw new Error('This view requires a session.');
    const session = interaction.scope.session;
    return {
      read: () => {
        const state = controller.client.getAttachment(session)?.state;
        return state?.status === 'live' ? state.snapshot?.presentation ?? [] : [];
      },
      subscribe: listener => controller.client.subscribe(listener),
    };
  };
  const remove = [registerPrewalkPresenter(presenters, ui), registerFusionPresenters(presenters, ui),
    registerTasksPresenter(presenters, ui, updates), registerProcessesPresenter(presenters, ui),
    registerContextViewPresenter(presenters, ui), registerMemoryPresenter(presenters, ui, updates),
    registerPromptHistoryPresenter(presenters, { ...ui, setEditorText: options.setEditorText }, updates),
    presenters.registerCustom(BROWSER_SETUP_PRESENTER, async (data, signal, _document, interaction) => {
      const request = parseSchema(BrowserSetupRequestSchema, data);
      return { opened: await open('Open browser setup on the daemon host?', request.applicationPath, signal, interaction) };
    }),
    presenters.registerCustom(INSIGHTS_REPORT_PRESENTER, async (data, signal, _document, interaction) => {
      const request = parseInsightsReportRequest(data);
      return { opened: await open('Open insights report on the daemon host?', request.path, signal, interaction) };
    })];
  const agents = new Map<string, ReturnType<typeof createClientAgentViews>>();
  const closing = new Set<Promise<void>>(); const errors: unknown[] = [];
  let root = controller.sessionId; let closed = false;
  const release = (view: ReturnType<typeof createClientAgentViews>) => {
    const work = view.dispose().catch(error => { errors.push(error); });
    closing.add(work); void work.then(() => closing.delete(work));
  };
  remove.push(presenters.registerCustom(AGENT_VIEW_PRESENTER, async (data, signal, _document, interaction) => {
    if (closed || signal.aborted) return undefined;
    if (interaction?.scope.kind !== 'session' || interaction.scope.root !== controller.sessionId) throw new Error('Agent view is no longer attached to this root.');
    const parent = interaction.scope.session;
    let view = agents.get(parent);
    if (!view) {
      if (agents.size >= 8) throw new Error('Close another agent view before opening more nested views.');
      view = createClientAgentViews(controller.client, parent, undefined, ui, options.settings, options.toolPresentation);
      agents.set(parent, view);
    }
    return view.present(data, signal);
  }));
  const unsubscribe = controller.subscribe(() => {
    if (controller.sessionId === root) return;
    root = controller.sessionId;
    for (const view of agents.values()) release(view);
    agents.clear();
  });
  return { presenters, async dispose() {
    if (closed) return;
    closed = true; lifetime.abort(); unsubscribe(); for (const unregister of remove.reverse()) unregister();
    for (const view of agents.values()) release(view);
    agents.clear(); await Promise.all([...closing]);
    if (errors.length) throw new AggregateError(errors, 'Agent presentation cleanup failed.');
  } };
}
