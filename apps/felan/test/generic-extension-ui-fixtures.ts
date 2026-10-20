import {
  createExtensionServiceAccess, createFelanServiceRegistry, createSilentLogger, getExtensionConfigDefinition,
  type ConfiguredFelanExtension, type ExtensionCommandContext, type ExtensionToolContext, type ExtensionUi,
  type FelanExtensionAPI, type SessionEntry, type ToolDefinition, type UiPresentOptions, type UiRequestResult,
} from '@felan-ai/agent-core';
import {
  parseInteraction, parseUiForm, parseUiPresentation, validateUiAction, validateUiFormAnswer,
  type Interaction, type UiActionRequest, type UiForm, type UiInput, type UiPresentation, type UiValues,
} from '@felan-ai/session-protocol';
import type { AgentContext } from '@agentclientprotocol/sdk';
import { vi } from 'vitest';
import { ClientInteractionPresenters, type InteractionPresenterUi } from '../src/client/presenters.js';
import type { SessionClient } from '../src/client/client.js';
import { createSessionState } from '../src/client/reducer.js';
import { GENERIC_UI_CAPABILITIES } from '../src/client/ui.js';
import { AcpProtocolInteractions } from '../src/acp/protocol-interactions.js';
import type { AcpProtocolUpdates } from '../src/acp/protocol-updates.js';
import { TerminalInteractions } from '../src/tui/interactions.js';
import type { TuiSessionController } from '../src/tui/controller.js';
import { snapshot } from './client-fixtures.js';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

export function withoutHint<T extends UiForm | UiPresentation>(source: T): T {
  const { hint: _hint, ...plain } = source;
  return plain as T;
}

let sequence = 0;
export function extensionFixture() {
  const root = `/virtual/generic-extension-${++sequence}`;
  const files = new Map<string, Uint8Array>();
  const storage = { root, mkdir: vi.fn(async () => {}),
    readFile: vi.fn(async (path: string) => {
      const bytes = files.get(path);
      if (!bytes) throw Object.assign(new Error('File not found'), { code: 'ENOENT' });
      return bytes.slice();
    }), writeFile: vi.fn(async (path: string, bytes: Uint8Array) => { files.set(path, bytes.slice()); }) };
  const forms: Array<{ form: UiForm; reply: (value: UiRequestResult) => void }> = [];
  const elements: Array<{ value: UiPresentation; options: UiPresentOptions; closed: boolean }> = [];
  const statuses: UiPresentation[] = [];
  const services = createFelanServiceRegistry();
  const handlers = new Map<string, Array<(...args: never[]) => unknown>>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => unknown }>();
  const tools = new Map<string, ToolDefinition>();
  const entries: SessionEntry[] = [];
  let configuration: FelanExtensionAPI['config'] = {};
  let serviceAccess = createExtensionServiceAccess(services, {});
  const ui: ExtensionUi = {
    notify: vi.fn(async () => {}),
    status: vi.fn(async value => { statuses.push(withoutHint(parseUiPresentation(value))); }),
    removeStatus: vi.fn(async () => {}),
    request: async (source, options) => {
      const result = deferred<UiRequestResult>();
      const abort = () => result.resolve({ state: 'cancelled', reason: 'abort' });
      options?.signal?.addEventListener('abort', abort, { once: true });
      if (options?.signal?.aborted) abort();
      forms.push({ form: withoutHint(parseUiForm(source)), reply: result.resolve });
      try { return await result.promise; } finally { options?.signal?.removeEventListener('abort', abort); }
    },
    present: async (source, options = {}) => {
      const row = { value: withoutHint(parseUiPresentation(source)), options, closed: false };
      elements.push(row);
      return {
        update: async next => {
          if (row.closed || next.id !== row.value.id || next.kind !== row.value.kind
            || !('revision' in row.value) || next.revision <= row.value.revision) throw new Error('Invalid presentation update.');
          row.value = withoutHint(parseUiPresentation(next));
        },
        close: async () => { row.closed = true; },
      };
    },
  };
  const context = {
    cwd: '/project', mode: 'print', hasUI: false, signal: new AbortController().signal,
    model: { id: 'fixture-model', name: 'Fixture model', provider: 'fixture', contextWindow: 8192 },
    thinkingLevel: 'off', isIdle: () => true, tools: [], executeTool: vi.fn(async () => { throw new Error('Unexpected tool execution.'); }),
    ui: { notify: vi.fn(), setStatus: vi.fn(), input: vi.fn(async () => undefined) },
    sessionManager: { getSessionId: () => 'session', getSessionFile: () => undefined, getSessionDir: () => root,
      getSessionName: () => 'Fixture', getCwd: () => '/project', getEntries: () => entries, getBranch: () => entries },
    modelRegistry: { getAvailable: () => [], getAll: () => [] },
    getContextUsage: () => ({ tokens: 10, percent: 1, contextWindow: 8192 }),
    getSystemPrompt: () => 'Fixture instructions', getSystemPromptOptions: () => ({ cwd: '/project', contextFiles: [], skills: [] }),
  } as unknown as ExtensionCommandContext & ExtensionToolContext;
  const api = {
    ui, get config() { return configuration; }, get services() { return serviceAccess; },
    runtime: { kind: 'host', cwd: '/project', storage: () => storage, logger: createSilentLogger() },
    exec: vi.fn(async () => ({ code: 0, killed: false, stdout: '', stderr: '' })),
    on: (event: string, handler: (...args: never[]) => unknown) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => unknown }) => commands.set(name, command),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCapability: vi.fn(), registerShortcut: vi.fn(), getActiveTools: () => ['read', 'bash', 'edit', 'write'],
    getAllTools: () => [], getCommands: () => [], getThinkingLevel: () => 'off', appendEntry: vi.fn(),
  } as unknown as FelanExtensionAPI;
  return { api, context, services, forms, elements, statuses, storage, entries, tools, commands,
    async install(extension: ConfiguredFelanExtension, config: FelanExtensionAPI['config'] = {}) {
      const definition = getExtensionConfigDefinition(extension);
      const defaults = definition ? Object.entries(definition.fields).map(([key, field]) => [key, field.default]) : [];
      configuration = { ...Object.fromEntries(defaults), ...config };
      serviceAccess = createExtensionServiceAccess(services, extension.serviceRequirements ?? {});
      await extension(api);
    },
    async emit(event: string) { for (const handler of handlers.get(event) ?? []) await handler({} as never, context as never); },
    async command(name: string, args = '') {
      const command = commands.get(name);
      if (!command) throw new Error(`Command not registered: ${name}`);
      return command.handler(args, context);
    },
    async tool(name: string, args: unknown) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool not registered: ${name}`);
      return tool.execute('fixture-tool-call', args, context.signal, undefined, context);
    },
  };
}

type Plan = { actionId: string; values?: UiValues; itemId?: string } | 'decline';
type Source = UiForm | UiPresentation;

export function clientRoute(kind: 'tui' | 'acp', initial: Source, capabilities: readonly string[] = GENERIC_UI_CAPABILITIES, interactionKinds: readonly string[] = ['form']) {
  let source = withoutHint(initial); let connected = true; let activePlan: Exclude<Plan, string> | undefined;
  const dialogs: Array<{ signal: AbortSignal; reply: (plan: Plan) => void }> = [];
  const pending: Array<{ op: string; params: unknown; reply: (accepted: boolean) => void }> = [];
  const listeners = new Set<() => void>(); const report = vi.fn();
  const send = vi.fn(); const displays: string[] = [];
  const interaction = (): Interaction => parseInteraction({ id: 'question', createdAt: 1, state: 'waiting',
    scope: { kind: 'session', session: 'session', root: 'session' }, request: { kind: 'form', form: source } });
  const state = () => ({ ...createSessionState('session'), status: connected ? 'live' as const : 'disconnected' as const,
    snapshot: { ...snapshot(), presentation: 'kind' in source ? [source] : [], interactions: 'kind' in source ? [] : [interaction()] } });
  const request = vi.fn(async (op: string, params: unknown) => {
    const ack = deferred<boolean>(); pending.push({ op, params, reply: ack.resolve });
    return await ack.promise ? { outcome: 'accepted', result: {} }
      : { outcome: 'rejected', error: { code: 'invalid_request', message: 'Broker rejected the action.', retryable: false } };
  });
  const daemon = { get status() { return connected ? 'ready' : 'disconnected'; },
    capabilities: { interactionKinds: [...interactionKinds], capabilities: [...capabilities], operations: capabilities.includes('ui.action') ? ['ui.action'] : [] },
    getInteractions: () => 'kind' in source ? [] : [interaction()], getAttachment: () => ({ state: state() }), readAttachment: () => ({ state: state() }), request,
  } as unknown as SessionClient;
  const choice = async (signal: AbortSignal) => {
    const current = source; const answer = deferred<Plan>(); dialogs.push({ signal, reply: answer.resolve });
    const abort = () => answer.resolve('decline');
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let plan: Plan;
    try { plan = await answer.promise; } finally { signal.removeEventListener('abort', abort); }
    if (plan === 'decline') return undefined;
    activePlan = plan;
    toggled.clear();
    if (!('kind' in current)) {
      const index = current.actions.findIndex(action => action.id === plan.actionId);
      if (index < 0) throw new Error('Undeclared form action.');
      return index;
    }
    if (current.kind === 'status') throw new Error('Statuses have no actions.');
    const choices = current.actions.flatMap<{ actionId: string; itemId: string | undefined }>(action => action.target === 'item' && current.kind === 'view'
      ? current.items.map(item => ({ actionId: action.id, itemId: item.id })) : [{ actionId: action.id, itemId: undefined }]);
    const index = choices.findIndex(action => action.actionId === plan.actionId && action.itemId === plan.itemId);
    if (index < 0) throw new Error('Undeclared action.');
    return index;
  };
  const input = (): UiInput => {
    if (!('kind' in source)) return source.input;
    if (source.kind === 'status') return { fields: [] };
    return source.actions.find(action => action.id === activePlan?.actionId)?.input ?? { fields: [] };
  };
  const fieldValue = (title: string) => {
    const field = input().fields.find(field => title.endsWith(field.label));
    if (!field) throw new Error(`Unexpected input: ${title}`);
    return { field, value: activePlan?.values?.[field.id] };
  };
  const toggled = new Map<string, Set<string>>();
  const ui = {
    custom: vi.fn(async (factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: boolean) => void) => { render(width: number): string[] }) => {
      const component = factory({ terminal: { rows: 200 }, requestRender: vi.fn() },
        { fg: (_color: string, value: string) => value, bold: (value: string) => value }, {}, () => {});
      displays.push(component.render(120).join('\n'));
      return true;
    }), notify: report,
    select: vi.fn(async (title: string, options: readonly string[], optionsSignal: { signal: AbortSignal }) => {
      if (title === 'Choose an action') { const index = await choice(optionsSignal.signal); return index === undefined ? undefined : options[index]; }
      const { field, value } = fieldValue(title);
      if (options.includes('Omit this field')) return value === undefined ? 'Omit this field' : 'Enter a value';
      if (field.kind === 'enum') return options[field.options.findIndex(option => option.id === value)];
      if (field.kind === 'boolean') return options[value ? 1 : 0];
      if (field.kind === 'multi_select') {
        const selected = toggled.get(field.id) ?? new Set(input().defaults?.[field.id] as string[] | undefined);
        toggled.set(field.id, selected);
        const desired = new Set(value as string[]);
        const id = [...selected].find(id => !desired.has(id)) ?? [...desired].find(id => !selected.has(id));
        if (id === undefined) return 'Done';
        if (selected.has(id)) selected.delete(id); else selected.add(id);
        return options[field.options.findIndex(option => option.id === id)];
      }
      throw new Error('Unexpected selector.');
    }),
    input: vi.fn(async (title: string) => String(fieldValue(title).value ?? '')),
    editor: vi.fn(async (title: string) => String(fieldValue(title).value ?? '')),
  } as unknown as InteractionPresenterUi;
  const controller = { sessionId: 'session', client: daemon, get state() { return state(); }, get snapshot() { return state().snapshot; },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    perform: request, setNotice: report,
  } as unknown as TuiSessionController;
  const acpRequest = vi.fn(async (_method: string, params: { requestedSchema: { properties: Record<string, unknown> } }, options: { cancellationSignal: AbortSignal }) => {
    if ('choice' in params.requestedSchema.properties) {
      const index = await choice(options.cancellationSignal);
      if (index === undefined) return { action: 'decline' };
      return { action: 'accept', content: { choice: 'kind' in source ? String(index) : source.actions[index]!.id } };
    }
    return { action: 'accept', content: activePlan?.values ?? {} };
  });
  const terminal = kind === 'tui' ? new TerminalInteractions(controller, new ClientInteractionPresenters(ui)) : undefined;
  const acp = kind === 'acp' ? new AcpProtocolInteractions(daemon, 'session', { request: acpRequest } as unknown as AgentContext,
    { send, flush: async () => {}, toolId: (id: string) => id } as unknown as AcpProtocolUpdates, true, report) : undefined;
  const refresh = () => { for (const listener of listeners) listener(); acp?.reconcile(); };
  acp?.reconcile();
  if ('kind' in source && (source.kind === 'status' || !source.actions.length)) terminal?.showElement(source.id);
  return { dialogs, pending, report, send, displays, request, ui, acpRequest,
    answer(plan: Plan, index = dialogs.length - 1) { dialogs[index]!.reply(plan); },
    update(value: Source) { source = withoutHint(value); refresh(); },
    connection(value: boolean) { connected = value; refresh(); },
    get busy() { return terminal?.busy; },
    async accept(effect?: (params: unknown) => Promise<void> | void, index = pending.length - 1) {
      const command = pending[index]!;
      await effect?.(command.params); command.reply(true);
    },
    async dispose() {
      acp?.close();
      for (const dialog of dialogs) dialog.reply('decline');
      for (const command of pending) command.reply(false);
      await terminal?.dispose();
    },
  };
}

export function commitForm(row: ReturnType<typeof extensionFixture>['forms'][number], params: unknown) {
  const { answer } = params as { answer: unknown };
  if (typeof answer === 'object' && answer !== null && 'cancelled' in answer) row.reply({ state: 'cancelled', reason: 'user' });
  else row.reply({ state: 'answered', answer: validateUiFormAnswer(row.form, answer) });
}

export async function commitAction(row: ReturnType<typeof extensionFixture>['elements'][number], params: unknown) {
  if (row.closed || row.value.kind === 'status') throw new Error('Element is closed or passive.');
  const request: UiActionRequest = validateUiAction(row.value, params);
  if (!row.options.onAction) throw new Error('No action handler.');
  await row.options.onAction(request, { requestId: 'fake-broker-action', signal: new AbortController().signal });
}
