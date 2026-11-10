import { activateClaudeCodeBridge } from '../../../src/bridge/index.ts';
import { catalogModelRows } from './catalog-models.mjs';

export function activateWithMockPi(activateFn = activateClaudeCodeBridge, settings = {}) {
  const handlers = new Map();
  activateFn({
    on: (event, handler) => handlers.set(event, handler),
    registerProvider: () => {},
  }, { settings, agentDir: process.env.PI_CODING_AGENT_DIR, supportedModels: catalogModelRows });
  return handlers;
}
