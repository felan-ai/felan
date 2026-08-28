import type { FelanExtensionAPI } from '@felan-ai/agent-core';
import type { CbmClient } from '../cbm/client.js';
import type { OutputService } from '../domain/output.js';
import type { ProjectService } from '../domain/project.js';
import type { QueryService } from '../domain/query.js';
import type { SymbolService } from '../domain/symbols.js';
import { createProxyTool } from './proxy.js';
import { createReadSymbolTool } from './read-symbol.js';
import { createSearchAndReadSymbolsTool } from './search-and-read-symbols.js';
import { createSearchCodeTool } from './search-code.js';
import type { CodebaseMemorySessionState } from '../extension/session-state.js';

export function registerCbmTools(
  pi: FelanExtensionAPI,
  services: { cbm: CbmClient; projects: ProjectService; output: OutputService; query: QueryService; symbols: SymbolService; state: CodebaseMemorySessionState },
): void {
  const guard = () => services.state.assertEnabled();
  pi.registerTool(createProxyTool(services.cbm, services.projects, services.output, guard));
  pi.registerTool(createReadSymbolTool(services.symbols, guard));
  pi.registerTool(createSearchAndReadSymbolsTool(services.symbols, guard));
  pi.registerTool(createSearchCodeTool(services.query, guard));
}
