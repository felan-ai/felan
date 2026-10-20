import { SESSIONS_HISTORY_SERVICE, type ConfiguredFelanExtension, type FelanExtensionAPI } from '@felan-ai/agent-core';
import { createInsightsExtension } from './index.js';
import { createSessionsInsights } from './sessions.js';
export * from './index.js';

const extension = Object.assign((pi: FelanExtensionAPI) => {
  const sessions = pi.services.get(SESSIONS_HISTORY_SERVICE);
  if (!sessions) throw new Error(`Required service ${SESSIONS_HISTORY_SERVICE.key} has no configured provider.`);
  const lifetime = new AbortController();
  const host = createSessionsInsights(sessions, pi.ui, lifetime.signal);
  createInsightsExtension(host, { ui: pi.ui, signal: lifetime.signal })(pi);
  pi.on('session_shutdown', async () => { lifetime.abort(); await host.dispose(); });
}, { serviceRequirements: { required: [SESSIONS_HISTORY_SERVICE] } }) as ConfiguredFelanExtension;

export default extension;
