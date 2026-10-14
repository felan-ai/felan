import { defineServiceContract } from '../services.js';

export type RuntimeDependencyInstallResult =
  | { readonly status: 'installed' }
  | { readonly status: 'cancelled' | 'unavailable'; readonly message: string };

/** Host policy selects known installers; session UI consent alone grants nothing. */
export interface RuntimeDependenciesService {
  install(request: { readonly id: string }, options?: { readonly signal?: AbortSignal }): Promise<RuntimeDependencyInstallResult>;
}

export const RUNTIME_DEPENDENCIES_SERVICE = defineServiceContract<RuntimeDependenciesService>('felan.runtime.dependencies', 1);
