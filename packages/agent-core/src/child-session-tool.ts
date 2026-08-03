import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentChildSessionResult, AgentSessionHost } from './session.js';

const childSessionParameters = Type.Object({
  personaId: Type.String({ description: 'Persona or role for the child agent' }),
  prompt: Type.String({ description: 'Task for the child agent' }),
  block: Type.Optional(Type.Boolean({ description: 'Wait for the child result', default: true })),
  model: Type.Optional(Type.String({ description: 'Optional provider/model override' })),
  timeoutMinutes: Type.Optional(Type.Integer({ minimum: 1 })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export function createChildSessionTool(
  host: AgentSessionHost,
): ToolDefinition<typeof childSessionParameters, AgentChildSessionResult> {
  return {
    name: 'spawn_agent',
    label: 'Spawn Agent',
    description: 'Spawn a portable child agent through the application host and optionally wait for its result.',
    promptSnippet: 'Delegate an isolated task to a child agent',
    promptGuidelines: [
      'Use spawn_agent when an isolated child agent can handle a self-contained task in parallel or with a separate context.',
    ],
    parameters: childSessionParameters,
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      if (signal?.aborted) throw new Error('Child session spawn aborted');
      const sessionId = context.sessionManager.getSessionId();
      const model = params.model
        ?? (context.model ? `${context.model.provider}/${context.model.id}` : undefined);
      const result = await host.createChildSession({
        rootSessionId: sessionId,
        parentSessionId: sessionId,
        personaId: params.personaId,
        prompt: params.prompt,
        block: params.block ?? true,
        ...(model === undefined ? {} : { model }),
        ...(params.timeoutMinutes === undefined ? {} : { timeoutMinutes: params.timeoutMinutes }),
        ...(params.metadata === undefined ? {} : { metadata: params.metadata }),
      });
      if (!result.ok) {
        throw new Error(result.error ?? result.message ?? 'Child session failed');
      }

      const text = result.result
        ?? result.message
        ?? `Child session ${result.sessionId} is ${result.status}`;
      return {
        content: [{ type: 'text', text }],
        details: result,
      };
    },
  };
}
