import { InteractiveMode } from '@earendil-works/pi-coding-agent';
import {
  createLocalFelanRuntime,
  type CreateLocalFelanRuntimeOptions,
} from './runtime.js';
import { createToolActivityRuntimeView } from './tool-activity/runtime-view.js';

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
    await mode.run();
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
