import { createCodexToolRenderers } from './renderers/codex.js';
import { createCodebaseMemoryToolPresentation } from './renderers/codebase-memory.js';
import { renderBackgroundBashCall } from './renderers/processes.js';
import { askUserToolPresentation } from './renderers/ask-user.js';
import { taskRenderCalls } from './renderers/tasks.js';
import type { AgentToolPresentation } from '../subagents/agent-transcript.js';

const codex = createCodexToolRenderers();
const codebaseTools = new Set(['codebase_memory', 'read_symbol', 'search_and_read_symbols', 'search_code']);

export function terminalToolPresentation(name: string): AgentToolPresentation | undefined {
  if (name === 'apply_patch') return codex.apply_patch;
  if (name === 'bash') return { renderCall: renderBackgroundBashCall };
  if (name === 'ask_user') return askUserToolPresentation;
  const task = Object.hasOwn(taskRenderCalls, name) ? taskRenderCalls[name as keyof typeof taskRenderCalls] : undefined;
  if (task) return { renderCall: task };
  if (codebaseTools.has(name)) return createCodebaseMemoryToolPresentation('curated', name);
  return undefined;
}
