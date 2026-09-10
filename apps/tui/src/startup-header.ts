import {
  VERSION as PI_VERSION,
  type InteractiveMode,
} from '@earendil-works/pi-coding-agent';
import { isMemoryContextEntry } from '@felan-ai/ext-memory';
import type { Component } from '@earendil-works/pi-tui';
import { FELAN_VERSION } from './version.js';
import type { LocalExtensionStartupState } from './dependencies.js';

const PI_ONBOARDING = 'Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.';
const PI_RESOURCE_HINT = 'to show full startup help and loaded resources.';
const FELAN_TAGLINE = '   get the job done · waste less';
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
  readonly options?: {
    readonly verbose?: boolean;
  };
  readonly settingsManager?: {
    getQuietStartup: () => boolean;
  };
  readonly session?: {
    readonly sessionManager: {
      buildContextEntries(): readonly unknown[];
    };
    readonly resourceLoader: {
      getAgentsFiles(): { agentsFiles: DisplayContextFile[] };
    };
  };
  showLoadedResources?(options?: unknown): void;
  readonly loadedResourcesContainer?: { addChild(component: Component): void };
}

export function installFelanStartupHeader(
  mode: InteractiveMode,
  options: {
    readonly expanded?: boolean;
    readonly memorySummaryPath?: () => string;
    readonly extensionState?: () => LocalExtensionStartupState;
  } = {},
): void {
  // Pi 0.85.0 has no pre-render header hook. Intercepting this assignment keeps
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

  installMemoryContextIndicator(mode, options.memorySummaryPath, options.extensionState);
}

export function rewritePiStartupHeader(text: string): string {
  const lines = text.split('\n');
  const logo = (lines[0] ?? '')
    .replace('pi', '◉  felan')
    .replace(`v${PI_VERSION}`, `v${FELAN_VERSION}`);
  const upstreamOnboarding = lines.find((line) => line.includes(PI_ONBOARDING));
  const tagline = upstreamOnboarding?.replace(PI_ONBOARDING, FELAN_TAGLINE) ?? FELAN_TAGLINE;
  const instructions = lines.slice(1).filter((line) => (
    line.trim().length > 0
    && !line.includes(PI_ONBOARDING)
    && !line.includes(PI_RESOURCE_HINT)
  ));
  return [logo, tagline, ...(instructions.length === 0 ? [] : ['', ...instructions])]
    .filter((line, index) => index > 0 || line.length > 0)
    .join('\n');
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
  extensionState?: () => LocalExtensionStartupState,
): void {
  const internals = mode as unknown as InteractiveModeResourceInternals;
  const showLoadedResources = internals.showLoadedResources;
  if (typeof showLoadedResources !== 'function') return;

  internals.showLoadedResources = function showFelanLoadedResources(options?: unknown): void {
    withNormalResourceListingSuppressed(internals, options, () => {
      const session = internals.session;
      const resourceOptions = extensionState
        ? { ...(typeof options === 'object' && options !== null ? options : {}), extensions: [] }
        : options;
      if (!session?.sessionManager.buildContextEntries().some(isMemoryContextEntry)) {
        showLoadedResources.call(mode, resourceOptions);
        if (extensionState && shouldShowResourceListing(internals, options)) {
          renderExtensionState(internals, extensionState());
        }
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
        showLoadedResources.call(mode, resourceOptions);
        if (extensionState && shouldShowResourceListing(internals, options)) {
          renderExtensionState(internals, extensionState());
        }
      } finally {
        if (ownGetAgentsFiles) Object.defineProperty(loader, 'getAgentsFiles', ownGetAgentsFiles);
        else Reflect.deleteProperty(loader, 'getAgentsFiles');
      }
    });
  };
}

function shouldShowResourceListing(internals: InteractiveModeResourceInternals, options: unknown): boolean {
  const forced = typeof options === 'object' && options !== null && Reflect.get(options, 'force') === true;
  return forced || internals.options?.verbose === true || !internals.settingsManager || !internals.settingsManager.getQuietStartup();
}

function renderExtensionState(
  internals: InteractiveModeResourceInternals,
  state: LocalExtensionStartupState,
): void {
  const container = internals.loadedResourcesContainer;
  if (!container) return;
  const lines = [
    '[Felan extensions]',
    `  Enabled: ${state.enabled.join(', ') || 'none'}`,
    `  Disabled: ${state.disabled.join(', ') || 'none'}`,
    `  Setup required: ${state.setupRequired.join(', ') || 'none'}`,
  ].join('\n');
  container.addChild({ render: () => [lines], invalidate: () => {} });
}

function withNormalResourceListingSuppressed(
  internals: InteractiveModeResourceInternals,
  options: unknown,
  render: () => void,
): void {
  const force = typeof options === 'object'
    && options !== null
    && Reflect.get(options, 'force') === true;
  const settingsManager = internals.settingsManager;
  if (force || internals.options?.verbose === true || !settingsManager) {
    render();
    return;
  }

  const ownGetQuietStartup = Object.getOwnPropertyDescriptor(settingsManager, 'getQuietStartup');
  settingsManager.getQuietStartup = () => true;
  try {
    render();
  } finally {
    if (ownGetQuietStartup) Object.defineProperty(settingsManager, 'getQuietStartup', ownGetQuietStartup);
    else Reflect.deleteProperty(settingsManager, 'getQuietStartup');
  }
}
