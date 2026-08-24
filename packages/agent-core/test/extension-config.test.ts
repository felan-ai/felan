import { describe, expect, it } from 'vitest';
import {
  configField,
  defineExtensionConfig,
  getExtensionConfigCliOptions,
  parseExtensionConfigCliValue,
  resolveExtensionConfigs,
} from '../src/index.js';

const definition = defineExtensionConfig({
  id: 'example',
  title: 'Example',
  fields: {
    enabled: configField.boolean({ default: true, description: 'Enable the feature' }),
    mode: configField.enum(['safe', 'fast'], { default: 'safe', description: 'Execution mode' }),
    limit: configField.number({ default: 3, description: 'Maximum items' }),
  },
});

describe('declarative extension configuration', () => {
  it('resolves defaults and ordered overrides', () => {
    const resolved = resolveExtensionConfigs([definition], [
      { extensionId: 'example', values: { mode: 'fast', limit: 4 }, source: 'settings' },
      { extensionId: 'example', values: { enabled: false }, source: 'programmatic' },
    ]);
    expect(resolved.get('example')).toEqual({ enabled: false, mode: 'fast', limit: 4 });
  });

  it('rejects unknown and malformed values', () => {
    expect(() => resolveExtensionConfigs([definition], [
      { extensionId: 'example', values: { unknown: true }, source: 'settings' },
    ])).toThrow('unknown field');
    expect(() => resolveExtensionConfigs([definition], [
      { extensionId: 'example', values: { mode: 'slow' }, source: 'settings' },
    ])).toThrow('must be one of');
  });

  it('generates and parses CLI options', () => {
    const options = getExtensionConfigCliOptions([definition]);
    const fast = options.find((option) => option.name === 'example-mode')!;
    const enabled = options.find((option) => option.name === 'example-enabled')!;
    expect(parseExtensionConfigCliValue(fast, 'fast')).toBe('fast');
    expect(parseExtensionConfigCliValue(enabled, false)).toBe(false);
    expect(() => parseExtensionConfigCliValue(fast, 'slow')).toThrow('must be one of');
  });

  it('resolves, clones, and freezes JSON configuration values', () => {
    const layout = { lines: [{ segments: { status: { enabled: true } } }] };
    const jsonDefinition = defineExtensionConfig({
      id: 'json-example',
      title: 'JSON Example',
      fields: {
        layout: configField.json({ default: layout, description: 'Structured layout' }),
      },
    });
    const resolved = resolveExtensionConfigs([jsonDefinition], [{
      extensionId: 'json-example',
      values: { layout: { lines: [{ segments: { status: { enabled: false } } }] } },
      source: 'settings',
    }]);
    const value = resolved.get('json-example')!.layout as { lines: readonly unknown[] };
    expect(value).toEqual({ lines: [{ segments: { status: { enabled: false } } }] });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.lines)).toBe(true);
    expect(layout.lines[0]!.segments.status.enabled).toBe(true);
  });

  it('parses JSON CLI values and rejects non-JSON values', () => {
    const jsonDefinition = defineExtensionConfig({
      id: 'json-cli',
      title: 'JSON CLI',
      fields: {
        value: configField.json({ default: {}, description: 'Structured value' }),
      },
    });
    const option = getExtensionConfigCliOptions([jsonDefinition])[0]!;
    expect(parseExtensionConfigCliValue(option, '{"enabled":true}')).toEqual({ enabled: true });
    expect(() => parseExtensionConfigCliValue(option, '{bad')).toThrow('valid JSON');
    expect(() => resolveExtensionConfigs([jsonDefinition], [{
      extensionId: 'json-cli', values: { value: new Date() }, source: 'settings',
    }])).toThrow('plain object');
  });

  it('omits sensitive fields from generated CLI options', () => {
    const sensitiveDefinition = defineExtensionConfig({
      id: 'sensitive-example',
      title: 'Sensitive Example',
      fields: {
        apiKey: configField.string({ default: '', description: 'Credential source', sensitive: true }),
        enabled: configField.boolean({ default: true, description: 'Enable feature' }),
      },
    });
    expect(getExtensionConfigCliOptions([sensitiveDefinition]).map((option) => option.field)).toEqual(['enabled']);
  });
});
