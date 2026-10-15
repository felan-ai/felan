import { resolve } from 'node:path';
import { CombinedAutocompleteProvider, type AutocompleteProvider, type SlashCommand } from '@earendil-works/pi-tui';
import { ThinkingSchema, parseSchema, parseOperationResult } from '@felan-ai/session-protocol';
import type { TuiSessionController } from './controller.js';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { pickSession, type NavigationDialogs } from './session-navigator.js';
import { pickTreeEntry, type TreeViewState } from './tree-navigator.js';

type ToolsManager = { getToolPath(tool: 'fd' | 'rg'): string | null };
const toolsManager = import(new URL('./utils/tools-manager.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href)
  .catch(() => undefined) as Promise<ToolsManager | undefined>;

/** `relaunch` restarts the daemon in place and then re-executes this client on the same session. */
export type DaemonAction = 'stop' | 'restart' | 'relaunch';
const BUILTINS: SlashCommand[] = [
  { name: 'settings', description: 'Open settings menu' },
  { name: 'model', description: 'Select model (opens selector UI)' },
  { name: 'tree', description: 'Navigate session tree (switch branches)' },
  { name: 'thinking', description: 'Set thinking level' },
  { name: 'fork', description: 'Create a new fork from a previous user message' },
  { name: 'login', description: 'Configure provider authentication' },
  { name: 'logout', description: 'Remove stored provider credentials' },
  { name: 'new', description: 'Start a new session' },
  { name: 'compact', description: 'Manually compact the session context' },
  { name: 'resume', description: 'Resume a different session' },
  { name: 'reload', description: 'Reload session configuration' },
  { name: 'cwd', description: 'Start a session in a different directory' },
  { name: 'sessions', description: 'Select a session' },
  { name: 'dependencies', description: 'Set up runtime dependencies' },
  { name: 'rename', description: 'Set session display name' },
  { name: 'reconnect', description: 'Reconnect to the daemon now, starting it if needed' },
  { name: 'restart', description: 'Restart the daemon and Felan Code, resuming this session' },
  { name: 'queue', description: 'Show queued messages' },
  { name: 'steer', description: 'Steer the active run' },
  { name: 'follow-up', description: 'Queue a follow-up message' },
  { name: 'cancel', description: 'Interrupt the active run' },
  { name: 'close', description: 'Close the current session' },
  { name: 'history', description: 'Load session history' },
  { name: 'ui', description: 'Open session UI' },
  { name: 'help', description: 'Show keyboard shortcuts and commands' },
  { name: 'hotkeys', description: 'Show keyboard shortcuts and commands' },
  { name: 'tools', description: '[t] Inspect tool calls and results' },
  { name: 'agents', description: '[t] Open agent navigator' },
  { name: 'exit', description: 'Quit Felan' },
  { name: 'daemon', description: 'Manage the daemon' },
];

export function tuiCommands(controller: TuiSessionController): SlashCommand[] {
  const builtinNames = new Set(BUILTINS.map(command => command.name));
  const markers = { temporary: 't', project: 'p', user: 'u' };
  return [...BUILTINS, ...(controller.snapshot?.catalog.commands.filter(command => !builtinNames.has(command.name)) ?? [])
    .map(command => ({ ...command, description: command.scope ? `[${markers[command.scope]}] ${command.description}` : command.description }))];
}

export function createCommandAutocomplete(controller: TuiSessionController, fallbackCwd = process.cwd()): AutocompleteProvider {
  let fdPath: Promise<string | null> | undefined;
  const provider = async () => {
    fdPath ??= toolsManager.then(manager => manager?.getToolPath('fd') ?? null);
    return new CombinedAutocompleteProvider(tuiCommands(controller), controller.snapshot?.cwd ?? fallbackCwd, await fdPath);
  };
  return {
    triggerCharacters: ['/', '@'],
    async getSuggestions(lines, line, column, options) {
      if (options.signal.aborted) return null;
      return (await provider()).getSuggestions(lines, line, column, options);
    },
    applyCompletion(lines, line, column, item, prefix) {
      return new CombinedAutocompleteProvider(tuiCommands(controller), controller.snapshot?.cwd ?? fallbackCwd, null)
        .applyCompletion(lines, line, column, item, prefix);
    },
    shouldTriggerFileCompletion(lines, line, column) {
      return new CombinedAutocompleteProvider(tuiCommands(controller), controller.snapshot?.cwd ?? fallbackCwd, null)
        .shouldTriggerFileCompletion(lines, line, column);
    },
  };
}

export async function submitTuiInput(controller: TuiSessionController, dialogs: NavigationDialogs, text: string,
  options: { cwd: string; exit(): void; theme?: () => Theme; requestRender?(): void; setDraft?(text: string): void; preferences?(): Promise<boolean>; login?(provider?: string): Promise<boolean>; logout?(): Promise<boolean>; dependencies?(): Promise<boolean>; ui?(): Promise<boolean>; daemon?(action: DaemonAction, force: boolean): Promise<void> }): Promise<boolean> {
  const trimmed = text.trim();
  if (trimmed === '/exit' || trimmed === '/quit') { options.exit(); return true; }
  if (trimmed === '/history') { await controller.loadHistory(); return true; }
  if (trimmed === '/reconnect') { await controller.reconnect(); return true; }
  if (trimmed === '/cancel') return (await controller.cancel()).outcome === 'accepted';
  if (!trimmed.startsWith('/')) {
    if (trimmed.startsWith('!')) {
      const includeInContext = !trimmed.startsWith('!!'); const command = trimmed.slice(includeInContext ? 1 : 2).trim();
      if (!command) return false;
      return (await controller.perform('shell.execute', { command, includeInContext }, requireSession(controller))).outcome === 'accepted';
    }
    return controller.submit(text);
  }
  const [, name = '', argument = ''] = /^\/(\S+)(?:\s+([\s\S]*))?$/u.exec(trimmed) ?? [];
  controller.setNotice('');
  if (name === 'ui') {
    if (argument) throw new Error('Usage: /ui');
    if (!options.ui) throw new Error('Session UI is unavailable.');
    return options.ui();
  }
  if (name === 'settings') {
    if (argument) throw new Error('Usage: /settings');
    if (!options.preferences) throw new Error('Client preferences are unavailable.');
    return options.preferences();
  }
  if (name === 'login' || name === 'logout' || name === 'dependencies') {
    if (name !== 'login' && argument) throw new Error(`Usage: /${name}`);
    const setup = options[name];
    if (!setup) throw new Error('Interactive daemon setup is unavailable in this client.');
    return setup(name === 'login' ? argument || undefined : undefined);
  }
  if (name === 'daemon' || name === 'restart') {
    const [action = 'status', mode, extra] = [...name === 'restart' ? ['restart'] : [], ...argument.split(/\s+/u).filter(Boolean)];
    if (extra || mode !== undefined && mode !== 'force') throw new Error('Usage: /daemon status|logs|stop|restart [force]');
    if (action === 'status' || action === 'logs') {
      if (mode) throw new Error('Force applies only to daemon stop/restart.');
      if (action === 'status') {
        const response = await controller.perform('host.status', {}); if (response.outcome !== 'accepted') return false;
        const host = response.result;
        await dialogs.select(`Daemon ${host.daemonVersion} · ${host.state}`, [
          { value: 'summary', label: `${host.active.sessions} sessions · ${host.active.runs} runs · ${host.active.work} active tasks · ${host.active.attachments} attachments` },
          ...host.setupNeeds.map(need => ({ value: need.code, label: need.message })),
        ]);
      } else {
        const response = await controller.perform('host.logs', { limit: 64 }); if (response.outcome !== 'accepted') return false;
        await dialogs.select(`Daemon logs${response.result.cursor ? ' (first page; use felan daemon logs for all)' : ''}`,
          response.result.entries.map((entry, index) => ({ value: String(index), label: `${entry.level}: ${entry.message}` })));
      }
      return true;
    }
    if (action !== 'stop' && action !== 'restart') throw new Error('Usage: /daemon status|logs|stop|restart [force]');
    if (!options.daemon) throw new Error('Daemon lifecycle controls are unavailable in this client.');
    const status = controller.client.capabilities?.operations.includes('host.status') ? await controller.perform('host.status', {}) : undefined;
    const active = status?.outcome === 'accepted' ? status.result.active.work : undefined;
    // Draining never interrupts work, so stopping busy work means choosing force.
    if (active !== 0) {
      const work = active === undefined ? 'Active work' : `${active} active task${active === 1 ? '' : 's'}`;
      if (!await dialogs.confirm(`${action === 'stop' ? 'Stop' : 'Restart'} daemon`, `${work} across all sessions will be interrupted. Continue?`)) return false;
    }
    await options.daemon(name === 'restart' ? 'relaunch' : action, mode === 'force' || active !== 0); return true;
  }
  if (name === 'new') {
    await controller.create({ cwd: resolve(controller.snapshot?.cwd ?? options.cwd, argument || '.') });
    controller.setNotice('✓ New session started'); return true;
  }
  if (name === 'cwd') {
    if (controller.snapshot && !['idle', 'interrupted'].includes(controller.snapshot.run.state)) throw new Error('Wait for the current run before changing directories.');
    const cwd = argument || await dialogs.input('Working directory', controller.snapshot?.cwd ?? options.cwd);
    if (!cwd) return false;
    await controller.create({ cwd: resolve(controller.snapshot?.cwd ?? options.cwd, cwd) }); return true;
  }
  if (name === 'reload') {
    if (argument) throw new Error('Usage: /reload');
    return controller.reloadSession(requireSession(controller));
  }
  if (name === 'resume' || name === 'sessions') {
    const rows = await controller.sessions();
    const selected = await pickSession(dialogs, rows, controller.snapshot?.cwd ?? options.cwd, controller.sessionId, options.theme);
    if (selected === undefined) return false;
    const row = rows.find(row => row.session === selected.session); if (!row) throw new Error('The selected session is unavailable.');
    if (selected.action === 'delete') {
      if ((await controller.perform('session.delete', {}, row.session)).outcome !== 'accepted') return false;
      controller.setNotice('Session deleted'); return true;
    }
    if (selected.action === 'rename') {
      if (row.session !== controller.sessionId) throw new Error('Attach to a session before renaming it.');
      const title = await dialogs.input('Session name', row.title);
      if (title === undefined || (await controller.perform('session.rename', { name: title }, row.session)).outcome !== 'accepted') return false;
      controller.setNotice(`Session name set: ${title}`); return true;
    }
    await controller.attach(row.session); return true;
  }
  const session = requireSession(controller); const snapshot = controller.snapshot!;
  switch (name) {
    case 'close':
      await controller.closeSession(); return controller.sessionId === undefined;
    case 'steer': return argument ? controller.submit(argument, 'steer') : false;
    case 'follow-up': return argument ? controller.submit(argument, 'follow_up') : false;
    case 'compact': return (await controller.perform('compact', argument ? { instructions: argument } : {}, session)).outcome === 'accepted';
    case 'rename': {
      const title = argument || await dialogs.input('Session name', snapshot.title);
      if (title === undefined || (await controller.perform('session.rename', { name: title }, session)).outcome !== 'accepted') return false;
      controller.setNotice(`Session name set: ${title}`); return true;
    }
    case 'model': {
      const models = snapshot.catalog.models;
      let persist = !argument;
      let selected = argument;
      if (!argument) {
        const response = await controller.perform('config.get', { scope: 'global' });
        if (response.outcome !== 'accepted') return false;
        const { writable, values: { defaultModel } } = parseOperationResult('config.get', response.result);
        persist = writable;
        const current = `${snapshot.model.provider}/${snapshot.model.id}`;
        const reference = (model: typeof models[number]) => `${model.provider}/${model.id}`;
        const rank = (model: typeof models[number]) => reference(model) === current ? 0 : reference(model) === defaultModel ? 1 : 2;
        selected = await dialogs.select('Model', [...models].sort((a, b) => rank(a) - rank(b) || a.provider.localeCompare(b.provider))
          .map(model => ({ value: reference(model), label: `${reference(model) === current ? '✓ ' : '  '}${model.id} [${model.provider}]${reference(model) === defaultModel ? ' · default' : ''}`,
            description: `Model Name: ${model.label}${writable ? '' : ' · host defaults are read-only'}` })), { initialValue: current, confirmLabel: writable ? 'set as default' : 'select for this session',
            ...(writable ? { secondary: { key: 'app.models.save' as const, label: 'select for this session', select: () => { persist = false; } } } : {}) }) ?? '';
      }
      if (!selected) return false;
      const model = models.find(model => `${model.provider}/${model.id}` === selected);
      if (!model) throw new Error('Choose a model advertised by this daemon.');
      if ((await controller.perform('set_model', { provider: model.provider, id: model.id }, session)).outcome !== 'accepted') return false;
      if (persist) {
        try {
          if ((await controller.perform('config.set', { scope: 'global', values: { defaultModel: selected } })).outcome !== 'accepted') throw new Error('Default save rejected.');
        } catch {
          controller.setNotice(`Model: ${model.id} set for this session; saving default failed`);
          return true;
        }
      }
      controller.setNotice(persist ? `Default model: ${selected}` : `Model: ${model.id}`);
      return true;
    }
    case 'thinking': {
      const choices = snapshot.catalog.models.find(model => model.provider === snapshot.model.provider && model.id === snapshot.model.id)?.thinking ?? [];
      let persist = false;
      let selected = argument;
      let modelThinkingLevels: ReturnType<typeof parseOperationResult<'config.get'>>['values']['modelThinkingLevels'];
      if (!argument) {
        const response = await controller.perform('config.get', { scope: 'global' }, session);
        if (response.outcome !== 'accepted') return false;
        const { values, writable } = parseOperationResult('config.get', response.result);
        const { defaultThinking } = values;
        modelThinkingLevels = values.modelThinkingLevels;
        const descriptions = { off: 'No reasoning', minimal: 'Very brief reasoning (~1k tokens)', low: 'Light reasoning (~2k tokens)',
          medium: 'Moderate reasoning (~8k tokens)', high: 'Deep reasoning (~16k tokens)', xhigh: 'Extra-high reasoning (~32k tokens)', max: 'Maximum reasoning' };
        selected = await dialogs.select('Thinking Level', choices.map(level => ({ value: level,
          label: `${level === snapshot.thinking ? '✓ ' : '  '}${level}${level === defaultThinking ? ' · default' : ''}`, description: `${descriptions[level]}${writable ? '' : ' · host defaults are read-only'}` })),
        { initialValue: snapshot.thinking, confirmLabel: 'select for this session',
          ...(writable ? { secondary: { key: 'app.thinking.save' as const, label: 'set as default', select: () => { persist = true; } } } : {}) }) ?? '';
      }
      if (!selected) return false;
      const thinking = parseSchema(ThinkingSchema, selected);
      if ((await controller.perform('set_thinking', { thinking }, session)).outcome !== 'accepted') return false;
      if (persist) {
        const reference = `${snapshot.model.provider}/${snapshot.model.id}`;
        try {
          if ((await controller.perform('config.set', { scope: 'global', values: { defaultThinking: thinking,
            ...(modelThinkingLevels?.[reference] === undefined ? {} : { modelThinkingLevels: { ...modelThinkingLevels, [reference]: thinking } }) } })).outcome !== 'accepted') throw new Error('Default save rejected.');
        } catch {
          controller.setNotice(`Thinking level: ${thinking} set for this session; saving default failed`);
          return true;
        }
      }
      controller.setNotice(persist ? `Default thinking level: ${thinking}` : `Thinking level: ${thinking}`);
      return true;
    }
    case 'fork': {
      const tree = await controller.tree(); const choices = tree.entries.filter(entry => entry.role === 'user');
      let entry = argument && /^(0|[1-9]\d*)$/u.test(argument) ? choices[Number(argument)] : undefined;
      let position = argument;
      if (!argument) {
        if (choices.length) {
          const selected = await dialogs.select('Fork before user message', choices.map((entry, index) => ({ value: entry.id, label: `${index}. ${entry.summary}` })));
          if (selected === undefined) return false;
          entry = choices.find(entry => entry.id === selected); if (!entry) throw new Error('Selected user message is no longer available.');
        } else if (tree.entries.some(entry => entry.kind === 'message' && entry.role === undefined)) {
          const value = await dialogs.input('This daemon does not list message roles. Enter a zero-based user-message position');
          if (value === undefined) return false; position = value;
        } else throw new Error('There are no user messages to fork.');
      }
      if (!entry && (!/^(0|[1-9]\d*)$/u.test(position) || !Number.isSafeInteger(Number(position)))) throw new Error('Fork position must be a zero-based integer.');
      const original = entry && controller.history.find(message => message.entryId === entry.id);
      const result = await controller.perform('fork', { from: entry ? { kind: 'entry', entryId: entry.id } : { kind: 'position', position: Number(position) } }, session);
      if (result.outcome !== 'accepted') return false;
      await controller.attach(result.result.sessionId, 'fork');
      if (original) options.setDraft?.(original.content.filter(part => part.type === 'text').map(part => part.text).join('\n'));
      return true;
    }
    case 'tree': {
      let selected: string | undefined; let view: TreeViewState | undefined;
      while (controller.sessionId === session) {
        const tree = await controller.tree();
        if (!tree.entries.length) { controller.setNotice('No entries in session'); return true; }
        const choice = await pickTreeEntry(dialogs, tree, { theme: options.theme, selected, requestRender: options.requestRender, view });
        if (!choice) return false;
        selected = choice.entryId;
        if (choice.action === 'label') {
          view = choice.view;
          const result = await controller.perform('session.entry.label', { entryId: choice.entryId, label: choice.label }, session);
          if (result.outcome !== 'accepted') return false;
          continue;
        }
        if (choice.entryId === tree.branch) { controller.setNotice('Already at this point'); return true; }
        const summarize = await dialogs.select('Summarize branch?', [{ value: 'no', label: 'No summary' }, { value: 'yes', label: 'Summarize' }]);
        if (summarize === undefined) continue;
        const entry = tree.entries.find(entry => entry.id === choice.entryId);
        const message = controller.history.find(message => message.entryId === choice.entryId);
        const result = await controller.perform('session.branch.select', { entryId: choice.entryId, summarize: summarize === 'yes' }, session);
        if (result.outcome !== 'accepted') return false;
        await controller.loadHistory();
        if (entry?.role === 'user') {
          if (message) options.setDraft?.(message.content.filter(part => part.type === 'text').map(part => part.text).join('\n'));
          else controller.setNotice('Branch selected. Full prompt text is not in the loaded history; the draft was not replaced with a truncated preview.');
        }
        return true;
      }
      return false;
    }
    case 'queue':
      await dialogs.select('Queue (read-only; targeted editing is unavailable)', snapshot.queue.map(item => ({ value: item.id, label: `${item.kind}: ${item.prompt.text}` })));
      return true;
    default: {
      const command = snapshot.catalog.commands.find(command => command.name === name);
      if (!command) throw new Error(`Unknown or unavailable command: /${name}`);
      return (await controller.perform('command.invoke', { name, arguments: argument }, session)).outcome === 'accepted';
    }
  }
}

function requireSession(controller: TuiSessionController): string {
  if (!controller.sessionId) throw new Error('No session is attached. Use /new or /sessions.');
  return controller.sessionId;
}
