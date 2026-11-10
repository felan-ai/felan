import { describe, expect, it } from 'vitest';
import { resolveExtensionConfigs } from '@felan-ai/agent-core';
import { CODEX_CONFIG, type CodexConfig, DEFAULT_CODEX_CONFIG, validateCodexConfig } from '../src/index.js';

describe('Codex configuration', () => {
  it('marks the legacy boolean deprecated without dropping stored values', () => {
    expect(CODEX_CONFIG.fields.fast.deprecated).toEqual(expect.stringContaining('priority'));
    expect(resolveExtensionConfigs([CODEX_CONFIG], [{
      extensionId: 'codex', values: { fast: true }, source: 'settings',
    }]).get('codex')).toEqual(validateCodexConfig({ fast: true }));
  });

  it('provides the normal settings defaults', () => {
    expect(DEFAULT_CODEX_CONFIG).toEqual({
      fast: false,
      verbosity: 'low',
      forceCachedWebSockets: true,
      postAgentRunCompaction: true,
      imageGeneration: true,
    });
  });

  it('validates programmatic settings', () => {
    expect(validateCodexConfig({
      fast: true,
      verbosity: 'high',
      forceCachedWebSockets: false,
      postAgentRunCompaction: false,
      imageGeneration: false,
    }, 'settings.json.extensionConfig.codex')).toEqual({
      fast: true,
      verbosity: 'high',
      forceCachedWebSockets: false,
      postAgentRunCompaction: false,
      imageGeneration: false,
    });
    expect(() => validateCodexConfig({ verbosity: 'max' }, 'settings.json.extensionConfig.codex'))
      .toThrow('settings.json.extensionConfig.codex.verbosity must be low, medium, or high');
    expect(() => validateCodexConfig({ fast: 'yes' }, 'settings.json.extensionConfig.codex'))
      .toThrow('settings.json.extensionConfig.codex.fast must be a boolean');
    expect(() => validateCodexConfig({ postAgentRunCompaction: 'yes' }, 'settings.json.extensionConfig.codex'))
      .toThrow('settings.json.extensionConfig.codex.postAgentRunCompaction must be a boolean');
  });

  it('declares and validates the image generation setting', () => {
    expect(CODEX_CONFIG.fields.imageGeneration.default).toBe(true);
    expect(validateCodexConfig({}).imageGeneration).toBe(true);
    for (const imageGeneration of [true, false]) {
      expect(validateCodexConfig({ imageGeneration }).imageGeneration).toBe(imageGeneration);
      expect(resolveExtensionConfigs([CODEX_CONFIG], [{
        extensionId: 'codex', values: { imageGeneration }, source: 'settings',
      }]).get('codex')?.imageGeneration).toBe(imageGeneration);
    }
    for (const imageGeneration of ['yes', 1, null, [], {}]) {
      expect(() => validateCodexConfig({ imageGeneration }))
        .toThrow('settings.json.extensionConfig.codex.imageGeneration must be a boolean');
      expect(() => resolveExtensionConfigs([CODEX_CONFIG], [{
        extensionId: 'codex', values: { imageGeneration }, source: 'settings',
      }])).toThrow();
    }
  });

  it('accepts a CodexConfig without image generation settings', () => {
    const config: CodexConfig = {
      fast: false,
      verbosity: 'low',
      forceCachedWebSockets: true,
      postAgentRunCompaction: true,
    };
    expect(validateCodexConfig(config)).toEqual({ ...config, imageGeneration: true });
  });

  it('preserves omission and validates exactly the three priority choices', () => {
    expect(validateCodexConfig({})).not.toHaveProperty('priority');
    expect(validateCodexConfig({ fast: true })).not.toHaveProperty('priority');
    expect(resolveExtensionConfigs([CODEX_CONFIG]).get('codex')).toEqual(DEFAULT_CODEX_CONFIG);
    for (const priority of ['normal', 'fast', 'ultrafast'] as const) {
      expect(validateCodexConfig({ fast: true, priority })).toMatchObject({ fast: true, priority });
      expect(resolveExtensionConfigs([CODEX_CONFIG], [{
        extensionId: 'codex', values: { priority }, source: 'settings',
      }]).get('codex')).toEqual(validateCodexConfig({ priority }));
    }
    for (const priority of ['legacy', 'priority', '', null, true, 1]) {
      expect(() => validateCodexConfig({ priority }))
        .toThrow('priority must be normal, fast, or ultrafast');
      expect(() => resolveExtensionConfigs([CODEX_CONFIG], [{
        extensionId: 'codex', values: { priority }, source: 'settings',
      }])).toThrow();
    }
  });
});
