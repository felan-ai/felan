import { SECRETS_SERVICE, type ConfiguredFelanExtension, type FelanExtensionAPI } from '@felan-ai/agent-core';
import { createMcpExtension } from './index.js';
import { MCP_OAUTH_CALLBACK_SERVICE } from './service.js';
import { readLocalMcpConfig } from './local-config.js';
import { createLocalMcpOAuthHost } from './oauth-host.js';
import { canAuthorize, createAuthorizationPresenter } from './authorization.js';
export * from './index.js';

const extension = Object.assign(async (pi: FelanExtensionAPI) => {
  const secrets = pi.services.get(SECRETS_SERVICE);
  if (!secrets) throw new Error('MCP secrets service is unavailable.');
  const callback = pi.services.get(MCP_OAUTH_CALLBACK_SERVICE);
  const local = await readLocalMcpConfig(pi.runtime, pi.agentDir);
  await createMcpExtension({
    config: local.config,
    oauthHost: createLocalMcpOAuthHost(pi.agentDir, local.oauth, {
      secrets, canAuthorize: () => canAuthorize(pi.ui),
      ...(pi.runtime.getEnvironmentVariable ? { getEnvironmentVariable: pi.runtime.getEnvironmentVariable.bind(pi.runtime) } : {}),
      ...(callback ? { reserveCallback: callback.reserve.bind(callback),
        presentAuthorization: createAuthorizationPresenter(pi.ui, callback.openAuthorizationUrl?.bind(callback)) } : {}),
    }),
  })(pi);
  if (local.warnings.length > 0) pi.on('session_start', async () => {
    for (const text of local.warnings) await pi.ui.notify({ level: 'warning', text });
  });
}, { serviceRequirements: { required: [SECRETS_SERVICE], optional: [MCP_OAUTH_CALLBACK_SERVICE] } }) satisfies ConfiguredFelanExtension;

export default extension;
