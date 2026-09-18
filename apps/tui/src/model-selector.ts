import {
  keyHint,
  ModelSelectorComponent,
  type InteractiveMode,
} from '@earendil-works/pi-coding-agent';
import { Text, type Component } from '@earendil-works/pi-tui';

export const MODEL_SELECTOR_COMPAT_ERROR =
  'The installed Pi version does not expose a compatible model selector';

type ModelSelectCallback = (model: unknown) => void;

interface InteractiveModeModelSelectorInternals {
  showModelSelector(initialSearchInput?: string): void;
  showSelector(create: (done: () => void) => SelectorResult): void;
}

interface SelectorResult {
  readonly component: unknown;
  readonly focus?: unknown;
  readonly dispose?: () => void;
}

interface ModelSelectorCallbacks {
  onSelectCallback: ModelSelectCallback;
  onSelectAsDefaultCallback?: ModelSelectCallback;
}

const installedModes = new WeakSet<object>();
const patchedSelectors = new WeakSet<object>();

export function installFelanModelSelectorBehavior(mode: InteractiveMode): void {
  if (installedModes.has(mode)) return;
  const internals = mode as unknown as InteractiveModeModelSelectorInternals;
  if (
    typeof internals.showModelSelector !== 'function'
    || typeof internals.showSelector !== 'function'
  ) {
    throw new Error(MODEL_SELECTOR_COMPAT_ERROR);
  }
  installedModes.add(mode);

  const showModelSelector = internals.showModelSelector.bind(mode);
  internals.showModelSelector = (initialSearchInput?: string) => {
    const showSelector = internals.showSelector.bind(mode);
    // Pi constructs the selector inside this one showSelector call.
    internals.showSelector = (create) => {
      internals.showSelector = showSelector;
      return showSelector((done) => {
        const result = create(done);
        applyFelanModelSelectorBehavior(result.component);
        return result;
      });
    };
    try {
      showModelSelector(initialSearchInput);
    } finally {
      internals.showSelector = showSelector;
    }
  };
}

export function applyFelanModelSelectorBehavior(component: unknown): void {
  if (typeof component === 'object' && component !== null && patchedSelectors.has(component)) {
    return;
  }
  if (!(component instanceof ModelSelectorComponent)) {
    throw new Error(MODEL_SELECTOR_COMPAT_ERROR);
  }

  const selector = component as unknown as ModelSelectorCallbacks;
  const sessionSelect = selector.onSelectCallback;
  const persistSelect = selector.onSelectAsDefaultCallback;
  if (typeof sessionSelect !== 'function' || typeof persistSelect !== 'function') {
    throw new Error(MODEL_SELECTOR_COMPAT_ERROR);
  }

  selector.onSelectCallback = persistSelect;
  selector.onSelectAsDefaultCallback = sessionSelect;
  rewriteModelSelectorHint(component);
  patchedSelectors.add(component);
}

function rewriteModelSelectorHint(selector: ModelSelectorComponent): void {
  const hint = `  ${keyHint('tui.select.confirm', 'set as default')} · ${keyHint('app.models.save', 'this session')} · ${keyHint('tui.select.cancel', 'cancel')}`;
  for (const child of selector.children) {
    if (!isTextComponent(child)) continue;
    if (!child.render(160).some((line) => line.includes('to set as default'))) continue;
    child.setText(hint);
    return;
  }
  throw new Error(MODEL_SELECTOR_COMPAT_ERROR);
}

function isTextComponent(component: Component): component is Text {
  return component instanceof Text;
}
