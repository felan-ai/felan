import { join, resolve } from 'node:path';
import {
  InteractiveMode,
  resolveCliModel,
  runPrintMode,
  type PrintModeOptions,
} from '@earendil-works/pi-coding-agent';
import type { CreateAgentSessionOptions } from '@felan-ai/agent-core';
import {
  createLocalFelanRuntime,
  createLocalModelRuntime,
  getLocalAgentDir,
  type CreateLocalFelanRuntimeOptions,
} from './runtime.js';
import { installFelanStartupHeader } from './startup-header.js';
import { createToolActivityRuntimeView } from './tool-activity/runtime-view.js';
import { checkForFelanUpdate } from './update.js';
import { showFelanUpdateNotification } from './update-notification.js';
import { CwdChangeRequested, installFelanCwdCommand } from './cwd-command.js';
import { installFelanSettingsCommand } from './extension-settings.js';
import { loadLocalExtensionConfigDefinitions } from './extensions.js';

export interface RunLocalFelanOptions extends CreateLocalFelanRuntimeOptions {
  readonly initialMessage?: string;
  readonly verbose?: boolean;
}

export interface RunLocalFelanHeadlessOptions extends Omit<CreateLocalFelanRuntimeOptions, 'model'> {
  readonly mode: PrintModeOptions['mode'];
  readonly initialMessage: string;
  readonly provider?: string;
  readonly model?: string;
  readonly thinkingLevel?: CreateAgentSessionOptions['thinkingLevel'];
  readonly writeError?: (line: string) => void;
}

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
      ...restartOptions
    } = nextOptions;
    nextOptions = {
      ...restartOptions,
      cwd: nextCwd,
      continueRecent: false,
    };
  }
}

export async function runLocalFelanHeadless(options: RunLocalFelanHeadlessOptions): Promise<number> {
  const writeError = options.writeError ?? ((line: string) => console.error(line));
  if (options.provider !== undefined && options.model === undefined) {
    writeError('--provider requires --model in headless mode');
    return 1;
  }
  let runtime: Awaited<ReturnType<typeof createLocalFelanRuntime>> | undefined;
  let printModeOwnsRuntime = false;
  const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousPiSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
  const previousPiTelemetry = process.env.PI_TELEMETRY;
  try {
    const modelRuntime = options.modelRuntime ?? await createLocalModelRuntimeForHeadless(options);
    const resolved = options.model === undefined
      ? { model: undefined, warning: undefined, error: undefined }
      : resolveCliModel({
        ...(options.provider === undefined ? {} : { cliProvider: options.provider }),
        cliModel: options.model,
        ...(options.thinkingLevel === undefined ? {} : { cliThinking: options.thinkingLevel }),
        modelRuntime,
      });
    if (resolved.warning) writeError(`Warning: ${resolved.warning}`);
    if (resolved.error) {
      writeError(resolved.error);
      return 1;
    }
    const {
      mode: _mode,
      initialMessage: _initialMessage,
      provider: _provider,
      model: _model,
      writeError: _writeError,
      ...runtimeOptions
    } = options;
    runtime = await createLocalFelanRuntime({
      ...runtimeOptions,
      modelRuntime,
      ...(resolved.model === undefined ? {} : { model: resolved.model }),
      ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
    });
    process.env.PI_CODING_AGENT_DIR = runtime.services.agentDir;
    process.env.PI_SKIP_VERSION_CHECK = '1';
    process.env.PI_TELEMETRY = '0';
    if (runtime.diagnostics.some((diagnostic) => diagnostic.type === 'error')) {
      for (const diagnostic of runtime.diagnostics) {
        if (diagnostic.type === 'error') writeError(`Error: ${diagnostic.message}`);
      }
      return 1;
    }
    for (const diagnostic of runtime.diagnostics) {
      if (diagnostic.type !== 'info') writeError(`${diagnostic.type === 'warning' ? 'Warning' : 'Error'}: ${diagnostic.message}`);
    }
    printModeOwnsRuntime = true;
    return await runPrintMode(runtime, {
      mode: options.mode,
      initialMessage: options.initialMessage,
    });
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    if (runtime !== undefined && !printModeOwnsRuntime) await runtime.dispose().catch((error) => {
      writeError(error instanceof Error ? error.message : String(error));
    });
    if (previousPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
    if (previousPiSkipVersionCheck === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
    else process.env.PI_SKIP_VERSION_CHECK = previousPiSkipVersionCheck;
    if (previousPiTelemetry === undefined) delete process.env.PI_TELEMETRY;
    else process.env.PI_TELEMETRY = previousPiTelemetry;
  }
}

async function createLocalModelRuntimeForHeadless(
  options: RunLocalFelanHeadlessOptions,
) {
  return createLocalModelRuntime(options.agentDir ?? getLocalAgentDir());
}

async function runLocalFelanSession(options: RunLocalFelanOptions): Promise<string | undefined> {
  const runtime = await createLocalFelanRuntime(options);
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

  try {
    const startupDiagnostics = runtime.diagnostics.filter(({ type }) => type !== 'info');
    const mode = new InteractiveMode(createToolActivityRuntimeView(runtime), {
      ...(options.initialMessage === undefined ? {} : { initialMessage: options.initialMessage }),
      ...(options.verbose === undefined ? {} : { verbose: options.verbose }),
      tuiMode: runtime.services.settingsManager.getGlobalSettings().tuiMode === undefined
        ? 'fullscreen'
        : runtime.services.settingsManager.getTuiMode(),
      initialThemeSetting: runtime.services.settingsManager.getThemeSetting() ?? 'felan-light/felan-dark',
      ...(startupDiagnostics.length === 0 ? {} : { startupDiagnostics }),
    });
    installFelanSettingsCommand(mode, {
      agentDir: runtime.services.agentDir,
      settingsManager: runtime.services.settingsManager,
      definitions: await loadLocalExtensionConfigDefinitions(),
    });
    installFelanCwdCommand(mode, {
      getCwd: () => runtime.cwd,
      isIdle: () => runtime.session.isIdle,
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    });
    installFelanStartupHeader(mode, {
      expanded: options.verbose === true,
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
        throw error;
      }
    } finally {
      modeActive = false;
      updateCheckController.abort();
      await updateNotification;
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
}
