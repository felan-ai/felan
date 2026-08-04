import { Type, type TSchema } from 'typebox';
import type {
  FelanExtension,
  FelanExtensionAPI,
} from '@felan-ai/agent-core';
import type {
  SubagentDescriptor,
  SubagentError,
  SubagentHost,
  SubagentHostResult,
  SubagentSpawnRequest,
  SubagentThinking,
} from './contracts.js';
import { renderError, renderRecord, renderRecords } from './presentation.js';

const thinkingSchema = Type.Union([
  Type.Literal('off'),
  Type.Literal('minimal'),
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
  Type.Literal('xhigh'),
  Type.Literal('max'),
]);
const MAX_TURNS = 100;
const MAX_TIMEOUT_SECONDS = 86_400;
const MAX_WAIT_SECONDS = 3_600;

export function createSubagentsExtension(host: SubagentHost): FelanExtension {
  return (pi) => {
    registerAgent(pi, host);
    registerList(pi, host);
    registerResult(pi, host);
    registerSteer(pi, host);
    registerCancel(pi, host);
  };
}

function registerAgent(pi: FelanExtensionAPI, host: SubagentHost): void {
  const typeSchema = descriptorSchema(host.descriptors);
  const parameters = Type.Object({
    prompt: Type.String({ minLength: 1, description: 'Task for the child agent' }),
    description: Type.String({ minLength: 1, description: 'Short status label' }),
    subagent_type: typeSchema,
    model: Type.Optional(Type.String({ minLength: 1 })),
    thinking: Type.Optional(thinkingSchema),
    max_turns: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TURNS })),
    timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_SECONDS })),
    run_in_background: Type.Optional(Type.Boolean({ default: true })),
    inherit_context: Type.Optional(Type.Boolean({ default: false })),
  }, { additionalProperties: false });

  pi.registerTool({
    name: 'Agent',
    label: 'Agent',
    description: `Start a tracked child agent. Available types: ${host.descriptors.map((entry) => `${entry.id} (${entry.description})`).join(', ')}.`,
    promptSnippet: 'Start a tracked foreground or background child agent',
    parameters,
    async execute(_id, params, signal, _update, ctx) {
      const type = params.subagent_type as string;
      const descriptor = host.descriptors.find((entry) => entry.id === type);
      if (!descriptor) return toolError(error('unknown_agent_type', `unknown subagent type: ${type}`));
      const validation = validateSpawn(host, params);
      if (validation) return toolError(validation);
      const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const parentThinking = pi.getThinkingLevel() as SubagentThinking;
      const model = normalizeModel(params.model, descriptor, parentModel);
      if (!model.ok) return toolError(model.error);
      const request: SubagentSpawnRequest = {
        type,
        description: params.description,
        prompt: params.prompt,
        runInBackground: params.run_in_background ?? true,
        inheritContext: params.inherit_context ?? false,
        ...(model.value === undefined ? {} : { model: model.value }),
        ...(params.thinking ?? descriptor.defaultThinking ?? parentThinking) === undefined
          ? {}
          : { thinking: params.thinking ?? descriptor.defaultThinking ?? parentThinking },
        ...(params.max_turns ?? descriptor.defaultMaxTurns) === undefined
          ? {}
          : { maxTurns: params.max_turns ?? descriptor.defaultMaxTurns },
        ...(params.timeout_seconds ?? descriptor.defaultTimeoutSeconds) === undefined
          ? {}
          : { timeoutSeconds: params.timeout_seconds ?? descriptor.defaultTimeoutSeconds },
      };
      return executeHost(() => host.spawn(request, signal), renderRecord);
    },
  });
}

function registerList(pi: FelanExtensionAPI, host: SubagentHost): void {
  const parameters = Type.Object({
    include_descendants: Type.Optional(Type.Boolean({ default: false })),
  }, { additionalProperties: false });
  pi.registerTool({
    name: 'list_subagents',
    label: 'List Subagents',
    description: 'List tracked direct children or a read-only descendant view.',
    parameters,
    execute: async (_id, params, _signal, _update, _ctx) => executeHost(
      () => host.list({
        includeDescendants: params.include_descendants ?? false,
      }),
      renderRecords,
    ),
  });
}

function registerResult(pi: FelanExtensionAPI, host: SubagentHost): void {
  const parameters = Type.Object({
    agent_id: Type.String({ minLength: 1 }),
    wait: Type.Optional(Type.Boolean({ default: false })),
    timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WAIT_SECONDS })),
  }, { additionalProperties: false });
  pi.registerTool({
    name: 'get_subagent_result',
    label: 'Get Subagent Result',
    description: 'Read a direct child result without consuming its completion delivery.',
    parameters,
    execute: async (_id, params, signal, _update, _ctx) => executeHost(
      () => host.getResult(params.agent_id, {
        wait: params.wait ?? false,
        ...(params.timeout_seconds === undefined ? {} : { timeoutSeconds: params.timeout_seconds }),
      }, signal),
      renderRecord,
    ),
  });
}

function registerSteer(pi: FelanExtensionAPI, host: SubagentHost): void {
  const parameters = Type.Object({
    agent_id: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
  }, { additionalProperties: false });
  pi.registerTool({
    name: 'steer_subagent',
    label: 'Steer Subagent',
    description: 'Queue guidance for a direct child or resume a completed child.',
    parameters,
    async execute(_id, params, _signal, _update, _ctx) {
      if (byteLength(params.message) > host.policy.maxSteerBytes) {
        return toolError(error('invalid_request', `message exceeds ${host.policy.maxSteerBytes} bytes`));
      }
      return executeHost(
        () => host.steer(params.agent_id, params.message),
        renderRecord,
      );
    },
  });
}

function registerCancel(pi: FelanExtensionAPI, host: SubagentHost): void {
  const parameters = Type.Object({
    agent_id: Type.String({ minLength: 1 }),
    reason: Type.Optional(Type.String({ minLength: 1 })),
  }, { additionalProperties: false });
  pi.registerTool({
    name: 'cancel_subagent',
    label: 'Cancel Subagent',
    description: 'Idempotently cancel a direct child and its active descendants.',
    parameters,
    execute: async (_id, params, _signal, _update, _ctx) => executeHost(
      () => host.cancel(params.agent_id, params.reason),
      renderRecord,
    ),
  });
}

function validateSpawn(
  host: SubagentHost,
  params: {
    prompt: string;
    description: string;
    model?: string;
    thinking?: SubagentThinking;
  },
): SubagentError | undefined {
  if (byteLength(params.prompt) > host.policy.maxPromptBytes) {
    return error('invalid_request', `prompt exceeds ${host.policy.maxPromptBytes} bytes`);
  }
  if (byteLength(params.description) > host.policy.maxDescriptionBytes) {
    return error('invalid_request', `description exceeds ${host.policy.maxDescriptionBytes} bytes`);
  }
  if (params.model && !isCanonicalModelSelector(params.model)) {
    return error('unsupported_model', 'model must be inherit or an exact provider/model reference');
  }
}

function normalizeModel(
  requested: string | undefined,
  descriptor: SubagentDescriptor,
  parentModel: string | undefined,
): SubagentHostResult<string | undefined> {
  const selected = requested ?? descriptor.defaultModel ?? parentModel;
  if (selected !== 'inherit') return { ok: true, value: selected };
  if (!parentModel) return { ok: false, error: error('unsupported_model', 'parent has no model to inherit') };
  return { ok: true, value: parentModel };
}

function isCanonicalModelSelector(selector: string): boolean {
  if (selector === 'inherit') return true;
  const separator = selector.indexOf('/');
  return separator > 0 && separator < selector.length - 1;
}

async function executeHost<T>(
  operation: () => Promise<SubagentHostResult<T>>,
  render: (value: T) => string,
) {
  try {
    const result = await operation();
    if (!result.ok) return toolError(result.error);
    return {
      content: [{ type: 'text' as const, text: render(result.value) }],
      details: result.value,
    };
  } catch {
    return toolError(error('internal_error', 'The subagent host failed unexpectedly'));
  }
}

function toolError(hostError: SubagentError) {
  return {
    content: [{ type: 'text' as const, text: renderError(hostError) }],
    details: { error: hostError },
  };
}

function descriptorSchema(descriptors: readonly SubagentDescriptor[]): TSchema {
  if (descriptors.length === 0) return Type.String({ minLength: 1 });
  return Type.Union(descriptors.map((descriptor) => Type.Literal(descriptor.id)) as unknown as [TSchema, ...TSchema[]]);
}

function error(code: SubagentError['code'], message: string): SubagentError {
  return { code, message };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export { bindSubagentSession } from './session-binding.js';
export type {
  SubagentCompletionNotice,
  SubagentDescriptor,
  SubagentError,
  SubagentErrorCode,
  SubagentHost,
  SubagentHostResult,
  SubagentParentContextEntry,
  SubagentParentPort,
  SubagentPolicy,
  SubagentRecord,
  SubagentSpawnRequest,
  SubagentStatus,
  SubagentTerminalStatus,
  SubagentThinking,
} from './contracts.js';
