import type { ExtensionContext } from '@felan-ai/agent-core';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { expect, it, vi } from 'vitest';
import { ProcessViewPanel } from '../../src/tui/renderers/processes.js';
import { type ProcessViewRequest } from '../../../../packages/ext-background-bash/src/data.js';

const theme = { fg: (_name: string, value: string) => value, bold: (value: string) => value } as ExtensionContext['ui']['theme'];
const state: ProcessViewRequest = { viewId: 'view', sequence: 1, offset: 0, total: 19, running: 19,
  jobs: Array.from({ length: 18 }, (_, i) => ({ id: `job-${i}`, command: '\u001b]0;bad\u0007echo test', commandTruncated: false,
    status: 'running', startedAt: 1, updatedAt: 1 })) };

it('uses bounded pages while preserving keyboard navigation and one-shot control', () => {
  const finish = vi.fn(); const panel = new ProcessViewPanel(state, theme, finish, vi.fn());
  for (let i = 0; i < 18; i++) panel.handleInput('\u001b[B');
  panel.handleInput('k');
  expect(finish).toHaveBeenCalledExactlyOnceWith({ viewId: 'view', sequence: 1, action: 'page', offset: 18, select: 'first' });
  const last = new ProcessViewPanel({ ...state, offset: 18, jobs: [{ ...state.jobs[0]!, id: 'last' }], selectedId: 'last' }, theme, vi.fn(), vi.fn(), { selectedId: 'job-1', scroll: 500 });
  expect(last.navigation.selectedId).toBe('last');
});

it('sanitizes terminal controls and fits narrow widths', () => {
  const panel = new ProcessViewPanel(state, theme, vi.fn(), vi.fn());
  for (const width of [0, 1, 5, 40, 100]) {
    const lines = panel.render(width);
    expect(lines.every(line => visibleWidth(line) <= Math.max(1, width))).toBe(true);
    expect(lines.every(line => !/[\u0000-\u001f\u007f-\u009f]/u.test(stripTerminalSequences(line)))).toBe(true);
    expect(lines.join('\n')).not.toContain('bad');
  }
});

it('provides empty and output-chunk navigation without signalling from scroll input', () => {
  const empty = new ProcessViewPanel({ ...state, total: 0, running: 0, jobs: [] }, theme, vi.fn(), vi.fn());
  expect(empty.render(100).join('\n')).toContain('No background processes');
  const finish = vi.fn();
  const detail = new ProcessViewPanel({ ...state, selectedId: 'job-0', detail: { id: 'job-0', index: 1, chunks: 3, text: 'output' } }, theme, finish, vi.fn());
  detail.handleInput('\u001b[A'); expect(finish).not.toHaveBeenCalled();
  detail.handleInput('g'); expect(finish).toHaveBeenCalledExactlyOnceWith({ action: 'output', index: 0, viewId: 'view', sequence: 1 });
});
