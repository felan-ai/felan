import { getMarkdownTheme, initTheme } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, beforeAll } from 'vitest';
import {
  CompactionMethodMessageComponent,
  compactionMethodForEntry,
  compactionMethodForMessage,
} from '../src/compaction-presentation.js';

beforeAll(() => {
  initTheme('dark', false);
});

describe('compaction presentation', () => {
  it('labels Felan classifier and summary entries', () => {
    expect(compactionMethodForEntry({
      fromHook: true,
      details: { namespace: 'felan.session-compaction', schemaVersion: 1, method: 'classifier' },
    })).toBe('Classifier');
    expect(compactionMethodForEntry({
      fromHook: true,
      details: { namespace: 'felan.session-compaction', schemaVersion: 1, method: 'summary' },
    })).toBe('Summary');
  });

  it('labels native entries and leaves unknown hook entries unchanged', () => {
    expect(compactionMethodForEntry({ fromHook: false, details: undefined })).toBe('Native');
    expect(compactionMethodForEntry({ fromHook: undefined, details: undefined })).toBe('Native');
    expect(compactionMethodForEntry({
      fromHook: true,
      details: { namespace: 'other.extension', schemaVersion: 1, method: 'summary' },
    })).toBeUndefined();
  });

  it('correlates live rows whose Pi-generated timestamp follows persistence', () => {
    expect(compactionMethodForMessage([{
      type: 'compaction',
      id: 'compact-1',
      parentId: null,
      timestamp: new Date(1).toISOString(),
      summary: 'checkpoint',
      firstKeptEntryId: 'kept-1',
      tokensBefore: 100,
      fromHook: true,
      details: { namespace: 'felan.session-compaction', schemaVersion: 1, method: 'classifier' },
    }], {
      role: 'compactionSummary',
      summary: 'checkpoint',
      tokensBefore: 100,
      timestamp: 2,
    })).toBe('Classifier');
  });

  it('keeps the collapsed row concise and expands to the summary', () => {
    const component = new CompactionMethodMessageComponent(
      {
        role: 'compactionSummary',
        summary: '## Goal\nKeep the active work.',
        tokensBefore: 12345,
        timestamp: 1,
      },
      'Classifier',
      getMarkdownTheme(),
    );

    expect(component.render(100).join('\n')).toContain('Context compacted · Classifier');
    expect(component.render(100).join('\n')).not.toContain('12,345');

    component.setExpanded(true);
    const expanded = component.render(100).join('\n');
    expect(expanded).toContain('Compacted from 12,345 tokens');
    expect(expanded).toContain('Keep the active work.');
  });
});
