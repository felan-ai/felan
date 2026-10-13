import type { HostAgentRuntimeOptions } from './host-agent-runtime.js';
import type { AgentRuntime } from './runtime.js';

const serviceTokenBrand: unique symbol = Symbol('FelanServiceContract');

export interface HostRuntimeService {
  create(cwd: string, options: HostAgentRuntimeOptions): AgentRuntime;
}

export interface ServiceContract<T> {
  readonly id: string;
  readonly major: number;
  readonly key: string;
  readonly [serviceTokenBrand]: T;
}

export function defineServiceContract<T>(id: string, major: number): ServiceContract<T> {
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(id) || id.length > 128) {
    throw new Error('Service contract IDs must be bounded lowercase identifiers.');
  }
  if (!Number.isSafeInteger(major) || major < 1 || major > 65_535) {
    throw new Error('Service contract major versions must be positive safe integers.');
  }
  return Object.freeze({ id, major, key: `${id}@${major}`, [serviceTokenBrand]: undefined as T });
}

export const HOST_RUNTIME_SERVICE = defineServiceContract<HostRuntimeService>('felan.runtime', 1);

export interface FelanServiceRegistry {
  set<T>(contract: ServiceContract<T>, implementation: T): void;
  get<T>(contract: ServiceContract<T>): T | undefined;
  fork(): FelanServiceRegistry;
  revoke(): void;
}

export function createFelanServiceRegistry(parent?: FelanServiceRegistry): FelanServiceRegistry {
  const implementations = new Map<string, unknown>();
  let revoked = false;
  const api: FelanServiceRegistry = {
    set<T>(contract: ServiceContract<T>, implementation: T): void {
      assertActive();
      if (implementations.has(contract.key)) throw new Error(`Service ${contract.key} already has a provider in this scope.`);
      implementations.set(contract.key, implementation);
    },
    get<T>(contract: ServiceContract<T>): T | undefined {
      assertActive();
      return implementations.has(contract.key) ? implementations.get(contract.key) as T : parent?.get(contract);
    },
    fork() { assertActive(); return createFelanServiceRegistry(api); },
    revoke() { revoked = true; implementations.clear(); },
  };
  return Object.freeze(api);
  function assertActive(): void {
    if (revoked) throw new Error('Service registry has been revoked.');
  }
}

export interface ExtensionServiceRequirements {
  readonly required?: readonly ServiceContract<unknown>[];
  readonly optional?: readonly ServiceContract<unknown>[];
}

export interface ExtensionServiceAccess {
  get<T>(contract: ServiceContract<T>): T | undefined;
}

export function createExtensionServiceAccess(
  registry: FelanServiceRegistry,
  requirements: ExtensionServiceRequirements,
): ExtensionServiceAccess {
  const required = new Set((requirements.required ?? []).map(contract => contract.key));
  const optional = new Set((requirements.optional ?? []).map(contract => contract.key));
  for (const key of required) {
    if (optional.has(key)) throw new Error(`Service ${key} cannot be both required and optional.`);
  }
  const declared = new Map([...(requirements.required ?? []), ...(requirements.optional ?? [])].map(contract => [contract.key, contract]));
  return Object.freeze({
    get<T>(contract: ServiceContract<T>): T | undefined {
      if (!declared.has(contract.key)) throw new Error(`Extension did not declare service ${contract.key}.`);
      const implementation = registry.get(contract);
      if (required.has(contract.key) && implementation === undefined) {
        throw new Error(`Required service ${contract.key} has no configured provider.`);
      }
      return implementation;
    },
  });
}
