import { InteractiveMode } from '@earendil-works/pi-coding-agent';
import {
  createLocalFelanRuntime,
  type CreateLocalFelanRuntimeOptions,
} from './runtime.js';
import { attachLocalSubagentPresenter } from './subagents/presenter.js';

export interface RunLocalFelanOptions extends CreateLocalFelanRuntimeOptions {
  readonly initialMessage?: string;
  readonly verbose?: boolean;
}

export async function runLocalFelan(options: RunLocalFelanOptions = {}): Promise<void> {
  const runtime = await createLocalFelanRuntime(options);
  const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = runtime.services.agentDir;

  try {
    const mode = new InteractiveMode(runtime, {
      ...(options.initialMessage === undefined ? {} : { initialMessage: options.initialMessage }),
      ...(options.verbose === undefined ? {} : { verbose: options.verbose }),
    });
    const detachPresenter = attachLocalSubagentPresenter(
      runtime,
      mode as unknown as Parameters<typeof attachLocalSubagentPresenter>[1],
    );
    try {
      await mode.run();
    } finally {
      detachPresenter();
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
    }
  }
}
