import type { AgentSession } from '@felan-ai/agent-core';
import { ProtocolValidationError, parseMessageDisplay, type MessageDisplay } from '@felan-ai/session-protocol';

export function messageDisplay(message: AgentSession['messages'][number]): MessageDisplay | undefined {
  try {
    if (message.role === 'toolResult') return parseMessageDisplay({ kind: 'tool', name: message.toolName, timestamp: message.timestamp });
    if (message.role !== 'assistant') return undefined;
    const usage = message.usage;
    return parseMessageDisplay({ kind: 'assistant', timestamp: message.timestamp, api: message.api, provider: message.provider, model: message.model,
      stopReason: message.stopReason, ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
      usage: { input: usage?.input, output: usage?.output, cacheRead: usage?.cacheRead, cacheWrite: usage?.cacheWrite, totalTokens: usage?.totalTokens,
        cost: { input: usage?.cost?.input, output: usage?.cost?.output, cacheRead: usage?.cost?.cacheRead, cacheWrite: usage?.cost?.cacheWrite, total: usage?.cost?.total } } });
  } catch (error) {
    if (error instanceof ProtocolValidationError) return undefined;
    throw error;
  }
}
