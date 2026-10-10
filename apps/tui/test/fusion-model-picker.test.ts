import type { ExtensionCommandContext } from '@felan-ai/agent-core';
import { KeybindingsManager, TUI_KEYBINDINGS, setKeybindings, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { FusionModelPicker } from '../src/fusion/model-picker.js';

beforeAll(() => {
  setKeybindings(new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    'app.models.save': { defaultKeys: 'ctrl+s', description: 'Save model selection' },
  }));
});

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as ExtensionCommandContext['ui']['theme'];

const models = [
  { reference: 'openrouter/anthropic/claude-sonnet-4', label: 'Claude Sonnet (openrouter/anthropic/claude-sonnet-4)' },
  { reference: 'openai/gpt-5', label: 'GPT 5 (openai/gpt-5)' },
  { reference: 'google/gemini-2.5-pro', label: 'Gemini Pro (google/gemini-2.5-pro)' },
];

function setup(participants: readonly string[] = []) {
  const done = vi.fn();
  const picker = new FusionModelPicker({ models, participants, fusionModel: 'inherit' }, theme, done);
  const search = (query: string) => {
    picker.handleInput('\u0015');
    for (const character of query) picker.handleInput(character);
  };
  return { picker, done, search };
}

describe('Fusion model picker', () => {
  it('aligns every divider at the same terminal column across varying row lengths', () => {
    const { picker, search } = setup();
    for (const width of [84, 100, 160]) {
      for (const query of ['', 'gpt', 'no-matching-model']) {
        search(query);
        const rows = picker.render(width).map(stripTerminalSequences);
        const columns = rows.map((line) => visibleWidth(line.slice(0, line.indexOf('│'))));
        expect(new Set(columns).size).toBe(1);
        expect(rows.every((line) => line.includes('│') && visibleWidth(line) === width)).toBe(true);
      }
    }
  });
  it('searches nested references and keeps selected participants visible across searches', () => {
    const { picker, search, done } = setup();
    search('openrouter anthropic sonnet');
    picker.handleInput('\r');
    search('openai gpt');
    expect(picker.render(180).join('\n')).toContain('Selected participants (1/8)');
    expect(picker.render(180).join('\n')).toContain('claude-sonnet-4');
    picker.handleInput('\r');
    picker.handleInput('\u0013');
    expect(done).toHaveBeenCalledWith({
      participants: ['openrouter/anthropic/claude-sonnet-4', 'openai/gpt-5'],
      fusionModel: 'inherit',
    });
  });

  it('lets users remove a selected participant and choose a fusion model without losing the lineup', () => {
    const { picker, search, done } = setup(models.map(({ reference }) => reference));
    search('gemini');
    picker.handleInput('\r');
    picker.handleInput('\t');
    search('gemini');
    picker.handleInput('\r');
    picker.handleInput('\u0013');
    expect(done).toHaveBeenCalledWith({
      participants: ['openrouter/anthropic/claude-sonnet-4', 'openai/gpt-5'],
      fusionModel: 'google/gemini-2.5-pro',
    });
  });

  it('does not commit an incomplete lineup and cancels without returning draft changes', () => {
    const { picker, done, search } = setup();
    search('gpt');
    picker.handleInput('\r');
    picker.handleInput('\u0013');
    expect(done).not.toHaveBeenCalled();
    picker.handleInput('\u001b');
    expect(done).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('enforces the eight-participant limit and supports clearing a full lineup', () => {
    const catalog = Array.from({ length: 10 }, (_, index) => ({
      reference: `provider/model-${index}`,
      label: `Model ${index} (provider/model-${index})`,
    }));
    const done = vi.fn();
    const picker = new FusionModelPicker({ models: catalog, participants: catalog.slice(0, 8).map(({ reference }) => reference), fusionModel: 'inherit' }, theme, done);
    expect(picker.render(140).join('\n')).toContain('Selected participants (8/8)');
    picker.searchInput.setValue('model-8');
    picker.handleInput('x');
    picker.handleInput('\u007f');
    picker.handleInput('\r');
    picker.handleInput('\u0013');
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ participants: expect.arrayContaining(catalog.slice(0, 8).map(({ reference }) => reference)) }));
  });

  it('shows unavailable saved choices so they can be removed, and stacks the selection summary narrowly', () => {
    const { picker, done, search } = setup(['missing/provider-model', 'openai/gpt-5', 'google/gemini-2.5-pro']);
    const lines = picker.render(44);
    expect(lines.join('\n')).toContain('Selected participants');
    expect(lines.join('\n')).toContain('Unavailable: missing/provider-model');
    expect(lines.every((line) => visibleWidth(line) <= 44)).toBe(true);
    search('missing');
    picker.handleInput('\r');
    picker.handleInput('\u0013');
    expect(done).toHaveBeenCalledWith({ participants: ['openai/gpt-5', 'google/gemini-2.5-pro'], fusionModel: 'inherit' });
  });

  it('renders large catalogs with bounded rows and safely truncates terminal control sequences', () => {
    const catalog = Array.from({ length: 500 }, (_, index) => ({
      reference: `provider/model-${String(index).padStart(3, '0')}`,
      label: `Model ${index} \u001b[31m${'long label '.repeat(12)}\u001b[0m`,
    }));
    const picker = new FusionModelPicker({ models: catalog, participants: [], fusionModel: 'inherit' }, theme, vi.fn());
    picker.searchInput.setValue('model-420');
    picker.handleInput('x');
    picker.handleInput('\u007f');
    const rendered = picker.render(72);
    expect(rendered.join('\n')).toContain('model-420');
    expect(rendered.join('\n')).not.toContain('\u001b[31m');
    expect(rendered.join('\n')).not.toContain('label \u001b');
    expect(rendered.every((line) => visibleWidth(line) <= 72)).toBe(true);
    picker.focused = true;
    expect(picker.searchInput.focused).toBe(true);
    picker.focused = false;
    expect(picker.searchInput.focused).toBe(false);
  });

  it('keeps empty and no-result states explicit and cannot save an incomplete selection', () => {
    const { picker, done, search } = setup();
    expect(picker.render(100).join('\n')).toContain('Select at least 2 participants');
    search('nothing-matches-this');
    expect(picker.render(100).join('\n')).toContain('No matching models');
    picker.handleInput('\u0013');
    expect(done).not.toHaveBeenCalled();
    picker.handleInput('\u001b');
    expect(done).toHaveBeenCalledOnce();
  });

  it('keeps the selected row visible while scrolling a large catalog', () => {
    const catalog = Array.from({ length: 300 }, (_, index) => ({
      reference: `provider/model-${String(index).padStart(3, '0')}`,
      label: `Model ${String(index).padStart(3, '0')}`,
    }));
    const picker = new FusionModelPicker({ models: catalog, participants: [], fusionModel: 'inherit' }, theme, vi.fn());
    for (let index = 0; index < 20; index++) picker.handleInput('\u001b[B');
    const rendered = picker.render(100).join('\n');
    expect(rendered).toContain('Model 019');
    expect(rendered).not.toContain('Model 000');
  });
});
