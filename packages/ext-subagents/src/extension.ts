import { SESSIONS_SERVICE, type ConfiguredFelanExtension, type FelanExtensionAPI } from '@felan-ai/agent-core';
import { createSubagentsExtension } from './index.js';
import { discoverSubagents } from './catalog.js';
export * from './index.js';

const extension = Object.assign(async (pi: FelanExtensionAPI) => {
  const sessions = pi.services.get(SESSIONS_SERVICE)!;
  const definitions = await discoverSubagents(pi.runtime, pi.agentDir);
  return createSubagentsExtension(sessions, definitions)(pi);
}, { serviceRequirements: { required: [SESSIONS_SERVICE] } }) as ConfiguredFelanExtension;

export default extension;
