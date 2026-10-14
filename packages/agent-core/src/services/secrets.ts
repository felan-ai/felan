import { defineServiceContract } from '../services.js';

export interface SecretAddress {
  readonly namespace: string;
  readonly key: string;
}

export interface SecretRecord {
  readonly value: string;
  /** Opaque content identity, not a monotonic revision or an authorization token. */
  readonly version: string;
}

export interface SecretsRequestOptions {
  readonly signal?: AbortSignal;
}

/**
 * Grant only to trusted credential consumers. Namespace selection addresses
 * storage within the provider's grant; it does not authorize a new namespace.
 * An address outside the grant fails with unavailable, not an absent record.
 * Values must stay out of model-facing results, UI, logs and durable events.
 */
export interface SecretsService {
  read(address: SecretAddress, options?: SecretsRequestOptions): Promise<SecretRecord | undefined>;
  write(address: SecretAddress, record: { readonly value: string; readonly expectedVersion: string | null }, options?: SecretsRequestOptions): Promise<SecretRecord>;
  remove(address: SecretAddress, expectedVersion: string, options?: SecretsRequestOptions): Promise<void>;
}

export type SecretServiceErrorCode = 'invalid' | 'unavailable' | 'conflict';

const messages: Record<SecretServiceErrorCode, string> = {
  invalid: 'Secret request is invalid.',
  unavailable: 'Secret storage is unavailable.',
  conflict: 'Secret version conflict.',
};

export class SecretServiceError extends Error {
  readonly code: SecretServiceErrorCode;

  constructor(code: SecretServiceErrorCode) {
    const safeCode = code === 'unavailable' || code === 'conflict' ? code : 'invalid';
    super(messages[safeCode]);
    this.name = 'SecretServiceError';
    this.code = safeCode;
  }
}

export const SECRETS_LIMITS = Object.freeze({ namespaceBytes: 64, keyBytes: 128, valueBytes: 64 * 1024, versionBytes: 128 });
export const SECRETS_SERVICE = defineServiceContract<SecretsService>('felan.secrets', 1);
