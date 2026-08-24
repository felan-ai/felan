import type {
  AgentRuntime,
  ExtensionContext,
  FelanExtension,
  SettingsManager,
} from '@felan-ai/agent-core';
import { inspectBackgroundBashRuntime } from '@felan-ai/ext-background-bash';
import {
  inspectAgentBrowserRuntime,
  installManagedAgentBrowser,
  MANAGED_AGENT_BROWSER_VERSION,
} from '@felan-ai/ext-browser';
import {
  detectMarkitdown,
  installManagedMarkitdown,
  setActiveMarkitdownEnabled,
} from '@felan-ai/ext-markitdown';
import {
  inspectRtkRuntime,
  installManagedRtk,
  MANAGED_RTK_VERSION,
  refreshActiveRtkRuntime,
} from '@felan-ai/ext-rtk-optimizer';
import type { BuiltinExtensionName } from './extensions.js';
import {
  getDependencyOnboardingChoice,
  getFelanSettings,
  isBuiltinExtensionEnabled,
  setBuiltinExtensionEnabled,
  setDependencyOnboardingChoice,
} from './settings.js';

export const localDependencyExtensionName = '@felan-ai/felan/runtime-dependencies';

export interface RuntimeDependencyStatus {
  readonly available: boolean;
  readonly version?: string;
  readonly reason?: string;
}

export interface LocalRuntimeDependency {
  readonly id: string;
  readonly label: string;
  readonly extension: BuiltinExtensionName;
  readonly purpose: string;
  readonly unavailableMessage?: (status: RuntimeDependencyStatus) => string;
  readonly installConfirmation?: string;
  readonly unavailableChoice: string;
  readonly unavailableOutcome: 'disable-extension' | 'continue';
  check(runtime: AgentRuntime): Promise<RuntimeDependencyStatus>;
  install?(runtime: AgentRuntime, onStatus: (message: string) => void): Promise<RuntimeDependencyStatus>;
  afterInstall?(runtime: AgentRuntime): Promise<void>;
}

export interface CreateLocalDependencyExtensionOptions {
  readonly agentDir: string;
  readonly settingsManager: SettingsManager;
  readonly dependencies?: readonly LocalRuntimeDependency[];
}

export const localRuntimeDependencies: readonly LocalRuntimeDependency[] = [
  {
    id: 'background-bash',
    label: 'Background Bash',
    extension: 'backgroundBash',
    purpose: 'detached process execution, which requires standard POSIX shell and process utilities',
    unavailableMessage: (status) => formatUnavailableMessage(
      'Background Bash is built into Felan, but this runtime is missing required POSIX shell/process utilities.',
      'Detached background jobs remain inactive until the runtime provides them.',
      status,
    ),
    unavailableChoice: 'Disable the Background Bash extension',
    unavailableOutcome: 'disable-extension',
    check: async (runtime) => {
      const status = await inspectBackgroundBashRuntime(runtime);
      return status.available ? status : { available: false, reason: status.reason };
    },
  },
  {
    id: 'agent-browser',
    label: 'agent-browser',
    extension: 'browser',
    purpose: 'browser automation, authenticated web-app workflows, and screenshots',
    unavailableMessage: (status) => formatUnavailableMessage(
      'Browser automation is built into Felan, but the reviewed agent-browser CLI is not installed or unavailable.',
      'The browser tool remains unavailable until you install it.',
      status,
    ),
    installConfirmation: `Download the reviewed agent-browser ${MANAGED_AGENT_BROWSER_VERSION} package, verify its integrity, and install its native CLI into Felan agent storage?`,
    unavailableChoice: 'Disable the Browser extension',
    unavailableOutcome: 'disable-extension',
    check: async (runtime) => {
      const detected = await inspectAgentBrowserRuntime(runtime);
      return detected.available
        ? { available: true, version: detected.invocation.version }
        : { available: false, reason: detected.reason };
    },
    install: async (runtime, onStatus) => {
      const detected = await installManagedAgentBrowser(runtime, onStatus);
      return detected.available
        ? { available: true, version: detected.invocation.version }
        : { available: false, reason: detected.reason };
    },
  },
  {
    id: 'markitdown',
    label: 'MarkItDown',
    extension: 'markitdown',
    purpose: 'document conversion for DOC/DOCX, PPT/PPTX, XLS/XLSX, RTF, EPUB, and MSG reads',
    unavailableMessage: (status) => formatUnavailableMessage(
      'MarkItDown support is built into Felan, but the external markitdown converter is not installed or unavailable.',
      'Felan can continue normally; Office document reads remain inactive until you install it.',
      status,
    ),
    installConfirmation: 'Create a Python virtual environment in Felan agent storage and install the pinned markitdown 0.1.7 document extras?',
    unavailableChoice: 'Disable the MarkItDown extension',
    unavailableOutcome: 'disable-extension',
    check: async (runtime) => {
      const detected = await detectMarkitdown(runtime);
      return detected.available
        ? { available: true, version: detected.invocation.version }
        : { available: false, reason: detected.reason };
    },
    install: async (runtime, onStatus) => {
      const detected = await installManagedMarkitdown(runtime, onStatus);
      return detected.available
        ? { available: true, version: detected.invocation.version }
        : { available: false, reason: detected.reason };
    },
  },
  {
    id: 'rtk',
    label: 'RTK',
    extension: 'rtkOptimizer',
    purpose: 'command rewriting; RTK output compaction remains available without the executable',
    unavailableMessage: (status) => formatUnavailableMessage(
      'RTK optimization is built into Felan, but the external rtk executable is not installed or unavailable.',
      'Felan can continue normally; output compaction still works, but command rewriting is inactive until RTK is installed.',
      status,
    ),
    installConfirmation: `Download the reviewed official installer, verify its pinned digest, and run it to install RTK ${MANAGED_RTK_VERSION} in Felan agent storage?`,
    unavailableChoice: 'Continue with output compaction only',
    unavailableOutcome: 'continue',
    check: async (runtime) => {
      const status = await inspectRtkRuntime(runtime);
      return status.rtkAvailable
        ? { available: true, ...(status.version === undefined ? {} : { version: status.version }) }
        : { available: false, ...(status.lastError === undefined ? {} : { reason: status.lastError }) };
    },
    install: async (runtime, onStatus) => {
      const status = await installManagedRtk(runtime, onStatus);
      return status.rtkAvailable
        ? { available: true, ...(status.version === undefined ? {} : { version: status.version }) }
        : { available: false, ...(status.lastError === undefined ? {} : { reason: status.lastError }) };
    },
    afterInstall: async (runtime) => {
      await refreshActiveRtkRuntime(runtime);
    },
  },
];

export function createLocalDependencyExtension(
  options: CreateLocalDependencyExtensionOptions,
): FelanExtension {
  const dependencies = options.dependencies ?? localRuntimeDependencies;
  let onboarding = false;

  return (pi) => {
    pi.registerCommand('dependencies', {
      description: 'Inspect, install, enable, or disable external runtime dependencies',
      handler: async (_args, ctx) => {
        if (!ctx.hasUI || ctx.mode !== 'tui') {
          ctx.ui.notify('/dependencies requires interactive TUI mode.', 'warning');
          return;
        }
        await manageDependencies(pi.runtime, ctx, options, dependencies);
      },
    });

    pi.on('session_start', async (event, ctx) => {
      try {
        await synchronizeDisabledDependencies(pi.runtime, options);
      } catch (error) {
        ctx.ui.notify(`Dependency settings could not be loaded: ${errorMessage(error)}`, 'warning');
        return;
      }
      if (event.reason !== 'startup' || ctx.mode !== 'tui' || !ctx.hasUI || onboarding) return;
      onboarding = true;
      try {
        await onboardMissingDependencies(pi.runtime, ctx, options, dependencies);
      } catch (error) {
        ctx.ui.notify(`Dependency onboarding failed: ${errorMessage(error)}`, 'warning');
      } finally {
        onboarding = false;
      }
    });
  };
}

async function synchronizeDisabledDependencies(
  runtime: AgentRuntime,
  options: CreateLocalDependencyExtensionOptions,
): Promise<void> {
  await options.settingsManager.reload();
  const settings = getFelanSettings(options.settingsManager);
  if (!isBuiltinExtensionEnabled(settings, 'markitdown')) {
    setActiveMarkitdownEnabled(runtime, false);
  }
}

async function onboardMissingDependencies(
  runtime: AgentRuntime,
  ctx: ExtensionContext,
  options: CreateLocalDependencyExtensionOptions,
  dependencies: readonly LocalRuntimeDependency[],
): Promise<void> {
  for (const dependency of dependencies) {
    await options.settingsManager.reload();
    const settings = getFelanSettings(options.settingsManager);
    if (!isBuiltinExtensionEnabled(settings, dependency.extension)) continue;
    if (getDependencyOnboardingChoice(settings, dependency.id) === 'continue') continue;

    const status = await checkDependency(dependency, runtime);
    if (status.available) continue;

    const installChoice = `Install ${dependency.label}`;
    const laterChoice = 'Decide later';
    const selected = await ctx.ui.select(
      dependency.unavailableMessage?.(status) ?? formatUnavailableMessage(
        `${dependency.label} is unavailable — ${dependency.purpose}.`,
        undefined,
        status,
      ),
      [...(dependency.install ? [installChoice] : []), dependency.unavailableChoice, laterChoice],
    );
    if (!selected || selected === laterChoice) continue;
    if (selected === installChoice) {
      await installDependency(dependency, runtime, ctx, options, false);
      continue;
    }
    await applyUnavailableChoice(dependency, runtime, ctx, options);
  }
}

async function manageDependencies(
  runtime: AgentRuntime,
  ctx: ExtensionContext,
  options: CreateLocalDependencyExtensionOptions,
  dependencies: readonly LocalRuntimeDependency[],
): Promise<void> {
  await options.settingsManager.reload();
  const settings = getFelanSettings(options.settingsManager);
  const entries = await Promise.all(dependencies.map(async (dependency) => {
    const enabled = isBuiltinExtensionEnabled(settings, dependency.extension);
    const status = enabled
      ? await checkDependency(dependency, runtime)
      : { available: false, reason: 'extension disabled' };
    const summary = enabled
      ? status.available
        ? `available${status.version ? ` (${status.version})` : ''}`
        : 'missing'
      : 'disabled';
    return { dependency, enabled, status, label: `${dependency.label} — ${summary}` };
  }));
  const close = 'Close dependency manager';
  const selected = await ctx.ui.select('Felan runtime dependencies', [...entries.map((entry) => entry.label), close]);
  if (!selected || selected === close) return;
  const entry = entries.find((candidate) => candidate.label === selected);
  if (!entry) return;

  if (!entry.enabled) {
    const installAndEnable = `Install and enable ${entry.dependency.label}`;
    const enable = `Enable ${entry.dependency.label} without installing`;
    const action = await ctx.ui.select(
      `${entry.dependency.label} extension is disabled`,
      [...(entry.dependency.install ? [installAndEnable] : []), enable, close],
    );
    if (action === installAndEnable) {
      await installDependency(entry.dependency, runtime, ctx, options, true);
    } else if (action === enable) {
      await setBuiltinExtensionEnabled(options.agentDir, entry.dependency.extension, true);
      await setDependencyOnboardingChoice(options.agentDir, entry.dependency.id, undefined);
      if (entry.dependency.id === 'markitdown') setActiveMarkitdownEnabled(runtime, true);
      ctx.ui.notify(`${entry.dependency.label} enabled. Restart Felan to load the extension.`, 'info');
    }
    return;
  }

  if (entry.status.available) {
    ctx.ui.notify(
      `${entry.dependency.label} is available${entry.status.version ? ` (${entry.status.version})` : ''}.`,
      'info',
    );
    return;
  }

  const installChoice = `Install ${entry.dependency.label}`;
  const action = await ctx.ui.select(
    `${entry.dependency.label} is unavailable${entry.status.reason ? `: ${entry.status.reason}` : ''}`,
    [...(entry.dependency.install ? [installChoice] : []), entry.dependency.unavailableChoice, close],
  );
  if (action === installChoice) {
    await installDependency(entry.dependency, runtime, ctx, options, false);
  } else if (action === entry.dependency.unavailableChoice) {
    await applyUnavailableChoice(entry.dependency, runtime, ctx, options);
  }
}

async function installDependency(
  dependency: LocalRuntimeDependency,
  runtime: AgentRuntime,
  ctx: ExtensionContext,
  options: CreateLocalDependencyExtensionOptions,
  enableAfterInstall: boolean,
): Promise<void> {
  if (!dependency.install || !dependency.installConfirmation) {
    ctx.ui.notify(`${dependency.label} has no managed installer.`, 'warning');
    return;
  }
  if (!await ctx.ui.confirm(`Install ${dependency.label}`, dependency.installConfirmation)) return;
  const statusKey = 'felan-dependency-install';
  ctx.ui.setStatus(statusKey, `… Installing ${dependency.label}`);
  try {
    const status = await dependency.install(runtime, (message) => {
      ctx.ui.setStatus(statusKey, `… ${message}`);
    });
    if (!status.available) {
      ctx.ui.notify(`${dependency.label} installation failed${status.reason ? `: ${status.reason}` : '.'}`, 'error');
      return;
    }
    await dependency.afterInstall?.(runtime);
    await setDependencyOnboardingChoice(options.agentDir, dependency.id, undefined);
    if (enableAfterInstall) {
      await setBuiltinExtensionEnabled(options.agentDir, dependency.extension, true);
      if (dependency.id === 'markitdown') setActiveMarkitdownEnabled(runtime, true);
    }
    ctx.ui.notify(
      `${dependency.label} installed${status.version ? ` (${status.version})` : ''}.${enableAfterInstall ? ' Restart Felan to load the extension.' : ''}`,
      'info',
    );
  } catch (error) {
    ctx.ui.notify(`${dependency.label} installation failed: ${errorMessage(error)}`, 'error');
  } finally {
    ctx.ui.setStatus(statusKey, undefined);
  }
}

async function applyUnavailableChoice(
  dependency: LocalRuntimeDependency,
  runtime: AgentRuntime,
  ctx: ExtensionContext,
  options: CreateLocalDependencyExtensionOptions,
): Promise<void> {
  if (dependency.unavailableOutcome === 'disable-extension') {
    await setBuiltinExtensionEnabled(options.agentDir, dependency.extension, false);
    if (dependency.id === 'markitdown') setActiveMarkitdownEnabled(runtime, false);
    ctx.ui.notify(`${dependency.label} disabled. Restart Felan to unload the extension completely.`, 'info');
    return;
  }
  await setDependencyOnboardingChoice(options.agentDir, dependency.id, 'continue');
  ctx.ui.notify(`${dependency.label} rewriting will stay bypassed while output compaction remains active.`, 'info');
}

async function checkDependency(
  dependency: LocalRuntimeDependency,
  runtime: AgentRuntime,
): Promise<RuntimeDependencyStatus> {
  try {
    return await dependency.check(runtime);
  } catch (error) {
    return { available: false, reason: errorMessage(error) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatUnavailableMessage(
  summary: string,
  detail: string | undefined,
  status: RuntimeDependencyStatus,
): string {
  return [
    summary,
    detail,
    status.reason ? `Detected reason: ${status.reason}` : undefined,
    'Use /dependencies to manage this later.',
  ].filter(Boolean).join('\n');
}
