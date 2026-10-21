import type { SessionExtensionContext, SessionExecutionPort } from './session-execution.js';
import type { TSchema } from 'typebox';
import type { JsonValue } from '@felan-ai/session-protocol';
import type { AgentRuntime, ExtensionServiceAccess, FelanServiceRegistry, InlineExtension, ModelReference, ModelRuntime, RuntimeDependenciesService, ServiceContract, SessionsService } from '@felan-ai/agent-core';
export { SESSION_RUNTIME_SERVICE } from './session-runtime.js';
export type { SessionRuntime, SessionComposition, SessionCompositionOptions, SessionCompositionRequest, SessionEnvironment, SessionEnvironmentRequest } from './session-runtime.js';

export interface ServiceProviderContract {
  readonly id: string;
  readonly major: number;
}

export interface ServiceProviderInstance {
  readonly implementations: readonly { readonly contract: ServiceContract<unknown>; readonly value: unknown }[];
  readonly inlineExtensions?: readonly InlineExtension[];
  busy?(): boolean;
  activate?(): Promise<void>;
  settle?(mode: 'drain' | 'force'): Promise<void>;
  dispose(): Promise<void>;
}

export interface ProviderCreateContext {
  readonly services: ExtensionServiceAccess;
  readonly options: JsonValue | undefined;
  readonly signal: AbortSignal;
}

export interface ProviderSecretStorage {
  read(namespace: string, key: string, signal?: AbortSignal): Promise<string | undefined>;
  write(namespace: string, key: string, value: string, signal?: AbortSignal): Promise<void>;
  remove(namespace: string, key: string, signal?: AbortSignal): Promise<void>;
}

export interface ProviderSessionContext extends ProviderCreateContext {
  readonly execution?: { readonly context: Omit<SessionExtensionContext, 'services'>; readonly port: SessionExecutionPort };
  readonly runtime: AgentRuntime;
  readonly modelRuntime: ModelRuntime;
  readonly secretStorage: ProviderSecretStorage;
  readonly sessions?: SessionsService;
  readonly openWorker?: ProviderWorkerLauncher;
  readonly runtimeDependencies?: RuntimeDependenciesService;
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly allowedModels: readonly ModelReference[] | undefined;
}

export type ProviderWorkerRequest = import('@felan-ai/agent-core').HostWorkerOptions;
export type ProviderWorkerSession = import('@felan-ai/agent-core').HostWorker;
export type ProviderWorkerLauncher = import('@felan-ai/agent-core').HostWorkerLauncher;

export interface ProviderSessionScope {
  readonly services: FelanServiceRegistry;
  readonly inlineExtensions: readonly InlineExtension[];
  busy(): boolean;
  activate(): Promise<void>;
  settle(mode: 'drain' | 'force'): Promise<void>;
  dispose(): Promise<void>;
}

export interface ServiceProviderDeclarations {
  readonly provides: readonly ServiceContract<unknown>[];
  readonly requires?: readonly ServiceProviderContract[];
  readonly optional?: readonly ServiceProviderContract[];
  readonly optionsSchema?: TSchema;
}

export type ServiceProviderDefinition = ServiceProviderDeclarations & ({
  readonly scope?: 'daemon';
  create(context: ProviderCreateContext): Promise<ServiceProviderInstance>;
} | {
  readonly scope: 'session';
  create(context: ProviderSessionContext): Promise<ServiceProviderInstance>;
});

export function defineServiceProvider(definition: Extract<ServiceProviderDefinition, { scope: 'session' }>): Extract<ServiceProviderDefinition, { scope: 'session' }>;
export function defineServiceProvider(definition: Exclude<ServiceProviderDefinition, { scope: 'session' }>): Exclude<ServiceProviderDefinition, { scope: 'session' }>;
export function defineServiceProvider(definition: ServiceProviderDefinition): ServiceProviderDefinition;
export function defineServiceProvider(definition: ServiceProviderDefinition): ServiceProviderDefinition {
  if (!Array.isArray(definition.provides) || typeof definition.create !== 'function'
    || definition.scope !== undefined && definition.scope !== 'daemon' && definition.scope !== 'session'
    || definition.requires !== undefined && !Array.isArray(definition.requires)
    || definition.optional !== undefined && !Array.isArray(definition.optional)
    || definition.provides.some(contract => !validContract(contract) || contract.key !== `${contract.id}@${contract.major}`)
    || [...(definition.requires ?? []), ...(definition.optional ?? [])].some(contract => !validContract(contract))) {
    throw new Error('Service provider contract declarations are invalid.');
  }
  const provided = definition.provides.map(contract => contract.key);
  const required = (definition.requires ?? []).map(contract => `${contract.id}@${contract.major}`);
  const optional = (definition.optional ?? []).map(contract => `${contract.id}@${contract.major}`);
  if (!definition.provides.length || new Set(provided).size !== provided.length || new Set(required).size !== required.length
    || new Set(optional).size !== optional.length || required.some(key => optional.includes(key))) {
    throw new Error('Service provider contract declarations are invalid.');
  }
  return Object.freeze({ ...definition, provides: Object.freeze([...definition.provides]),
    requires: Object.freeze([...(definition.requires ?? [])]), optional: Object.freeze([...(definition.optional ?? [])]) });
}

function validContract(value: ServiceProviderContract): boolean {
  return value !== null && typeof value === 'object' && typeof value.id === 'string'
    && value.id.length <= 128 && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(value.id)
    && Number.isSafeInteger(value.major) && value.major >= 1 && value.major <= 65_535;
}

export type { SessionExecutionPort, SessionExtensionBindings, SessionExtensionContext } from './session-execution.js';
export type { DetachedProcessInspection, ProcessAdapter, ProcessRecord } from './process-adapter.js';
export { assertAbsolutePath, canonicalPath } from './profile-storage.js';
export { createRuntimeStorageRequest } from '../runtime-factory.js';
export type { RuntimeFactory, RuntimeStorageRequest } from '../runtime-factory.js';
export { acquireLocalFileLock, withLocalFileLock } from '../lock.js';
export type { LocalFileLock, LocalFileLockOptions } from '../lock.js';
export { createLocalAgentLogger, redact } from '../logger.js';
export { commandError } from './commands.js';

export type { ExecutionHost, ExecutionSettings, ExecutionRecord, ExecutionCompletionNotice, ExecutionParentPort } from './executions.js';
