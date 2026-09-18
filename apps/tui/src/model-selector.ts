import {
  keyHint,
  type InteractiveMode,
} from '@earendil-works/pi-coding-agent';

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

interface HintTextChild {
  readonly text?: unknown;
  setText(text: string): void;
  render?(width: number): unknown;
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
        try {
          applyFelanModelSelectorBehavior(result.component);
        } catch {
          // Keep Pi's selector usable when chrome patching fails.
        }
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
  if (typeof component !== 'object' || component === null) return;
  if (patchedSelectors.has(component)) return;

  const selector = component as ModelSelectorCallbacks;
  const sessionSelect = selector.onSelectCallback;
  const persistSelect = selector.onSelectAsDefaultCallback;
  if (typeof sessionSelect !== 'function' || typeof persistSelect !== 'function') {
    return;
  }

  selector.onSelectCallback = persistSelect;
  selector.onSelectAsDefaultCallback = sessionSelect;
  patchedSelectors.add(component);
  rewriteModelSelectorHint(component);
}

function rewriteModelSelectorHint(selector: object): void {
  const hint = `  ${keyHint('tui.select.confirm', 'set as default')} · ${keyHint('app.models.save', 'this session')} · ${keyHint('tui.select.cancel', 'cancel')}`;
  const children = (selector as { children?: unknown }).children;
  if (!Array.isArray(children)) return;
  for (const child of children) {
    if (!isHintTextChild(child) || !hintSource(child).includes('set as default')) continue;
    child.setText(hint);
    return;
  }
}

function isHintTextChild(component: unknown): component is HintTextChild {
  return typeof component === 'object'
    && component !== null
    && typeof (component as HintTextChild).setText === 'function';
}

function hintSource(component: HintTextChild): string {
  const parts: string[] = [];
  if (typeof component.text === 'string') parts.push(component.text);
  if (typeof component.render === 'function') {
    const lines = component.render(160);
    if (Array.isArray(lines)) {
      for (const line of lines) {
        if (typeof line === 'string') parts.push(line);
      }
    }
  }
  return parts.join('\n');
}
