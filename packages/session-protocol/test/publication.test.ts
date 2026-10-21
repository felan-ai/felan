import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  LIMITS, OriginSchema, PUBLISHED_TOOL_OUTPUT_CHARACTERS, REMOTE_FEATURES, RemoteCommandRowSchema, parseClientEnvelope, parseHostRegistration, parseHostTokenClaims, parseHostTokenResponse, parseOperationResult, parsePublishedEvent,
  parsePublishedSession, parseRealtimeNotification, parseRemoteCommand, parseRemoteCommandOutcome, parseSchema, parseServerEnvelope,
  type HostTokenClaims, type HostTokenResponse, type OperationParams, type RemoteCommand, type RemoteCommandRow,
} from '../src/index.js';
import { tool } from './fixtures.js';

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
  });
  it('rejects duplicate host projects', () => {
    const project = { id: 'p1', name: 'felan', path: '/work/felan' };
    const registration = { name: 'MacBook', daemonVersion: '0.29.0', rowSchemaVersion: 1, capabilities: { operations: ['prompt'], interactionKinds: ['confirm'] }, projects: [project] };
    expect(parseHostRegistration(registration)).toEqual(registration);
    expect(() => parseHostRegistration({ ...registration, projects: [project, project] })).toThrow(/Duplicate/);
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
  it('records web requests as a run origin', () => {
    expect(parseSchema(OriginSchema, { kind: 'web', user: host, command })).toEqual({ kind: 'web', user: host, command });
  });
  it('records channel-started requests on runs, queue items and messages', () => {
    const origin = { kind: 'channel', provider: 'slack', user: host, command };
    expect(parseSchema(OriginSchema, origin)).toEqual(origin);
    for (const change of [{ type: 'run.updated', run: { state: 'running', id: command, origin } },
      { type: 'queue.updated', queue: [{ id: command, kind: 'steer', prompt: { text: 'Next' }, origin }] },
      { type: 'message.completed', message: { id: command, entryId: command, role: 'user', content: [], timestamp: 0, origin } }]) {
      expect(parsePublishedEvent({ ...event, change }).change).toEqual(change);
    }
    for (const provider of ['', 'Slack', 'slack\nadmin', 'a'.repeat(65)]) expect(() => parseSchema(OriginSchema, { ...origin, provider })).toThrow();
    expect(() => parseSchema(OriginSchema, { kind: 'channel', user: host, command })).toThrow();
  });
  it('records channel origins without an identified user', () => {
    const origin = { kind: 'channel', provider: 'slack', command };
    expect(parseSchema(OriginSchema, origin)).toEqual(origin);
    for (const change of [{ type: 'run.updated', run: { state: 'running', id: command, origin } },
      { type: 'queue.updated', queue: [{ id: command, kind: 'follow_up', prompt: { text: 'Next' }, origin }] },
      { type: 'message.completed', message: { id: command, entryId: command, role: 'user', content: [], timestamp: 0, origin } }]) {
      expect(parsePublishedEvent({ ...event, change }).change).toEqual(change);
    }
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
  it('requires the host as token subject and at most 15 minutes of lifetime', () => {
    const claims = { iss: 'https://felan.ai', aud: 'authenticated', role: 'authenticated', sub: host, iat: 100, exp: 1000,
      felan: { kind: 'host', host_id: host, team_id: host, user_id: session } };
    expect(parseHostTokenClaims(claims)).toEqual(claims);
    expect(() => parseHostTokenClaims({ ...claims, sub: session })).toThrow(/subject/);
    expect(() => parseHostTokenClaims({ ...claims, exp: 1001 })).toThrow(/lifetime/);
    expect(() => parseHostTokenClaims({ ...claims, role: 'service_role' })).toThrow();
  });
  it('accepts team-host claims and token responses without a user', () => {
    const claims: HostTokenClaims = { iss: 'https://felan.ai', aud: 'authenticated', role: 'authenticated', sub: host, iat: 100, exp: 1000,
      felan: { kind: 'host', host_id: host, team_id: host } };
    expect(parseHostTokenClaims(claims)).toEqual(claims);
    expect(() => parseHostTokenClaims({ ...claims, sub: session })).toThrow(/subject/);
    expect(() => parseHostTokenClaims({ ...claims, exp: 1001 })).toThrow(/lifetime/);
    expect(() => parseHostTokenClaims({ ...claims, felan: { ...claims.felan, user_id: null } })).toThrow();
    const response: HostTokenResponse = { token: 't', expiresAt: 10, refreshAt: 5, host: { id: host, teamId: host },
      supabase: { url: 'https://x.supabase.co', publishableKey: 'sb_publishable_x' } };
    expect(parseHostTokenResponse(response)).toEqual(response);
    expect(() => parseHostTokenResponse({ ...response, refreshAt: 11 })).toThrow(/refresh/);
    expect(() => parseHostTokenResponse({ ...response, host: { ...response.host, userId: null } })).toThrow();
  });
  it('rejects a refresh time after expiry', () => {
    const response = { token: 't', expiresAt: 10, refreshAt: 5, host: { id: host, teamId: host, userId: host }, supabase: { url: 'https://x.supabase.co', publishableKey: 'sb_publishable_x' } };
    expect(parseHostTokenResponse(response)).toEqual(response);
    expect(() => parseHostTokenResponse({ ...response, refreshAt: 11 })).toThrow(/refresh/);
  });
});
