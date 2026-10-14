import { validateExtensionConfigValue, type ExtensionConfigDefinition, type ExtensionConfigOverride } from '@felan-ai/agent-core';
import { ConfigValuesSchema, parseOperationResult, parseSchema, type JsonValue, type OperationParams, type OperationResult } from '@felan-ai/session-protocol';
import type { HostConfiguration, HostServices } from '../../src/daemon/host-services.js';

export class TestHostConfiguration implements HostConfiguration {
  private values: OperationParams<'config.set'>['values'];

  constructor(private readonly options: { definitions: readonly ExtensionConfigDefinition[]; assertCurrent(): void; readOnly?: boolean }) {
    this.values = { extensionConfig: Object.fromEntries(options.definitions.map(definition => [definition.id,
      Object.fromEntries(Object.entries(definition.fields).filter(([, field]) => field.default !== undefined && !field.sensitive && !field.deprecated)
        .map(([id, field]) => [id, field.default as JsonValue]))])) };
  }

  async get(scope: OperationParams<'config.get'>['scope']): Promise<OperationResult<'config.get'>> {
    this.options.assertCurrent();
    return parseOperationResult('config.get', { writable: scope === 'global' && !this.options.readOnly, values: structuredClone(this.values) });
  }

  prepare(scope: OperationParams<'config.set'>['scope'], input: unknown): void {
    this.options.assertCurrent();
    if (scope !== 'global') throw Object.assign(new Error('Configuration scope is read-only.'), { code: 'unavailable' });
    this.validate(input);
  }

  async set(scope: OperationParams<'config.set'>['scope'], input: unknown): Promise<void> {
    this.prepare(scope, input);
    const values = this.validate(input);
    const extensionConfig = { ...this.values.extensionConfig };
    for (const [id, fields] of Object.entries(values.extensionConfig ?? {})) extensionConfig[id] = { ...extensionConfig[id], ...fields };
    this.values = { ...this.values, ...values, extensionConfig };
  }

  sessionOverrides(input: unknown, previous: readonly ExtensionConfigOverride[] = []): ReturnType<HostConfiguration['sessionOverrides']> {
    const values = this.validate(input);
    if (Object.keys(values).some(key => key !== 'extensionConfig')) throw Object.assign(new Error('Use global configuration.'), { code: 'unavailable' });
    const groups = new Map(previous.map(row => [row.extensionId, { ...row, values: { ...row.values } as Record<string, JsonValue> }]));
    for (const [id, fields] of Object.entries(values.extensionConfig ?? {})) {
      const group = groups.get(id) ?? { extensionId: id, source: 'CLI', values: {} };
      Object.assign(group.values, fields); groups.set(id, group);
    }
    return [...groups.values()];
  }

  async sessionValues(overrides: readonly ExtensionConfigOverride[]): Promise<OperationResult<'config.get'>> {
    const result = await this.get('global');
    for (const row of overrides) Object.assign(result.values.extensionConfig![row.extensionId]!, row.values);
    return result;
  }

  private validate(input: unknown): OperationParams<'config.set'>['values'] {
    this.options.assertCurrent();
    const values = parseSchema(ConfigValuesSchema, input);
    for (const [id, fields] of Object.entries(values.extensionConfig ?? {})) {
      const definition = this.options.definitions.find(definition => definition.id === id);
      if (!definition) throw new Error('Unknown extension.');
      for (const [field, value] of Object.entries(fields)) {
        if (!definition.fields[field] || definition.fields[field]!.sensitive || definition.fields[field]!.deprecated) throw new Error('Unavailable extension field.');
        validateExtensionConfigValue(definition, field, value, 'test configuration');
      }
    }
    return values;
  }
}

export function createTestHostServices(configuration: HostConfiguration): HostServices {
  const unavailable = (): never => { throw Object.assign(new Error('Setup is unavailable in this fixture.'), { code: 'unavailable' }); };
  return {
    configuration,
    setup: {
      dependency: () => undefined,
      installApprovedDependency: async () => ({ status: 'unavailable' }),
      catalog: async () => ({ providers: [], dependencies: [] }),
      validateStart: unavailable, start: unavailable, read: unavailable, answer: unavailable,
      cancel: unavailable, prepareOpenLink: unavailable,
      disconnected() {}, beginDrain() {}, async drain() {},
    },
  };
}
