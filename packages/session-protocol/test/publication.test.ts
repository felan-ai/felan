import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  LIMITS, OriginSchema, PUBLICATION_LIMITS, PUBLISHED_TASK_TEXT_BYTES, PUBLISHED_TOOL_OUTPUT_CHARACTERS, ProtocolValidationError, PublishedTaskDetailSchema, REMOTE_FEATURES, RemoteCommandRowSchema, RemoteOperationSchema, parseClientEnvelope, parseHostPairingError, parseHostPairingPollRequest, parseHostPairingPollResponse, parseHostPairingStartRequest, parseHostPairingStartResponse,
  parseHostRegistration, parseHostTokenClaims, parseHostTokenResponse, parseOperationResult, parsePublishedEvent,
  parsePublishedSession, parsePublishedTaskDetails, parseRealtimeNotification, parseRemoteCommand, parseRemoteCommandOutcome, parseSchema, parseServerEnvelope, utf8Bytes,
  type HostTokenClaims, type HostTokenResponse, type OperationParams, type PublishedTaskDetail, type PublishedTaskDetails, type RemoteCommand, type RemoteCommandRow,
} from '../src/index.js';
import { commandParams, tool } from './fixtures.js';

const session = '0199e6a4-8c1a-7c3e-9b1d-2f4a5b6c7d8e';
const host = '5b1f7c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
const command = '0199e6a4-8c1a-7c3e-9b1d-000000000001';
const event = { schemaVersion: 1, session, seq: 1, rev: 4, change: { type: 'tool.updated', tool }, occurredAt: 1 };

describe('published events', () => {
  it('accepts a change from the publish set with a contiguous-capable seq', () => {
    expect(parsePublishedEvent(event)).toEqual(event);
  });
  it('rejects unpublished, unknown and malformed rows', () => {
    expect(() => parsePublishedEvent({ ...event, change: { type: 'policy.updated', policy: { effective: 'host-default', generation: 1 } } })).toThrow(/not published/);
    expect(() => parsePublishedEvent({ ...event, change: { type: 'future.addition' } })).toThrow();
    expect(() => parsePublishedEvent({ ...event, seq: 0 })).toThrow();
    expect(() => parsePublishedEvent({ ...event, session: 'not-a-uuid' })).toThrow();
  });
  it('caps tool output at the published limit', () => {
    const output = 'x'.repeat(PUBLISHED_TOOL_OUTPUT_CHARACTERS);
    expect(parsePublishedEvent({ ...event, change: { type: 'tool.updated', tool: { ...tool, output, truncated: true } } })).toBeTruthy();
    expect(() => parsePublishedEvent({ ...event, change: { type: 'tool.updated', tool: { ...tool, output: output + 'x' } } })).toThrow(/tool output/);
  });
});

describe('published sessions and hosts', () => {
  it('parses a session index row', () => {
    const row = { schemaVersion: 1, session, directory: 'felan', shared: true, title: 'Fix login', state: 'open', runState: 'idle' };
    expect(parsePublishedSession(row)).toEqual(row);
    expect(parsePublishedSession({ ...row, lastActivity: 1_700_000_000_000 })).toEqual({ ...row, lastActivity: 1_700_000_000_000 });
    expect(() => parsePublishedSession({ ...row, lastActivity: -1 })).toThrow();
    expect(() => parsePublishedSession({ ...row, lastActivity: 1.5 })).toThrow();
  });
  it('parses bounded loaded skills and processes on a session row', () => {
    const row = { schemaVersion: 1, session, directory: 'felan', shared: true, title: 'Fix login', state: 'open', runState: 'idle' };
    const skill = { name: 'linear', description: 'Work with Linear.', path: '~/.agents/skills/linear/SKILL.md', scope: 'user' };
    const process = { id: 'p1', command: 'pnpm dev', kind: 'detached', state: 'exited', startedAt: 1, exitCode: 0 };
    expect(parsePublishedSession({ ...row, skills: [skill], processes: [process] })).toEqual({ ...row, skills: [skill], processes: [process] });
    const { exitCode: _, ...running } = { ...process, state: 'running' };
    expect(parsePublishedSession({ ...row, skills: [], processes: [running] })).toEqual({ ...row, skills: [], processes: [running] });
    expect(() => parsePublishedSession({ ...row, skills: [{ ...skill, path: '/home/agent/.agents/skills/linear/SKILL.md' }] })).toThrow(/relative/);
    expect(() => parsePublishedSession({ ...row, skills: [{ ...skill, path: 'C:\\Users\\me\\SKILL.md' }] })).toThrow(/relative/);
    expect(() => parsePublishedSession({ ...row, skills: [{ ...skill, path: '' }] })).toThrow();
    expect(() => parsePublishedSession({ ...row, skills: [{ ...skill, scope: 'team' }] })).toThrow();
    expect(() => parsePublishedSession({ ...row, skills: [{ ...skill, description: 'é'.repeat(513) }] })).toThrow();
    expect(() => parsePublishedSession({ ...row, skills: Array.from({ length: LIMITS.pageEntries + 1 }, () => skill) })).toThrow();
    expect(() => parsePublishedSession({ ...row, processes: [{ ...process, state: 'stopped' }] })).toThrow();
    expect(() => parsePublishedSession({ ...row, processes: [{ ...process, exitCode: 1.5 }] })).toThrow();
    expect(() => parsePublishedSession({ ...row, processes: [{ ...process, command: 'x'.repeat(1025) }] })).toThrow();
    expect(() => parsePublishedSession({ ...row, processes: Array.from({ length: LIMITS.pageEntries + 1 }, () => process) })).toThrow();
  });
  it('parses bounded task graphs and omits unknown task fields', () => {
    const row = { schemaVersion: 1, session, directory: 'felan', shared: true, title: 'Fix login', state: 'open', runState: 'idle' };
    const task = { id: 'T-ABC123', title: 'Review change', status: 'pending', blockedBy: [] };
    expect(parsePublishedSession({ ...row, tasks: [] })).toEqual({ ...row, tasks: [] });
    expect(parsePublishedSession({ ...row, tasks: [task] })).toEqual({ ...row, tasks: [task] });
    expect(parsePublishedSession({ ...row, tasks: [{ ...task, description: 'Detail text', futureField: true }] }).tasks).toEqual([task]);
    expect(parsePublishedSession({ ...row, tasks: Array.from({ length: 256 }, (_, i) => ({ ...task, id: `T-${String(i).padStart(6, '0')}` })) }).tasks).toHaveLength(256);
    expect(() => parsePublishedSession({ ...row, tasks: Array.from({ length: 257 }, () => task) })).toThrow();
    expect(() => parsePublishedSession({ ...row, tasks: [{ ...task, title: 'é'.repeat(201) }] })).toThrow();
    expect(() => parsePublishedSession({ ...row, tasks: [{ ...task, title: 'é'.repeat(401) }] })).toThrow();
    expect(() => parsePublishedSession({ ...row, tasks: [{ ...task, status: 'ready' }] })).toThrow();
    expect(() => parsePublishedSession({ ...row, tasks: [{ ...task, blockedBy: Array.from({ length: 33 }, (_, i) => `T-${String(i).padStart(6, '0')}`) }] })).toThrow();
  });
  it('accepts optional task priority, owner and lifecycle timestamps', () => {
    const row = { schemaVersion: 1, session, directory: 'felan', shared: true, title: 'Fix login', state: 'open', runState: 'idle' };
    const task = { id: 'T-ABC123', title: 'Review change', status: 'in_progress', blockedBy: [], ownerSessionId: session,
      createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_001, claimedAt: 1_700_000_000_001 };
    for (const priority of [0, 1, 2, 3, 4]) {
      expect(parsePublishedSession({ ...row, tasks: [{ ...task, priority }] }).tasks).toEqual([{ ...task, priority }]);
    }
    const { ownerSessionId: _, claimedAt: __, ...completed } = { ...task, status: 'completed', completedAt: 1_700_000_000_002 };
    expect(parsePublishedSession({ ...row, tasks: [completed] }).tasks).toEqual([completed]);
    for (const priority of [5, -1, 1.5]) expect(() => parsePublishedSession({ ...row, tasks: [{ ...task, priority }] })).toThrow();
    expect(() => parsePublishedSession({ ...row, tasks: [{ ...task, ownerSessionId: '' }] })).toThrow();
  });
  it.each(['createdAt', 'updatedAt', 'claimedAt', 'completedAt'])('requires task %s to be a safe non-negative integer', field => {
    const row = { schemaVersion: 1, session, directory: 'felan', shared: true, title: 'Fix login', state: 'open', runState: 'idle' };
    const task = { id: 'T-ABC123', title: 'Review change', status: 'pending', blockedBy: [] };
    for (const timestamp of [0, Number.MAX_SAFE_INTEGER]) {
      expect(parsePublishedSession({ ...row, tasks: [{ ...task, [field]: timestamp }] }).tasks).toEqual([{ ...task, [field]: timestamp }]);
    }
    for (const timestamp of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, 'today']) {
      expect(() => parsePublishedSession({ ...row, tasks: [{ ...task, [field]: timestamp }] })).toThrow();
    }
  });
  it('rejects duplicate host projects', () => {
    const project = { id: 'p1', name: 'felan', path: '/work/felan' };
    const registration = { name: 'MacBook', daemonVersion: '0.29.0', rowSchemaVersion: 1, capabilities: { operations: ['prompt'], interactionKinds: ['confirm'] }, projects: [project] };
    expect(parseHostRegistration(registration)).toEqual(registration);
    expect(() => parseHostRegistration({ ...registration, projects: [project, project] })).toThrow(/Duplicate/);
  });
});

describe('published task details', () => {
  it('accepts full and id-only records and omits unknown fields', () => {
    const task: PublishedTaskDetail = { id: 'T-ABC123', description: 'Review the change.', acceptanceCriteria: 'The checks pass.',
      notes: 'Review started.', result: 'Review passed.', blockedReason: 'Awaiting approval.' };
    const details: PublishedTaskDetails = { session, tasks: [task, { id: 'T-DEF456' }] };
    expect(parsePublishedTaskDetails(details)).toEqual(details);
    expect(parsePublishedTaskDetails({ ...details, futureField: true, tasks: [{ ...task, title: 'Review change' }, { id: 'T-DEF456' }] })).toEqual(details);
  });
  it('requires a UUID session and between 1 and 256 tasks with unique IDs', () => {
    const tasks = Array.from({ length: LIMITS.pageEntries }, (_, i) => ({ id: `T-${String(i).padStart(6, '0')}` }));
    expect(parsePublishedTaskDetails({ session, tasks }).tasks).toEqual(tasks);
    expect(() => parsePublishedTaskDetails({ session, tasks: [] })).toThrow();
    expect(() => parsePublishedTaskDetails({ session, tasks: [...tasks, { id: 'T-ABC123' }] })).toThrow();
    expect(() => parsePublishedTaskDetails({ session, tasks: [tasks[0], { ...tasks[0], notes: 'Changed' }] }))
      .toThrowError(new ProtocolValidationError('invalid_request', 'Duplicate published task'));
    expect(() => parsePublishedTaskDetails({ session: 'not-a-uuid', tasks })).toThrow();
    expect(() => parsePublishedTaskDetails({ session, tasks: [{}] })).toThrow();
    expect(() => parsePublishedTaskDetails({ session, tasks: [{ id: '' }] })).toThrow();
  });
  it.each(Object.entries(PUBLISHED_TASK_TEXT_BYTES))('bounds task %s text by UTF-8 bytes', (field, bytes) => {
    for (const character of ['x', 'é', '😀', '👨‍👩‍👧']) {
      const count = Math.floor(bytes / utf8Bytes(character));
      const task = { id: 'T-ABC123', [field]: character.repeat(count) };
      expect(parsePublishedTaskDetails({ session, tasks: [task] }).tasks).toEqual([task]);
      expect(() => parsePublishedTaskDetails({ session, tasks: [{ ...task, [field]: character.repeat(count + 1) }] })).toThrow();
    }
    for (const value of ['', null, 1]) {
      expect(() => parsePublishedTaskDetails({ session, tasks: [{ id: 'T-ABC123', [field]: value }] })).toThrow();
    }
  });
  it('rejects RPC batches over 4 MiB measured in UTF-8 bytes', () => {
    const task = { id: 'T-ABC123', description: 'x'.repeat(4000), notes: '😀'.repeat(8000) };
    expect(parseSchema(PublishedTaskDetailSchema, task)).toEqual(task);
    const tasks = Array.from({ length: 128 }, (_, i) => ({ ...task, id: `T-${String(i).padStart(6, '0')}` }));
    const request = JSON.stringify({ p_session: session, p_tasks: tasks });
    expect(request.length).toBeLessThan(PUBLICATION_LIMITS.batchBytes);
    expect(utf8Bytes(request)).toBeGreaterThan(PUBLICATION_LIMITS.batchBytes);
    expect(() => parsePublishedTaskDetails({ session, tasks }))
      .toThrowError(new ProtocolValidationError('invalid_request', 'Published task details exceed batch limit'));
  });
});

describe('remote commands', () => {
  it('names a project rather than a path when creating sessions', () => {
    expect(parseRemoteCommand({ op: 'sessions.create', params: { project: 'p1', prompt: { text: 'hi' } } }).op).toBe('sessions.create');
    expect(() => parseRemoteCommand({ op: 'sessions.create', params: { cwd: '/etc' } })).toThrow();
  });
  it('reuses protocol params and rejects operations outside the remote set', () => {
    expect(parseRemoteCommand({ op: 'interaction.answer', session, params: { interactionId: 'i', answer: { kind: 'confirm', confirmed: true } } }).op).toBe('interaction.answer');
    expect(() => parseRemoteCommand({ op: 'close', session, params: {} })).toThrow();
    expect(() => parseRemoteCommand({ op: 'prompt', params: { text: 'hi' } })).toThrow();
  });
  it('accepts follow-up commands, notifications and correlated queue results', () => {
    const input = { op: 'follow_up', session, params: { text: 'Continue', attachments: [{ type: 'image', mimeType: 'image/png', data: 'YQ==' }] } };
    expect(parseRemoteCommand(input)).toEqual(input);
    expectTypeOf<Extract<RemoteCommand, { op: 'follow_up' }>['params']>().toEqualTypeOf<OperationParams<'follow_up'>>();
    expect(parseRealtimeNotification({ event: 'command', payload: { id: command, op: 'follow_up' } })).toEqual({ event: 'command', payload: { id: command, op: 'follow_up' } });
    const registration = { name: 'host', daemonVersion: '0.3.0', rowSchemaVersion: 1, projects: [],
      capabilities: { operations: ['follow_up'], interactionKinds: [] } };
    expect(parseHostRegistration(registration)).toEqual(registration);
    for (const result of [{ itemId: 'queued' }, { status: 'handled' }]) {
      expect(parseOperationResult('follow_up', result)).toEqual(result);
      const response = { v: 1, re: command, outcome: 'accepted', result };
      expect(parseServerEnvelope(response, 'follow_up')).toEqual(response);
    }
    expect(() => parseRemoteCommand({ ...input, session: undefined })).toThrow();
    expect(() => parseRemoteCommand({ ...input, params: {} })).toThrow();
    expect(() => parseOperationResult('follow_up', { itemId: 'queued', status: 'handled' })).toThrow();
  });
  it('accepts and advertises remote catalog invocations with or without attachments and delivery', () => {
    const op = 'command.invoke';
    const params = commandParams[op];
    const input = { op, session, params };
    const attachments = [{ type: 'image', mimeType: 'image/png', data: 'YQ==' }];
    expect(parseRemoteCommand(input)).toEqual(input);
    for (const delivery of ['steer', 'follow_up']) {
      const queued = { ...input, params: { ...params, attachments, delivery } };
      expect(parseRemoteCommand(queued)).toEqual(queued);
    }
    expectTypeOf<Extract<RemoteCommand, { op: typeof op }>['params']>().toEqualTypeOf<OperationParams<typeof op>>();
    expect(parseSchema(RemoteOperationSchema, op)).toBe(op);
    const notification = { event: 'command', payload: { id: command, op } };
    expect(parseRealtimeNotification(notification)).toEqual(notification);
    const registration = { name: 'host', daemonVersion: '0.3.0', rowSchemaVersion: 1, projects: [],
      capabilities: { operations: [op], interactionKinds: [] } };
    expect(parseHostRegistration(registration)).toEqual(registration);
  });
  it.each(['AAA_', 'YR=='])('rejects invalid or noncanonical image data %j in remote catalog invocations', data => {
    const input = { op: 'command.invoke', session, params: { ...commandParams['command.invoke'],
      attachments: [{ type: 'image', mimeType: 'image/png', data }] } };
    expect(() => parseRemoteCommand(input)).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
  });
  it('reuses local model and thinking schemas for remote commands and capabilities', () => {
    const model = { op: 'set_model', session, params: { provider: 'anthropic', id: 'claude-sonnet' } } as const;
    const thinking = { op: 'set_thinking', session, params: { thinking: 'high' } } as const;
    expect(parseRemoteCommand(model)).toEqual(model);
    expect(parseRemoteCommand(thinking)).toEqual(thinking);
    expectTypeOf<Extract<RemoteCommand, { op: 'set_model' }>['params']>().toEqualTypeOf<OperationParams<'set_model'>>();
    expectTypeOf<Extract<RemoteCommand, { op: 'set_thinking' }>['params']>().toEqualTypeOf<OperationParams<'set_thinking'>>();
    for (const remoteCommand of [model, thinking]) {
      expect(parseHostRegistration({ name: 'host', daemonVersion: '0.3.0', rowSchemaVersion: 1, projects: [],
        capabilities: { operations: [remoteCommand.op], interactionKinds: [] } }).capabilities.operations).toEqual([remoteCommand.op]);
      expect(parseRealtimeNotification({ event: 'command', payload: { id: command, op: remoteCommand.op } })).toEqual({
        event: 'command', payload: { id: command, op: remoteCommand.op },
      });
    }
    expect(() => parseRemoteCommand({ ...model, params: { provider: 'anthropic' } })).toThrow();
    expect(() => parseRemoteCommand({ ...thinking, params: { thinking: 'extreme' } })).toThrow();
  });
  it('accepts and advertises remote summary compaction with bounded focus instructions', () => {
    const compact = { op: 'compact', session, params: { method: 'summary', instructions: 'é'.repeat(LIMITS.instructionsBytes / 2) } } as const;
    expect(parseRemoteCommand(compact)).toEqual(compact);
    expect(parseRemoteCommand({ op: 'compact', session, params: {} })).toEqual({ op: 'compact', session, params: {} });
    expect(parseSchema(RemoteOperationSchema, 'compact')).toBe('compact');
    expect(parseHostRegistration({ name: 'host', daemonVersion: '0.8.2', rowSchemaVersion: 1, projects: [],
      capabilities: { operations: ['compact'], interactionKinds: [] } }).capabilities.operations).toEqual(['compact']);
    expect(parseRealtimeNotification({ event: 'command', payload: { id: command, op: 'compact' } })).toEqual({ event: 'command', payload: { id: command, op: 'compact' } });
    for (const params of [{ instructions: '' }, { instructions: 'é'.repeat(LIMITS.instructionsBytes / 2 + 1) }, { method: 'custom' }, { method: '' }]) {
      expect(() => parseRemoteCommand({ ...compact, params })).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
    }
    expect(() => parseRemoteCommand({ op: 'compact', params: {} })).toThrow();
    expectTypeOf<Extract<RemoteCommand, { op: 'compact' }>['params']>().toEqualTypeOf<{ instructions?: string; method?: 'summary' }>();
  });
  it('accepts only lowercase UUIDs for optional client-created session IDs', () => {
    const create = { op: 'sessions.create', params: { project: 'workspace', sessionId: session } };
    expect(parseRemoteCommand(create)).toEqual(create);
    for (const sessionId of ['', 'not-a-uuid', session.toUpperCase(), command + '\n']) {
      expect(() => parseRemoteCommand({ ...create, params: { ...create.params, sessionId } })).toThrow();
    }
    expectTypeOf<Extract<RemoteCommand, { op: 'sessions.create' }>['params']['sessionId']>().toEqualTypeOf<string | undefined>();
  });
  it.each(['prompt', 'steer', 'follow_up', 'sessions.create'] as const)('validates image data in remote %s prompts', op => {
    const prompt = { text: 'Inspect', attachments: [{ type: 'image', mimeType: 'image/png', data: 'invalid' }] };
    const input = op === 'sessions.create' ? { op, params: { project: 'workspace', prompt } } : { op, session, params: prompt };
    expect(() => parseRemoteCommand(input)).toThrow(/base64/);
  });
  it('adds an expired outcome to protocol responses', () => {
    expect(parseRemoteCommandOutcome({ v: 1, re: command, outcome: 'expired' }).outcome).toBe('expired');
    expect(parseRemoteCommandOutcome({ v: 1, re: command, outcome: 'rejected', error: { code: 'forbidden', message: 'no', retryable: false } }).outcome).toBe('rejected');
  });
  it('records web and channel origins with or without an identified channel user', () => {
    for (const origin of [{ kind: 'web', user: host, command }, { kind: 'channel', provider: 'slack', user: host, command },
      { kind: 'channel', provider: 'slack', command }]) {
      expect(parseSchema(OriginSchema, origin)).toEqual(origin);
      if (origin.kind !== 'channel') continue;
      for (const change of [{ type: 'run.updated', run: { state: 'running', id: command, origin } },
        { type: 'queue.updated', queue: [{ id: command, kind: origin.user ? 'steer' : 'follow_up', prompt: { text: 'Next' }, origin }] },
        { type: 'message.completed', message: { id: command, entryId: command, role: 'user', content: [], timestamp: 0, origin } }]) {
        expect(parsePublishedEvent({ ...event, change }).change).toEqual(change);
      }
    }
    const origin = { kind: 'channel', provider: 'slack', command };
    for (const provider of ['', 'Slack', 'slack\nadmin', 'a'.repeat(65)]) expect(() => parseSchema(OriginSchema, { ...origin, provider })).toThrow();
    expect(() => parseSchema(OriginSchema, { kind: 'channel', user: host, command })).toThrow();
    expect(() => parseSchema(OriginSchema, { ...origin, user: null })).toThrow();
    expect(() => parseSchema(OriginSchema, { ...origin, command: undefined })).toThrow();
    expect(() => parseSchema(OriginSchema, { kind: 'web', command })).toThrow();
  });
});

describe('channel commands and session instructions', () => {
  const create = { op: 'sessions.create', params: { project: 'project', instructions: 'Write Markdown only.' } };
  it('bounds remote and local create instructions', () => {
    expect(parseRemoteCommand(create)).toEqual(create);
    expect(() => parseRemoteCommand({ ...create, params: { ...create.params, instructions: '' } })).toThrow();
    expect(() => parseRemoteCommand({ ...create, params: { ...create.params, instructions: 'é'.repeat(LIMITS.instructionsBytes / 2 + 1) } })).toThrow();
    const local = { v: 1, id: command, op: 'sessions.create', params: { cwd: '/work', instructions: 'Stay silent unless addressed.' } };
    expect(parseClientEnvelope(local)).toEqual(local);
    expect(() => parseClientEnvelope({ ...local, params: { ...local.params, instructions: 'x'.repeat(LIMITS.instructionsBytes + 1) } })).toThrow();
  });
  it('carries the channel provider on claimed command rows', () => {
    const row = { id: command, host, requester: host, command: create, createdAt: 1, expiresAt: 2 };
    expect(parseSchema(RemoteCommandRowSchema, { ...row, channel: { provider: 'slack' } })).toEqual({ ...row, channel: { provider: 'slack' } });
    expect(parseSchema(RemoteCommandRowSchema, row)).toEqual(row);
    expect(() => parseSchema(RemoteCommandRowSchema, { ...row, channel: {} })).toThrow();
  });
  it('accepts automated commands and commands without a requester', () => {
    const row: RemoteCommandRow = { id: command, host, command: { op: 'sessions.create', params: { project: 'workspace' } }, createdAt: 1, expiresAt: 2 };
    expect(parseSchema(RemoteCommandRowSchema, row)).toEqual(row);
    for (const source of ['schedule', 'x'.repeat(256), 'é'.repeat(128)]) {
      const automated = { ...row, automation: { source } };
      expect(parseSchema(RemoteCommandRowSchema, automated)).toEqual(automated);
      expect(parseSchema(OriginSchema, { kind: 'automation', source })).toEqual({ kind: 'automation', source });
    }
    for (const source of [null, 1, '', 'x'.repeat(257), 'é'.repeat(129)]) {
      expect(() => parseSchema(RemoteCommandRowSchema, { ...row, automation: { source } })).toThrow();
      expect(() => parseSchema(OriginSchema, { kind: 'automation', source })).toThrow();
    }
    expect(() => parseSchema(RemoteCommandRowSchema, { ...row, requester: null })).toThrow();
    expect(() => parseSchema(RemoteCommandRowSchema, { ...row, automation: {} })).toThrow();
  });
  it('advertises optional host features and keeps unknown ones for forward compatibility', () => {
    expect(REMOTE_FEATURES).toContain('sessions.create.session-id');
    const registration = { name: 'host', daemonVersion: '0.3.0', rowSchemaVersion: 1, projects: [],
      capabilities: { operations: ['sessions.create'], interactionKinds: [], features: [...REMOTE_FEATURES] } };
    expect(parseHostRegistration(registration)).toEqual(registration);
    const { features: _, ...legacy } = registration.capabilities;
    expect(parseHostRegistration({ ...registration, capabilities: legacy }).capabilities).toEqual(legacy);
    expect(parseHostRegistration({ ...registration, capabilities: { ...legacy, features: ['future.feature'] } }).capabilities.features).toEqual(['future.feature']);
    expect(() => parseHostRegistration({ ...registration, capabilities: { ...legacy, features: [''] } })).toThrow();
    expect(() => parseHostRegistration({ ...registration, capabilities: { ...legacy, features: ['a', 'a'] } })).toThrow();
  });
});

describe('realtime and tokens', () => {
  it('parses notifications that carry only identifiers', () => {
    expect(parseRealtimeNotification({ event: 'events', payload: { seq: 3 } })).toEqual({ event: 'events', payload: { seq: 3 } });
    expect(() => parseRealtimeNotification({ event: 'text', payload: {} })).toThrow();
  });
  it('requires host token subjects and at most 15 minutes of lifetime with or without a user', () => {
    for (const felan of [{ kind: 'host' as const, host_id: host, team_id: host, user_id: session }, { kind: 'host' as const, host_id: host, team_id: host }]) {
      const claims: HostTokenClaims = { iss: 'https://felan.ai', aud: 'authenticated', role: 'authenticated', sub: host, iat: 100, exp: 1000, felan };
      expect(parseHostTokenClaims(claims)).toEqual(claims);
      expect(() => parseHostTokenClaims({ ...claims, sub: session })).toThrow(/subject/);
      expect(() => parseHostTokenClaims({ ...claims, exp: 1001 })).toThrow(/lifetime/);
      expect(() => parseHostTokenClaims({ ...claims, role: 'service_role' })).toThrow();
      expect(() => parseHostTokenClaims({ ...claims, felan: { ...claims.felan, user_id: null } })).toThrow();
    }
  });
  it('validates personal and team-host token responses and bounds refresh times by expiry', () => {
    for (const hostRecord of [{ id: host, teamId: host }, { id: host, teamId: host, userId: host }]) {
      const response: HostTokenResponse = { token: 't', expiresAt: 10, refreshAt: 5, host: hostRecord,
        supabase: { url: 'https://x.supabase.co', publishableKey: 'sb_publishable_x' } };
      expect(parseHostTokenResponse(response)).toEqual(response);
      expect(() => parseHostTokenResponse({ ...response, refreshAt: 11 })).toThrow(/refresh/);
      expect(() => parseHostTokenResponse({ ...response, host: { ...response.host, userId: null } })).toThrow();
    }
  });
});

describe('browser pairing', () => {
  const deviceCode = 'd'.repeat(43);
  const start = { deviceCode, userCode: 'BCDF-GHJK', verificationUri: 'https://app.felan.ai/pair',
    verificationUriComplete: 'https://app.felan.ai/pair?code=BCDF-GHJK', interval: 5, expiresAt: 1_000 };

  it('starts with the same registration fields as the token exchange', () => {
    const request = { installId: host, name: 'MacBook', daemonVersion: '0.4.0', protocol: 1, rowSchemaVersion: 1 };
    expect(parseHostPairingStartRequest(request)).toEqual(request);
    expect(() => parseHostPairingStartRequest({ ...request, installId: 'not-a-uuid' })).toThrow();
    expect(() => parseHostPairingStartRequest({ ...request, protocol: 2 })).toThrow();
  });
  it('accepts a start response with readable user codes and same-origin verification URIs', () => {
    expect(parseHostPairingStartResponse(start)).toEqual(start);
    for (const fields of [
      { userCode: 'ABCD-EFGH' }, { userCode: 'bcdf-ghjk' }, { userCode: 'BCDFGHJK' }, { deviceCode: 'short' }, { deviceCode: 'd'.repeat(42) + '.' },
      { interval: 0 }, { interval: 61 }, { verificationUri: 'ftp://app.felan.ai/pair' },
      { verificationUri: 'https://user:secret@app.felan.ai/pair' }, { verificationUriComplete: 'https://evil.example/pair?code=BCDF-GHJK' },
    ]) expect(() => parseHostPairingStartResponse({ ...start, ...fields })).toThrow();
  });
  it('polls by device code and returns a credential bound to a personal host', () => {
    expect(parseHostPairingPollRequest({ deviceCode })).toEqual({ deviceCode });
    expect(() => parseHostPairingPollRequest({ deviceCode: '' })).toThrow();
    const response = { credential: 'fln_pat_secret', host: { id: host, teamId: host, userId: host } };
    expect(parseHostPairingPollResponse(response)).toEqual(response);
    expect(() => parseHostPairingPollResponse({ ...response, host: { id: host, teamId: host } })).toThrow();
    expect(() => parseHostPairingPollResponse({ ...response, credential: '' })).toThrow();
  });
  it('accepts only the bounded pairing error codes', () => {
    for (const code of ['authorization_pending', 'slow_down', 'access_denied', 'expired_token', 'unsupported_schema', 'rate_limited']) {
      expect(parseHostPairingError({ code, message: 'm' }).code).toBe(code);
    }
    expect(parseHostPairingError({ code: 'unsupported_schema', message: 'm', supported: { protocol: [1], rowSchemaVersion: [1] } }).supported)
      .toEqual({ protocol: [1], rowSchemaVersion: [1] });
    expect(() => parseHostPairingError({ code: 'invalid_pat', message: 'm' })).toThrow();
  });
});
