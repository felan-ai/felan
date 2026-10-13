import { describe, expect, it } from 'vitest';
import { INTERACTION_KINDS, InteractionRequestSchema, LIMITS, parseInteraction, parseSchema, validateInteractionAnswer } from '../src/index.js';
import { interaction, now } from './fixtures.js';

const cases = [
  [{ kind: 'select', title: 'Pick', choices: [{ id: 'a', title: 'A' }], multiple: false }, { kind: 'select', choices: ['a'] }],
  [{ kind: 'confirm', title: 'Proceed', message: '' }, { kind: 'confirm', confirmed: true }],
  [{ kind: 'input', title: 'Input' }, { kind: 'input', text: 'text' }],
  [{ kind: 'editor', title: 'Edit', initialValue: 'before' }, { kind: 'editor', text: 'after' }],
  [{ kind: 'tool_approval', toolCallId: 'call', toolName: 'bash', summary: 'Command', options: [{ id: 'once', title: 'Allow once' }] }, { kind: 'tool_approval', optionId: 'once' }],
  [{ kind: 'dependency', dependency: 'fixture', message: 'Install?' }, { kind: 'dependency', approved: false }],
  [{ kind: 'form', form: { title: 'Choose', fallback: 'Choose an action', input: { fields: [] }, actions: [{ id: 'cancel', label: 'Cancel', target: 'element', outcome: 'cancel' }] } }, { kind: 'form', actionId: 'cancel', outcome: 'cancel', values: {} }],
] as const;

describe('declarative interactions', () => {
  it('preserves optional approval authority without changing legacy interactions', () => {
    expect(parseInteraction(interaction)).not.toHaveProperty('authority');
    for (const authority of ['owner', 'local-console'] as const) {
      expect(parseInteraction({ ...interaction, authority })).toMatchObject({ authority });
    }
    for (const authority of ['tui', 'acp', true, null, { owner: true }]) {
      expect(() => parseInteraction({ ...interaction, authority })).toThrow();
    }
  });

  it.each(cases)('round trips $kind request and typed answer', (request, result) => {
    const value = { ...interaction, request };
    expect(validateInteractionAnswer(parseInteraction(value), result)).toEqual(result);
    expect(parseInteraction({ ...value, state: 'answered', responder: 'assigned-principal', resolvedAt: now + 1, result })).toMatchObject({ state: 'answered' });
  });
  it('validates explicit deferral independently of request kind', () => {
    for (const [request] of cases) {
      const value = { ...interaction, request };
      expect(parseInteraction({ ...value, deferrable: true }).deferrable).toBe(true);
      expect(parseInteraction({ ...value, deferrable: false }).deferrable).toBe(false);
      expect(parseInteraction(value).deferrable).toBeUndefined();
      expect(() => parseInteraction({ ...value, deferrable: 'true' })).toThrow();
    }
  });
  it('covers exactly the negotiated kinds', () => {
    expect(cases.map(([request]) => request.kind)).toEqual(INTERACTION_KINDS);
  });
  it('rejects mismatched kinds and invalid choices', () => {
    expect(() => validateInteractionAnswer(interaction, { kind: 'input', text: 'not approval' })).toThrow();
    const select = parseInteraction({ ...interaction, request: cases[0]![0] });
    expect(() => validateInteractionAnswer(select, { kind: 'select', choices: ['unknown'] })).toThrow();
  });
  it.each(['ask_user', 'custom', 'oauth', 'trust'])('rejects removed interaction kind %s', kind => {
    expect(() => parseInteraction({ ...interaction, request: { kind } })).toThrow();
    expect(() => validateInteractionAnswer(interaction, { kind })).toThrow();
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

});
