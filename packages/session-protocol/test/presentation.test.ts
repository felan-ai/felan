import { describe, expect, it } from 'vitest';
import { LIMITS, PresentationEventSchema, PresentationSchema, parsePresentation, parseSchema, parseServerEnvelope } from '../src/index.js';

describe('runtime UI presentation contract', () => {
  it('bounds plain working status text', () => {
    const status = { id: 'working', kind: 'status', key: 'working', value: { kind: 'text', text: 'Indexing' }, fallback: 'Status' };
    expect(parseSchema(PresentationSchema, status)).toEqual(status);
    expect(() => parseSchema(PresentationSchema, { ...status, value: { kind: 'text', text: 'x'.repeat(LIMITS.statusTextBytes + 1) } })).toThrow();
  });
  it('validates optional widget placement', () => {
    const widget = { id: 'widget', kind: 'widget', text: 'value' };
    expect(parseSchema(PresentationSchema, widget)).toEqual(widget);
    expect(parseSchema(PresentationSchema, { ...widget, placement: 'belowEditor' })).toMatchObject({ placement: 'belowEditor' });
    expect(() => parseSchema(PresentationSchema, { ...widget, placement: 'outside' })).toThrow();
  });
});

it('bounds opaque negotiated presentation events without importing runtime-specific types', () => {
  const event = { v: 1, session: 'session', presentationEvent: { sequence: 0, data: { type: 'session', version: 3 } } };
  expect(parseServerEnvelope(event)).toEqual(event);
  expect(() => parseSchema(PresentationEventSchema, { ...event, presentationEvent: { ...event.presentationEvent, sequence: -1 } })).toThrow();
  expect(() => parseSchema(PresentationEventSchema, { ...event, presentationEvent: { ...event.presentationEvent, data: 'x'.repeat(LIMITS.pageBytes) } })).toThrow();
});

it.each(['custom', 'status_item'])('treats unknown %s presentations as fallback content', kind => {
  expect(parsePresentation({ id: 'unknown', kind, fallback: 'Unsupported content' })).toEqual({
    id: 'unknown', kind: 'notification', level: 'info', text: 'Unsupported content',
  });
});

it.each(['progress', 'document', 'view'])('rejects incomplete known %s presentations instead of downgrading them', kind => {
  expect(() => parsePresentation({ id: 'incomplete', kind, fallback: 'Incomplete content' })).toThrow();
});
