import type { ExtensionContext, UiView } from '@felan-ai/agent-core';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { presentMemoryHistory } from '../src/tui/renderers/memory.js';
import { presentTasksElement } from '../src/tui/renderers/tasks.js';

type Panel = { render(width: number): string[]; handleInput(key: string): void };
const colours: Record<string, number> = { accent: 36, success: 32, warning: 33, dim: 90, muted: 37 };
const theme = { fg: (role: string, text: string) => `\x1b[${colours[role] ?? 39}m${text}\x1b[0m`, bold: (text: string) => text };
function ui(run: (panel: Panel) => void) {
  return { custom: vi.fn((factory: (...args: any[]) => Panel) => new Promise(resolve => {
    run(factory({ terminal: { rows: 30 }, requestRender: vi.fn() }, theme, {}, resolve));
  })), input: vi.fn() } as unknown as Pick<ExtensionContext['ui'], 'custom' | 'input'>;
}
const close = { id: 'close', label: 'Close', target: 'element', outcome: 'cancel' } as const;

describe('view detail parity', () => {
  it('colours task selection and states and identifies unfinished prerequisites', async () => {
    const states = ['ready', 'waiting', 'in_progress', 'completed', 'cancelled', 'blocked'];
    const source: UiView = { kind: 'view', id: 'task-detail-parity', revision: 1, title: 'Tasks', fallback: 'Six tasks', fields: [],
      items: states.map((availability, index) => ({ id: `T-00000${index}`, fallback: availability,
        values: { title: 'Safe\x1b[31mtitle', priority: 1, availability, blockedBy: 'T-000000, T-000003', waitingOn: 'T-000000' } })),
      actions: [close] };
    const request = await presentTasksElement(source, ui(panel => {
      const output = panel.render(180).join('\n');
      expect(output).toContain('\x1b[36m▶\x1b[0m \x1b[37m○\x1b[0m');
      for (const [colour, icon] of [[33, '⊘'], [36, '◐'], [32, '✓'], [90, '×']] as const) {
        expect(output).toContain(`\x1b[${colour}m${icon}\x1b[0m`);
      }
      expect(output).not.toContain('\x1b[31m');
      expect(stripVTControlCharacters(output)).toContain('waiting ← waiting on T-000000');
      expect(stripVTControlCharacters(output)).not.toContain('waiting on T-000000, T-000003');
      panel.handleInput('\x1b[B');
      expect(panel.render(180).join('\n')).toContain('\x1b[36m▶\x1b[0m \x1b[33m⊘\x1b[0m');
      panel.handleInput('\x1b');
    }), new AbortController().signal, vi.fn());
    expect(request).toMatchObject({ actionId: 'close', outcome: 'cancel' });
  });

  it.each(['', 'missing'])('explains empty memory history with query %j and only applicable hints', async query => {
    const source: UiView = { kind: 'view', id: `memory-empty-${query}`, revision: 1, title: 'Memory history', fallback: 'enabled · idle · 0 pending',
      fields: [], items: [], query: { actionId: 'query', values: { query } }, actions: [close,
        { id: 'query', label: 'Search runs', target: 'element', outcome: 'submit' },
        { id: 'refresh', label: 'Refresh', target: 'element', outcome: 'submit' }] };
    const request = await presentMemoryHistory(source, ui(panel => {
      const output = stripVTControlCharacters(panel.render(120).join('\n'));
      expect(output).toContain(query ? 'No matching memory runs.' : 'No retained memory runs.');
      expect(output).toContain('Ctrl+F search');
      expect(output).toContain('Ctrl+R refresh');
      expect(output).not.toContain('Enter inspect');
      expect(output).not.toContain('↑↓ navigate');
      panel.handleInput('\r');
      panel.handleInput('\x1b');
    }), new AbortController().signal);
    expect(request).toMatchObject({ actionId: 'close', outcome: 'cancel' });
  });
});
