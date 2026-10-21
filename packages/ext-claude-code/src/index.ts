import { associateExtensionConfig, RUNTIME_DEPENDENCIES_SERVICE, type FelanExtension } from '@felan-ai/agent-core';
import { activateClaudeCodeBridge } from './bridge/index.js';
import { registerClaudeCodeCommand } from './command.js';
import { CLAUDE_CODE_CONFIG, claudeCodeSettingsFromConfig } from './config.js';
import { inspectClaudeCodeRuntime } from './managed/index.js';
import { loadClaudeAgentSdk, setClaudeAgentSdk } from './sdk/runtime.js';

const claudeCodeExtension: FelanExtension = async (pi) => {
  const settings = claudeCodeSettingsFromConfig(pi.config ?? {});
  let providerRegistered = false;
  registerClaudeCodeCommand(pi, {
    getSettings: () => settings,
    isProviderRegistered: () => providerRegistered,
  });
  if (pi.runtime.kind !== 'host') return;

  try {
    const status = await inspectClaudeCodeRuntime(pi.runtime);
    if (status.available === false) {
      pi.runtime.logger.warn({ reason: status.reason }, 'Claude Code provider not registered: SDK unavailable');
      return;
    }
    const sdk = await loadClaudeAgentSdk(status.entryPath);
    setClaudeAgentSdk(sdk);
    activateClaudeCodeBridge(pi, { settings, agentDir: pi.agentDir });
    providerRegistered = true;
  } catch (error) {
    pi.runtime.logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      'Claude Code provider not registered: could not activate the bridge; run /claude-code install',
    );
  }
};

export default Object.assign(claudeCodeExtension, { serviceRequirements: { optional: [RUNTIME_DEPENDENCIES_SERVICE] } });
associateExtensionConfig(claudeCodeExtension, CLAUDE_CODE_CONFIG);

export { activateClaudeCodeBridge } from './bridge/index.js';
export type { ClaudeCodeSettings } from './bridge/config.js';
export { CLAUDE_CODE_CONFIG, claudeCodeSettingsFromConfig } from './config.js';
export {
  MANAGED_CLAUDE_AGENT_SDK_VERSION,
  managedClaudeAgentSdkDirectory,
  inspectClaudeCodeRuntime,
  installManagedClaudeAgentSdk,
} from './managed/index.js';
export type { ClaudeCodeRuntimeStatus } from './managed/index.js';
export {
  CLAUDE_AGENT_SDK_ENTRY_FILE,
  CLAUDE_AGENT_SDK_ENTRY_SOURCE,
  claudeAgentSdk,
  loadClaudeAgentSdk,
  setClaudeAgentSdk,
} from './sdk/runtime.js';
export type { ClaudeAgentSdk } from './sdk/runtime.js';
