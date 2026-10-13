import {
  createAssistantMessageEventStream,
  createExtensionServiceAccess,
  createFelanServiceRegistry,
  normalizeContext,
  resolveExtensionConfigs,
  type Api,
  type Model,
  type StreamFunction,
} from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import rootExtension from '../../../../packages/ext-codex/src/index.js';
import runtimeExtension, { CODEX_CONFIG, createCodexExtension } from '../../../../packages/ext-codex/src/runtime.js';

describe('Codex execution contribution', () => {
  it.each([
    ['root', rootExtension],
    ['runtime', runtimeExtension],
    ['factory', createCodexExtension()],
  ] as const)('carries configured transport and native thinking support through the %s entry', (_entry, extension) => {
    const config = resolveExtensionConfigs([CODEX_CONFIG], [{
      extensionId: 'codex', source: 'test', values: {
        priority: 'ultrafast', verbosity: 'high', forceCachedWebSockets: true,
      },
    }]).get('codex')!;
    const contribution = extension.execution!({
      config, services: createExtensionServiceAccess(createFelanServiceRegistry(), {}),
    });
    const original = vi.fn<StreamFunction>(() => createAssistantMessageEventStream());
    const wrapped = contribution.wrapStreamFunction!(original);
    const model = { provider: 'openai-codex', id: 'gpt-6-astra', api: 'openai-codex-responses' } as Model<Api>;
    wrapped(model, normalizeContext({ messages: [] }), { transport: 'websocket' });
    expect(original).toHaveBeenCalledOnce();
    expect(original.mock.calls[0]?.[2]).toMatchObject({
      transport: 'websocket-cached', serviceTier: 'ultrafast', textVerbosity: 'high',
    });
    expect(contribution.supportsNativeThinkingUpdates!(model)).toBe(true);
    expect(contribution.supportsNativeThinkingUpdates!({ ...model, provider: 'openai', api: 'openai-responses' })).toBe(true);
    expect(contribution.supportsNativeThinkingUpdates!({ ...model, provider: 'custom' })).toBe(false);
    expect(contribution.supportsNativeThinkingUpdates!({ ...model, id: 'other-model' })).toBe(false);
    expect(contribution.supportsNativeThinkingUpdates!({ ...model, api: 'openai-completions' })).toBe(false);
  });

  it('keeps configuration session-local and leaves other providers unchanged', () => {
    const extension = createCodexExtension();
    const createContribution = (values: Record<string, unknown>) => extension.execution!({
      config: resolveExtensionConfigs([CODEX_CONFIG], [{ extensionId: 'codex', source: 'test', values }]).get('codex')!,
      services: createExtensionServiceAccess(createFelanServiceRegistry(), {}),
    });
    const first = vi.fn<StreamFunction>(() => createAssistantMessageEventStream());
    const second = vi.fn<StreamFunction>(() => createAssistantMessageEventStream());
    const firstWrapped = createContribution({ priority: 'fast', verbosity: 'high' }).wrapStreamFunction!(first);
    const secondWrapped = createContribution({ priority: 'normal', forceCachedWebSockets: false }).wrapStreamFunction!(second);
    const model = { provider: 'openai-codex', id: 'gpt-6-astra', api: 'openai-codex-responses' } as Model<Api>;
    const context = normalizeContext({ messages: [] });
    const options = { transport: 'websocket' as const };
    firstWrapped(model, context, options);
    secondWrapped(model, context, options);
    expect(first.mock.calls[0]?.[2]).toMatchObject({
      transport: 'websocket-cached', serviceTier: 'priority', textVerbosity: 'high',
    });
    expect(second.mock.calls[0]?.[2]).toMatchObject({
      transport: 'websocket', serviceTier: 'default', textVerbosity: 'low',
    });
    firstWrapped({ ...model, provider: 'custom' }, context, options);
    expect(first.mock.calls[1]?.[2]).toBe(options);
    expect(options).toEqual({ transport: 'websocket' });
  });
});
