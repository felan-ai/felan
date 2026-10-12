import {
  associateExtensionConfig,
  getExtensionConfigDefinition,
  type ExtensionConfigDefinition,
  type ExtensionPackageImporter,
  type FelanExtensionAPI,
  type ModelRuntime,
  type AgentRuntime,
} from '@felan-ai/agent-core';
import { ASK_USER_CONFIG, createAskUserExtension, type AskUserHost } from '@felan-ai/ext-ask-user';
import { createPrewalkExtension, type PrewalkHost } from '@felan-ai/ext-prewalk';
import { createMemoryExtension, type MemoryHost, type MemoryRole } from '@felan-ai/ext-memory';
import { createModelToolsExtension } from '@felan-ai/ext-model-tools';
import { createTasksExtension, type TasksPresentationHost } from '@felan-ai/ext-tasks';
import { createContextViewExtension, type ContextViewPresentationHost } from '@felan-ai/ext-context-view';
import { createFusionExtension, type FusionHost } from '@felan-ai/ext-fusion';
import {
  DEFAULT_OUTPUT_STYLE,
  type OutputStyle,
  OUTPUT_STYLE_CONFIG,
} from '@felan-ai/ext-output-style';
import { createPowerlineRuntimeExtension, POWERLINE_CONFIG, type PowerlineExtensionFactory } from '@felan-ai/ext-powerline/runtime';
import { createSessionTitleExtension, type SessionTitleHost } from '@felan-ai/ext-session-title';
import { createLocalSessionTitleHost } from './session-title.js';
import { createInsightsExtension } from '@felan-ai/ext-insights';
import { createBackgroundBashExtension, type BackgroundBashCoordinator, type BackgroundBashPresentationHost } from '@felan-ai/ext-background-bash';
import {
  createSubagentsExtension,
  type SubagentHost,
} from '@felan-ai/ext-subagents';
import { createPromptHistoryExtension, PROMPT_HISTORY_CONFIG } from '@felan-ai/ext-prompt-history';
import { createLocalMcpExtension } from './mcp/index.js';
import type { LocalMcpOAuthUrlOpener, LocalMcpOAuthPresenter } from './mcp/oauth-host.js';
import { createLocalBrowserAuthorizationHost } from './browser/authorization-host.js';
import type { BrowserAuthorizationPresentationFactory } from '@felan-ai/ext-browser/presentation';
import { BROWSER_CONFIG, type BrowserAuthorizationPolicy } from '@felan-ai/ext-browser';
import { HERDR_BLOCKED_EVENT } from './herdr.js';
import {
  createFileSubscriptionUsageStore,
  createLocalSavingsUsageHost,
  createLocalSubscriptionUsageHost,
} from './powerline.js';
import type { SavingsService } from './savings.js';
import { createLocalInsightsHost, type InsightsReportPresentation } from './insights.js';
import { createLocalOutputStyleExtension } from './output-style-instructions.js';
import { createLocalFusionHost } from './fusion/host.js';
import type { AgentRailRenderer, LocalSubagentNavigatorHost, LocalSubagentPresentationHost } from './subagents/presentation.js';

import {
  askUserExtensionPackage, mcpExtensionPackage, powerlineExtensionPackage, subagentsExtensionPackage, memoryExtensionPackage,
  modelToolsExtensionPackage, fusionExtensionPackage, outputStyleExtensionPackage, insightsExtensionPackage,
  promptHistoryExtensionPackage, sessionTitleExtensionPackage, builtinExtensionPackages, localExtensionPackages, importLocalExtension,
} from './extension-catalog.js';
export * from './extension-catalog.js';

export async function loadLocalExtensionConfigDefinitions(
  packages: readonly string[] = localExtensionPackages,
  importExtension: ExtensionPackageImporter = importLocalExtension,
): Promise<readonly ExtensionConfigDefinition[]> {
  const definitions: ExtensionConfigDefinition[] = [];
  for (const packageName of packages) {
    if (packageName === askUserExtensionPackage) {
      definitions.push(ASK_USER_CONFIG);
      continue;
    }
    if (packageName === promptHistoryExtensionPackage) {
      definitions.push(PROMPT_HISTORY_CONFIG);
      continue;
    }
    const imported = await importExtension(packageName);
    const extension = (typeof imported === 'object' && imported !== null)
      ? Reflect.get(imported, 'default')
      : undefined;
    if (typeof extension !== 'function') continue;
    const definition = getExtensionConfigDefinition(extension);
    if (definition) definitions.push(definition);
  }
  return definitions;
}

export interface LocalMemoryExtensionBinding {
  readonly role: MemoryRole;
  readonly host: MemoryHost;
}

export interface LocalExtensionUiHosts {
  readonly powerline?: PowerlineExtensionFactory;
  readonly subagents?: LocalSubagentPresentationHost;
  readonly insights?: InsightsReportPresentation;
  readonly promptHistory?: import('@felan-ai/ext-prompt-history').PromptHistoryPresentationHost;
  readonly contextView?: ContextViewPresentationHost;
  readonly backgroundBash?: BackgroundBashPresentationHost;
  readonly tasks?: TasksPresentationHost;
  readonly askUser?: AskUserHost;
  readonly prewalk?: PrewalkHost;
  readonly fusion?: Pick<FusionHost, 'configure' | 'review'>;
  readonly openOAuthUrl?: LocalMcpOAuthUrlOpener;
  readonly mcp?: LocalMcpOAuthPresenter;
  readonly browser?: BrowserAuthorizationPresentationFactory;
}

export function createLocalExtensionImporter(
  host: SubagentHost & LocalSubagentNavigatorHost,
  modelRuntime: ModelRuntime,
  importExtension: ExtensionPackageImporter = importLocalExtension,
  shutdownHost?: () => Promise<void>,
  memoryBinding?: LocalMemoryExtensionBinding,
  outputStyle: OutputStyle = DEFAULT_OUTPUT_STYLE,
  savings?: SavingsService,
  sessionDirectory?: string,
  backgroundBashCoordinator?: BackgroundBashCoordinator,
  backgroundBashCoordinatorOwner = true,
  browserAuthorizationPolicy?: {
    readonly get: () => BrowserAuthorizationPolicy;
    readonly persist: (policy: BrowserAuthorizationPolicy) => Promise<void>;
  },
  subscriptionUsagePath?: string,
  fusionAgentDir?: string,
  felanVersion?: string,
  uiHosts: LocalExtensionUiHosts = {},
  executionHosts: { sessionTitle?: (runtime: AgentRuntime) => SessionTitleHost } = {},
): ExtensionPackageImporter {
  let powerlineLoaded = false;
  let agentRailRenderer: AgentRailRenderer | undefined;
  const additionalSessionUsageHost = isSessionUsageHost(host)
    ? {
        getUsage: () => host.getUsage(),
        subscribe: (listener: () => void) => host.subscribeUsage(listener),
      }
    : undefined;
  const subscriptionHost = createLocalSubscriptionUsageHost(modelRuntime, fetch, subscriptionUsagePath);
  const powerline = (uiHosts.powerline ?? createPowerlineRuntimeExtension)(subscriptionHost, {
    ...(felanVersion === undefined ? {} : { felanVersion }),
    ...(savings === undefined ? {} : { savingsHost: createLocalSavingsUsageHost(savings) }),
    ...(additionalSessionUsageHost === undefined ? {} : { additionalSessionUsageHost }),
    ...(subscriptionUsagePath === undefined
      ? {}
      : { subscriptionStore: createFileSubscriptionUsageStore(subscriptionUsagePath) }),
    footerRows: (width) => agentRailRenderer?.(width) ?? [],
  });
  const sessionTitle = (pi: FelanExtensionAPI) => createSessionTitleExtension(
    executionHosts.sessionTitle?.(pi.runtime) ?? createLocalSessionTitleHost(modelRuntime, pi.runtime.logger),
  )(pi);
  associateExtensionConfig(powerline, POWERLINE_CONFIG);
  return async (packageName) => {
    if (packageName === askUserExtensionPackage) {
      return { default: createAskUserExtension(uiHosts.askUser ?? {
        ask: async () => ({ status: 'cancelled', reason: 'unavailable', message: 'No ask-user interaction host is configured.' }),
      }) };
    }
    if (packageName === builtinExtensionPackages.prewalk) {
      return { default: createPrewalkExtension(uiHosts.prewalk) };
    }
    if (packageName === builtinExtensionPackages.tasks) {
      return { default: createTasksExtension(uiHosts.tasks) };
    }
    if (packageName === builtinExtensionPackages.contextView) {
      return { default: createContextViewExtension(uiHosts.contextView) };
    }
    if (packageName === promptHistoryExtensionPackage) {
      const extension = createPromptHistoryExtension(
        (await import('./prompt-history.js')).localPromptHistoryHost,
        uiHosts.promptHistory,
      );
      return { default: extension };
    }
    if (packageName === builtinExtensionPackages.backgroundBash) {
      return { default: createBackgroundBashExtension(backgroundBashCoordinator, backgroundBashCoordinatorOwner, uiHosts.backgroundBash) };
    }
    if (packageName === mcpExtensionPackage) {
      return { default: createLocalMcpExtension({ ...(uiHosts.openOAuthUrl ? { openUrl: uiHosts.openOAuthUrl } : {}),
        ...(uiHosts.mcp ? { presentAuthorization: uiHosts.mcp } : {}) }) };
    }
    if (packageName === modelToolsExtensionPackage) {
      return { default: createModelToolsExtension(modelRuntime) };
    }
    if (packageName === fusionExtensionPackage) {
      return { default: createFusionExtension(fusionAgentDir && uiHosts.fusion ? createLocalFusionHost(fusionAgentDir, uiHosts.fusion) : undefined) };
    }
    if (packageName === builtinExtensionPackages.browser) {
      const { createBrowserExtension } = await import('@felan-ai/ext-browser');
      const extension = (pi: FelanExtensionAPI) => createBrowserExtension({
        authorizationHost: createLocalBrowserAuthorizationHost({
          runtime: pi.runtime,
          ...(uiHosts.browser ? { presentation: uiHosts.browser } : {}),
          ...(browserAuthorizationPolicy === undefined ? {} : {
            getAuthorizationPolicy: browserAuthorizationPolicy.get,
            persistAuthorizationPolicy: browserAuthorizationPolicy.persist,
          }),
          onAttention: (active, label) => pi.events.emit(HERDR_BLOCKED_EVENT, { active, label }),
        }),
      })(pi);
      associateExtensionConfig(extension, BROWSER_CONFIG);
      return {
        default: extension,
      };
    }
    if (packageName === subagentsExtensionPackage) {
      const subagents = createSubagentsExtension(host);
      return {
        default: ((pi) => {
          subagents(pi);
          uiHosts.subagents?.register(pi, host, {
            renderRailInEditor: () => !powerlineLoaded,
            onRailRendererChange: (renderer) => {
              agentRailRenderer = renderer;
            },
          });
          if (shutdownHost) {
            pi.on('session_shutdown', async (event) => {
              if (event.reason !== 'reload') await shutdownHost();
            });
          }
        }) satisfies ReturnType<typeof createSubagentsExtension>,
      };
    }
    if (packageName === powerlineExtensionPackage) {
      powerlineLoaded = true;
      return { default: powerline };
    }
    if (packageName === sessionTitleExtensionPackage) {
      return { default: sessionTitle };
    }
    if (packageName === insightsExtensionPackage) {
      return { default: createInsightsExtension(createLocalInsightsHost(savings, sessionDirectory, uiHosts.insights)) };
    }
    if (packageName === memoryExtensionPackage) {
      if (!memoryBinding) throw new Error('Local memory extension requires a host binding');
      return { default: createMemoryExtension(memoryBinding) };
    }
    if (packageName === outputStyleExtensionPackage) {
      const extension = createLocalOutputStyleExtension(outputStyle);
      associateExtensionConfig(extension, OUTPUT_STYLE_CONFIG);
      return { default: extension };
    }
    return importExtension(packageName);
  };
}

function isSessionUsageHost(value: object): value is object & {
  getUsage: () => import('@felan-ai/ext-powerline/runtime').SessionUsageTotals;
  subscribeUsage: (listener: () => void) => () => void;
} {
  return 'getUsage' in value
    && typeof value.getUsage === 'function'
    && 'subscribeUsage' in value
    && typeof value.subscribeUsage === 'function';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
