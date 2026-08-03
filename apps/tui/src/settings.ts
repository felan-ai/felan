import { SettingsManager } from '@felan-ai/agent-core';

export function createLocalSettingsManager(cwd: string, agentDir: string): SettingsManager {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  settingsManager.applyOverrides({
    packages: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  });
  return settingsManager;
}
