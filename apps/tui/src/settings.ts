import { SettingsManager } from '@felan-ai/agent-core';

export function createLocalSettingsManager(cwd: string, agentDir: string): SettingsManager {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const filteredResources = {
    packages: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  };
  const reload = settingsManager.reload.bind(settingsManager);
  const getGlobalSettings = settingsManager.getGlobalSettings.bind(settingsManager);
  const getProjectSettings = settingsManager.getProjectSettings.bind(settingsManager);

  settingsManager.applyOverrides(filteredResources);
  settingsManager.reload = async () => {
    await reload();
    settingsManager.applyOverrides(filteredResources);
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
