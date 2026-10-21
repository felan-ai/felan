import type { SetupDependency } from '@felan-ai/daemon/session-runtime';
import { inspectBackgroundBashRuntime } from '@felan-ai/ext-background-bash';
import { inspectAgentBrowserRuntime, installManagedAgentBrowser, MANAGED_AGENT_BROWSER_VERSION } from '@felan-ai/ext-browser';
import { inspectClaudeCodeRuntime, installManagedClaudeAgentSdk, MANAGED_CLAUDE_AGENT_SDK_VERSION } from '@felan-ai/ext-claude-code';
import { inspectCodebaseMemoryRuntime, installManagedCodebaseMemory, MANAGED_CODEBASE_MEMORY_VERSION } from '@felan-ai/ext-codebase-memory';
import { detectMarkitdown, installManagedMarkitdown } from '@felan-ai/ext-markitdown';
import { inspectRtkRuntime, installManagedRtk, MANAGED_RTK_VERSION } from '@felan-ai/ext-rtk-optimizer';
export const setupDependencies: readonly SetupDependency[] = [
  { id: 'background-bash', extension: 'backgroundBash', revision: 1, label: 'Background processes',
    description: 'Detached processes require standard POSIX shell and process utilities. No OS utilities will be installed.',
    check: async runtime => { const result = await inspectBackgroundBashRuntime(runtime); return result.available ? { available: true } : { available: false, reason: result.reason }; } },
  { id: 'agent-browser', extension: 'browser', revision: 2, label: 'agent-browser',
    description: `Download and verify reviewed agent-browser ${MANAGED_AGENT_BROWSER_VERSION} in Felan agent storage.`,
    check: async runtime => { const result = await inspectAgentBrowserRuntime(runtime); return result.available ? { available: true, version: result.invocation.version } : { available: false, reason: result.reason }; },
    install: installManagedAgentBrowser },
  { id: 'claude-code', extension: 'claudeCode', revision: 1, label: 'Claude Code',
    description: `Download the pinned Claude Agent SDK ${MANAGED_CLAUDE_AGENT_SDK_VERSION} (~225 MB) and its MCP peers into Felan agent storage under Anthropic's terms. Requires a Claude Code login.`,
    check: inspectClaudeCodeRuntime,
    install: installManagedClaudeAgentSdk },
  { id: 'codebase-memory', extension: 'codebaseMemory', revision: 2, label: 'Codebase Memory',
    description: `Verify the pinned official installer and install Codebase Memory ${MANAGED_CODEBASE_MEMORY_VERSION} in agent storage.`,
    check: async runtime => { const result = await inspectCodebaseMemoryRuntime(runtime); return result.available ? { available: true, version: result.invocation.version } : { available: false, reason: result.reason }; },
    install: installManagedCodebaseMemory },
  { id: 'markitdown', extension: 'markitdown', revision: 1, label: 'MarkItDown',
    description: 'Create a private Python environment and install the pinned MarkItDown 0.1.7 document extras.',
    check: async runtime => { const result = await detectMarkitdown(runtime); return result.available ? { available: true, version: result.invocation.version } : { available: false, reason: result.reason }; },
    install: installManagedMarkitdown },
  { id: 'rtk', extension: 'rtkOptimizer', revision: 1, label: 'RTK',
    description: `Verify the pinned official installer and install RTK ${MANAGED_RTK_VERSION} in agent storage.`,
    check: async runtime => { const result = await inspectRtkRuntime(runtime); return { available: result.rtkAvailable,
      ...(result.version === undefined ? {} : { version: result.version }), ...(result.lastError === undefined ? {} : { reason: result.lastError }) }; },
    install: installManagedRtk },
];
