import { InteractiveMode } from '@earendil-works/pi-coding-agent';
import { createLocalFelanRuntime, type CreateLocalFelanRuntimeOptions } from './runtime.js';

export interface RunLocalFelanOptions extends CreateLocalFelanRuntimeOptions {
  readonly initialMessage?: string;
  readonly verbose?: boolean;
}

export async function runLocalFelan(options: RunLocalFelanOptions = {}): Promise<void> {
  const runtime = await createLocalFelanRuntime(options);
  const mode = new InteractiveMode(runtime, {
    ...(options.initialMessage === undefined ? {} : { initialMessage: options.initialMessage }),
    ...(options.verbose === undefined ? {} : { verbose: options.verbose }),
  });

  try {
    await mode.run();
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
