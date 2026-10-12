import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  InteractiveMode,
  type AgentSessionRuntimeDiagnostic,
} from '@earendil-works/pi-coding-agent';
import {
  createLocalFelanRuntime,
  getLocalAgentDir,
  type CreateLocalFelanRuntimeOptions,
} from './runtime.js';
import { installFelanStartupHeader } from './startup-header.js';
import { resolveInteractivePiExtensionPaths } from './pi-extensions.js';
import { createLocalSettingsManager, getFelanSettings, getPiExtensionSettings } from '@felan-ai/daemon/internal/settings';
import { getLocalExtensionStartupState } from './dependencies.js';
import { createToolActivityRuntimeView } from './tool-activity/runtime-view.js';
import { checkForFelanUpdate } from './update.js';
import { showFelanUpdateNotification } from './update-notification.js';
import { CwdChangeRequested, installFelanCwdCommand } from './cwd-command.js';
import { RestartRequested, installFelanRestartCommand } from './restart-command.js';
import { installFelanSettingsCommand } from './extension-settings.js';
import { installFelanModelSelectorBehavior } from './model-selector.js';
import { installFelanTuiCompatibility } from './tui-compatibility.js';
import {
  loadLocalExtensionConfigDefinitions,
  promptHistoryExtensionPackage,
} from '@felan-ai/daemon/internal/extensions';
import { installPromptHistoryKeybindingOverride } from './prompt-history.js';
import { restartFelanProcess, type RestartProcess } from './process-restart.js';

export interface RunLocalFelanOptions extends CreateLocalFelanRuntimeOptions {
  readonly initialMessage?: string;
  readonly startupDiagnostics?: readonly AgentSessionRuntimeDiagnostic[];
  readonly verbose?: boolean;
  readonly restartProcess?: RestartProcess;
  readonly restartArgs?: readonly string[];
}

export { runLocalFelanHeadless } from './headless.js';
export type { RunLocalFelanHeadlessOptions } from './headless.js';

export function brandResumeHint(output: string, usesDefaultSessionDir = false): string {
  const brandedOutput = output.replace(
    /(To resume this session:(?:\x1b\[[0-9;]*m)*\s*)pi /,
    '$1felan ',
  );
  if (!usesDefaultSessionDir) return brandedOutput;
  return brandedOutput.replace(
    /(To resume this session:(?:\x1b\[[0-9;]*m)*\s*felan )--session-dir (?:[a-zA-Z0-9_\-./~:@]+|'(?:[^']|'\\'')*') (?=--session )/,
    '$1',
  );
}

function pathsEqual(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

export async function runLocalFelan(options: RunLocalFelanOptions = {}): Promise<void> {
  let nextOptions = options;
  while (true) {
    const nextCwd = await runLocalFelanSession(nextOptions);
    if (nextCwd === undefined) return;
    const {
      continueRecent: _continueRecent,
      initialMessage: _initialMessage,
      memoryCoordinator: _memoryCoordinator,
      sessionManager: _sessionManager,
      skillPaths: _skillPaths,
      startupDiagnostics: _startupDiagnostics,
      ...restartOptions
    } = nextOptions;
    nextOptions = {
      ...restartOptions,
      cwd: nextCwd,
      continueRecent: false,
    };
  }
}

async function runLocalFelanSession(options: RunLocalFelanOptions): Promise<string | undefined> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const agentDir = resolve(options.agentDir ?? getLocalAgentDir());
  const homeDir = options.homeDir ?? homedir();
  const { extensionPaths: cliExtensionPaths, ...runtimeOptions } = options;
  const extensionPaths = await resolveInteractivePiExtensionPaths({
    cwd,
    homeDir,
    agentDir,
    settings: getPiExtensionSettings(createLocalSettingsManager(cwd, agentDir)),
    ...(cliExtensionPaths === undefined ? {} : { cliPaths: cliExtensionPaths }),
  });
  const runtime = await createLocalFelanRuntime({
    ...runtimeOptions,
    cwd,
    agentDir,
    homeDir,
    ...(extensionPaths.length === 0 ? {} : { extensionPaths }),
  });
  const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousPiSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
  const previousPiTelemetry = process.env.PI_TELEMETRY;
  process.env.PI_CODING_AGENT_DIR = runtime.services.agentDir;
  process.env.PI_SKIP_VERSION_CHECK = '1';
  process.env.PI_TELEMETRY = '0';
  const previousStdoutWrite = process.stdout.write;
  const defaultSessionDir = join(runtime.services.agentDir, 'sessions');
  process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    if (typeof chunk === 'string') {
      chunk = brandResumeHint(
        chunk,
        chunk.includes('To resume this session:') && pathsEqual(
          runtime.session.sessionManager.getSessionDir(),
          defaultSessionDir,
        ),
      );
    }
    return previousStdoutWrite.call(process.stdout, chunk, ...args as never[]);
  }) as typeof process.stdout.write;

  let restartRequested = false;
  try {
    const startupDiagnostics = [
      ...(options.startupDiagnostics ?? []),
      ...runtime.diagnostics.filter(({ type }) => type !== 'info'),
    ];
    const mode = new InteractiveMode(createToolActivityRuntimeView(runtime), {
      ...(options.initialMessage === undefined ? {} : { initialMessage: options.initialMessage }),
      ...(options.verbose === undefined ? {} : { verbose: options.verbose }),
      tuiMode: runtime.services.settingsManager.getGlobalSettings().tuiMode === undefined
        ? 'fullscreen'
        : runtime.services.settingsManager.getTuiMode(),
      initialThemeSetting: runtime.services.settingsManager.getThemeSetting() ?? 'felan-light/felan-dark',
      ...(startupDiagnostics.length === 0 ? {} : { startupDiagnostics }),
    });
    installFelanTuiCompatibility(mode);
    installFelanModelSelectorBehavior(mode);
    if (runtime.services.resourceLoader.getExtensions().extensions.some(
      ({ path }) => path === `<inline:${promptHistoryExtensionPackage}>`,
    )) {
      installPromptHistoryKeybindingOverride(mode);
    }
    installFelanSettingsCommand(mode, {
      agentDir: runtime.services.agentDir,
      settingsManager: runtime.services.settingsManager,
      definitions: await loadLocalExtensionConfigDefinitions(),
      modelRuntime: runtime.services.modelRuntime,
    });
    installFelanCwdCommand(mode, {
      getCwd: () => runtime.cwd,
      isIdle: () => runtime.session.isIdle,
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    });
    installFelanRestartCommand(mode, {
      isIdle: () => runtime.session.isIdle,
    });
    installFelanStartupHeader(mode, {
      expanded: options.verbose === true,
      extensionState: () => getLocalExtensionStartupState(
        getFelanSettings(runtime.services.settingsManager),
      ),
      memorySummaryPath: () => join(
        runtime.services.agentDir,
        'storage',
        'sessions',
        encodeURIComponent(runtime.session.sessionManager.getSessionId()),
        '.memory',
        'summary.md',
      ),
    });
    // Pi starts passive checks immediately after its idempotent initialization.
    // Initialize first so Felan's check begins at the same lifecycle point.
    await mode.init();
    const updateCheckController = new AbortController();
    let modeActive = true;
    const updateNotification = checkForFelanUpdate({ signal: updateCheckController.signal })
      .then((latestVersion) => {
        if (modeActive && latestVersion) {
          showFelanUpdateNotification(mode, latestVersion);
        }
      })
      .catch(() => {});
    try {
      try {
        await mode.run();
      } catch (error) {
        if (error instanceof CwdChangeRequested) return error.cwd;
        if (error instanceof RestartRequested) {
          restartRequested = true;
        } else {
          throw error;
        }
      }
    } finally {
      modeActive = false;
      updateCheckController.abort();
      await updateNotification;
      mode.stop();
    }
  } finally {
    try {
      await runtime.dispose();
    } finally {
      if (previousPiAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
      }
      if (previousPiSkipVersionCheck === undefined) {
        delete process.env.PI_SKIP_VERSION_CHECK;
      } else {
        process.env.PI_SKIP_VERSION_CHECK = previousPiSkipVersionCheck;
      }
      if (previousPiTelemetry === undefined) {
        delete process.env.PI_TELEMETRY;
      } else {
        process.env.PI_TELEMETRY = previousPiTelemetry;
      }
      process.stdout.write = previousStdoutWrite;
    }
  }
  if (restartRequested) {
    await (options.restartProcess ?? restartFelanProcess)({
      sessionManager: runtime.session.sessionManager,
      verbose: options.verbose === true,
      ...(options.restartArgs === undefined ? {} : { restartArgs: options.restartArgs }),
    });
  }
}
