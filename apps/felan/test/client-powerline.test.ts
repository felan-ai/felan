import { expect, it, vi } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { Presentation, UiView } from '@felan-ai/session-protocol';
import type { SessionClient } from '../src/client/client.js';
import { createClientPowerlineFooter, powerlineViewData } from '../src/client/powerline-presenter.js';
import { fallbackPresentations } from '../src/tui/screen.js';
import { isPowerlinePresentation } from '../src/client/powerline-presenter.js';
import { presentationText, statusText } from '../src/client/ui.js';
import { snapshot } from './client-fixtures.js';

function view(): UiView {
  return { id: 'opaque-binding-view', kind: 'view', revision: 1, title: 'Powerline', hint: { id: 'felan.powerline', version: '2.0.0' },
    fields: [{ id: 'line', label: 'Line', valueKind: 'number' }, { id: 'segment', label: 'Segment', valueKind: 'text' },
      { id: 'text', label: 'Value', valueKind: 'text' }, { id: 'alignment', label: 'Alignment', valueKind: 'text' }, { id: 'color', label: 'Color role', valueKind: 'text' }],
    items: [
      ...Object.entries({ style: 'minimal', charset: 'text', autoWrap: 'true', padding: '0', lines: '1' }).map(([key, text]) => ({
        id: `display-${key}`, values: { line: 0, segment: `display.${key}`, text, alignment: '', color: '' }, fallback: key,
      })),
      { id: 'line-0-segment-0', values: { line: 1, segment: 'directory', text: 'Projected footer', alignment: 'left', color: 'directory' }, fallback: 'Directory' },
    ], actions: [], fallback: 'Powerline data' };
}

it('derives optional footer styling only from visible generic rows, including multiple pages', () => {
  const source = view();
  const first = { ...source, items: source.items.slice(0, 3) };
  const second = { ...source, id: 'another-opaque-id', items: source.items.slice(3) };
  expect(powerlineViewData([second, first])).toEqual({ style: 'minimal', charset: 'text', autoWrap: true, padding: 0,
    lines: [[{ name: 'directory', colorKey: 'directory', align: 'left', text: 'Projected footer' }]] });
  const { hint: _hint, ...plain } = source;
  expect(powerlineViewData([plain])).toBeUndefined();
  expect(presentationText(plain)).toContain('Projected footer');
  expect(powerlineViewData([{ ...source, hint: { id: 'felan.powerline', version: '1.0.0' } }])).toBeUndefined();
});

it('updates and clears a client-only footer across recovery, removal and disposal', () => {
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
  expect(footer.render(80)).toEqual(['']);
  live = true; for (const listener of listeners) listener();
  expect(footer.render(80).join('\n')).toContain('Projected footer');
  presentation = []; for (const listener of listeners) listener();
  expect(footer.render(80)).toEqual(['']);
  footer.dispose(); expect(listeners.size).toBe(0);
});

it('rejects malformed or ambiguous decorations without changing generic view data', async () => {
  const source = view();
  expect(() => powerlineViewData([source, { ...source, id: 'duplicate' }])).toThrow('Ambiguous');
  const bad = { ...source, items: source.items.map(item => item.id === 'line-0-segment-0'
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
    value: { kind: 'text', text: 'Project' }, fallback: 'Project', hint: { id: 'felan.powerline', version: '2.0.0' } };
  const unknown = { ...segment, id: 'unknown', hint: { id: 'unknown.renderer', version: '1.0.0' } };
  const plain = { id: 'plain', kind: 'status', key: 'build', value: { kind: 'text', text: 'Ready' }, fallback: 'Ready' } as const;
  const memory = { id: 'ui:memory-binding:status:opaque', kind: 'status', key: 'memory',
    value: { kind: 'text', text: 'Memory: 1 pending' }, fallback: 'Memory: 1 pending' } as const;
  const fallback = fallbackPresentations([segment, view(), unknown, plain, memory], isPowerlinePresentation);
  expect(fallback).toEqual([unknown, plain, memory]);
  expect(fallback.filter(item => item.kind === 'status').map(statusText)).toEqual(['Project', 'Ready', 'Memory: 1 pending']);
  expect(fallbackPresentations([segment])).toEqual([segment]);
});
