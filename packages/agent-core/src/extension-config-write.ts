import {
  resolveExtensionConfigs, type ExtensionConfigDefinition, type ExtensionConfigValue,
} from './extension-config.js';

export type ExtensionConfigWriter = (
  packageName: string,
  patch: Readonly<Record<string, ExtensionConfigValue>>,
) => Promise<void>;

export function createExtensionConfigBinding(
  packageName: string,
  definition: ExtensionConfigDefinition | undefined,
  writer: ExtensionConfigWriter | undefined,
): () => { updateConfig(patch: Readonly<Record<string, ExtensionConfigValue>>): Promise<void>; revoke(): void } {
  let generation = 0;
  let pending: Promise<void> = Promise.resolve();
  return () => {
    const activation = ++generation;
    const assertCurrent = () => {
      if (activation !== generation) throw new Error('Extension configuration binding is no longer active.');
    };
    return {
      revoke() { if (generation === activation) generation++; },
      async updateConfig(patch) {
        assertCurrent();
        if (!writer) throw new Error('Extension configuration persistence is unsupported without a configured writer.');
        if (!definition) throw new Error('This extension does not declare a configuration definition.');
        const validated = validatePatch(definition, patch);
        const work = pending.then(async () => {
          assertCurrent();
          await writer(packageName, validated);
          assertCurrent();
        });
        pending = work.catch(() => {});
        return work;
      },
    };
  };
}

function validatePatch(
  definition: ExtensionConfigDefinition,
  patch: Readonly<Record<string, ExtensionConfigValue>>,
): Readonly<Record<string, ExtensionConfigValue>> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)
    || (Object.getPrototypeOf(patch) !== Object.prototype && Object.getPrototypeOf(patch) !== null)) {
    throw new Error('Extension configuration patch must be a plain object.');
  }
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const keys = Reflect.ownKeys(patch);
  for (const key of keys) {
    if (typeof key !== 'string' || !Object.hasOwn(definition.fields, key)) throw new Error('Unknown extension configuration field.');
    if (definition.fields[key]!.sensitive) throw new Error('Sensitive extension configuration fields cannot be updated through this API.');
    const descriptor = Object.getOwnPropertyDescriptor(patch, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('Extension configuration fields must be enumerable data properties.');
    values[key] = descriptor.value;
  }
  const resolved = resolveExtensionConfigs([definition], [{ extensionId: definition.id, values, source: 'extension configuration update' }]).get(definition.id)!;
  return Object.freeze(Object.fromEntries(keys.map(key => [key, resolved[key as string]!])));
}
