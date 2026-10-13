import { createHash } from 'node:crypto';
import type {
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import type { ResolvedMcpServer } from './contracts.js';
import type { SecretAddress, SecretRecord, SecretsService } from '@felan-ai/agent-core';

const credentialLocks = new Map<string, Promise<void>>();

export interface StoredMcpOAuthCredentials {
  readonly version: 1;
  readonly serverUrl: string;
  readonly oauthProfile: string;
  readonly clientInformation?: StoredOAuthClientInformation;
  readonly tokens?: StoredOAuthTokens;
}

export class McpOAuthCredentialRepository {
  readonly #namespace: string;
  readonly #secrets: SecretsService;

  constructor(namespace: string, secrets: SecretsService) {
    this.#namespace = namespace;
    this.#secrets = secrets;
  }

  async read(
    server: ResolvedMcpServer,
    signal?: AbortSignal,
  ): Promise<StoredMcpOAuthCredentials | undefined> {
    signal?.throwIfAborted();
    const payload = (await this.#read(this.#account(server), signal))?.value;
    signal?.throwIfAborted();
    if (payload == null) return undefined;
    const parsed = parseStoredCredentials(payload);
    return parsed.serverUrl === server.url ? parsed : undefined;
  }

  async update(
    server: ResolvedMcpServer,
    update: (
      current: StoredMcpOAuthCredentials | undefined,
    ) => StoredMcpOAuthCredentials | undefined | Promise<StoredMcpOAuthCredentials | undefined>,
    signal?: AbortSignal,
  ): Promise<void> {
    const account = this.#account(server);
    await this.#withLock(account, async () => {
      signal?.throwIfAborted();
      const record = await this.#read(account, signal);
      const payload = record?.value;
      const parsed = payload == null ? undefined : parseStoredCredentials(payload);
      const current = parsed?.serverUrl === server.url ? parsed : undefined;
      const next = await update(current);
      signal?.throwIfAborted();
      if (next === undefined) {
        await this.#remove(account, record, signal);
      } else {
        const value = JSON.stringify(next);
        await this.#secrets.write(this.#address(account), { value, expectedVersion: record?.version ?? null },
          signal ? { signal } : undefined);
      }
    });
  }

  async remove(server: ResolvedMcpServer, signal?: AbortSignal): Promise<void> {
    const account = this.#account(server);
    await this.#withLock(account, async () => {
      await this.#remove(account, await this.#read(account, signal), signal);
    });
  }

  #address(account: string): SecretAddress {
    return { namespace: 'mcp.oauth', key: account };
  }

  async #read(account: string, signal?: AbortSignal): Promise<SecretRecord | undefined> {
    return this.#secrets.read(this.#address(account), signal ? { signal } : undefined);
  }

  async #remove(account: string, record: SecretRecord | undefined, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (record) await this.#secrets.remove(this.#address(account), record.version, signal ? { signal } : undefined);
  }

  #account(server: ResolvedMcpServer): string {
    const digest = createHash('sha256')
      .update(this.#namespace, 'utf8')
      .update('\0', 'utf8')
      .update(server.name, 'utf8')
      .digest('hex');
    return `sha256-${digest}`;
  }

  async #withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = credentialLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    credentialLocks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (credentialLocks.get(key) === queued) credentialLocks.delete(key);
    }
  }
}

function parseStoredCredentials(payload: string): StoredMcpOAuthCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    throw new Error('Stored MCP OAuth credentials are invalid');
  }
  if (
    !isRecord(parsed)
    || parsed.version !== 1
    || typeof parsed.serverUrl !== 'string'
    || typeof parsed.oauthProfile !== 'string'
    || (parsed.clientInformation !== undefined && !isStoredClientInformation(parsed.clientInformation))
    || (parsed.tokens !== undefined && !isStoredTokens(parsed.tokens))
  ) {
    throw new Error('Stored MCP OAuth credentials are invalid');
  }
  return parsed as unknown as StoredMcpOAuthCredentials;
}

function isStoredClientInformation(value: unknown): boolean {
  return isRecord(value)
    && typeof value.client_id === 'string'
    && (value.client_secret === undefined || typeof value.client_secret === 'string')
    && (value.issuer === undefined || typeof value.issuer === 'string');
}

function isStoredTokens(value: unknown): boolean {
  return isRecord(value)
    && typeof value.access_token === 'string'
    && typeof value.token_type === 'string'
    && (value.refresh_token === undefined || typeof value.refresh_token === 'string')
    && (value.issuer === undefined || typeof value.issuer === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
