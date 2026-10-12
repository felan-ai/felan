import {
  initTheme,
  ModelSelectorComponent,
  type InteractiveMode,
} from '@earendil-works/pi-coding-agent';
import {
  KeybindingsManager as TuiKeybindingsManager,
  TUI_KEYBINDINGS,
  setKeybindings,
  stripTerminalSequences,
  type TUI,
} from '@earendil-works/pi-tui';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  applyFelanModelSelectorBehavior,
  installFelanModelSelectorBehavior,
  MODEL_SELECTOR_COMPAT_ERROR,
} from '../src/model-selector.js';

const model = {
  id: 'test-model',
  name: 'Test Model',
  provider: 'openai',
};

const selectors: ModelSelectorComponent[] = [];

beforeAll(() => {
  initTheme('dark', false);
  setKeybindings(new TuiKeybindingsManager({
    ...TUI_KEYBINDINGS,
    'app.models.save': { defaultKeys: 'ctrl+s', description: 'Save model' },
  }));
});

afterEach(() => {
  while (selectors.length > 0) {
    selectors.pop()?.dispose();
  }
});

describe('Felan model selector behavior', () => {
  it('throws when Pi does not expose the model selector internals', () => {
    expect(() => installFelanModelSelectorBehavior({} as InteractiveMode)).toThrow(
      MODEL_SELECTOR_COMPAT_ERROR,
    );
  });

  it('makes Enter persist the default and Ctrl+S stay session-only', () => {
    const persist = vi.fn();
    const sessionOnly = vi.fn();
    const selector = createSelector(sessionOnly, persist);
    applyFelanModelSelectorBehavior(selector);

    selector.handleInput('\r');
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith(model);
    expect(sessionOnly).not.toHaveBeenCalled();
  });

  it('uses search submit to persist the default', () => {
    const persist = vi.fn();
    const sessionOnly = vi.fn();
    const selector = createSelector(sessionOnly, persist);
    applyFelanModelSelectorBehavior(selector);

    selector.getSearchInput().onSubmit?.('');
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith(model);
    expect(sessionOnly).not.toHaveBeenCalled();
  });

  it('keeps Ctrl+S as a session-only selection', () => {
    const persist = vi.fn();
    const sessionOnly = vi.fn();
    const selector = createSelector(sessionOnly, persist);
    applyFelanModelSelectorBehavior(selector);

    selector.handleInput('\x13');
    expect(sessionOnly).toHaveBeenCalledOnce();
    expect(sessionOnly).toHaveBeenCalledWith(model);
    expect(persist).not.toHaveBeenCalled();
  });

  it('rewrites the selector hint for default vs session shortcuts', () => {
    const selector = createSelector(vi.fn(), vi.fn());
    applyFelanModelSelectorBehavior(selector);

    const hint = selector.children
      .flatMap((child) => child.render(160))
      .map((line) => stripTerminalSequences(line))
      .find((line) => line.includes('set as default'));
    expect(hint).toContain('set as default');
    expect(hint).toContain('this session');
    expect(hint).not.toContain('to set as default');
  });

  it('does not throw when the component is not a model selector', () => {
    expect(() => applyFelanModelSelectorBehavior({})).not.toThrow();
    expect(() => applyFelanModelSelectorBehavior(null)).not.toThrow();
  });

  it('swaps callbacks when the hint child is missing', () => {
    const persist = vi.fn();
    const sessionOnly = vi.fn();
    const selector = {
      onSelectCallback: sessionOnly,
      onSelectAsDefaultCallback: persist,
      children: [],
    };

    expect(() => applyFelanModelSelectorBehavior(selector)).not.toThrow();
    selector.onSelectCallback(model);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith(model);
    expect(sessionOnly).not.toHaveBeenCalled();
  });

  it('rewrites a duck-typed hint child that is not a pi-tui Text', () => {
    const hint = {
      text: '  Enter to select · Ctrl+S to set as default · Esc to cancel',
      setText(text: string) {
        this.text = text;
      },
    };
    applyFelanModelSelectorBehavior({
      onSelectCallback: vi.fn(),
      onSelectAsDefaultCallback: vi.fn(),
      children: [hint],
    });

    expect(hint.text).toContain('set as default');
    expect(hint.text).toContain('this session');
    expect(hint.text).not.toContain('to set as default');
  });

  it('patches a selector constructed with scoped models', () => {
    const persist = vi.fn();
    const sessionOnly = vi.fn();
    const selector = createSelector(sessionOnly, persist, [
      { model: { ...model, id: 'scoped-a' } },
      { model: { ...model, id: 'scoped-b' } },
      { model: { ...model, id: 'scoped-c' } },
    ]);
    applyFelanModelSelectorBehavior(selector);

    selector.handleInput('\r');
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith(model);
    expect(sessionOnly).not.toHaveBeenCalled();
  });

  it('does not throw when showModelSelector creates a non-selector component', () => {
    const showSelector = vi.fn((create: (done: () => void) => { component: unknown }) => (
      create(() => {})
    ));
    const mode = {
      showSelector,
      showModelSelector() {
        this.showSelector(() => ({ component: {} }));
      },
    } as unknown as InteractiveMode & {
      showSelector: typeof showSelector;
      showModelSelector(): void;
    };

    installFelanModelSelectorBehavior(mode as InteractiveMode);
    expect(() => mode.showModelSelector()).not.toThrow();
  });

  it('patches the selector created through InteractiveMode.showModelSelector', () => {
    const persist = vi.fn();
    const sessionOnly = vi.fn();
    const selector = createSelector(sessionOnly, persist);
    const showSelector = vi.fn((create: (done: () => void) => { component: unknown }) => (
      create(() => {})
    ));
    const mode = {
      showSelector,
      showModelSelector() {
        this.showSelector(() => ({ component: selector }));
      },
    } as unknown as InteractiveMode & {
      showSelector: typeof showSelector;
      showModelSelector(): void;
    };

    installFelanModelSelectorBehavior(mode as InteractiveMode);
    mode.showModelSelector();

    selector.handleInput('\r');
    expect(persist).toHaveBeenCalledOnce();
    expect(sessionOnly).not.toHaveBeenCalled();

    const laterSession = vi.fn();
    const laterPersist = vi.fn();
    const later = createSelector(laterSession, laterPersist);
    mode.showSelector(() => ({ component: later }));
    later.handleInput('\r');
    expect(laterSession).toHaveBeenCalledOnce();
    expect(laterPersist).not.toHaveBeenCalled();
  });
});

function createSelector(
  onSelect: (model: unknown) => void,
  onSelectAsDefault: (model: unknown) => void,
  scopedModels: ReadonlyArray<{ model: typeof model }> = [],
): ModelSelectorComponent {
  const selector = new ModelSelectorComponent(
    { requestRender() {} } as TUI,
    model as never,
    {
      getAvailableSnapshot: () => [model],
      getModel: () => model,
      getError: () => undefined,
      refresh: async () => ({ errors: new Map(), aborted: false }),
    } as never,
    scopedModels as never,
    onSelect,
    () => {},
    undefined,
    onSelectAsDefault,
  );
  selectors.push(selector);
  return selector;
}
