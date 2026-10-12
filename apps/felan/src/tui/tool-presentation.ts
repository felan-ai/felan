import { createCodexToolRenderers } from '@felan-ai/ext-codex/tui';
import { createCodebaseMemoryToolPresentation } from '@felan-ai/ext-codebase-memory/tui';
import { createTuiBackgroundBashHost } from '@felan-ai/ext-background-bash/tui';
import { createTuiAskUserHost } from '@felan-ai/ext-ask-user/tui';
import { taskRenderCalls } from '@felan-ai/ext-tasks/tui';
import type { AgentToolPresentation } from '../subagents/agent-transcript.js';

const codex = createCodexToolRenderers();
const background = createTuiBackgroundBashHost();
const askUser = createTuiAskUserHost().toolPresentation;
const codebaseTools = new Set(['codebase_memory', 'read_symbol', 'search_and_read_symbols', 'search_code']);

export function terminalToolPresentation(name: string): AgentToolPresentation | undefined {
  if (name === 'apply_patch') return codex.apply_patch;
  if (name === 'bash' && background.renderCall) return { renderCall: background.renderCall };
  if (name === 'ask_user') return askUser;
  const task = Object.hasOwn(taskRenderCalls, name) ? taskRenderCalls[name as keyof typeof taskRenderCalls] : undefined;
  if (task) return { renderCall: task };
  if (codebaseTools.has(name)) return createCodebaseMemoryToolPresentation('curated', name);
  return undefined;
}
