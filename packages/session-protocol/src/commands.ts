import { Type, type Static, type TSchema } from 'typebox';
import { ConfigScopeSchema, ConfigValuesSchema } from './config.js';
import { AgentControlSchema, AgentReadSchema, AgentsPageSchema } from './agents.js';
import { CatalogSchema, HistoryPageSchema, ProcessPageSchema, PromptSchema, SessionsPageSchema, TreePageSchema } from './data.js';
import { SessionSnapshotSchema } from './events.js';
import { InteractionAnswerSchema, InteractionKindSchema, UserCancellationSchema } from './interactions.js';
import { LIMITS } from './limits.js';
import { TuiPreferencesSchema, TuiPreferencesUpdateSchema } from './preferences.js';
import { SetupCatalogSchema, SetupJobSchema, SetupStartSchema } from './setup.js';
import { AbsolutePathSchema, ClientKindSchema, CounterSchema, DaemonIdentitySchema, DaemonTargetSchema, DiagnosticTextSchema, IdSchema, ModelSchema, NameSchema, PageRequestSchema, PresenterSchema, ThinkingSchema, enumOf, text } from './schema.js';

const empty = Type.Object({});
const all = ['tui', 'acp', 'headless'] as const;
const tui = ['tui'] as const;
const local = ['tui', 'headless'] as const;
const identity = { expected: DaemonIdentitySchema };
const resource = { root: IdSchema, resourceId: IdSchema };
const confirmed = { confirmed: Type.Literal(true) };
const lifecycle = Type.Object({ state: enumOf(['starting', 'ready', 'draining', 'stopped', 'blocked'] as const) });
export const HostStatusSchema = Type.Object({
  ...lifecycle.properties, identity: DaemonIdentitySchema, daemonVersion: text(128, 1), protocol: Type.Literal(1),
  active: Type.Object({ sessions: CounterSchema, runs: CounterSchema, attachments: CounterSchema }),
  setupNeeds: Type.Array(Type.Object({ code: IdSchema, message: DiagnosticTextSchema, provisioningId: Type.Optional(IdSchema) }), { maxItems: LIMITS.pageEntries }),
});
export const Base64Schema = Type.String({ pattern: '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' });
const bytes = (limit: number) => Type.String({ ...Base64Schema, maxLength: Math.ceil(limit / 3) * 4 });
export const OperationSchemas = {
  hello: Type.Object({ clientVersion: text(128, 1), protocol: Type.Literal(1), kind: ClientKindSchema,
    interactionKinds: Type.Array(InteractionKindSchema, { maxItems: 32, uniqueItems: true }), presenters: Type.Array(PresenterSchema, { maxItems: LIMITS.catalogEntries }), target: DaemonTargetSchema }),
  'host.status': empty,
  'sessions.list': Type.Object({ ...PageRequestSchema.properties, cwd: Type.Optional(AbsolutePathSchema), root: Type.Optional(IdSchema) }),
  'sessions.create': Type.Object({ cwd: AbsolutePathSchema, sessionDir: Type.Optional(AbsolutePathSchema),
    model: Type.Optional(ModelSchema), thinking: Type.Optional(ThinkingSchema), config: Type.Optional(ConfigValuesSchema), source: ClientKindSchema,
    extensions: Type.Optional(Type.Array(AbsolutePathSchema, { maxItems: LIMITS.catalogEntries, uniqueItems: true })) }),
  attach: Type.Object({ ...identity, requirePolicy: Type.Optional(Type.Literal('acp-strict')), policyWaitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: LIMITS.policyWaitMs })) }),
  'session.adopt': Type.Object({ ...identity, sourceFingerprint: text(256, 1), backupConfirmed: Type.Literal(true), quiescenceConfirmed: Type.Literal(true), legacyRiskAcknowledged: Type.Literal(true) }),
  detach: Type.Object({ attachmentId: IdSchema }),
  close: empty,
  prompt: PromptSchema,
  steer: PromptSchema,
  follow_up: PromptSchema,
  cancel: Type.Object({ runId: Type.Optional(IdSchema) }),
  set_model: ModelSchema,
  set_thinking: Type.Object({ thinking: ThinkingSchema }),
  compact: Type.Object({ instructions: Type.Optional(text(LIMITS.promptTextBytes)), method: Type.Optional(text(128, 1)) }),
  fork: Type.Object({ from: Type.Union([Type.Object({ kind: Type.Literal('entry'), entryId: IdSchema }), Type.Object({ kind: Type.Literal('position'), position: CounterSchema })]) }),
  'command.invoke': Type.Object({ name: text(LIMITS.commandBytes, 1), arguments: text(LIMITS.structuredBytes) }),
  'interaction.answer': Type.Object({ interactionId: IdSchema, answer: Type.Union([InteractionAnswerSchema, UserCancellationSchema]) }),
  'session.rename': Type.Object({ name: text(4096, 1) }),
  'session.tree': PageRequestSchema,
  'session.branch.select': Type.Object({ entryId: IdSchema, summarize: Type.Optional(Type.Boolean()), expectedRevision: CounterSchema }),
  'session.entry.label': Type.Object({ entryId: IdSchema, label: text(4096), expectedRevision: CounterSchema }),
  'session.clone': empty,
  'session.import': Type.Object({ path: AbsolutePathSchema, cwd: AbsolutePathSchema, ...confirmed }),
  'session.export': Type.Object({ format: enumOf(['html', 'jsonl'] as const), destination: AbsolutePathSchema, ...confirmed }),
  'session.delete': Type.Object({ ...confirmed, expectedRevision: CounterSchema }),
  'session.history': Type.Object({ ...PageRequestSchema.properties, revision: CounterSchema, branch: IdSchema }),
  'queue.update': Type.Object({ kind: enumOf(['steer', 'follow_up'] as const), expectedRevision: CounterSchema,
    edits: Type.Array(Type.Union([Type.Object({ op: Type.Literal('remove'), id: IdSchema }), Type.Object({ op: Type.Literal('replace'), id: IdSchema, prompt: PromptSchema })]), { minItems: 1, maxItems: LIMITS.pageEntries }) }),
  'shell.execute': Type.Object({ command: text(LIMITS.promptTextBytes, 1), includeInContext: Type.Boolean() }),
  'config.get': Type.Object({ scope: ConfigScopeSchema }),
  'config.set': Type.Object({ scope: ConfigScopeSchema, values: ConfigValuesSchema }),
  'tui.preferences.get': empty,
  'tui.preferences.set': Type.Object({ values: TuiPreferencesUpdateSchema }),
  'host.setup.catalog': empty,
  'host.setup.start': SetupStartSchema,
  'host.setup.read': Type.Object({ jobId: IdSchema }),
  'host.setup.answer': Type.Object({ jobId: IdSchema, promptId: IdSchema, text: text(64 * 1024) }),
  'host.setup.cancel': Type.Object({ jobId: IdSchema }),
  'host.setup.open_link': Type.Object({ jobId: IdSchema, index: Type.Integer({ minimum: 0, maximum: 15 }), confirmed: Type.Literal(true) }),
  'host.open_interaction': Type.Object({ interactionId: IdSchema, confirmed: Type.Literal(true) }),
  'session.reload': empty,
  'processes.list': Type.Object({ ...PageRequestSchema.properties, root: IdSchema }),
  'processes.read': Type.Object({ ...resource, offset: CounterSchema, limit: Type.Integer({ minimum: 1, maximum: LIMITS.processReadBytes }) }),
  'processes.write': Type.Object({ ...resource, data: bytes(LIMITS.processWriteBytes) }),
  'processes.stop': Type.Object({ ...resource, signal: enumOf(['SIGTERM', 'SIGKILL'] as const) }),
  'agents.list': PageRequestSchema,
  'agents.read': Type.Object({ agentId: IdSchema }),
  'agents.steer': Type.Object({ agentId: IdSchema, message: text(32 * 1024, 1) }),
  'agents.cancel': Type.Object({ agentId: IdSchema, reason: Type.Optional(text(4096)) }),
  'host.stop': Type.Object({ ...identity, ...confirmed, mode: enumOf(['drain', 'force'] as const) }),
  'host.restart': Type.Object({ ...identity, ...confirmed, mode: enumOf(['drain', 'force'] as const) }),
  'host.logs': PageRequestSchema,
} as const;
export type Operation = keyof typeof OperationSchemas;

type Definition = { scope: 'host' | 'session' | 'either'; mutation: boolean; storage: 'none' | 'connection' | 'durable'; clients: readonly ('tui' | 'acp' | 'headless')[] };
const definition = <S extends Definition['scope']>(scope: S, clients: Definition['clients'], mutation = true, storage: Definition['storage'] = 'durable') => Object.freeze({
  scope, clients: Object.freeze([...clients]), mutation, storage,
});
export const OPERATION_CATALOG = Object.freeze({
  hello: definition('host', all, false, 'connection'), 'host.status': definition('host', all, false, 'none'),
  'sessions.list': definition('host', all, false, 'none'),
  'sessions.create': definition('host', all), attach: definition('session', all, true, 'connection'),
  'session.adopt': definition('session', tui), detach: definition('session', all, true, 'connection'), close: definition('session', local),
  prompt: definition('session', all), steer: definition('session', local), follow_up: definition('session', local), cancel: definition('session', all),
  set_model: definition('session', local), set_thinking: definition('session', local), compact: definition('session', local), fork: definition('session', local),
  'command.invoke': definition('session', local), 'interaction.answer': definition('either', all), 'session.rename': definition('session', tui),
  'session.tree': definition('session', tui, false, 'none'), 'session.branch.select': definition('session', tui), 'session.entry.label': definition('session', tui),
  'session.clone': definition('session', tui), 'session.import': definition('host', tui), 'session.export': definition('session', tui), 'session.delete': definition('session', tui),
  'session.history': definition('session', all, false, 'none'), 'queue.update': definition('session', tui), 'shell.execute': definition('session', local),
  'config.get': definition('either', local, false, 'none'), 'config.set': definition('either', local), 'session.reload': definition('session', local),
  'tui.preferences.get': definition('host', tui, false, 'none'), 'tui.preferences.set': definition('host', tui),
  'host.setup.catalog': definition('host', tui, false, 'none'), 'host.setup.start': definition('host', tui),
  'host.setup.read': definition('host', tui, false, 'none'), 'host.setup.answer': definition('host', tui, true, 'connection'),
  'host.setup.cancel': definition('host', tui, true, 'connection'), 'host.open_interaction': definition('host', tui),
  'host.setup.open_link': definition('host', tui),
  'processes.list': definition('session', tui, false, 'none'), 'processes.read': definition('session', tui, false, 'none'),
  'processes.write': definition('session', tui), 'processes.stop': definition('session', tui), 'host.stop': definition('host', local),
  'agents.list': definition('session', tui, false, 'none'), 'agents.read': definition('session', tui, false, 'none'),
  'agents.steer': definition('session', tui), 'agents.cancel': definition('session', tui),
  'host.restart': definition('host', local), 'host.logs': definition('host', tui, false, 'none'),
} satisfies Record<Operation, Definition>);

export const HelloResultSchema = Type.Object({
  attachmentId: IdSchema, principal: IdSchema, daemonVersion: text(128, 1), protocol: Type.Literal(1), identity: DaemonIdentitySchema,
  operations: Type.Array(NameSchema, { maxItems: LIMITS.catalogEntries, uniqueItems: true }),
  interactionKinds: Type.Array(InteractionKindSchema, { maxItems: 32, uniqueItems: true }), presenters: Type.Array(PresenterSchema, { maxItems: LIMITS.catalogEntries }),
});
const created = Type.Object({ sessionId: IdSchema });
const run = Type.Object({ runId: IdSchema });
const inputResult = Type.Union([
  Type.Object({ itemId: IdSchema, status: Type.Optional(Type.Never()) }),
  Type.Object({ status: Type.Literal('handled'), itemId: Type.Optional(Type.Never()) }),
]);
const emptyResult = Type.Object({});
export const ResultSchemas = {
  hello: HelloResultSchema, 'host.status': HostStatusSchema, 'sessions.list': SessionsPageSchema,
  'sessions.create': created,
  attach: Type.Object({ attachmentId: IdSchema, snapshot: SessionSnapshotSchema }), 'session.adopt': Type.Object({ sessionId: IdSchema, adoptionId: IdSchema }),
  detach: emptyResult, close: emptyResult, prompt: run, steer: inputResult, follow_up: inputResult, cancel: emptyResult, set_model: emptyResult, set_thinking: emptyResult,
  compact: run, fork: created, 'command.invoke': Type.Object({ runId: Type.Optional(IdSchema), status: enumOf(['completed', 'started', 'waiting'] as const) }),
  'interaction.answer': emptyResult, 'session.rename': emptyResult, 'session.tree': TreePageSchema, 'session.branch.select': emptyResult, 'session.entry.label': emptyResult,
  'session.clone': created, 'session.import': created, 'session.export': Type.Object({ destination: AbsolutePathSchema }), 'session.delete': emptyResult,
  'session.history': HistoryPageSchema, 'queue.update': emptyResult, 'shell.execute': Type.Object({ resourceId: IdSchema, runId: IdSchema }),
  'config.get': Type.Object({ values: ConfigValuesSchema, catalog: Type.Optional(CatalogSchema), credentialSetup: Type.Optional(Type.Object({ provisioningId: IdSchema })) }),
  'config.set': emptyResult, 'session.reload': emptyResult, 'processes.list': ProcessPageSchema,
  'tui.preferences.get': TuiPreferencesSchema, 'tui.preferences.set': emptyResult,
  'host.setup.catalog': SetupCatalogSchema, 'host.setup.start': SetupJobSchema, 'host.setup.read': SetupJobSchema,
  'host.setup.answer': emptyResult, 'host.setup.cancel': emptyResult, 'host.open_interaction': emptyResult,
  'host.setup.open_link': emptyResult,
  'processes.read': Type.Object({ resourceId: IdSchema, offset: CounterSchema, nextOffset: CounterSchema, data: bytes(LIMITS.processReadBytes),
    state: enumOf(['running', 'exited', 'missing', 'interrupted'] as const), exitCode: Type.Optional(Type.Integer()) }),
  'processes.write': Type.Object({ writtenBytes: Type.Integer({ minimum: 0, maximum: LIMITS.processWriteBytes }) }), 'processes.stop': emptyResult,
  'agents.list': AgentsPageSchema, 'agents.read': AgentReadSchema, 'agents.steer': AgentControlSchema, 'agents.cancel': AgentControlSchema,
  'host.stop': lifecycle, 'host.restart': lifecycle, 'host.logs': Type.Object({ entries: Type.Array(Type.Object({ timestamp: CounterSchema,
    level: enumOf(['info', 'warning', 'error'] as const), message: DiagnosticTextSchema }), { maxItems: LIMITS.pageEntries }), cursor: Type.Optional(text(4096, 1)) }, { 'x-maxEncodedBytes': LIMITS.pageBytes }),
} as const satisfies Record<Operation, TSchema>;

export type OperationParams<O extends Operation> = Static<(typeof OperationSchemas)[O]>;
export type OperationResult<O extends Operation> = Static<(typeof ResultSchemas)[O]>;

export type SessionCommand = { [O in Operation]: typeof OPERATION_CATALOG[O]['scope'] extends 'host' ? never : { op: O; params: OperationParams<O> } }[Operation];
export const SessionCommandSchema = Type.Unsafe<SessionCommand>(Type.Union(Object.entries(OperationSchemas).filter(([op]) => OPERATION_CATALOG[op as Operation].scope !== 'host')
  .map(([op, params]) => Type.Object({ op: Type.Literal(op as Operation), params }))));
