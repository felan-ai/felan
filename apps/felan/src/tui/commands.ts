import { resolve } from 'node:path';
import { ThinkingSchema, parseSchema } from '@felan-ai/session-protocol';
import type { TuiSessionController } from './controller.js';
import type { TuiDialogHost } from './dialogs.js';
import type { AutocompleteProvider } from '@earendil-works/pi-tui';

export type DaemonAction = 'stop' | 'restart';
const BUILTINS = ['new', 'cwd', 'sessions', 'resume', 'model', 'thinking', 'settings', 'login', 'dependencies', 'compact', 'fork', 'tree', 'rename', 'reload', 'reconnect', 'queue', 'steer', 'follow-up', 'cancel', 'close', 'history', 'help', 'exit', 'daemon'];

export function createCommandAutocomplete(controller: TuiSessionController): AutocompleteProvider {
  return {
    triggerCharacters: ['/'],
    async getSuggestions(lines, line, column, { signal }) {
      const prefix = lines[line]?.slice(0, column) ?? '';
      if (signal.aborted || line !== 0 || !/^\/[^\s]*$/u.test(prefix)) return null;
      const names = new Set([...BUILTINS, ...(controller.snapshot?.catalog.commands.filter(command => command.eligibleClientKinds.includes('tui')).map(command => command.name) ?? [])]);
      return { prefix, items: [...names].filter(name => `/${name}`.startsWith(prefix)).sort().map(name => ({ value: `/${name} `, label: `/${name}` })) };
    },
    applyCompletion(lines, line, column, item, prefix) {
      const next = [...lines]; next[line] = `${lines[line]!.slice(0, column - prefix.length)}${item.value}${lines[line]!.slice(column)}`;
      return { lines: next, cursorLine: line, cursorCol: column - prefix.length + item.value.length };
    },
  };
}

export async function submitTuiInput(controller: TuiSessionController, dialogs: TuiDialogHost, text: string,
  options: { cwd: string; exit(): void; setDraft?(text: string): void; preferences?(): Promise<boolean>; login?(): Promise<boolean>; dependencies?(): Promise<boolean>; daemon?(action: DaemonAction, force: boolean): Promise<void> }): Promise<boolean> {
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
  if (name === 'settings') {
    if (argument) throw new Error('Usage: /settings');
    if (!options.preferences) throw new Error('Client preferences are unavailable.');
    return options.preferences();
  }
  if (name === 'login' || name === 'dependencies') {
    if (argument) throw new Error(`Usage: /${name}`);
    const setup = options[name];
    if (!setup) throw new Error('Interactive daemon setup is unavailable in this client.');
    return setup();
  }
  if (name === 'daemon') {
    const [action = 'status', mode, extra] = argument.split(/\s+/u).filter(Boolean);
    if (extra || mode !== undefined && mode !== 'force') throw new Error('Usage: /daemon status|logs|stop|restart [force]');
    if (action === 'status' || action === 'logs') {
      if (mode) throw new Error('Force applies only to daemon stop/restart.');
      if (action === 'status') {
        const response = await controller.perform('host.status', {}); if (response.outcome !== 'accepted') return false;
        const host = response.result;
        await dialogs.select(`Daemon ${host.daemonVersion} · ${host.state}`, [
          { value: 'summary', label: `${host.active.sessions} sessions · ${host.active.runs} runs · ${host.active.attachments} attachments` },
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
    requireSession(controller);
    if (!options.daemon) throw new Error('Daemon lifecycle controls are unavailable in this client.');
    if (!await dialogs.confirm(`${action === 'stop' ? 'Stop' : 'Restart'} daemon`, 'This affects every session and attached client. Graceful shutdown waits for active work. Continue?')) return false;
    if (mode === 'force' && !await dialogs.confirm('Interrupt all active work', 'Cancel active runs, descendants and processes across every session?')) return false;
    await options.daemon(action, mode === 'force'); return true;
  }
  if (name === 'new') { await controller.create({ cwd: resolve(controller.snapshot?.cwd ?? options.cwd, argument || '.') }); return true; }
  if (name === 'cwd') {
    if (controller.snapshot && !['idle', 'interrupted'].includes(controller.snapshot.run.state)) throw new Error('Wait for the current run before changing directories.');
    const cwd = argument || await dialogs.input('Working directory', controller.snapshot?.cwd ?? options.cwd);
    if (!cwd) return false;
    await controller.create({ cwd: resolve(controller.snapshot?.cwd ?? options.cwd, cwd) }); return true;
  }
  if (name === 'resume' || name === 'sessions') {
    const rows = await controller.sessions();
    const selected = await dialogs.select('Sessions', rows.map((row, index) => ({ value: String(index),
      label: `${row.title || row.session}${row.adoption === 'legacy' ? ' [legacy]' : ''}`, description: `${row.cwd} · ${row.run.state}` })));
    if (selected === undefined) return false;
    const row = rows[Number(selected)]; if (!row) throw new Error('The selected session is unavailable.');
    if (row.adoption === 'legacy') {
      if (!row.sourceFingerprint || !controller.client.identity) throw new Error('This legacy session cannot be safely adopted.');
      if (!await dialogs.confirm('Adopt legacy session', 'All older Felan/Pi writers must be stopped. Continue?')
        || !await dialogs.confirm('Backup confirmation', 'Have you made an offline backup of this session?')
        || !await dialogs.confirm('Legacy writer risk', 'Older binaries cannot honor the new lock. Keep them stopped while this daemon owns the session.')) return false;
      const adopted = await controller.perform('session.adopt', { expected: controller.client.identity, sourceFingerprint: row.sourceFingerprint,
        backupConfirmed: true, quiescenceConfirmed: true, legacyRiskAcknowledged: true }, row.session);
      if (adopted.outcome !== 'accepted') return false;
    }
    await controller.attach(row.session); return true;
  }
  const session = requireSession(controller); const snapshot = controller.snapshot!;
  switch (name) {
    case 'close':
      if (!await dialogs.confirm('Close session', `Stop work and close ${snapshot.title || session}? Exiting the client instead only detaches.`)) return false;
      await controller.closeSession(); return controller.sessionId === undefined;
    case 'steer': return argument ? controller.submit(argument, 'steer') : false;
    case 'follow-up': return argument ? controller.submit(argument, 'follow_up') : false;
    case 'compact': return (await controller.perform('compact', argument ? { instructions: argument } : {}, session)).outcome === 'accepted';
    case 'reload': return (await controller.perform('session.reload', {}, session)).outcome === 'accepted';
    case 'rename': {
      const title = argument || await dialogs.input('Session name', snapshot.title);
      return title === undefined ? false : (await controller.perform('session.rename', { name: title }, session)).outcome === 'accepted';
    }
    case 'model': {
      const models = snapshot.catalog.models;
      const selected = argument || await dialogs.select('Model', models.map(model => ({ value: `${model.provider}/${model.id}`, label: model.label,
        description: `${model.provider}/${model.id}` })));
      if (!selected) return false;
      const model = models.find(model => `${model.provider}/${model.id}` === selected);
      if (!model) throw new Error('Choose a model advertised by this daemon.');
      return (await controller.perform('set_model', { provider: model.provider, id: model.id }, session)).outcome === 'accepted';
    }
    case 'thinking': {
      const choices = snapshot.catalog.models.find(model => model.provider === snapshot.model.provider && model.id === snapshot.model.id)?.thinking ?? [];
      const selected = argument || await dialogs.select('Thinking level', choices.map(level => ({ value: level, label: level })));
      if (!selected) return false;
      return (await controller.perform('set_thinking', { thinking: parseSchema(ThinkingSchema, selected) }, session)).outcome === 'accepted';
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
      await controller.attach(result.result.sessionId);
      if (original) options.setDraft?.(original.content.filter(part => part.type === 'text').map(part => part.text).join('\n'));
      return true;
    }
    case 'tree': {
      const tree = await controller.tree();
      const entryId = await dialogs.select('Session branches', tree.entries.map(entry => ({ value: entry.id, label: entry.label || entry.summary, description: entry.kind })));
      if (entryId === undefined) return false;
      const result = await controller.perform('session.branch.select', { entryId, expectedRevision: tree.revision }, session);
      if (result.outcome !== 'accepted') return false;
      await controller.loadHistory(); return true;
    }
    case 'queue':
      await dialogs.select('Queue (read-only; targeted editing is unavailable)', snapshot.queue.map(item => ({ value: item.id, label: `${item.kind}: ${item.prompt.text}` })));
      return true;
    case 'help':
      controller.setNotice('/new /cwd /sessions /model /thinking /settings /login /dependencies /compact /fork /tree /rename /reload /reconnect /queue /steer /follow-up /cancel /close /exit; ! shell, !! shell without context');
      return true;
    default: {
      const command = snapshot.catalog.commands.find(command => command.name === name && command.eligibleClientKinds.includes('tui'));
      if (!command) throw new Error(`Unknown or unavailable command: /${name}`);
      return (await controller.perform('command.invoke', { name, arguments: argument }, session)).outcome === 'accepted';
    }
  }
}

function requireSession(controller: TuiSessionController): string {
  if (!controller.sessionId) throw new Error('No session is attached. Use /new or /sessions.');
  return controller.sessionId;
}
