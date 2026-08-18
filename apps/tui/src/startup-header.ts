import {
  VERSION as PI_VERSION,
  type InteractiveMode,
} from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { FELAN_VERSION } from './version.js';

const PI_ONBOARDING = 'Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.';

interface ExpandableStartupHeader extends Component {
  getCollapsedText(): string;
  getExpandedText(): string;
  setExpanded(expanded: boolean): void;
}

interface InteractiveModeHeaderInternals {
  builtInHeader: Component | undefined;
}

export function installFelanStartupHeader(
  mode: InteractiveMode,
  options: { readonly expanded?: boolean } = {},
): void {
  // Pi 0.84.2 has no pre-render header hook. Intercepting this assignment keeps
  // its own expandable component and keybinding behavior without showing it first.
  const internals = mode as unknown as InteractiveModeHeaderInternals;
  const descriptor = Object.getOwnPropertyDescriptor(internals, 'builtInHeader');
  if (!descriptor || !('value' in descriptor) || !descriptor.configurable) {
    throw new Error('The installed Pi version does not expose a compatible startup header');
  }

  let header = descriptor.value as Component | undefined;
  Object.defineProperty(internals, 'builtInHeader', {
    configurable: true,
    enumerable: descriptor.enumerable ?? false,
    get: () => header,
    set: (next: Component | undefined) => {
      header = next;
      if (!isExpandableStartupHeader(next)) return;
      rewriteExpandableStartupHeader(next);
      next.setExpanded(options.expanded === true);
    },
  });

  if (isExpandableStartupHeader(header)) {
    rewriteExpandableStartupHeader(header);
    header.setExpanded(options.expanded === true);
  }
}

export function rewritePiStartupHeader(text: string): string {
  const lines = text.split('\n');
  if (lines[0]) {
    lines[0] = lines[0]
      .replace('pi', 'felan')
      .replace(`v${PI_VERSION}`, `v${FELAN_VERSION}`);
  }
  return lines
    .filter((line) => !line.includes(PI_ONBOARDING))
    .join('\n')
    .replace(/\n+$/u, '');
}

function isExpandableStartupHeader(component: Component | undefined): component is ExpandableStartupHeader {
  return component !== undefined
    && typeof Reflect.get(component, 'getCollapsedText') === 'function'
    && typeof Reflect.get(component, 'getExpandedText') === 'function'
    && typeof Reflect.get(component, 'setExpanded') === 'function';
}

function rewriteExpandableStartupHeader(header: ExpandableStartupHeader): void {
  const getCollapsedText = header.getCollapsedText.bind(header);
  const getExpandedText = header.getExpandedText.bind(header);
  header.getCollapsedText = () => rewritePiStartupHeader(getCollapsedText());
  header.getExpandedText = () => rewritePiStartupHeader(getExpandedText());
}
