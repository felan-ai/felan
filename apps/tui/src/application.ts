import { join } from 'node:path';
import { InteractiveMode } from '@earendil-works/pi-coding-agent';
import {
  createLocalFelanRuntime,
  type CreateLocalFelanRuntimeOptions,
} from './runtime.js';
import { installFelanStartupHeader } from './startup-header.js';
import { createToolActivityRuntimeView } from './tool-activity/runtime-view.js';
import { checkForFelanUpdate } from './update.js';
import { CwdChangeRequested, installFelanCwdCommand } from './cwd-command.js';

export interface RunLocalFelanOptions extends CreateLocalFelanRuntimeOptions {
  readonly initialMessage?: string;
  readonly verbose?: boolean;
}

export function brandResumeHint(output: string): string {
  return output.replace(
    /(To resume this session:(?:\x1b\[[0-9;]*m)*\s*)pi /,
    '$1felan ',
  );
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

async function runLocalFelanSession(options: RunLocalFelanOptions): Promise<string | undefined> {
  const runtime = await createLocalFelanRuntime(options);
  const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousPiSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
  const previousPiTelemetry = process.env.PI_TELEMETRY;
  process.env.PI_CODING_AGENT_DIR = runtime.services.agentDir;
  process.env.PI_SKIP_VERSION_CHECK = '1';
  process.env.PI_TELEMETRY = '0';
  const previousStdoutWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    if (typeof chunk === 'string') chunk = brandResumeHint(chunk);
    return previousStdoutWrite.call(process.stdout, chunk, ...args as never[]);
  }) as typeof process.stdout.write;

  try {
    const mode = new InteractiveMode(createToolActivityRuntimeView(runtime), {
      ...(options.initialMessage === undefined ? {} : { initialMessage: options.initialMessage }),
      ...(options.verbose === undefined ? {} : { verbose: options.verbose }),
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
          mode.showWarning(
            `Felan ${latestVersion} is available. Exit all Felan sessions, then run felan update `
              + '(global npm) or update with your package manager.',
          );
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
