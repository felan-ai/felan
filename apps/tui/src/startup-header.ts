import {
  VERSION as PI_VERSION,
  type InteractiveMode,
} from '@earendil-works/pi-coding-agent';
import { isMemoryContextEntry } from '@felan-ai/ext-memory';
import type { Component } from '@earendil-works/pi-tui';
import { FELAN_VERSION } from './version.js';

const PI_ONBOARDING = 'Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.';
const MEMORY_CONTEXT_DISPLAY_PATH = 'Project memory';

interface ExpandableStartupHeader extends Component {
  getCollapsedText(): string;
  getExpandedText(): string;
  setExpanded(expanded: boolean): void;
}

interface InteractiveModeHeaderInternals {
  builtInHeader: Component | undefined;
}

interface DisplayContextFile {
  readonly path: string;
  readonly content: string;
}

interface InteractiveModeResourceInternals {
  readonly session?: {
    readonly sessionManager: {
      buildContextEntries(): readonly unknown[];
    };
    readonly resourceLoader: {
      getAgentsFiles(): { agentsFiles: DisplayContextFile[] };
    };
  };
  showLoadedResources?(options?: unknown): void;
}

export function installFelanStartupHeader(
  mode: InteractiveMode,
  options: {
    readonly expanded?: boolean;
    readonly memorySummaryPath?: () => string;
  } = {},
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

  installMemoryContextIndicator(mode, options.memorySummaryPath);
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

function installMemoryContextIndicator(
  mode: InteractiveMode,
  memorySummaryPath?: () => string,
): void {
  const internals = mode as unknown as InteractiveModeResourceInternals;
  const showLoadedResources = internals.showLoadedResources;
  if (typeof showLoadedResources !== 'function') return;

  internals.showLoadedResources = function showFelanLoadedResources(options?: unknown): void {
    const session = internals.session;
    if (!session?.sessionManager.buildContextEntries().some(isMemoryContextEntry)) {
      showLoadedResources.call(mode, options);
      return;
    }

    const loader = session.resourceLoader;
    const getAgentsFiles = loader.getAgentsFiles;
    const ownGetAgentsFiles = Object.getOwnPropertyDescriptor(loader, 'getAgentsFiles');
    const displayPath = memorySummaryPath?.().trim() || MEMORY_CONTEXT_DISPLAY_PATH;
    loader.getAgentsFiles = () => {
      const result = getAgentsFiles.call(loader);
      if (result.agentsFiles.some(({ path }) => path === displayPath)) return result;
      return {
        agentsFiles: [
          ...result.agentsFiles,
          { path: displayPath, content: '' },
        ],
      };
    };
    try {
      showLoadedResources.call(mode, options);
    } finally {
      if (ownGetAgentsFiles) Object.defineProperty(loader, 'getAgentsFiles', ownGetAgentsFiles);
      else Reflect.deleteProperty(loader, 'getAgentsFiles');
    }
  };
}
