import { VERSION as PI_VERSION } from '@earendil-works/pi-coding-agent';
import { SettingsManager } from '@felan-ai/agent-core';
import type { BuiltinExtensionSettings } from './extensions.js';
import type { LocalSubagentSettings } from './subagents/host.js';

export interface FelanSettings {
  readonly builtinExtensions?: BuiltinExtensionSettings;
  readonly felanSubagents?: LocalSubagentSettings;
}

export function createLocalSettingsManager(cwd: string, agentDir: string): SettingsManager {
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  // Felan's fixed resource policy makes Pi project trust unnecessary.
  settingsManager.isProjectTrusted = () => true;
  settingsManager.setProjectTrusted = () => {};
  const filteredResources = {
    packages: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  };
  const runtimeOverrides = {
    ...filteredResources,
    enableInstallTelemetry: false,
    lastChangelogVersion: PI_VERSION,
  };
  const reload = settingsManager.reload.bind(settingsManager);
  const getGlobalSettings = settingsManager.getGlobalSettings.bind(settingsManager);
  const getProjectSettings = settingsManager.getProjectSettings.bind(settingsManager);

  settingsManager.applyOverrides(runtimeOverrides);
  settingsManager.reload = async () => {
    await reload();
    settingsManager.applyOverrides(runtimeOverrides);
  };
  settingsManager.getGlobalSettings = () => ({
    ...getGlobalSettings(),
    ...filteredResources,
  });
  settingsManager.getProjectSettings = () => ({
    ...getProjectSettings(),
    ...filteredResources,
  });
  return settingsManager;
}

export function getFelanSettings(settingsManager: SettingsManager): FelanSettings {
  return settingsManager.getGlobalSettings() as FelanSettings;
}
