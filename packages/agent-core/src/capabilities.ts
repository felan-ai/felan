import type { InlineExtension } from '@earendil-works/pi-coding-agent';

export interface FelanCapability {
  readonly id: string;
  readonly instructions: string;
}

export interface RegisteredFelanCapability extends FelanCapability {
  readonly source: string;
}

const collectors = new WeakMap<object, CapabilityCollector>();
const CAPABILITY_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export class CapabilityCollector {
  readonly #capabilities = new Map<string, RegisteredFelanCapability>();

  beginLoad(): void {
    this.#capabilities.clear();
  }

  register(source: string, capability: FelanCapability): void {
    if (!capability || typeof capability !== 'object') {
      throw new Error(`Invalid capability registration from ${source}: expected an object`);
    }
    if (typeof capability.id !== 'string' || !CAPABILITY_ID_PATTERN.test(capability.id)) {
      throw new Error(`Invalid capability id from ${source}: expected lowercase letters, numbers, dots, dashes, or underscores`);
    }
    if (typeof capability.instructions !== 'string' || capability.instructions.trim().length === 0) {
      throw new Error(`Invalid capability instructions for ${capability.id} from ${source}: expected non-blank text`);
    }

    const existing = this.#capabilities.get(capability.id);
    if (existing) {
      throw new Error(
        `Duplicate capability id ${capability.id} from ${source}; already registered by ${existing.source}`,
      );
    }
    this.#capabilities.set(capability.id, {
      id: capability.id,
      instructions: capability.instructions.trim(),
      source,
    });
  }

  values(): readonly RegisteredFelanCapability[] {
    return [...this.#capabilities.values()];
  }
}

export function associateCapabilityCollector(
  extension: InlineExtension,
  collector: CapabilityCollector,
): void {
  collectors.set(extension, collector);
}

export function collectCapabilities(
  extensions: readonly InlineExtension[],
): readonly RegisteredFelanCapability[] {
  const seenCollectors = new Set<CapabilityCollector>();
  const seenCapabilities = new Map<string, RegisteredFelanCapability>();
  const capabilities: RegisteredFelanCapability[] = [];

  for (const extension of extensions) {
    const collector = collectors.get(extension);
    if (!collector || seenCollectors.has(collector)) continue;
    seenCollectors.add(collector);

    for (const capability of collector.values()) {
      const existing = seenCapabilities.get(capability.id);
      if (existing) {
        throw new Error(
          `Duplicate capability id ${capability.id} from ${capability.source}; already registered by ${existing.source}`,
        );
      }
      seenCapabilities.set(capability.id, capability);
      capabilities.push(capability);
    }
  }

  return capabilities;
}

export function formatCapabilitiesSection(
  capabilities: readonly FelanCapability[],
): string | undefined {
  if (capabilities.length === 0) return undefined;

  return [
    '## Enabled capabilities',
    ...capabilities.map(({ id, instructions }) => `### ${id}\n\n${instructions.trim()}`),
  ].join('\n\n');
}
