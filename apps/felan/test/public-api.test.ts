import { expect, it } from 'vitest';
import * as client from '../src/index.js';

it('exposes daemon clients without legacy execution or store ownership APIs', () => {
  for (const name of ['runCli', 'runDaemonFelan', 'runLocalFelanHeadless', 'clientDaemonTarget', 'clientConfigurationRoot',
    'getClientAgentDir', 'SessionClient', 'newRequestId', 'resolveInstalledDaemonEntrypoint']) {
    expect(client).toHaveProperty(name, expect.any(Function));
  }
  expect(client.FELAN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  for (const name of ['runLocalFelan', 'createLocalFelanRuntime', 'createLocalModelRuntime', 'createLocalSessionRuntimeFactory',
    'openLocalSessionManager', 'selectLocalSessionManager', 'createLocalSettingsManager', 'getFelanSettings',
    'createLocalClassifier', 'selectLocalClassifierModel', 'LocalMemoryCoordinator', 'LocalSubagentHost',
    'localMemoryProjectDirectory', 'resolveLocalMemoryProject', 'loadLocalAppendSystemPrompt',
    'builtinExtensionPackages', 'localExtensionPackages', 'importLocalExtension', 'resolveBuiltinExtensionPackages']) {
    expect(client).not.toHaveProperty(name);
  }
});
