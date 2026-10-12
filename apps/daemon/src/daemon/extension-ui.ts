import { createHash, randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import type { AgentSession } from '@felan-ai/agent-core';
import { PREWALK_REVIEW_PRESENTER, PlanReviewRequestSchema, PlanReviewResultSchema, type PrewalkHost } from '@felan-ai/ext-prewalk';
import { FUSION_PICKER_PRESENTER, FUSION_REVIEW_PRESENTER, parseFusionPickerRequest, parseFusionPickerResult,
  parseFusionReview, parseFusionReviewMetadata, parseFusionReviewDecision, type FusionHost } from '@felan-ai/ext-fusion';
import {
  LIMITS, PresentationSchema, RUNTIME_UI_PRESENTER, parseRuntimeUiState, parseSchema,
  type Interaction, type JsonValue, type Presentation, type RuntimeUiState,
} from '@felan-ai/session-protocol';
import type { BrokerPresenter, InteractionBroker } from './broker.js';
import { createBrokerFusionPresentation } from '../fusion/presentation.js';
import type { LocalMcpOAuthPresenter } from '../mcp/oauth-host.js';
import type { TasksPresentationHost } from '@felan-ai/ext-tasks';
import { TASKS_PRESENTER, parseTaskViewAction, parseTaskViewRequest } from '@felan-ai/ext-tasks/view';
import { createBrokerTasksHost } from './task-view.js';
import type { BackgroundBashPresentationHost } from '@felan-ai/ext-background-bash';
import { PROCESS_VIEW_PRESENTER, parseProcessViewRequest, parseProcessViewAction } from '@felan-ai/ext-background-bash/view';
import { createBrokerProcessHost } from './process-view.js';
import type { ContextViewPresentationHost } from '@felan-ai/ext-context-view';
import { CONTEXT_VIEW_PRESENTER, parseContextViewRequest, parseContextViewResult } from '@felan-ai/ext-context-view/view';
import { createBrokerContextViewHost } from './context-view.js';
import { MEMORY_VIEW_PRESENTER, parseMemoryViewRequest, parseMemoryViewAction } from '@felan-ai/ext-memory/view';
import { createBrokerMemoryHost } from './memory-view.js';
import type { MemoryControlPresentationHost } from '../memory/control.js';
import { PROMPT_HISTORY_PRESENTER, parsePromptHistoryAction, parsePromptHistoryRequest } from '@felan-ai/ext-prompt-history/view';
import type { PromptHistoryPresentationHost } from '@felan-ai/ext-prompt-history';
import { createBrokerPromptHistoryHost } from './prompt-history-view.js';
import { INSIGHTS_REPORT_PRESENTER, parseInsightsReportRequest, parseInsightsReportResult } from '@felan-ai/ext-insights/view';
import type { InsightsReportPresentation } from '../insights.js';
import { createBrokerInsightsHost } from './insights-view.js';
import { POWERLINE_PRESENTER } from '@felan-ai/ext-powerline/view';
import type { PowerlineExtensionFactory } from '@felan-ai/ext-powerline/runtime';
import { createBrokerPowerlineFactory } from './powerline-view.js';
import { AGENT_VIEW_PRESENTER, parseAgentOpenRequest, parseAgentOpenResult } from '@felan-ai/ext-subagents/view';
import type { LocalSubagentPresentationHost } from '../subagents/presentation.js';
import { createAgentPresentation } from './agent-presentation.js';
import { BROWSER_SETUP_PRESENTER, BrowserSetupResultSchema, CHROME_ACCESS_MESSAGE, CHROME_READY_MESSAGE, type BrowserAuthorizationPresentationFactory } from '@felan-ai/ext-browser/presentation';

type Ui = NonNullable<NonNullable<Parameters<AgentSession['bindExtensions']>[0]>['uiContext']>;
type PresentationUpdate = Presentation | { id: string; remove: true };
export const SESSION_UI_PRESENTERS: readonly BrokerPresenter[] = Object.freeze([
  Object.freeze({ ...AGENT_VIEW_PRESENTER, validateAnswer(data: JsonValue, request: Interaction['request']): undefined {
    if (request.kind !== 'custom') throw new Error('Invalid agent navigator request.');
    parseAgentOpenRequest(request.data); parseAgentOpenResult(data); return undefined;
  } }),
  Object.freeze({ ...POWERLINE_PRESENTER, validateAnswer(): never { throw new Error('Powerline is a read-only presentation.'); } }),
  Object.freeze({ ...INSIGHTS_REPORT_PRESENTER, validateAnswer(data: JsonValue, request: Interaction['request']): undefined {
    if (request.kind !== 'custom') throw new Error('Invalid insights report request.');
    parseInsightsReportRequest(request.data); parseInsightsReportResult(data); return undefined;
  } }),
  Object.freeze({ ...PROMPT_HISTORY_PRESENTER, validateAnswer(data: JsonValue, request: Interaction['request']): undefined {
    if (request.kind !== 'custom') throw new Error('Invalid prompt history request.');
    parsePromptHistoryAction(data, parsePromptHistoryRequest(request.data)); return undefined;
  } }),
  Object.freeze({ ...MEMORY_VIEW_PRESENTER, validateAnswer(data: JsonValue, request: Interaction['request']): undefined {
    if (request.kind !== 'custom') throw new Error('Invalid memory view request.');
    parseMemoryViewAction(data, parseMemoryViewRequest(request.data)); return undefined;
  } }),
  Object.freeze({ ...CONTEXT_VIEW_PRESENTER, validateAnswer(data: JsonValue, request: Interaction['request']): undefined {
    if (request.kind !== 'custom') throw new Error('Invalid context view request.');
    parseContextViewRequest(request.data); parseContextViewResult(data); return undefined;
  } }),
  Object.freeze({ ...PROCESS_VIEW_PRESENTER, validateAnswer(data: JsonValue, request: Interaction['request']): undefined {
    if (request.kind !== 'custom') throw new Error('Invalid process view request.');
    parseProcessViewAction(data, parseProcessViewRequest(request.data)); return undefined;
  } }),
  Object.freeze({ ...PREWALK_REVIEW_PRESENTER, validateAnswer(data: JsonValue): undefined { parseSchema(PlanReviewResultSchema, data); return undefined; } }),
  Object.freeze({ ...FUSION_PICKER_PRESENTER, validateAnswer(data: JsonValue, request: Interaction['request']): undefined {
    if (request.kind !== 'custom') throw new Error('Invalid Fusion request.');
    parseFusionPickerResult(data, parseFusionPickerRequest(request.document)); return undefined;
  } }),
  Object.freeze({ ...FUSION_REVIEW_PRESENTER, validateAnswer(data: JsonValue, request: Interaction['request']): undefined {
    if (request.kind !== 'custom') throw new Error('Invalid Fusion request.');
    parseFusionReviewDecision(data, parseFusionReview(request.document), parseFusionReviewMetadata(request.data).busy); return undefined;
  } }),
  Object.freeze({ ...BROWSER_SETUP_PRESENTER, validateAnswer(data: JsonValue): undefined { parseSchema(BrowserSetupResultSchema, data); return undefined; } }),
  Object.freeze({ ...TASKS_PRESENTER, validateAnswer(data: JsonValue, request: Interaction['request']): undefined {
    if (request.kind !== 'custom') throw new Error('Invalid task view request.');
    parseTaskViewRequest(request.data); parseTaskViewAction(data); return undefined;
  } }),
]);

export class UnsupportedExtensionUiError extends Error {
  readonly code = 'unsupported';
  constructor(readonly surface: string) {
    super(`Extension UI ${surface} requires a compatible client presenter.`);
    this.name = 'UnsupportedExtensionUiError';
  }
}

export function createSessionExtensionUi(options: {
  broker: InteractionBroker;
  scope: Extract<Interaction['scope'], { kind: 'session' }>;
}): {
  context: Ui;
  prewalk: PrewalkHost;
  fusion: Pick<FusionHost, 'configure' | 'review'>;
  mcp: LocalMcpOAuthPresenter;
  browser: BrowserAuthorizationPresentationFactory;
  tasks: TasksPresentationHost;
  backgroundBash: BackgroundBashPresentationHost;
  contextView: ContextViewPresentationHost;
  memory: MemoryControlPresentationHost;
  promptHistory: PromptHistoryPresentationHost;
  insights: InsightsReportPresentation;
  powerline: PowerlineExtensionFactory;
  subagents: LocalSubagentPresentationHost;
  activate(publish: (update: PresentationUpdate) => void): void;
  dispose(): void;
} {
  const lifetime = new AbortController();
  const presentations = new Map<string, Presentation>();
  const statusListeners = new Set<() => void>();
  const statusChanged = () => { for (const listener of [...statusListeners]) listener(); };
  let publish: ((update: PresentationUpdate) => void) | undefined;
  let state: RuntimeUiState = {};

  const check = () => {
    if (lifetime.signal.aborted) throw Object.assign(new Error('Session extension UI is disposed.'), { code: 'unavailable' });
  };
  const present = (value: PresentationUpdate) => {
    check();
    if ('remove' in value) { const status = presentations.get(value.id)?.kind === 'status'; publish?.(value); presentations.delete(value.id); if (status) statusChanged(); return; }
    const parsed = parseSchema(PresentationSchema, value);
    if (!presentations.has(parsed.id) && presentations.size >= LIMITS.pageEntries) throw new Error('Session presentation capacity reached.');
    publish?.(parsed); presentations.set(parsed.id, parsed);
    if (parsed.kind === 'status') statusChanged();
  };
  const notify: Ui['notify'] = (message, level = 'info') => present({ id: `notification:${level}`, kind: 'notification', level, text: plainText(message) });
  const unsupported = (surface: string): never => {
    const error = new UnsupportedExtensionUiError(surface);
    notify(error.message, 'warning');
    throw error;
  };
  const changeState = <K extends keyof RuntimeUiState>(key: K, value: RuntimeUiState[K]) => {
    const next = { ...state };
    if (value === undefined) delete next[key]; else next[key] = value;
    const parsed = parseRuntimeUiState(next);
    present({ id: RUNTIME_UI_PRESENTER.id, kind: 'custom', presenter: RUNTIME_UI_PRESENTER, data: parsed });
    state = parsed;
  };
  const request = (value: Interaction['request'], dialog?: { signal?: AbortSignal; timeout?: number }, scope: Interaction['scope'] = options.scope) => {
    check();
    if (!publish) throw Object.assign(new Error('Session interaction requested before the runtime became active.'), { code: 'unavailable' });
    return options.broker.request(value, scope, {
      signal: dialog?.signal ? AbortSignal.any([lifetime.signal, dialog.signal]) : lifetime.signal,
      ...(dialog?.timeout === undefined ? {} : { timeout: Math.ceil(dialog.timeout) }),
    });
  };
  const context: Ui = {
    async select(title, choices, dialog) {
      const result = await request({ kind: 'select', title: plainText(title), multiple: false,
        choices: choices.map((choice, index) => ({ id: String(index), title: plainText(choice) })) }, dialog);
      return result.state === 'answered' && result.answer.kind === 'select' ? choices[Number(result.answer.choices[0])] : undefined;
    },
    async confirm(title, message, dialog) {
      const result = await request({ kind: 'confirm', title: plainText(title), message: plainText(message) }, dialog);
      return result.state === 'answered' && result.answer.kind === 'confirm' ? result.answer.confirmed : false;
    },
    async input(title, placeholder, dialog) {
      const result = await request({ kind: 'input', title: plainText(title), ...(placeholder === undefined ? {} : { placeholder: plainText(placeholder) }) }, dialog);
      return result.state === 'answered' && result.answer.kind === 'input' ? result.answer.text : undefined;
    },
    async editor(title, initialValue = '') {
      const result = await request({ kind: 'editor', title: plainText(title), initialValue });
      return result.state === 'answered' && result.answer.kind === 'editor' ? result.answer.text : undefined;
    },
    notify,
    setStatus(key, text) { present(text === undefined ? { id: keyed('status', key), remove: true }
      : { id: keyed('status', key), kind: 'status', text: plainText(text) }); },
    setWidget(key, content, widget) {
      if (typeof content === 'function') return unsupported('component widget');
      present(content === undefined ? { id: keyed('widget', key), remove: true }
        : { id: keyed('widget', key), kind: 'widget', text: content.map(plainText).join('\n'), placement: widget?.placement ?? 'aboveEditor' });
    },
    setTitle(title) { present({ id: 'title', kind: 'title', text: plainText(title) }); },
    setWorkingMessage(message) { changeState('workingMessage', message === undefined ? undefined : plainText(message)); },
    setWorkingVisible(visible) { changeState('workingVisible', visible); },
    setWorkingIndicator(indicator) {
      changeState('workingIndicator', indicator === undefined ? undefined : {
        ...(indicator.frames === undefined ? {} : { frames: indicator.frames.map(plainText) }),
        ...(indicator.intervalMs === undefined ? {} : { intervalMs: indicator.intervalMs }),
      });
    },
    setHiddenThinkingLabel(label) { changeState('hiddenThinkingLabel', label === undefined ? undefined : plainText(label)); },
    getToolsExpanded() { check(); return state.toolsExpanded ?? false; },
    setToolsExpanded(expanded) { changeState('toolsExpanded', expanded); },
    onTerminalInput() { return unsupported('terminal input'); },
    setFooter() { return unsupported('footer component'); },
    setHeader() { return unsupported('header component'); },
    async custom() { return unsupported('custom component'); },
    pasteToEditor() { return unsupported('editor paste'); },
    setEditorText() { return unsupported('editor text'); },
    getEditorText() { return unsupported('editor text'); },
    addAutocompleteProvider() { return unsupported('autocomplete'); },
    setEditorComponent() { return unsupported('editor component'); },
    getEditorComponent() { return unsupported('editor component'); },
    theme: new Proxy({} as Ui['theme'], { get: () => unsupported('theme') }),
    getAllThemes() { return unsupported('theme catalog'); },
    getTheme() { return unsupported('theme'); },
    setTheme() { return unsupported('theme'); },
  };

  return {
    context,
    subagents: createAgentPresentation({ request, signal: lifetime.signal, unsupported }),
    powerline: createBrokerPowerlineFactory({ broker: options.broker, scope: options.scope, signal: lifetime.signal, present,
      ready: () => publish !== undefined, statuses: () => new Map([...presentations.values()].flatMap(value => value.kind === 'status' ? [[value.id, value.text] as const] : [])),
      subscribe(listener) { statusListeners.add(listener); return () => { statusListeners.delete(listener); }; } }),
    insights: createBrokerInsightsHost({ request, signal: lifetime.signal, unsupported }),
    promptHistory: createBrokerPromptHistoryHost({ request, present, signal: lifetime.signal, unsupported }),
    contextView: createBrokerContextViewHost({ request, signal: lifetime.signal, unsupported }),
    memory: createBrokerMemoryHost({ request, present, signal: lifetime.signal, unsupported,
      canOpen: () => options.broker.canPresent({ kind: 'custom', presenter: MEMORY_VIEW_PRESENTER, data: {} }, { kind: 'host' }) }),
    backgroundBash: createBrokerProcessHost({ request, signal: lifetime.signal, unsupported }),
    tasks: createBrokerTasksHost({ request, present, signal: lifetime.signal, unsupported }),
    fusion: createBrokerFusionPresentation({ request, signal: lifetime.signal, unsupported }),
    browser() {
      check();
      const choices = [{ id: 'once', title: 'Allow once' }, { id: 'always', title: 'Always allow' }, { id: 'deny', title: 'Deny' }];
      if (!options.broker.canPresent({ kind: 'select', title: 'Authorize existing Chrome?', choices, multiple: false }, { kind: 'host' })) return undefined;
      return {
        async consent(origin, reason, signal) {
          const result = await request({ kind: 'select', multiple: false, choices,
            title: plainText(`Authorize existing Chrome?\n\n${origin}\n\n${reason ? `${reason}\n\n` : ''}${CHROME_ACCESS_MESSAGE}`) }, { signal }, { kind: 'host' });
          if (result.state !== 'answered' || result.answer.kind !== 'select') return undefined;
          const choice = result.answer.choices[0]; return choice === 'once' || choice === 'always' ? choice : undefined;
        },
        async openSetup(applicationPath, signal) {
          const result = await request({ kind: 'custom', presenter: BROWSER_SETUP_PRESENTER, data: { applicationPath } }, { signal }, { kind: 'host' });
          if (result.state === 'cancelled' && result.reason === 'unsupported') unsupported('Chrome setup');
          return result.state === 'answered';
        },
        async ready(signal) {
          const result = await request({ kind: 'confirm', title: 'Continue Chrome authorization?',
            message: CHROME_READY_MESSAGE }, { signal }, { kind: 'host' });
          return result.state === 'answered' && result.answer.kind === 'confirm' && result.answer.confirmed;
        },
      };
    },
    async mcp({ server, url, signal }) {
      const provisioningId = randomUUID();
      const pending = request({ kind: 'oauth', provider: 'mcp', url, provisioningId,
        instructions: `Authorize MCP server ${plainText(server).slice(0, 120)} in your browser. This dialog closes when authorization finishes.` }, { signal }, { kind: 'host' });
      // OAuth also uses unsupported when its already-active presenting client disconnects.
      const admitted = options.broker.pending().some(item => item.request.kind === 'oauth' && item.request.provisioningId === provisioningId);
      const result = await pending;
      if (!admitted && result.state === 'cancelled' && result.reason === 'unsupported') unsupported('MCP authorization');
    },
    prewalk: { async review(_context, plan, signal) {
      const value = parseSchema(PlanReviewRequestSchema, { plan });
      const result = await request({ kind: 'custom', presenter: PREWALK_REVIEW_PRESENTER, data: null, document: value.plan }, signal ? { signal } : undefined);
      if (result.state !== 'answered') {
        if (result.state === 'cancelled' && result.reason === 'unsupported') return unsupported('prewalk plan review');
        return undefined;
      }
      if (result.answer.kind !== 'custom') throw new Error('Prewalk answer kind changed.');
      return parseSchema(PlanReviewResultSchema, result.answer.data);
    } },
    activate(next) {
      check();
      if (publish) throw new Error('Session extension UI is already active.');
      for (const value of presentations.values()) next(value);
      publish = next;
      statusChanged();
    },
    dispose() { lifetime.abort(); statusListeners.clear(); presentations.clear(); publish = undefined; },
  };
}

function keyed(kind: string, key: string): string {
  return `${kind}:${createHash('sha256').update(key).digest('hex')}`;
}

function plainText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
}
