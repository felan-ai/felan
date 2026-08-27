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

  it('uses the Felan theme and customized default layout when no overrides are supplied', () => {
    const resolved = resolveExtensionConfigs([POWERLINE_CONFIG]);
    expect(powerlineConfigFromSettings(resolved.get('powerline')!)).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG).toEqual({
      theme: 'felan',
      display: {
        style: 'powerline',
        charset: 'text',
        colorCompatibility: 'truecolor',
        autoWrap: true,
        padding: 1,
        lines: [
          {
            segments: {
              directory: { enabled: true, style: 'fish' },
              git: { enabled: true, showSha: false, showWorkingTree: true },
              savings: { enabled: true, align: 'right', periodDays: 7 },
            },
          },
          {
            segments: {
              context: { enabled: true, displayStyle: 'text', showTokensOnly: true },
              session: { enabled: true, type: 'cost' },
              subscription: { enabled: true, showProviderName: false, showReset: true, maxWindows: 3 },
              model: { enabled: true, align: 'right' },
            },
          },
          { segments: { status: { enabled: true } } },
        ],
      },
    });
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

  it('validates the savings period', () => {
    expect(() => resolveExtensionConfigs([POWERLINE_CONFIG], [{
      extensionId: 'powerline', source: 'settings', values: {
        lines: [{ segments: { savings: { periodDays: 0 } } }],
      },
    }])).toThrow('periodDays must be an integer from 1 to 3650');
  });
});
