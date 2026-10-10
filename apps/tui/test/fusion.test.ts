import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initTheme } from '@earendil-works/pi-coding-agent';
import type { ExtensionCommandContext } from '@felan-ai/agent-core';
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import type { FusionReview, FusionReviewActions } from '@felan-ai/ext-fusion';
import { createLocalFusionHost } from '../src/fusion/host.js';

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as ExtensionCommandContext['ui']['theme'];

beforeAll(() => initTheme('dark', false));

describe('local Fusion host', () => {
  it('opens comparison first, uses Prewalk action colors, and closes immediately on Fuse while awaiting its result', async () => {
    let component!: ReviewComponent;
    const closed = vi.fn();
    const colors = vi.spyOn(theme, 'fg');
    const context = fakeContext({ custom: (factory: ReviewFactory) => new Promise<void>((resolve) => {
      component = factory({ requestRender: vi.fn() }, theme, {}, () => { closed(); resolve(); });
    }) });
    let finish!: () => void;
    const actions: FusionReviewActions = {
      fuse: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })),
      retryParticipants: vi.fn(), retryComparison: vi.fn(), retryFusion: vi.fn(), cancel: vi.fn(),
    };
    const review: FusionReview = {
      prompt: 'Compare', participants: ['one/model', 'two/model'], fusionModel: 'one/model',
      answers: [{ model: 'one/model', text: 'Source answer', durationMs: 1 }],
      comparison: { model: 'one/model', text: 'Comparison first', durationMs: 1 }, updatedAt: 1,
    };
    const settled = vi.fn();
    const reviewing = createLocalFusionHost('/tmp/unused-fusion-test').review(context, () => review, actions).then(settled);
    expect(component.render(100).join('\n')).toContain('Comparison first');
    expect(component.render(100).join('\n')).not.toContain('Source answer');
    expect(colors).toHaveBeenCalledWith('accent', '→ 1. Fuse');
    expect(colors).toHaveBeenCalledWith('text', '  2. Fuse with options');
    component.handleInput('\r');
    expect(closed).toHaveBeenCalledOnce();
    expect(actions.fuse).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    finish();
    await reviewing;
    expect(settled).toHaveBeenCalledOnce();
    colors.mockRestore();
  });
  it('shows current models, billing and run/change/cancel choices before requests', async () => {
    const select = vi.fn().mockResolvedValueOnce('Change models').mockResolvedValueOnce('Run with these models').mockResolvedValueOnce(undefined);
    const context = fakeContext({ select });
    const host = createLocalFusionHost('/tmp/unused-fusion-test');
    expect(await host.selectRunAction!(context, ['one/model', 'two/model'], 'two/model')).toBe('change');
    expect(select).toHaveBeenCalledWith(expect.stringContaining('one/model'), ['Run with these models', 'Change models', 'Cancel']);
    expect(select.mock.calls[0]?.[0]).toContain('Comparison / fusion: two/model');
    expect(select.mock.calls[0]?.[0]).toContain('Provider billing may apply');
    expect(await host.selectRunAction!(context, ['one/model', 'two/model'], 'two/model')).toBe('run');
    expect(await host.selectRunAction!(context, ['one/model', 'two/model'], 'two/model')).toBe('cancel');
  });
  it('renders Markdown sections, bullets and code with paged scrolling and fixed controls', async () => {
    let component!: ReviewComponent;
    const context = fakeContext({ custom: (factory: ReviewFactory) => new Promise<void>((resolve) => {
      component = factory({ requestRender: vi.fn() }, theme, {}, resolve);
    }) });
    const review: FusionReview = {
      prompt: 'Readable review', participants: ['one/model', 'two/model'], fusionModel: 'one/model',
      answers: [{ model: 'one/model', durationMs: 1, text: '## Agreements\n\n- **Shared finding**\n- Second finding\n\n```ts\nconst answer = 42;\n```\n\n' + Array.from({ length: 40 }, (_, i) => `- Detail ${i}`).join('\n') }],
      updatedAt: 1,
    };
    const actions = { fuse: vi.fn(), retryParticipants: vi.fn(), retryComparison: vi.fn(), retryFusion: vi.fn(), cancel: vi.fn() };
    const reviewing = createLocalFusionHost('/tmp/unused-fusion-test').review(context, () => review, actions);
    const render = () => component.render(100).map(stripTerminalSequences).join('\n');
    expect(render()).toContain('Agreements');
    expect(component.render(100)).toHaveLength(30);
    component.handleInput('\u001b[<65;10;10M');
    expect(render()).not.toContain('Shared finding');
    component.handleInput('\u001b[H');
    component.handleMouse({ type: 'wheel', wheelDelta: 3 });
    expect(render()).not.toContain('Shared finding');
    component.handleInput('\u001b[H');
    expect(render()).not.toContain('## Agreements');
    expect(render()).not.toContain('**Shared finding**');
    expect(render()).toContain('const answer = 42;');
    component.handleInput('\u001b[6~');
    expect(render()).not.toContain('Shared finding');
    expect(render()).toContain('Cancel / close');
    component.handleInput('\u001b[F');
    expect(render()).toContain('Detail 39');
    component.handleInput('\u001b[H');
    expect(render()).toContain('Shared finding');
    component.handleInput('q');
    await reviewing;
  });
  it('selects distinct session models, confirms the request count, and persists defaults', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'felan-fusion-'));
    try {
      await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
        builtinExtensions: { fusion: true },
        extensionConfig: { other: { enabled: true }, fusion: { concurrency: 2 } },
      }));
      const context = fakeContext({
        custom: vi.fn(async (factory: (tui: { requestRender(): void }, theme: typeof theme, keys: unknown, done: (result: unknown) => void) => { handleInput(data: string): void }) => new Promise((resolve) => {
          const picker = factory({ requestRender: vi.fn() }, theme, {}, resolve);
          for (const character of 'vendor/model') picker.handleInput(character);
          picker.handleInput('\r');
          picker.handleInput('\u0015');
          for (const character of 'openai model') picker.handleInput(character);
          picker.handleInput('\r');
          picker.handleInput('\t');
          picker.handleInput('\u0015');
          for (const character of 'vendor/model') picker.handleInput(character);
          picker.handleInput('\r');
          picker.handleInput('\u0013');
        })),
        confirm: vi.fn(async () => true),
      });
      const models = [
        { reference: 'openrouter/vendor/model', label: 'First (openrouter/vendor/model)' },
        { reference: 'openai/model', label: 'Second (openai/model)' },
      ];
      const host = createLocalFusionHost(agentDir);
      const configured = await host.configure(context, models, [], 'inherit');
      expect(context.ui.custom).toHaveBeenCalledOnce();
      expect(vi.mocked(context.ui.custom).mock.calls[0]).toHaveLength(1);
      expect(configured).toEqual({ participants: ['openrouter/vendor/model', 'openai/model'], fusionModel: 'openrouter/vendor/model' });
      expect(context.ui.confirm).not.toHaveBeenCalled();
      const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')) as Record<string, any>;
      expect(settings.extensionConfig.fusion).toEqual({
        concurrency: 2,
        participants: ['openrouter/vendor/model', 'openai/model'],
        fusionModel: 'openrouter/vendor/model',
      });
      expect(settings.extensionConfig.other).toEqual({ enabled: true });
      expect(settings.builtinExtensions).toEqual({ fusion: true });
      const accepted = await host.confirm(context, 2);
      expect(accepted).toBe(true);
      expect(context.ui.confirm).toHaveBeenCalledWith('Run model comparison?', expect.stringContaining('2 participant models'));
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it('keeps review and synthesis options in one fullscreen view', async () => {
    const host = createLocalFusionHost('/tmp/unused-fusion-test');
    const review: FusionReview = {
      prompt: 'Compare these approaches',
      participants: ['one/model', 'two/model'], fusionModel: 'one/model',
      answers: [
        { model: 'one/model', text: 'First independent answer', durationMs: 10 },
        { model: 'two/model', text: 'Second independent answer', durationMs: 12 },
      ],
      comparison: { model: 'one/model', text: 'Agreement and disagreement report', durationMs: 14 },
      updatedAt: 1,
    };
    const actions: FusionReviewActions = {
      fuse: vi.fn(async () => {}),
      retryParticipants: vi.fn(async () => {}),
      retryComparison: vi.fn(async () => {}),
      retryFusion: vi.fn(async () => {}),
      cancel: vi.fn(),
    };
    let component!: ReviewComponent;
    const context = fakeContext({
      input: vi.fn(),
      custom: vi.fn((factory: ReviewFactory) => new Promise<void>((resolve) => {
        component = factory({ requestRender: vi.fn() }, theme, {}, resolve);
        component.focused = true;
      })),
    });
    (context as unknown as { modelRegistry: { getAvailable: () => unknown[]; hasConfiguredAuth: () => boolean } }).modelRegistry = {
      getAvailable: () => [{ provider: 'two', id: 'model', name: 'Two model' }],
      hasConfiguredAuth: () => true,
    };
    const reviewing = host.review(context, () => review, actions);
    expect(vi.mocked(context.ui.custom).mock.calls[0]?.[1]).toMatchObject({ overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', margin: 0 } });
    const narrowLines = component.render(32);
    expect(narrowLines.join('\n')).toContain('Agreement and disagreement');
    expect(narrowLines.every((line) => visibleWidth(line) <= 32)).toBe(true);
    component.handleInput('\u001b[C');
    expect(component.render(72).join('\n')).toContain('First independent answer');
    component.handleInput('\u001b[C');
    expect(component.render(72).join('\n')).toContain('Second independent answer');
    component.handleInput('\u001b[D');
    component.handleInput('\u001b[D');
    expect(component.render(100).map(stripTerminalSequences).join('\n')).toContain('1. Fuse');
    component.handleInput('F');
    expect(component.render(72).join('\n')).toContain('Fusion instruction (optional)');
    expect(component.render(72).join('\n')).toContain(CURSOR_MARKER);
    component.focused = false;
    expect(component.render(72).join('\n')).not.toContain(CURSOR_MARKER);
    component.focused = true;
    for (const character of 'prioritize the simplest approach') component.handleInput(character);
    component.handleInput('\r');
    expect(component.render(120).join('\n')).toContain('Fusion model selection');
    expect(component.render(120).join('\n')).toContain(CURSOR_MARKER);
    component.focused = false;
    expect(component.render(120).join('\n')).not.toContain(CURSOR_MARKER);
    component.focused = true;
    for (const character of 'two model') component.handleInput(character);
    component.handleInput('\r');
    component.handleInput('\u0013');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(actions.fuse).toHaveBeenCalledWith('prioritize the simplest approach', 'two/model');
    expect(context.ui.custom).toHaveBeenCalledOnce();
    expect(context.ui.input).not.toHaveBeenCalled();
    component.handleInput('q');
    await reviewing;
    expect(actions.cancel).not.toHaveBeenCalled();
  });

  it('returns to the same review page when either synthesis option step is canceled', async () => {
    let component!: ReviewComponent;
    const context = fakeContext({
      custom: vi.fn((factory: ReviewFactory) => new Promise<void>((resolve) => {
        component = factory({ requestRender: vi.fn() }, theme, {}, resolve);
        component.focused = true;
      })),
    });
    const review: FusionReview = {
      prompt: 'Compare', participants: ['one/model', 'two/model'], fusionModel: 'one/model',
      answers: [{ model: 'one/model', text: 'Original answer', durationMs: 1 }],
      comparison: { model: 'one/model', text: 'Original comparison', durationMs: 1 },
      updatedAt: 1,
    };
    const actions: FusionReviewActions = {
      fuse: vi.fn(), retryParticipants: vi.fn(), retryComparison: vi.fn(), retryFusion: vi.fn(), cancel: vi.fn(),
    };
    const reviewing = createLocalFusionHost('/tmp/unused-fusion-test').review(context, () => review, actions);
    component.handleInput('F');
    component.handleInput('\u001b');
    expect(component.render(80).join('\n')).toContain('Original comparison');
    component.handleInput('F');
    component.handleInput('\r');
    expect(component.render(120).join('\n')).toContain('Fusion model selection');
    component.handleInput('\u001b');
    expect(component.render(80).join('\n')).toContain('Original comparison');
    expect(context.ui.custom).toHaveBeenCalledOnce();
    expect(actions.fuse).not.toHaveBeenCalled();
    expect(actions.cancel).not.toHaveBeenCalled();
    component.handleInput('q');
    await reviewing;
  });
});

interface ReviewComponent {
  focused: boolean;
  render(width: number): string[];
  handleInput(data: string): void;
  handleMouse(event: { type: 'wheel'; wheelDelta: number }): unknown;
}

type ReviewFactory = (
  tui: { requestRender(): void },
  theme: typeof theme,
  keys: unknown,
  done: () => void,
) => ReviewComponent;

function fakeContext(ui: Record<string, unknown>): ExtensionCommandContext {
  return {
    mode: 'tui',
    hasUI: true,
    ui: { theme, ...ui },
    model: undefined,
    scopedModels: [],
    modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => true },
  } as unknown as ExtensionCommandContext;
}
