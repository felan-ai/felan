import { AGENT_VIEW_PRESENTER, parseAgentOpenRequest, parseAgentOpenResult } from '@felan-ai/ext-subagents/view';
import type { Interaction } from '@felan-ai/session-protocol';
import type { LocalSubagentPresentationHost } from '../subagents/presentation.js';
import type { BrokerOutcome } from './broker.js';

export function createAgentPresentation(options: {
  signal: AbortSignal;
  request(value: Interaction['request']): Promise<BrokerOutcome>;
  unsupported(surface: string): never;
}): LocalSubagentPresentationHost {
  return { register(pi) {
    pi.registerCommand('agents', { description: 'Open the subagent navigator', async handler(args) {
      options.signal.throwIfAborted();
      const request = parseAgentOpenRequest(args.trim() ? { agentId: args.trim() } : {});
      const result = await options.request({ kind: 'custom', presenter: AGENT_VIEW_PRESENTER, data: request });
      if (result.state !== 'answered') {
        if (result.state === 'cancelled' && result.reason === 'unsupported') options.unsupported('agent navigator');
        return;
      }
      if (result.answer.kind !== 'custom') throw new Error('Invalid agent navigator answer.');
      parseAgentOpenResult(result.answer.data);
    } });
  } };
}
