export type ExtensionConfigPrimitive = boolean | number | string;

export interface ExtensionConfigJsonObject {
  readonly [key: string]: ExtensionConfigValue;
}

export interface ExtensionConfigJsonArray extends ReadonlyArray<ExtensionConfigValue> {}

export type ExtensionConfigValue =
  | ExtensionConfigPrimitive
  | null
  | ExtensionConfigJsonObject
  | ExtensionConfigJsonArray;

export interface ExtensionConfigFieldOptions<T> {
  readonly default: T;
  readonly label?: string;
  readonly description: string;
  readonly cliName?: string | false;
  readonly sensitive?: boolean;
  readonly validate?: (value: unknown) => string | undefined;
}

export interface ExtensionConfigField<T = unknown>
  extends ExtensionConfigFieldOptions<T> {
  readonly type: 'boolean' | 'json' | 'number' | 'string';
  readonly values?: readonly T[];
}

export type ExtensionConfigFields = Readonly<Record<string, ExtensionConfigField<unknown>>>;

export interface ExtensionConfigDefinition<TFields extends ExtensionConfigFields = ExtensionConfigFields> {
  readonly id: string;
  readonly title: string;
  readonly fields: TFields;
}

export type ExtensionConfigFieldValue<TField> = TField extends ExtensionConfigField<infer TValue>
  ? TValue
  : never;

export type InferExtensionConfig<TDefinition extends ExtensionConfigDefinition> = Readonly<{
  [TKey in keyof TDefinition['fields']]: ExtensionConfigFieldValue<TDefinition['fields'][TKey]>;
}>;

export interface ExtensionConfigOverride {
  readonly extensionId: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly source: string;
}

export interface ExtensionConfigCliOption {
  readonly name: string;
  readonly extensionId: string;
  readonly field: string;
  readonly definition: ExtensionConfigDefinition;
  readonly configField: ExtensionConfigField;
}

const extensionDefinitions = new WeakMap<Function, ExtensionConfigDefinition>();

export const configField = {
  boolean(options: ExtensionConfigFieldOptions<boolean>): ExtensionConfigField<boolean> {
    return createField('boolean', options);
  },
  number(options: ExtensionConfigFieldOptions<number>): ExtensionConfigField<number> {
    return createField('number', options);
  },
  string(options: ExtensionConfigFieldOptions<string>): ExtensionConfigField<string> {
    return createField('string', options);
  },
  enum<const TValues extends readonly [string, ...string[]]>(
    values: TValues,
    options: ExtensionConfigFieldOptions<TValues[number]>,
  ): ExtensionConfigField<TValues[number]> {
    return createField('string', options, values);
  },
  json<const TValue>(options: ExtensionConfigFieldOptions<TValue>): ExtensionConfigField<TValue> {
    return createField('json', options);
  },
};

export function defineExtensionConfig<const TFields extends ExtensionConfigFields>(
  definition: ExtensionConfigDefinition<TFields>,
): ExtensionConfigDefinition<TFields> {
  validateDefinition(definition);
  const fields = Object.fromEntries(Object.entries(definition.fields).map(([name, field]) => [
    name,
    Object.freeze({
      ...field,
      default: cloneExtensionConfigValue(field.default),
      ...(field.values === undefined ? {} : { values: Object.freeze([...field.values]) }),
    }),
  ])) as TFields;
  return Object.freeze({ ...definition, fields: Object.freeze(fields) });
}

export function associateExtensionConfig(
  extension: Function,
  definition: ExtensionConfigDefinition,
): void {
  extensionDefinitions.set(extension, definition);
}

export function getExtensionConfigDefinition(
  extension: Function,
): ExtensionConfigDefinition | undefined {
  return extensionDefinitions.get(extension);
}

export function configureExtension<TDefinition extends ExtensionConfigDefinition>(
  definition: TDefinition,
  values: Partial<InferExtensionConfig<TDefinition>>,
  source = 'programmatic',
): ExtensionConfigOverride {
  return {
    extensionId: definition.id,
    values: { ...values },
    source,
  };
}

export function extensionConfigOverridesFromObject(
  definitions: readonly ExtensionConfigDefinition[],
  value: unknown,
  source: string,
): ExtensionConfigOverride[] {
  if (value === undefined) return [];
  if (!isRecord(value)) throw new Error(`${source} must be an object`);
  const definitionsById = definitionMap(definitions);
  const overrides: ExtensionConfigOverride[] = [];
  for (const [extensionId, fields] of Object.entries(value)) {
    if (!definitionsById.has(extensionId)) {
      throw new Error(`${source} contains unknown extension: ${extensionId}`);
    }
    if (!isRecord(fields)) throw new Error(`${source}.${extensionId} must be an object`);
    overrides.push({ extensionId, values: { ...fields }, source: `${source}.${extensionId}` });
  }
  return overrides;
}

export function resolveExtensionConfigs(
  definitions: readonly ExtensionConfigDefinition[],
  overrides: readonly ExtensionConfigOverride[] = [],
): ReadonlyMap<string, Readonly<Record<string, ExtensionConfigValue>>> {
  const definitionsById = definitionMap(definitions);
  const resolved = new Map<string, Record<string, ExtensionConfigValue>>();

  for (const definition of definitions) {
    const values: Record<string, ExtensionConfigValue> = {};
    for (const [name, field] of Object.entries(definition.fields)) {
      validateFieldValue(definition, name, field, field.default, `default for ${definition.id}.${name}`);
      values[name] = cloneExtensionConfigValue(field.default);
    }
    resolved.set(definition.id, values);
  }

  for (const override of overrides) {
    const definition = definitionsById.get(override.extensionId);
    if (!definition) {
      throw new Error(`${override.source} configures unknown extension: ${override.extensionId}`);
    }
    if (!isRecord(override.values)) {
      throw new Error(`${override.source} must provide an object for ${override.extensionId}`);
    }
    const values = resolved.get(definition.id)!;
    for (const [name, value] of Object.entries(override.values)) {
      const field = definition.fields[name];
      if (!field) throw new Error(`${override.source} contains unknown field: ${definition.id}.${name}`);
      validateFieldValue(definition, name, field, value, `${override.source}.${name}`);
      values[name] = cloneExtensionConfigValue(value);
    }
  }

  return new Map([...resolved].map(([id, values]) => [id, Object.freeze({ ...values })]));
}

export function getExtensionConfigCliOptions(
  definitions: readonly ExtensionConfigDefinition[],
): readonly ExtensionConfigCliOption[] {
  definitionMap(definitions);
  const seen = new Set<string>();
  const options: ExtensionConfigCliOption[] = [];
  for (const definition of definitions) {
    for (const [field, configField] of Object.entries(definition.fields)) {
      if (configField.cliName === false || configField.sensitive === true) continue;
      const name = configField.cliName ?? `${toKebabCase(definition.id)}-${toKebabCase(field)}`;
      if (!/^[a-z][a-z0-9-]*$/u.test(name)) {
        throw new Error(`Invalid CLI name for ${definition.id}.${field}: ${name}`);
      }
      if (seen.has(name)) throw new Error(`Duplicate extension configuration CLI option: --${name}`);
      seen.add(name);
      options.push({ name, extensionId: definition.id, field, definition, configField });
    }
  }
  return Object.freeze(options);
}

export function parseExtensionConfigCliValue(
  option: ExtensionConfigCliOption,
  value: string | boolean,
): ExtensionConfigValue {
  const { definition, field, configField } = option;
  let parsed: unknown;
  if (configField.type === 'boolean') {
    if (typeof value === 'boolean') parsed = value;
    else if (value === 'true') parsed = true;
    else if (value === 'false') parsed = false;
    else throw new Error(`--${option.name} must be true or false`);
  } else if (configField.type === 'number') {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`--${option.name} requires a number`);
    }
    parsed = Number(value);
  } else if (configField.type === 'json') {
    if (typeof value !== 'string') throw new Error(`--${option.name} requires JSON`);
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error(`--${option.name} must be valid JSON: ${errorMessage(error)}`);
    }
  } else {
    if (typeof value !== 'string') throw new Error(`--${option.name} requires a value`);
    parsed = value;
  }
  validateFieldValue(definition, field, configField, parsed, `--${option.name}`);
  return cloneExtensionConfigValue(parsed);
}

export function validateExtensionConfigValue(
  definition: ExtensionConfigDefinition,
  field: string,
  value: unknown,
  source: string,
): ExtensionConfigValue {
  const configField = definition.fields[field];
  if (!configField) throw new Error(`${source} refers to unknown field: ${definition.id}.${field}`);
  validateFieldValue(definition, field, configField, value, source);
  return cloneExtensionConfigValue(value);
}

function createField<T>(
  type: ExtensionConfigField<T>['type'],
  options: ExtensionConfigFieldOptions<T>,
  values?: readonly T[],
): ExtensionConfigField<T> {
  return Object.freeze({
    type,
    ...options,
    ...(values === undefined ? {} : { values: Object.freeze([...values]) }),
  });
}

function validateDefinition(definition: ExtensionConfigDefinition): void {
  if (!/^[a-z][a-zA-Z0-9-]*$/u.test(definition.id)) {
    throw new Error(`Invalid extension configuration id: ${definition.id}`);
  }
  if (definition.title.trim().length === 0) {
    throw new Error(`Extension configuration ${definition.id} must have a title`);
  }
  const names = Object.keys(definition.fields);
  if (names.length === 0) throw new Error(`Extension configuration ${definition.id} must define fields`);
  for (const [name, field] of Object.entries(definition.fields)) {
    if (!/^[a-z][a-zA-Z0-9]*$/u.test(name)) {
      throw new Error(`Invalid extension configuration field: ${definition.id}.${name}`);
    }
    if (field.description.trim().length === 0) {
      throw new Error(`Extension configuration field ${definition.id}.${name} must have a description`);
    }
    if (field.values && field.values.length === 0) {
      throw new Error(`Extension configuration field ${definition.id}.${name} must not have empty values`);
    }
    validateFieldValue(definition, name, field, field.default, `default for ${definition.id}.${name}`);
  }
}

function definitionMap(
  definitions: readonly ExtensionConfigDefinition[],
): Map<string, ExtensionConfigDefinition> {
  const result = new Map<string, ExtensionConfigDefinition>();
  for (const definition of definitions) {
    validateDefinition(definition);
    if (result.has(definition.id)) throw new Error(`Duplicate extension configuration id: ${definition.id}`);
    result.set(definition.id, definition);
  }
  return result;
}

function validateFieldValue(
  definition: ExtensionConfigDefinition,
  name: string,
  field: ExtensionConfigField,
  value: unknown,
  source: string,
): void {
  if (field.type === 'json') {
    const issue = jsonValueIssue(value);
    if (issue) throw new Error(`${source} must be valid JSON: ${issue}`);
  } else if (typeof value !== field.type || (field.type === 'number' && !Number.isFinite(value))) {
    throw new Error(`${source} must be a ${field.type}`);
  }
  if (field.values && !field.values.includes(value as never)) {
    throw new Error(`${source} must be one of: ${field.values.join(', ')}`);
  }
  const validation = field.validate?.(value as never);
  if (validation) throw new Error(`${source} ${validation}`);
  if (!Object.hasOwn(definition.fields, name)) {
    throw new Error(`${source} refers to unknown field: ${definition.id}.${name}`);
  }
}

function cloneExtensionConfigValue(value: unknown): ExtensionConfigValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneExtensionConfigValue(item)));
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      cloneExtensionConfigValue(item),
    ]),
  ));
}

function jsonValueIssue(value: unknown): string | undefined {
  return inspectJsonValue(value, '$', new WeakSet<object>(), 0);
}

function inspectJsonValue(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
  depth: number,
): string | undefined {
  if (depth > 100) return `${path} exceeds the maximum nesting depth of 100`;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? undefined : `${path} is not a finite number`;
  if (typeof value !== 'object') return `${path} contains ${typeof value}`;
  if (ancestors.has(value)) return `${path} contains a circular reference`;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) return `${path} must be a dense JSON array`;
      if (Object.getOwnPropertySymbols(value).length > 0) return `${path} contains symbol properties`;
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) return `${path} must be a dense JSON array`;
        const issue = inspectJsonValue(value[index], `${path}[${index}]`, ancestors, depth + 1);
        if (issue) return issue;
      }
      return undefined;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return `${path} must be a plain object`;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return `${path} contains symbol properties`;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        return `${path}.${key} must be an enumerable data property`;
      }
      const issue = inspectJsonValue(descriptor.value, `${path}.${key}`, ancestors, depth + 1);
      if (issue) return issue;
    }
    return undefined;
  } finally {
    ancestors.delete(value);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toKebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .replace(/_/gu, '-')
    .toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
