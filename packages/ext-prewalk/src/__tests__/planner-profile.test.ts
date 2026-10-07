import type { ExtensionContext } from '@felan-ai/agent-core';
import { describe, expect, it } from 'vitest';
import { plannerProfiles } from '../planner-profile.js';

const lower = { provider: 'openai-codex', id: 'gpt-6-luna', reasoning: true } as any;
const planner = { provider: 'openai-codex', id: 'gpt-6-sol', reasoning: true,
  thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } } as any;
const stronger = { provider: 'openai-codex', id: 'gpt-6-astra', reasoning: true } as any;
const otherProvider = { provider: 'anthropic', id: 'claude-opus-4-6', reasoning: true } as any;

function context(models: any[], options: { current?: any; scope?: any[]; authenticated?: any[] } = {}) {
  return {
    model: options.current ?? lower,
    scopedModels: (options.scope ?? []).map(model => ({ model })),
    modelRegistry: {
      getAvailable: () => options.authenticated ?? models,
      hasConfiguredAuth: (model: any) => (options.authenticated ?? models).includes(model),
    },
  } as unknown as ExtensionContext;
}

describe('planner profiles', () => {
  it.each(['off', 'low', 'medium'])('starts planning at high when current effort is %s', effort => {
    const profiles = plannerProfiles(context([lower, planner, stronger]), effort);

    expect(profiles[0]).toEqual({ model: planner, tier: 'high', thinking: 'high' });
    expect(profiles).toEqual([
      { model: planner, tier: 'high', thinking: 'high' },
      { model: planner, tier: 'high', thinking: 'xhigh' },
      { model: planner, tier: 'high', thinking: 'max' },
      { model: stronger, tier: 'xhigh', thinking: 'high' },
    ]);
  });

  it.each(['high', 'xhigh', 'max'])('preserves supported current %s effort as the static first choice', effort => {
    const profiles = plannerProfiles(context([lower, planner, stronger], { current: planner }), effort);

    expect(profiles[0]).toEqual({ model: planner, tier: 'high', thinking: effort });
    expect(new Set(profiles.map(profile => `${profile.model.id}/${profile.thinking}`)).size).toBe(profiles.length);
  });

  it('preserves an already capable xhigh model before another high model', () => {
    expect(plannerProfiles(context([planner, stronger], { current: stronger }), 'high')[0])
      .toEqual({ model: stronger, tier: 'xhigh', thinking: 'high' });
  });

  it('never substitutes an authenticated high model on another provider', () => {
    expect(plannerProfiles(context([lower, otherProvider]), 'high')).toEqual([]);
  });

  it('uses only authenticated models within a nonempty session scope', () => {
    expect(plannerProfiles(context([lower, planner, stronger], {
      scope: [lower, planner, stronger], authenticated: [lower, stronger],
    }), 'medium')).toEqual([{ model: stronger, tier: 'xhigh', thinking: 'high' }]);
    expect(plannerProfiles(context([lower, planner], { scope: [lower] }), 'medium')).toEqual([]);
  });

  it('falls back to a supported xhigh-tier model when the preferred high model cannot reason', () => {
    const unsupported = { ...planner, reasoning: false };
    expect(plannerProfiles(context([lower, unsupported, stronger]), 'medium'))
      .toEqual([{ model: stronger, tier: 'xhigh', thinking: 'high' }]);
  });

  it('uses another capable high model when the preferred high model cannot support planning effort', () => {
    const unsupported = { ...planner, thinkingLevelMap: { high: null, xhigh: null, max: null } };
    const capable = { provider: 'openai-codex', id: 'gpt-5.5', reasoning: true } as any;

    expect(plannerProfiles(context([unsupported, capable], { current: unsupported }), 'medium'))
      .toEqual([{ model: capable, tier: 'high', thinking: 'high' }]);
  });

  it('does not expose clamped or unsupported planning efforts', () => {
    const highOnly = { ...planner, thinkingLevelMap: undefined };
    expect(plannerProfiles(context([lower, highOnly]), 'max'))
      .toEqual([{ model: highOnly, tier: 'high', thinking: 'high' }]);
    const lowOnly = { ...planner, thinkingLevelMap: { high: null, xhigh: null, max: null } };
    expect(plannerProfiles(context([lower, lowOnly]), 'medium')).toEqual([]);
  });

  it('returns no profiles without a selected model', () => {
    const ctx = { ...context([planner]), model: undefined } as ExtensionContext;
    expect(plannerProfiles(ctx, 'high')).toEqual([]);
  });
});
