import { getExtensionConfigCliOptions, validateExtensionConfigValue, type ExtensionConfigDefinition, type ExtensionConfigOverride } from '@felan-ai/agent-core';
import { ConfigValuesSchema, parseOperationResult, parseSchema, type JsonValue, type OperationParams, type OperationResult } from '@felan-ai/session-protocol';
import type { HostConfiguration, HostServices } from '../../src/daemon/host-services.js';

export class TestHostConfiguration implements HostConfiguration {
  private readonly fields;
  private values: Record<string, JsonValue> = {};

  constructor(private readonly options: { definitions: readonly ExtensionConfigDefinition[]; assertCurrent(): void }) {
    this.fields = new Map(getExtensionConfigCliOptions(options.definitions).map(field => [field.name, field]));
    for (const [name, field] of this.fields) {
      if (field.configField.default !== undefined) this.values[name] = field.configField.default;
    }
  }

  async get(scope: OperationParams<'config.get'>['scope']): Promise<OperationResult<'config.get'>> {
    this.checkScope(scope);
    return parseOperationResult('config.get', { values: this.values });
  }

  prepare(scope: OperationParams<'config.set'>['scope'], input: unknown): void {
    this.checkScope(scope);
    const values = parseSchema(ConfigValuesSchema, input);
    for (const [name, value] of Object.entries(values)) {
      const field = this.fields.get(name);
      if (field) validateExtensionConfigValue(field.definition, field.field, value, 'test configuration');
    }
  }

  async set(scope: OperationParams<'config.set'>['scope'], input: unknown): Promise<void> {
    this.prepare(scope, input);
    this.values = { ...this.values, ...parseSchema(ConfigValuesSchema, input) };
  }

  sessionOverrides(input: unknown, previous: readonly ExtensionConfigOverride[] = []): ReturnType<HostConfiguration['sessionOverrides']> {
    this.prepare('global', input);
    const groups = new Map(previous.map(row => [row.extensionId, { ...row, values: { ...row.values } as Record<string, JsonValue> }]));
    for (const [name, value] of Object.entries(parseSchema(ConfigValuesSchema, input))) {
      const field = this.fields.get(name);
      if (!field) throw Object.assign(new Error('Use global configuration.'), { code: 'unavailable' });
      const group = groups.get(field.extensionId) ?? { extensionId: field.extensionId, source: 'CLI', values: {} };
      group.values[field.field] = value;
      groups.set(field.extensionId, group);
    }
    return [...groups.values()];
  }

  async sessionValues(overrides: readonly ExtensionConfigOverride[]): Promise<OperationResult<'config.get'>> {
    const result = await this.get('global');
    for (const [name, field] of this.fields) {
      const value = overrides.find(row => row.extensionId === field.extensionId)?.values[field.field];
      if (value !== undefined) Object.assign(result.values, { [name]: value });
    }
    return parseOperationResult('config.get', result);
  }

  private checkScope(scope: string): void {
    this.options.assertCurrent();
    if (scope !== 'global') throw Object.assign(new Error('Unsupported test configuration scope.'), { code: 'unavailable' });
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
