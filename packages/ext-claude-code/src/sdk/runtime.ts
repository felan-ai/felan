import { pathToFileURL } from 'node:url';
import type { ClaudeAgentSdk } from './types.js';

export type { ClaudeAgentSdk } from './types.js';

export const CLAUDE_AGENT_SDK_ENTRY_FILE = 'felan-claude-agent-sdk.mjs';
export const CLAUDE_AGENT_SDK_ENTRY_SOURCE = `export { query } from '@anthropic-ai/claude-agent-sdk';
export { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
`;

let sdk: ClaudeAgentSdk | undefined;

export async function loadClaudeAgentSdk(entryPath: string): Promise<ClaudeAgentSdk> {
  let loaded: Record<string, unknown>;
  try {
    loaded = await import(pathToFileURL(entryPath).href) as Record<string, unknown>;
  } catch (cause) {
    throw new Error('Could not load Claude Agent SDK; run /claude-code install', { cause });
  }

  for (const name of ['query', 'McpServer'] as const) {
    if (typeof loaded[name] !== 'function') {
      throw new Error(`Invalid Claude Agent SDK: missing ${name} export; run /claude-code install`);
    }
  }
  for (const name of ['CallToolRequestSchema', 'ListToolsRequestSchema'] as const) {
    if (typeof loaded[name] !== 'object' || loaded[name] === null) {
      throw new Error(`Invalid Claude Agent SDK: missing ${name} export; run /claude-code install`);
    }
  }
  return loaded as unknown as ClaudeAgentSdk;
}

export function setClaudeAgentSdk(value: ClaudeAgentSdk | undefined): void {
  sdk = value;
}

export function claudeAgentSdk(): ClaudeAgentSdk {
  if (!sdk) throw new Error('Claude Agent SDK is not installed; run /claude-code install');
  return sdk;
}
