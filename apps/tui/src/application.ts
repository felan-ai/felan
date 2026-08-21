import { join } from 'node:path';
import { InteractiveMode } from '@earendil-works/pi-coding-agent';
import {
  createLocalFelanRuntime,
  type CreateLocalFelanRuntimeOptions,
} from './runtime.js';
import { installFelanStartupHeader } from './startup-header.js';
import { createToolActivityRuntimeView } from './tool-activity/runtime-view.js';
import { checkForFelanUpdate } from './update.js';

export interface RunLocalFelanOptions extends CreateLocalFelanRuntimeOptions {
  readonly initialMessage?: string;
  readonly verbose?: boolean;
}

export async function runLocalFelan(options: RunLocalFelanOptions = {}): Promise<void> {
  const runtime = await createLocalFelanRuntime(options);
  const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousPiSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
  const previousPiTelemetry = process.env.PI_TELEMETRY;
  process.env.PI_CODING_AGENT_DIR = runtime.services.agentDir;
  process.env.PI_SKIP_VERSION_CHECK = '1';
  process.env.PI_TELEMETRY = '0';

  try {
    const mode = new InteractiveMode(createToolActivityRuntimeView(runtime), {
      ...(options.initialMessage === undefined ? {} : { initialMessage: options.initialMessage }),
      ...(options.verbose === undefined ? {} : { verbose: options.verbose }),
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
      await mode.run();
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
    }
  }
}
