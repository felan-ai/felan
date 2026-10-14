import { shellExecutionMessage } from './shell-execution.js';
import type { AgentViewTranscript } from '../subagents/types.js';
import { COMPACTION_MESSAGE_TYPE, parseCompactionPresentation } from '@felan-ai/ext-session-compaction/view';
import type { Message, SessionSnapshot } from '@felan-ai/session-protocol';
import { projectedNativeMessage, projectedStreamingContent, projectedStreamingMessage } from '../client/message-display.js';

export function projectTuiTranscript(snapshot: SessionSnapshot, history: readonly Message[], settings: AgentViewTranscript['settings']): AgentViewTranscript {
  const messages: AgentViewTranscript['messages'] = [];
  const fallbacks: NonNullable<AgentViewTranscript['fallbacks']> = [];
  const compactions: NonNullable<AgentViewTranscript['compactions']> = [];
  for (const item of history) {
    try {
      const message = projectedNativeMessage(item);
      if (message) messages.push(message);
      else if (item.customType === COMPACTION_MESSAGE_TYPE) {
        const metadata = parseCompactionPresentation(item.details);
        if (metadata.method) compactions.push({ message: messages.length, method: metadata.method });
        messages.push({ role: 'compactionSummary', summary: messageText(item), tokensBefore: metadata.tokensBefore, timestamp: item.timestamp });
      } else if (['user', 'assistant', 'tool'].includes(item.role)) fallbacks.push({ before: messages.length, text: `${item.role}:\n\n${messageText(item)}` });
    } catch {
      fallbacks.push({ before: messages.length, text: `[Display metadata unavailable]\n${item.role}:\n\n${messageText(item)}` });
    }
  }
  let streaming: AgentViewTranscript['streaming'];
  try { streaming = projectedStreamingMessage(snapshot); } catch { streaming = undefined; }
  const streamingContent = streaming ? undefined : projectedStreamingContent(snapshot);
  const runningShells: number[] = [];
  for (const item of snapshot.presentation) {
    const message = shellExecutionMessage(item);
    if (!message) continue;
    runningShells.push(messages.length);
    messages.push(message);
  }
  return { agentId: snapshot.session, cwd: snapshot.cwd, messages, pendingTools: snapshot.tools.filter(tool => tool.state === 'running').map(tool => tool.id),
    settings, tools: snapshot.tools, fallbacks, compactions, runningShells, ...(streaming ? { streaming } : {}), ...(streamingContent ? { streamingContent } : {}) };
}

function messageText(message: Message): string {
  return message.content.flatMap(part => part.type === 'text' || part.type === 'thinking' || part.type === 'tool_result' ? [part.text]
    : part.type === 'resource_link' ? [part.uri] : part.type === 'image' ? ['[Image]'] : []).join('\n');
}
