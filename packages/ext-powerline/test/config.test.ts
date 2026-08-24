import { describe, expect, it } from 'vitest';
import { resolveExtensionConfigs } from '@felan-ai/agent-core';
import {
  DEFAULT_CONFIG,
  POWERLINE_CONFIG,
  powerlineConfigFromSettings,
} from '../src/config.js';

describe('powerline configuration', () => {
  it('declares and resolves the complete structured configuration', () => {
    const resolved = resolveExtensionConfigs([POWERLINE_CONFIG], [{
      extensionId: 'powerline',
      source: 'settings.json.extensionConfig.powerline',
      values: {
        theme: 'custom',
        padding: 2,
        colors: { metrics: { fg: '#ffffff', bg: '#123456' } },
        lines: [{ segments: { directory: { enabled: true, style: 'basename' } } }],
      },
    }]);
    const config = powerlineConfigFromSettings(resolved.get('powerline')!);
    expect(config).toMatchObject({
      theme: 'custom',
      colors: { custom: { metrics: { fg: '#ffffff', bg: '#123456' } } },
      display: { padding: 2 },
    });
    expect(config.display.lines).toEqual([{ segments: { directory: { enabled: true, style: 'basename' } } }]);
  });

  it('keeps default layout when no overrides are supplied', () => {
    expect(powerlineConfigFromSettings({})).toEqual(DEFAULT_CONFIG);
  });

  it('rejects malformed structured values before activation', () => {
    expect(() => resolveExtensionConfigs([POWERLINE_CONFIG], [{
      extensionId: 'powerline', source: 'settings', values: {
        lines: [{ segments: { unknown: { enabled: true } } }],
      },
    }])).toThrow('unknown segment');
    expect(() => resolveExtensionConfigs([POWERLINE_CONFIG], [{
      extensionId: 'powerline', source: 'settings', values: {
        colors: { directory: { fg: 'red', bg: '#123456' } },
      },
    }])).toThrow('#RRGGBB');
  });
});
