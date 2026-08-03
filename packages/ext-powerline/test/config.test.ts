import { describe, expect, it } from 'vitest';
import { POWERLINE_FLAGS, configFromFlags, registerPowerlineFlags } from '../src/config.js';

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
