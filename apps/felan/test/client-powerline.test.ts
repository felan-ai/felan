import { expect, it, vi } from 'vitest';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import type { Presentation, UiView } from '@felan-ai/session-protocol';
import type { SessionClient } from '../src/client/client.js';
import { createClientPowerlineFooter, powerlineViewData } from '../src/client/powerline-presenter.js';
import { fallbackPresentations } from '../src/tui/screen.js';
import { isPowerlinePresentation } from '../src/client/powerline-presenter.js';
import { presentationText, statusText } from '../src/client/ui.js';
import { snapshot } from './client-fixtures.js';

function view(): UiView {
  return { id: 'opaque-binding-view', kind: 'view', revision: 1, title: 'Powerline', hint: { id: 'felan.powerline', version: '3.0.0' },
    fields: ['segment', 'data', 'color'].map(id => ({ id, label: id, valueKind: 'text' as const })),
    items: [{ id: 'directory', values: { segment: 'directory', data: JSON.stringify({ cwd: 'Projected footer' }), color: 'directory' }, fallback: 'Directory' }],
    actions: [], fallback: 'Powerline data' };
}

it('derives data only from versioned generic rows, leaving layout to the client', () => {
  const source = view();
  expect(powerlineViewData([source])).toEqual({ segments: [{ name: 'directory', colorKey: 'directory', values: { cwd: 'Projected footer' } }] });
  const { hint: _hint, ...plain } = source;
  expect(powerlineViewData([plain])).toBeUndefined();
  expect(presentationText(plain)).toContain('Projected footer');
  expect(powerlineViewData([{ ...source, hint: { id: 'felan.powerline', version: '2.0.0' } }])).toBeUndefined();
});

it('preserves a client-only footer across recovery and clears it on removal or disposal', () => {
  let live = true; let presentation: Presentation[] = [view()];
  const listeners = new Set<() => void>();
  const client = { getAttachment: () => ({ state: { status: live ? 'live' : 'disconnected', snapshot: { ...snapshot(), presentation } } }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } } as unknown as SessionClient;
  const render = vi.fn(); const footer = createClientPowerlineFooter(client, 'session', {
    theme: () => ({ getFgAnsi: () => '', getBgAnsi: () => '' }), requestRender: render, extraRows: () => ['child rail'],
  });
  expect(footer.render(80).join('\n')).toContain('Projected footer');
  expect(footer.render(80).at(-1)).toBe('child rail');
  expect(footer.render(8).every(row => visibleWidth(row) <= 8)).toBe(true);
  live = false; for (const listener of listeners) listener();
  expect(footer.render(80).join('\n')).toContain('Projected footer');
  live = true; for (const listener of listeners) listener();
  expect(footer.render(80).join('\n')).toContain('Projected footer');
  presentation = []; for (const listener of listeners) listener();
  expect(footer.render(80)).toEqual(['']);
  footer.dispose(); expect(listeners.size).toBe(0);
});

it('rejects malformed or ambiguous decorations without changing generic view data', async () => {
  const source = view();
  expect(() => powerlineViewData([source, { ...source, id: 'duplicate' }])).toThrow();
  const bad = { ...source, items: source.items.map(item => item.id === 'directory'
    ? { ...item, values: { ...item.values, color: 'untrusted-color' } } : item) };
  expect(() => powerlineViewData([bad])).toThrow();
  const report = vi.fn();
  const client = { getAttachment: () => ({ state: { status: 'live', snapshot: { ...snapshot(), presentation: [bad] } } }),
    subscribe: () => () => {} } as unknown as SessionClient;
  const footer = createClientPowerlineFooter(client, 'session', { theme: () => ({ getFgAnsi: () => '', getBgAnsi: () => '' }), requestRender() {}, onError: report });
  expect(footer.render(80)).toEqual(['']); expect(footer.render(80)).toEqual(['']);
  await Promise.resolve(); expect(report).toHaveBeenCalledOnce(); footer.dispose();
  expect(presentationText(bad)).toContain('untrusted\\-color');
});

it('renders hinted Powerline statuses only in their renderer and keeps unmatched hints in the generic fallback', () => {
  const segment: Presentation = { id: 'ui:binding:status:opaque', kind: 'status', key: 'powerline.directory',
    value: { kind: 'text', text: 'Project' }, fallback: 'Project', hint: { id: 'felan.powerline', version: '3.0.0' } };
  const unknown = { ...segment, id: 'unknown', hint: { id: 'unknown.renderer', version: '1.0.0' } };
  const plain = { id: 'plain', kind: 'status', key: 'build', value: { kind: 'text', text: 'Ready' }, fallback: 'Ready' } as const;
  const memory = { id: 'ui:memory-binding:status:opaque', kind: 'status', key: 'memory',
    value: { kind: 'text', text: 'Memory: 1 pending' }, fallback: 'Memory: 1 pending' } as const;
  const fallback = fallbackPresentations([segment, view(), unknown, plain, memory], isPowerlinePresentation);
  expect(fallback).toEqual([unknown, plain, memory]);
  expect(fallback.filter(item => item.kind === 'status').map(statusText)).toEqual(['Project', 'Ready', 'Memory: 1 pending']);
  expect(fallbackPresentations([segment])).toEqual([segment]);
});

it('lets clients render identical published values with different local styles and layouts', () => {
  const presentation = [view()];
  const client = { getAttachment: () => ({ state: { status: 'live', snapshot: { ...snapshot(), presentation } } }), subscribe: () => () => {} } as unknown as SessionClient;
  const footer = (style: 'minimal' | 'capsule', enabled = true) => createClientPowerlineFooter(client, 'session', {
    theme: () => ({ getFgAnsi: () => '', getBgAnsi: () => '' }), requestRender() {},
    preferences: () => ({ style, charset: 'text', autoWrap: true, padding: 0, lines: [{ segments: { directory: { enabled, style: 'full' } } }] }),
  });
  const first = footer('minimal'); const second = footer('capsule'); const hidden = footer('minimal', false);
  expect(first.render(80).map(stripTerminalSequences)).toEqual(['Projected footer']);
  expect(second.render(80).map(stripTerminalSequences)).toEqual(['[Projected footer]']);
  expect(hidden.render(80)).toEqual(['']);
  expect(presentation[0]).toEqual(view());
  first.dispose(); second.dispose(); hidden.dispose();
});

it('keeps the released default footer lines and shows the status line only when populated', () => {
  const data = view();
  data.items.push({ id: 'model', values: { segment: 'model', data: JSON.stringify({ id: 'test-model', provider: 'test', reasoning: false, providerCount: 1 }), color: 'model' }, fallback: 'Model' },
    { id: 'version', values: { segment: 'version', data: JSON.stringify({ version: '0.30.0' }), color: 'version' }, fallback: 'Version' });
  const presentation: Presentation[] = [data];
  const client = { getAttachment: () => ({ state: { status: 'live', snapshot: { ...snapshot(), presentation } } }), subscribe: () => () => {} } as unknown as SessionClient;
  const footer = createClientPowerlineFooter(client, 'session', { theme: () => ({ getFgAnsi: () => '', getBgAnsi: () => '' }), requestRender() {} });
  try {
    const rows = footer.render(80).map(stripTerminalSequences);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.trim()).toBe('Projected footer');
    expect(rows[1]?.trim()).toBe('test-model');
    expect(rows.join('')).not.toContain('Felan');
    presentation.push({ id: 'status', kind: 'status', key: 'build', value: { kind: 'text', text: 'Ready' }, fallback: 'Ready' });
    expect(footer.render(80).map(stripTerminalSequences)).toHaveLength(3);
    expect(footer.render(80).map(stripTerminalSequences).at(-1)?.trim()).toBe('Ready');
  } finally { footer.dispose(); }
});
