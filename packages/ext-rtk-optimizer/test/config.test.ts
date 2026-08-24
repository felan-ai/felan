import { describe, expect, it } from 'vitest';
import { resolveExtensionConfigs } from '@felan-ai/agent-core';
import {
  RTK_OPTIMIZER_CONFIG,
  rtkOptimizerConfigFromSettings,
  validateRtkOptimizerConfig,
} from '../src/config.js';
import { DEFAULT_RTK_OPTIMIZER_CONFIG } from '../src/types.js';

describe('RTK optimizer configuration', () => {
  it('resolves declarative defaults to the documented runtime config', () => {
    const resolved = resolveExtensionConfigs([RTK_OPTIMIZER_CONFIG]);
    expect(rtkOptimizerConfigFromSettings(resolved.get('rtkOptimizer')!)).toEqual(DEFAULT_RTK_OPTIMIZER_CONFIG);
  });

  it('resolves flat overrides into the runtime config shape', () => {
    const resolved = resolveExtensionConfigs([RTK_OPTIMIZER_CONFIG], [{
      extensionId: 'rtkOptimizer', source: 'settings', values: {
        mode: 'suggest', stripAnsi: false, truncateMaxChars: 20_000,
      },
    }]);
    const config = rtkOptimizerConfigFromSettings(resolved.get('rtkOptimizer')!);
    expect(config.mode).toBe('suggest');
    expect(config.outputCompaction.stripAnsi).toBe(false);
    expect(config.outputCompaction.truncate.maxChars).toBe(20_000);
  });

  it('rejects invalid legacy runtime-shaped values', () => {
    expect(() => validateRtkOptimizerConfig({ surprise: true })).toThrow('contains unknown field: surprise');
    expect(() => validateRtkOptimizerConfig({ enabled: 'yes' })).toThrow('.enabled must be a boolean');
  });
});
