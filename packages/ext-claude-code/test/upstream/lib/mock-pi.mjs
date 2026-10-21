import { activateClaudeCodeBridge } from '../../../src/bridge/index.ts';

export function activateWithMockPi(activateFn = activateClaudeCodeBridge, settings = {}) {
  const handlers = new Map();
  activateFn({
    on: (event, handler) => handlers.set(event, handler),
    registerProvider: () => {},
  }, { settings, agentDir: process.env.PI_CODING_AGENT_DIR });
  return handlers;
}
