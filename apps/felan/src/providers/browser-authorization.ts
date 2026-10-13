import { defineServiceProvider } from '@felan-ai/daemon/provider';
import { BROWSER_AUTHORIZATION_SERVICE, type BrowserAuthorizationService } from '@felan-ai/ext-browser/service';
import { createLocalBrowserAuthorizationHost } from './browser/authorization-host.js';
import { createBrowserAuthorizationPresentation } from './ui/extension-ui.js';
import { openBrowserSetup } from './setup-open.js';
import { setExtensionConfigValue } from './settings.js';

export default defineServiceProvider({
  scope: 'session',
  provides: [BROWSER_AUTHORIZATION_SERVICE],
  async create(provider) {
    if (!provider.execution) throw new Error('Browser authorization requires a session execution port.');
    const { context, port } = provider.execution;
    const presentation = createBrowserAuthorizationPresentation({ port: port.ui,
      openBrowserSetup: (path, signal) => openBrowserSetup(context.runtime, path, signal) });
    const browserOverride = [...context.extensionConfigOverrides].reverse()
      .find(row => row.extensionId === 'browser' && Object.hasOwn(row.values, 'authorizationPolicy'))?.values.authorizationPolicy;
    const value: BrowserAuthorizationService = {
      checkExecution: () => createLocalBrowserAuthorizationHost().checkExecution?.(),
      authorize: request => createLocalBrowserAuthorizationHost({
        runtime: context.runtime, presentation,
        getAuthorizationPolicy: () => request.authorizationPolicy,
        persistAuthorizationPolicy: async policy => {
          if (browserOverride !== undefined) throw new Error('Browser policy is overridden for this session.');
          port.assertCurrent(); await setExtensionConfigValue(context.resources.agentDir, 'browser', 'authorizationPolicy', policy);
          port.assertCurrent(); await context.settingsManager.reload();
        },
      }).authorize(request),
    };
    return { implementations: [{ contract: BROWSER_AUTHORIZATION_SERVICE, value }], async dispose() {} };
  },
});
