import { describe, expect, it } from 'vitest';
import {
  KNOWN_CHANGE_TYPES, PUBLISHED_CHANGE_TYPES, PUBLISHED_TOOL_OUTPUT_CHARACTERS, PUBLICATION_LIMITS,
  parsePublishedEvent, parsePublishedSession, type KnownSessionChange,
} from '@felan-ai/session-protocol';
import { publishableChange, publishedEvent, publishedSession } from '../src/remote/content.js';

const session = '01999999-1111-7111-8111-111111111111';
const message = (text: string): KnownSessionChange => ({ type: 'message.completed', message: { id: 'm', entryId: 'e', role: 'assistant', timestamp: 1, content: [{ type: 'text', text }] } });
const interaction = { id: 'i', scope: { kind: 'session' as const, session, root: session }, request: { kind: 'confirm' as const, title: 'Confirm', message: 'Yes?' }, state: 'waiting' as const, createdAt: 1, authority: 'local-console' as const };
const changes: KnownSessionChange[] = [
  message('Hello'),
  { type: 'tool.updated', tool: { id: 't', message: 'm', name: 'bash', state: 'completed', output: 'ok', truncated: false } },
  { type: 'run.updated', run: { state: 'idle' } },
  { type: 'queue.updated', queue: [{ id: 'q', kind: 'steer', prompt: { text: 'Next' }, origin: { kind: 'tui', attachment: 'a' } }] },
  { type: 'interaction.requested', interaction },
  { type: 'interaction.resolved', interaction: { ...interaction, state: 'cancelled', resolvedAt: 2, result: { cancelled: true, reason: 'user' } } },
  { type: 'metadata.updated', title: 'Title', state: 'open', residency: 'warm' },
  { type: 'model.updated', model: { id: 'test', provider: 'test' }, thinking: 'off' },
  { type: 'child.updated', child: { session, parent: session, root: session, title: 'Child', run: { state: 'idle' }, state: 'open' } },
  { type: 'stream.completion_only', stream: { message: 'm', id: 'stream', kind: 'assistant', reason: 'lost' } },
];

describe('remote publication content', () => {
  for (const type of KNOWN_CHANGE_TYPES) {
    it(`applies the publish set to ${type}`, () => {
      const fixture = changes.find(change => change.type === type);
      const change = publishableChange(fixture ?? { type } as KnownSessionChange);
      if (PUBLISHED_CHANGE_TYPES.includes(type as typeof PUBLISHED_CHANGE_TYPES[number])) {
        expect(change?.type).toBe(type);
        const event = publishedEvent(session, { seq: 1, rev: 5000, occurredAt: 10, change: change! });
        expect(parsePublishedEvent(event)).toEqual(event);
      } else expect(change).toBeUndefined();
    });
  }
  it('caps tool output in Unicode code points and sets truncated without mutating the input', () => {
    const output = '🦊'.repeat(5000);
    const original: KnownSessionChange = { type: 'tool.updated', tool: { id: 'tool', message: 'm', name: 'bash', state: 'completed', output, truncated: false } };
    const change = publishableChange(original)!;
    expect(change.type).toBe('tool.updated');
    if (change.type !== 'tool.updated') return;
    expect(Array.from(change.tool.output)).toHaveLength(PUBLISHED_TOOL_OUTPUT_CHARACTERS); expect(change.tool.truncated).toBe(true);
    expect(original.tool.output).toBe(output); expect(original.tool.truncated).toBe(false);
    expect(parsePublishedEvent(publishedEvent(session, { seq: 1, rev: 1, occurredAt: 1, change })).change).toEqual(change);
  });
  it('preserves already-truncated output and does not set truncated for short output', () => {
    for (const truncated of [false, true]) {
      const change = publishableChange({ type: 'tool.updated', tool: { id: 't', message: 'm', name: 'bash', state: 'completed', output: 'short', truncated } });
      expect(change).toMatchObject({ tool: { output: 'short', truncated } });
    }
  });
  it('redacts provider keys, PATs, JWTs and Bearer headers in text, thinking, results and nested argument leaves', () => {
    const secrets = ['sk-secret123456789', 'fln_pat_test123456789', 'bzy_team_test123456789', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.signature', 'Bearer abc123456789'];
    const text = secrets.join(' ');
    const change = publishableChange({ type: 'message.completed', message: {
      id: 'm', entryId: 'e', role: 'assistant', timestamp: 1,
      content: [
        { type: 'text', text }, { type: 'thinking', text }, { type: 'tool_result', id: 't', text, isError: false, details: { response: text } },
        { type: 'tool_call', id: 't', name: 'tool', arguments: { nested: [text, { token: 'short-secret' }] } },
      ], details: { description: text },
    } })!;
    const bytes = JSON.stringify(change);
    for (const secret of [...secrets, 'short-secret']) expect(bytes).not.toContain(secret);
    expect(bytes).toContain('[redacted]');
    expect(parsePublishedEvent(publishedEvent(session, { seq: 1, rev: 1, occurredAt: 0, change })).change).toEqual(change);
  });
  it('redacts tool output, interaction summaries, queue prompts and child titles', () => {
    const secret = 'fln_pat_abcdefghijk';
    const inputs: KnownSessionChange[] = [
      { type: 'tool.updated', tool: { id: 't', message: 'm', name: 'bash', state: 'completed', output: secret, truncated: false } },
      { type: 'interaction.requested', interaction: { ...interaction, request: { kind: 'tool_approval', toolCallId: 't', toolName: 'bash', summary: secret, options: [{ id: 'yes', title: secret }] } } },
      { type: 'queue.updated', queue: [{ id: 'q', kind: 'follow_up', prompt: { text: secret }, origin: { kind: 'headless', attachment: 'a' } }] },
      { type: 'child.updated', child: { session, parent: session, root: session, title: secret, run: { state: 'idle' }, state: 'open' } },
      { type: 'metadata.updated', title: secret, state: 'open', residency: 'warm' },
    ];
    for (const input of inputs) {
      const change = publishableChange(input)!; expect(JSON.stringify(change)).not.toContain(secret);
      expect(() => publishedEvent(session, { seq: 1, rev: 1, occurredAt: 1, change })).not.toThrow();
    }
  });
  it('replaces inline images in messages and queued attachments with text placeholders', () => {
    const input = { type: 'image' as const, mimeType: 'image/png' as const, data: 'a'.repeat(2 * 1024 * 1024) };
    const a = publishableChange({ type: 'message.completed', message: { id: 'm', entryId: 'e', role: 'user', timestamp: 0, content: [input] } })!;
    const b = publishableChange({ type: 'queue.updated', queue: [{ id: 'q', kind: 'steer', prompt: { text: '', attachments: [input] }, origin: { kind: 'tui', attachment: 'a' } }] })!;
    for (const change of [a, b]) {
      expect(JSON.stringify(change)).toContain('[image omitted]'); expect(JSON.stringify(change)).not.toContain('"data"');
      expect(() => publishedEvent(session, { seq: 1, rev: 1, occurredAt: 1, change })).not.toThrow();
    }
  });
  it('deterministically fits escaped multibyte text and nested arguments to the 1 MiB JSON budget', () => {
    const input = message('🦊\n"'.repeat(200_000));
    if (input.type === 'message.completed') input.message.content.push({ type: 'tool_call', id: 't', name: 'test', arguments: { text: '日本語'.repeat(180_000) } });
    const first = publishableChange(input)!; const second = publishableChange(input)!;
    expect(first).toEqual(second); expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(PUBLICATION_LIMITS.changeBytes);
    expect(() => publishedEvent(session, { seq: 1, rev: 1, occurredAt: 1, change: first })).not.toThrow();
  });
  it('bounds redacted session title/directory in UTF-8 and maps every run state', () => {
    for (const state of ['idle', 'running', 'waiting', 'cancelling', 'interrupted'] as const) {
      const value = publishedSession({ session, parent: session, cwd: `/private/full/path/${'🦊'.repeat(100)}`, title: `fln_pat_secret123 ${'日'.repeat(1000)}`, state: 'closed', run: { state }, shared: false });
      expect(value.runState).toBe(state); expect(value.state).toBe('closed'); expect(value.parent).toBe(session);
      expect(Buffer.byteLength(value.directory)).toBeLessThanOrEqual(256); expect(Buffer.byteLength(value.title)).toBeLessThanOrEqual(1024);
      expect(value.directory).not.toContain('/private'); expect(value.title).not.toContain('fln_pat_'); expect(value.title).not.toContain('�');
      expect(parsePublishedSession(value)).toEqual(value);
    }
  });
  it('publishes channel origins with their provider and identities intact', () => {
    const origin = { kind: 'channel' as const, provider: 'slack', user: session, command: session };
    const change: KnownSessionChange = { type: 'run.updated', run: { state: 'running', id: 'run', origin } };
    expect(publishableChange(change)).toEqual(change);
  });

  it('preserves interaction identities while redacting their visible labels', () => {
    const id = 'sk-choice123456789';
    const change = publishableChange({ type: 'interaction.resolved', interaction: {
      ...interaction, request: { kind: 'select', title: 'Select', multiple: false, choices: [{ id, title: 'fln_pat_label123456789' }] },
      state: 'answered', responder: 'r', resolvedAt: 2, result: { kind: 'select', choices: [id] },
    } })!;
    expect(change).toMatchObject({ interaction: { result: { choices: [id] }, request: { choices: [{ id, title: '[redacted]' }] } } });
    expect(() => publishedEvent(session, { seq: 1, rev: 1, occurredAt: 2, change })).not.toThrow();
  });
  it('fails closed when non-text structure cannot fit without dropping records', () => {
    const change = message('text');
    if (change.type !== 'message.completed') return;
    change.message.details = Array.from({ length: 600_000 }, () => 0);
    expect(() => publishableChange(change)).toThrow(/non-text structure/u);
  });
  it('rejects malformed and oversize publication entries at the boundary', () => {
    const change = publishableChange(message('ok'))!;
    expect(() => publishedEvent('../bad', { seq: 1, rev: 1, occurredAt: 0, change })).toThrow();
    expect(() => publishedEvent(session, { seq: 0, rev: 1, occurredAt: 0, change })).toThrow();
    expect(() => publishedEvent(session, { seq: 1, rev: 1, occurredAt: 0, change: message('x'.repeat(2 * 1024 * 1024)) as typeof change })).toThrow(/byte limit/u);
  });
});
