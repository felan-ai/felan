import type { ExtensionContext } from '@felan-ai/agent-core';
import { expect, it, vi } from 'vitest';
import type { ContextReport } from '../src/index.js';
import { ContextUsageOverlay } from '../src/tui.js';
import { CONTEXT_VIEW_BYTES, createContextViewRequest, parseContextViewRequest, parseContextViewResult } from '../src/view.js';

function report(): ContextReport {
  return { breakdown: { systemPrompt: 2, systemTools: 0, extensions: 0, contextFiles: 0, skills: 0, memory: 0, messages: 3, other: 0, available: 95 },
    usedTokens: 5, contextWindow: 100, usagePercent: 5, estimated: true, systemToolCount: 1, extensionToolCount: 0,
    contextFileCount: 0, skillCount: 0, memory: { summary: 0, index: 0, schema: 0, recalls: 0 }, extensionDetails: [], skillDetails: [], modelLabel: 'test model' };
}
const theme = { fg: (_key: string, text: string) => text, bold: (text: string) => text } as ExtensionContext['ui']['theme'];

it('bounds detail transport while retaining exactly the existing visible report', () => {
  const full = report();
  full.extensionDetails = Array.from({ length: 30 }, (_, i) => ({ label: `extension-${i}`, tokens: 0, toolCount: 1 }));
  full.extensionToolCount = 30;
  full.skillDetails = Array.from({ length: 25 }, (_, i) => ({ label: `skill-${i}`, tokens: 0, promptVisible: false })); full.skillCount = 25;
  const data = createContextViewRequest(full, 'inline');
  expect(data.report.extensionDetails).toHaveLength(8); expect(data.report.extensionDetailsTotal).toBe(30);
  expect(data.report.skillDetails).toHaveLength(8); expect(data.report.skillDetailsTotal).toBe(25);
  expect(new ContextUsageOverlay(data.report, theme, vi.fn()).render(120)).toEqual(new ContextUsageOverlay(full, theme, vi.fn()).render(120));
});

it('removes terminal controls, marks clipped labels, and excludes private input fields', () => {
  const full = Object.assign(report(), { systemPrompt: 'private prompt', credentials: 'private credentials' });
  full.modelLabel = '\u001b]0;title\u0007' + '💚'.repeat(2000);
  const data = createContextViewRequest(full, 'overlay'); const text = JSON.stringify(data);
  expect(text).not.toContain('private'); expect(data.report.modelLabel).toMatch(/…$/u);
  expect(data.report.modelLabel).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
  expect(new TextEncoder().encode(text).length).toBeLessThan(CONTEXT_VIEW_BYTES);
});

it('preserves unknown and zero context windows', () => {
  for (const contextWindow of [null, 0]) {
    const full = report(); full.contextWindow = contextWindow; full.usagePercent = null; full.breakdown.available = 0;
    expect(createContextViewRequest(full, 'inline').report).toMatchObject({ contextWindow, usagePercent: null });
  }
});

it('renders an extreme legal used/window ratio without unbounded cell allocation', () => {
  const full = report(); full.usedTokens = Number.MAX_SAFE_INTEGER; full.breakdown.systemPrompt = full.usedTokens;
  full.breakdown.messages = 0; full.contextWindow = 1; full.breakdown.available = 0; full.usagePercent = full.usedTokens * 100;
  const data = createContextViewRequest(full, 'inline');
  expect(new ContextUsageOverlay(data.report, theme, vi.fn()).render(88).length).toBeLessThan(50);
});

it.each([
  { usedTokens: 6 }, { usagePercent: null }, { contextWindow: -1 }, { skillDetailsTotal: 2 },
  { modelLabel: '\u001bmalicious' }, { systemToolCount: Infinity }, { systemPrompt: 'not allowed' },
])('rejects malformed or inconsistent report data: %j', change => {
  const data = createContextViewRequest(report(), 'inline');
  expect(() => parseContextViewRequest({ ...data, report: { ...data.report, ...change } })).toThrow('Invalid context view data');
});

it('accepts only the close result', () => {
  expect(parseContextViewResult({ closed: true })).toEqual({ closed: true });
  for (const value of [{ closed: false }, { closed: true, command: 'execute' }, {}, null]) expect(() => parseContextViewResult(value)).toThrow();
});
