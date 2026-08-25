import { describe, expect, it } from 'vitest';
import { DEFAULT_CODEX_CONFIG, validateCodexConfig } from '../src/index.js';

describe('Codex configuration', () => {
  it('provides the normal settings defaults', () => {
    expect(DEFAULT_CODEX_CONFIG).toEqual({
      fast: false,
      verbosity: 'low',
      forceCachedWebSockets: true,
    });
  });

  it('validates programmatic settings', () => {
    expect(validateCodexConfig({
      fast: true,
      verbosity: 'high',
      forceCachedWebSockets: false,
    }, 'settings.json.extensionConfig.codex')).toEqual({
      fast: true,
      verbosity: 'high',
      forceCachedWebSockets: false,
    });
    expect(() => validateCodexConfig({ verbosity: 'max' }, 'settings.json.extensionConfig.codex'))
      .toThrow('settings.json.extensionConfig.codex.verbosity must be low, medium, or high');
    expect(() => validateCodexConfig({ fast: 'yes' }, 'settings.json.extensionConfig.codex'))
      .toThrow('settings.json.extensionConfig.codex.fast must be a boolean');
  });
});
