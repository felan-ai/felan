import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  POWERLINE_CONFIG_FILENAME,
  POWERLINE_FLAGS,
  configFromFlags,
  loadPowerlineConfig,
  registerPowerlineFlags,
} from '../src/config.js';

describe('powerline flags', () => {
  it('registers only namespaced inert display flags', () => {
    const registered = new Map<string, unknown>();
    registerPowerlineFlags({
      registerFlag: (name: string, options: unknown) => registered.set(name, options),
    } as never);

    expect([...registered.keys()]).toEqual(Object.values(POWERLINE_FLAGS));
    expect([...registered.keys()].every((name) => name.startsWith('felan-powerline-'))).toBe(true);
    expect(registered.get(POWERLINE_FLAGS.wrap)).toMatchObject({ type: 'boolean', default: true });
  });

  it('applies supported values and falls back for invalid values', () => {
    const values = new Map<string, boolean | string>([
      [POWERLINE_FLAGS.theme, 'nord'],
      [POWERLINE_FLAGS.style, 'capsule'],
      [POWERLINE_FLAGS.charset, 'unicode'],
      [POWERLINE_FLAGS.color, 'none'],
      [POWERLINE_FLAGS.wrap, false],
      [POWERLINE_FLAGS.directoryStyle, 'basename'],
      [POWERLINE_FLAGS.sessionType, 'both'],
      [POWERLINE_FLAGS.contextStyle, 'dots'],
    ]);
    const config = configFromFlags({ getFlag: (name) => values.get(name) });
    expect(config).toMatchObject({
      theme: 'nord',
      display: { style: 'capsule', charset: 'unicode', colorCompatibility: 'none', autoWrap: false },
    });
    expect(config.display.lines[0]?.segments.directory?.style).toBe('basename');
    expect(config.display.lines[1]?.segments.session?.type).toBe('both');
    expect(config.display.lines[1]?.segments.context?.displayStyle).toBe('dots');

    const fallback = configFromFlags({ getFlag: () => 'unsupported' });
    expect(fallback).toMatchObject({
      theme: 'dark',
      display: { style: 'powerline', charset: 'text', colorCompatibility: 'auto', autoWrap: true },
    });
  });
});

describe('powerline config file', () => {
  it('loads supported Pi powerline settings and custom colors from the Felan root', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'felan-powerline-'));
    try {
      await writeFile(join(agentDir, POWERLINE_CONFIG_FILENAME), JSON.stringify({
        theme: 'custom',
        colors: {
          custom: {
            directory: { fg: '#ffffff', bg: '#123456' },
            subscription: { fg: '#ffffff', bg: '#654321' },
          },
        },
        display: {
          padding: 2,
          style: 'capsule',
          charset: 'unicode',
          colorCompatibility: 'truecolor',
          autoWrap: false,
          lines: [
            { segments: { directory: { enabled: true, style: 'basename' } } },
            {
              segments: {
                subscription: {
                  enabled: true,
                  showProviderName: false,
                  showReset: true,
                  showPercentage: false,
                  maxWindows: 2,
                },
                model: { enabled: true, align: 'right' },
                context: { enabled: true, displayStyle: 'dots' },
              },
            },
            { segments: { status: { enabled: true } } },
          ],
        },
      }));

      const loaded = loadPowerlineConfig(agentDir);

      expect(loaded).not.toHaveProperty('warning');
      expect(loaded.path).toBe(join(agentDir, 'powerline.json'));
      expect(loaded.config).toMatchObject({
        theme: 'custom',
        colors: {
          custom: {
            directory: { fg: '#ffffff', bg: '#123456' },
            subscription: { fg: '#ffffff', bg: '#654321' },
          },
        },
        display: {
          padding: 2,
          style: 'capsule',
          charset: 'unicode',
          colorCompatibility: 'truecolor',
          autoWrap: false,
        },
      });
      expect(loaded.config.display.lines).toHaveLength(3);
      expect(loaded.config.display.lines[1]?.segments).toEqual({
        subscription: {
          enabled: true,
          showProviderName: false,
          showReset: true,
          showPercentage: false,
          maxWindows: 2,
        },
        model: { enabled: true, align: 'right' },
        context: { enabled: true, displayStyle: 'dots' },
      });
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it('uses defaults for a missing file and reports malformed JSON', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'felan-powerline-'));
    try {
      const missing = loadPowerlineConfig(agentDir);
      expect(missing).not.toHaveProperty('warning');
      expect(missing.config.theme).toBe('dark');

      await writeFile(join(agentDir, POWERLINE_CONFIG_FILENAME), '{');
      const malformed = loadPowerlineConfig(agentDir);
      expect(malformed.warning).toContain(join(agentDir, POWERLINE_CONFIG_FILENAME));
      expect(malformed.config.theme).toBe('dark');
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});
