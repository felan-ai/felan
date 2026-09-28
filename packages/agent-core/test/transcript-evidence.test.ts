import { describe, expect, it } from 'vitest';
import { extractTranscriptEvidenceEntry, extractTranscriptTextParts } from '../src/transcript-evidence.js';

describe('transcript text extraction', () => {
  it('preserves text blocks and reports non-text evidence without mutating it', () => {
    const content = [{ type: 'text', text: 'First\nline' }, { type: 'image', data: 'image-data' },
      { type: 'toolCall', name: 'read', arguments: { path: 'src/file.ts' } },
      { type: 'thinking', thinking: 'Reasoning' }, { type: 'text', text: 'Second' }];
    const before = structuredClone(content);
    expect(extractTranscriptTextParts(content)).toEqual({
      text: ['First\nline', 'Second'], nonTextKinds: ['image', 'toolCall', 'thinking'],
    });
    expect(content).toEqual(before);
    expect(extractTranscriptTextParts('Direct user text')).toEqual({ text: ['Direct user text'], nonTextKinds: [] });
    expect(extractTranscriptTextParts([{ type: 'text', text: 123 }, null])).toEqual({
      text: [], nonTextKinds: ['text', 'unsupported-block'],
    });
  });

  it('extracts entry identity, role, tool provenance, and summaries', () => {
    expect(extractTranscriptEvidenceEntry({ type: 'message', id: 'answer', message: {
      role: 'toolResult', toolName: 'ask_user', content: [{ type: 'text', text: 'The user chose staging.' }],
    } })).toEqual({ entryId: 'answer', role: 'toolResult', toolName: 'ask_user',
      text: ['The user chose staging.'], nonTextKinds: [] });
    expect(extractTranscriptEvidenceEntry({ type: 'message', id: 'request', message: {
      role: 'user', content: 'Remember the new rule.',
    } })).toMatchObject({ entryId: 'request', role: 'user', text: ['Remember the new rule.'] });
    expect(extractTranscriptEvidenceEntry({ type: 'message', id: 'response', message: {
      role: 'assistant', content: [{ type: 'text', text: 'Result' }],
    } })).toMatchObject({ entryId: 'response', role: 'assistant', text: ['Result'] });
    for (const type of ['compaction', 'branch_summary'] as const) {
      expect(extractTranscriptEvidenceEntry({ type, id: type, summary: 'Continuation' })).toEqual({
        entryId: type, role: type, text: ['Continuation'], nonTextKinds: [],
      });
    }
    expect(extractTranscriptEvidenceEntry({ type: 'message', id: 'unknown', message: { role: 'unsupported' } }))
      .toBeUndefined();
  });
});
