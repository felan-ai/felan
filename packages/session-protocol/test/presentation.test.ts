import { describe, expect, it } from 'vitest';
import { HEADLESS_JSON_PRESENTER, LIMITS, PresentationEventSchema, PresentationSchema, RUNTIME_UI_PRESENTER, parseRuntimeUiState, parseSchema, parseServerEnvelope } from '../src/index.js';

describe('runtime UI presentation contract', () => {
  it('round trips bounded declarative state', () => {
    const state = { workingMessage: 'Indexing', workingVisible: true, workingIndicator: { frames: ['.', '..'], intervalMs: 120 }, hiddenThinkingLabel: 'Thinking', toolsExpanded: false };
    expect(parseRuntimeUiState(state)).toEqual(state);
    expect(parseSchema(PresentationSchema, { id: 'runtime-ui', kind: 'custom', presenter: RUNTIME_UI_PRESENTER, data: state })).toMatchObject({ data: state });
    expect(parseRuntimeUiState({})).toEqual({});
    expect(parseRuntimeUiState({ workingIndicator: { frames: [] } })).toEqual({ workingIndicator: { frames: [] } });
  });
  it.each([
    ['oversized text', { workingMessage: 'x'.repeat(LIMITS.statusTextBytes + 1) }],
    ['too many frames', { workingIndicator: { frames: Array(65).fill('x') } }],
    ['zero interval', { workingIndicator: { intervalMs: 0 } }],
    ['non-finite interval', { workingIndicator: { intervalMs: Infinity } }],
    ['unknown root field', { callback: 'unsupported' }],
    ['unknown nested field', { workingIndicator: { callback: 'unsupported' } }],
  ])('rejects %s', (_name, value) => { expect(() => parseRuntimeUiState(value)).toThrow(); });
  it('preserves widget placement without requiring it for older payloads', () => {
    const widget = { id: 'widget', kind: 'widget', text: 'value' };
    expect(parseSchema(PresentationSchema, widget)).toEqual(widget);
    expect(parseSchema(PresentationSchema, { ...widget, placement: 'belowEditor' })).toMatchObject({ placement: 'belowEditor' });
    expect(() => parseSchema(PresentationSchema, { ...widget, placement: 'outside' })).toThrow();
  });
});

it('bounds opaque negotiated presentation events without importing runtime-specific types', () => {
  const event = { v: 1, session: 'session', presentationEvent: { presenter: HEADLESS_JSON_PRESENTER, sequence: 0, data: { type: 'session', version: 3 } } };
  expect(parseServerEnvelope(event)).toEqual(event);
  expect(() => parseSchema(PresentationEventSchema, { ...event, presentationEvent: { ...event.presentationEvent, sequence: -1 } })).toThrow();
  expect(() => parseSchema(PresentationEventSchema, { ...event, presentationEvent: { ...event.presentationEvent, data: 'x'.repeat(LIMITS.pageBytes) } })).toThrow();
});
