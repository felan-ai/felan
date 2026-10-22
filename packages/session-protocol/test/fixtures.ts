import { OPERATION_CATALOG, type Operation, type RemoteStatus, type SessionSnapshot } from '../src/index.js';

export const now = 1_800_000_000_000;
export function requestId(time = now): string {
  const hex = time.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000001`;
}
export const identity = { namespaceId: 'isolated', instanceId: 'instance', agentDir: '/fixture/agent', rootSet: ['/fixture/agent', '/fixture/sessions'] };
export const origin = { kind: 'tui' as const, attachment: 'attachment' };
export const prompt = { text: 'hello', attachments: [{ type: 'resource_link' as const, uri: 'file:///fixture/a.txt' }] };
export const message = { id: 'message', entryId: 'entry', role: 'assistant' as const, content: [{ type: 'text' as const, text: 'answer' }], timestamp: now, origin };
export const history = { revision: 7, branch: 'branch', entries: [message] };
export const policy = { effective: 'host-default' as const, generation: 0 };
export const execution = { id: 'child', parent: 'session', label: 'general', description: 'fixture', state: 'queued' as const, createdAt: new Date(now).toISOString() };
export const interaction = {
  id: 'question', scope: { kind: 'session' as const, session: 'session', root: 'session' },
  request: { kind: 'confirm' as const, title: 'Continue?', message: 'Confirm a local action' },
  createdAt: now, state: 'waiting' as const,
};
export const tool = { id: 'tool-call', name: 'read', message: 'message', state: 'running' as const, output: 'partial', truncated: false };
export const process = { id: 'resource', session: 'session', root: 'session', kind: 'pty' as const, state: 'running' as const,
  command: 'fixture', startedAt: now, controllable: true, outputOffset: 0 };
export const snapshot: SessionSnapshot = {
  session: 'session', root: 'session', revision: 7, cwd: '/fixture', title: 'Test', state: 'open', residency: 'warm',
  branch: 'branch', history, model: { provider: 'fixture', id: 'fake' }, thinking: 'off', queue: [],
  run: { state: 'running', id: 'run', turnId: 'turn', origin }, catalog: { tools: [], commands: [], models: [] }, policy,
  interactions: [interaction], children: [], processes: [process], tools: [tool], presentation: [],
  activeStreams: [{ message: 'message', id: 'assistant-stream', kind: 'assistant', text: 'a😀', offset: 2 },
    { message: 'message', id: 'thinking-stream', kind: 'thinking', text: 'think', offset: 5 }],
  completionOnlyStreams: [],
};
export const remoteStatus: RemoteStatus = {
  configured: false, share: 'on-request', state: 'off', apiUrl: 'https://app.felan.ai', projects: [], pending: 0, sessions: 0,
};
export const commandParams = {
  hello: { clientVersion: '0.1.0', protocol: 1, kind: 'tui', interactionKinds: ['confirm'], target: { kind: 'production' } },
  'host.status': {}, 'remote.status': {}, 'remote.configure': { action: 'logout' }, 'sessions.list': { cwd: '/fixture' },
  'sessions.create': { cwd: '/fixture' },
  attach: { expected: identity },
  detach: { attachmentId: 'attachment' }, close: {}, prompt, steer: prompt, follow_up: prompt, cancel: {},
  set_model: { provider: 'fixture', id: 'fake' }, set_thinking: { thinking: 'high' }, compact: { method: 'classifier' },
  fork: { from: { kind: 'entry', entryId: 'entry' } }, 'command.invoke': { name: 'tasks', arguments: '' },
  'interaction.answer': { interactionId: 'question', answer: { kind: 'confirm', confirmed: true } },
  'ui.action': { elementId: 'document', revision: 1, actionId: 'open', outcome: 'submit', values: {} },
  'session.remote': { shared: true },
  'session.rename': { name: 'renamed' }, 'session.tree': {}, 'session.branch.select': { entryId: 'entry' },
  'session.entry.label': { entryId: 'entry', label: 'label' }, 'session.clone': {},
  'session.import': { path: '/fixture/selected.jsonl', cwd: '/fixture' },
  'session.export': { format: 'jsonl', destination: '/fixture/export.jsonl' }, 'session.delete': {},
  'session.history': { revision: 7, branch: 'branch' }, 'queue.update': { kind: 'steer', expectedRevision: 7, edits: [{ op: 'remove', id: 'queue-item' }] },
  'queue.clear': {},
  'shell.execute': { command: 'echo fixture', includeInContext: false }, 'config.get': { scope: 'session' },
  'config.set': { scope: 'session', values: { extensionConfig: { codex: { priority: 'fast' } } } },
  'host.setup.catalog': {}, 'host.setup.start': { kind: 'login', provider: 'fixture', method: 'api_key' },
  'host.setup.read': { jobId: 'setup' }, 'host.setup.answer': { jobId: 'setup', promptId: 'input', text: 'synthetic' },
  'host.setup.cancel': { jobId: 'setup' }, 'host.setup.open_link': { jobId: 'setup', index: 0 },
  'host.open_interaction': { interactionId: 'question' },
  'session.reload': {},
  'processes.list': { root: 'session' }, 'processes.read': { root: 'session', resourceId: 'resource', offset: 0, limit: 64 },
  'processes.write': { root: 'session', resourceId: 'resource', data: 'Aw==' }, 'processes.stop': { root: 'session', resourceId: 'resource', signal: 'SIGTERM' },
  'executions.list': {}, 'executions.read': { executionId: 'child' }, 'executions.steer': { executionId: 'child', message: 'Continue' }, 'executions.cancel': { executionId: 'child' },
  'host.stop': { expected: identity, mode: 'drain' }, 'host.restart': { expected: identity, mode: 'force' }, 'host.logs': {},
} satisfies Record<Operation, object>;
export function request(op: Operation, params: object = commandParams[op]) {
  return { v: 1, id: requestId(), op, ...(OPERATION_CATALOG[op].scope === 'host' ? {} : { session: 'session' }), params };
}

export const results = {
  hello: { attachmentId: 'attachment', principal: 'principal', daemonVersion: '0.1.0', protocol: 1, identity,
    operations: Object.keys(commandParams), interactionKinds: ['confirm'] },
  'host.status': { state: 'ready', identity, daemonVersion: '0.1.0', protocol: 1, active: { sessions: 1, runs: 1, work: 1, attachments: 1 }, setupNeeds: [] },
  'remote.status': remoteStatus, 'remote.configure': remoteStatus,
  'sessions.list': { entries: [] }, 'sessions.create': { sessionId: 'session' },
  attach: { attachmentId: 'attachment', snapshot }, detach: {}, close: {},
  prompt: { runId: 'run' }, steer: { itemId: 'item' }, follow_up: { itemId: 'item' }, cancel: {}, set_model: {}, set_thinking: {}, compact: { runId: 'run' },
  fork: { sessionId: 'fork' }, 'command.invoke': { status: 'completed' }, 'interaction.answer': {}, 'session.rename': {}, 'session.tree': { ...history, entries: [] },
  'ui.action': {}, 'session.remote': {},
  'session.branch.select': {}, 'session.entry.label': {}, 'session.clone': { sessionId: 'clone' }, 'session.import': { sessionId: 'import' },
  'session.export': { destination: '/fixture/export.jsonl' }, 'session.delete': {}, 'session.history': history, 'queue.update': {},
  'queue.clear': { steering: ['steer'], followUp: ['follow up'] },
  'shell.execute': { resourceId: 'resource', runId: 'run' }, 'config.get': { writable: true, values: { extensionConfig: { codex: { priority: 'fast' } } } }, 'config.set': {},
  'host.setup.catalog': { providers: [], credentials: [], dependencies: [] }, 'host.setup.start': { id: 'setup', kind: 'login', state: 'running', message: 'Starting' },
  'host.setup.read': { id: 'setup', kind: 'login', state: 'completed', message: 'Complete' },
  'host.setup.answer': {}, 'host.setup.cancel': {}, 'host.open_interaction': {},
  'host.setup.open_link': {},
  'session.reload': {}, 'processes.list': { entries: [process] },
  'processes.read': { resourceId: 'resource', offset: 0, nextOffset: 1, data: 'YQ==', state: 'running' }, 'processes.write': { writtenBytes: 1 },
  'processes.stop': {}, 'host.stop': { state: 'draining' }, 'host.restart': { state: 'draining' }, 'host.logs': { entries: [] },
  'executions.list': { items: [execution] }, 'executions.read': execution,
  'executions.steer': execution, 'executions.cancel': execution,
} satisfies Record<Operation, object>;
