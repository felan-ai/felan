import { describe, expect, it } from 'vitest';
import { INTERACTION_KINDS, InteractionRequestSchema, LIMITS, parseInteraction, parseSchema, validateInteractionAnswer } from '../src/index.js';
import { interaction, now } from './fixtures.js';

const cases = [
  [{ kind: 'select', title: 'Pick', choices: [{ id: 'a', title: 'A' }], multiple: false }, { kind: 'select', choices: ['a'] }],
  [{ kind: 'confirm', title: 'Proceed', message: '' }, { kind: 'confirm', confirmed: true }],
  [{ kind: 'input', title: 'Input' }, { kind: 'input', text: 'text' }],
  [{ kind: 'editor', title: 'Edit', initialValue: 'before' }, { kind: 'editor', text: 'after' }],
  [{ kind: 'ask_user', questions: [{ id: 'q', question: 'Which?', options: [{ id: 'a', title: 'A' }] }] }, { kind: 'ask_user', answers: [{ questionId: 'q', choices: ['a'] }] }],
  [{ kind: 'tool_approval', toolCallId: 'call', toolName: 'bash', summary: 'Command', options: [{ id: 'once', title: 'Allow once' }] }, { kind: 'tool_approval', optionId: 'once' }],
  [{ kind: 'oauth', provider: 'fixture', url: 'https://example.invalid/authorize', instructions: 'Sign in', provisioningId: 'private-ref' }, { kind: 'oauth', provisioningId: 'private-ref' }],
  [{ kind: 'trust', cwd: '/fixture', message: 'Trust?' }, { kind: 'trust', trusted: true }],
  [{ kind: 'dependency', dependency: 'fixture', message: 'Install?' }, { kind: 'dependency', approved: false }],
  [{ kind: 'custom', presenter: { id: 'fixture', version: '1' }, data: { title: 'Fixture' } }, { kind: 'custom', presenter: { id: 'fixture', version: '1' }, data: { selected: 'a' } }],
] as const;

describe('declarative interactions', () => {
  it.each(cases)('round trips $kind request and typed answer', (request, result) => {
    const value = { ...interaction, request };
    expect(validateInteractionAnswer(parseInteraction(value), result)).toEqual(result);
    expect(parseInteraction({ ...value, state: 'answered', responder: 'assigned-principal', resolvedAt: now + 1, result })).toMatchObject({ state: 'answered' });
  });
  it('covers exactly the negotiated kinds', () => {
    expect(cases.map(([request]) => request.kind)).toEqual(INTERACTION_KINDS);
  });
  it('rejects mismatched kinds, invalid choices and custom presenter versions', () => {
    expect(() => validateInteractionAnswer(interaction, { kind: 'input', text: 'not approval' })).toThrow();
    const select = parseInteraction({ ...interaction, request: cases[0]![0] });
    expect(() => validateInteractionAnswer(select, { kind: 'select', choices: ['unknown'] })).toThrow();
    const custom = parseInteraction({ ...interaction, request: cases[9]![0] });
    expect(() => validateInteractionAnswer(custom, { kind: 'custom', presenter: { id: 'fixture', version: '2' }, data: {} })).toThrow();
  });
  it('requires complete unique wizard answers and enforces freeform/comment permissions', () => {
    const wizard = parseInteraction({ ...interaction, request: { kind: 'ask_user', questions: [
      { id: 'a', question: 'A?', allowFreeform: false, options: [{ id: 'x', title: 'X' }] },
      { id: 'b', question: 'B?', allowFreeform: true },
    ] } });
    const good = { kind: 'ask_user', answers: [{ questionId: 'a', choices: ['x'] }, { questionId: 'b', choices: [], text: 'text' }] };
    expect(validateInteractionAnswer(wizard, good)).toEqual(good);
    expect(() => validateInteractionAnswer(wizard, { ...good, answers: [good.answers[0]] })).toThrow();
    expect(() => validateInteractionAnswer(wizard, { ...good, answers: [good.answers[0], good.answers[0]] })).toThrow();
    expect(() => validateInteractionAnswer(wizard, { ...good, answers: [{ questionId: 'a', choices: [], text: 'forbidden' }, good.answers[1]] })).toThrow();
    expect(() => validateInteractionAnswer(wizard, { ...good, answers: [{ ...good.answers[0], comment: 'forbidden' }, good.answers[1]] })).toThrow();
  });
  it('retains waiting and deferred requests without inventing answers on detach', () => {
    expect(parseInteraction(interaction).state).toBe('waiting');
    expect(parseInteraction({ ...interaction, state: 'deferred', expiresAt: now + LIMITS.deferredInteractionTtlMs }).state).toBe('deferred');
    expect(() => parseInteraction({ ...interaction, state: 'deferred' })).toThrow();
    expect(() => parseInteraction({ ...interaction, expiresAt: now - 1 })).toThrow();
    expect(() => parseInteraction({ ...interaction, state: 'answered', result: { kind: 'confirm', confirmed: true }, resolvedAt: now })).toThrow();
    expect(parseInteraction({ ...interaction, state: 'cancelled', resolvedAt: now, result: { cancelled: true, reason: 'restart' } }).state).toBe('cancelled');
  });
  it('bounds choices, wizard pages, answers and presentation JSON', () => {
    expect(() => parseSchema(InteractionRequestSchema, { kind: 'select', title: 'Pick', multiple: false, choices: Array.from({ length: 101 }, (_, id) => ({ id: String(id), title: 'x' })) })).toThrow();
    expect(() => parseSchema(InteractionRequestSchema, { kind: 'ask_user', questions: Array.from({ length: 5 }, (_, id) => ({ id: String(id), question: 'x' })) })).toThrow();
    expect(() => validateInteractionAnswer({ ...interaction, request: { kind: 'input', title: 'Input' } }, { kind: 'input', text: 'a'.repeat(LIMITS.answerBytes) })).toThrow();
    expect(() => parseInteraction({ ...interaction, request: { kind: 'custom', presenter: { id: 'p', version: '1' }, data: 'x'.repeat(LIMITS.structuredBytes) } })).toThrow();
  });

  it.each([
    { name: 'Unicode', text: '界'.repeat(32_000) },
    { name: 'astral Unicode', text: '😀'.repeat(16_000) },
    { name: 'escaped controls', text: '\u0000'.repeat(32_000) },
  ])('preserves large custom document text independently of metadata bounds: $name', ({ text }) => {
    const value = { ...interaction, request: { kind: 'custom', presenter: { id: 'document', version: '1' }, data: null, document: text } };
    expect(parseInteraction(value).request).toEqual(value.request);
  });

  it('keeps the overall interaction ceiling on custom document text', () => {
    expect(() => parseInteraction({ ...interaction, request: {
      kind: 'custom', presenter: { id: 'document', version: '1' }, data: null, document: 'x'.repeat(LIMITS.interactionBytes),
    } })).toThrow();
  });

  it('retains bounded structured documents without relaxing ordinary metadata limits', () => {
    const document = { answers: [{ model: 'fixture/model', text: 'answer '.repeat(30_000) }], complete: true };
    const request = { kind: 'custom', presenter: { id: 'structured-review', version: '1' }, data: null, document };
    expect(parseInteraction({ ...interaction, request }).request).toEqual(request);
    expect(() => parseInteraction({ ...interaction, request: { kind: 'custom', presenter: request.presenter, data: document } })).toThrow();
    expect(() => parseInteraction({ ...interaction, request: { ...request, document: Array(LIMITS.catalogEntries + 1).fill(null) } })).toThrow();
  });
});
