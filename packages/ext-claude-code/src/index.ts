import {
  associateExtensionConfig,
  RUNTIME_DEPENDENCIES_SERVICE,
  type ConfiguredFelanExtension,
  type FelanExtension,
} from '@felan-ai/agent-core';
import { activateClaudeCodeBridge, claudeCodeSupportedModels, supportsPerTurnEffort } from './bridge/index.js';
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
    const supportedModels = await claudeCodeSupportedModels(settings).catch((error: unknown) => {
      pi.runtime.logger.warn(
        { error: errorMessage(error) },
        'Claude Code provider not registered: Claude Code did not list its models; check that Claude Code is signed in',
      );
      return undefined;
    });
    if (!supportedModels) return;
    activateClaudeCodeBridge(pi, { settings, agentDir: pi.agentDir, supportedModels });
    providerRegistered = true;
  } catch (error) {
    pi.runtime.logger.error(
      { error: errorMessage(error) },
      'Claude Code provider not registered: could not activate the bridge; run /claude-code install',
    );
  }
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default Object.assign(claudeCodeExtension, {
  serviceRequirements: { optional: [RUNTIME_DEPENDENCIES_SERVICE] },
  execution: (() => ({
    supportsNativeThinkingUpdates: supportsPerTurnEffort,
  })) satisfies NonNullable<ConfiguredFelanExtension['execution']>,
});
associateExtensionConfig(claudeCodeExtension, CLAUDE_CODE_CONFIG);

export { activateClaudeCodeBridge, claudeCodeSupportedModels } from './bridge/index.js';
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
