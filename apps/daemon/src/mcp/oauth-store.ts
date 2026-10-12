import { createHash } from 'node:crypto';
import type {
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import type { ResolvedMcpServer } from '@felan-ai/ext-mcp';

const KEYRING_SERVICE = 'felan.mcp.oauth';
const credentialLocks = new Map<string, Promise<void>>();

export interface StoredMcpOAuthCredentials {
  readonly version: 1;
  readonly serverUrl: string;
  readonly oauthProfile: string;
  readonly clientInformation?: StoredOAuthClientInformation;
  readonly tokens?: StoredOAuthTokens;
}

export interface McpOAuthSecretStore {
  read(account: string, signal?: AbortSignal): Promise<string | null | undefined>;
  write(account: string, value: string, signal?: AbortSignal): Promise<void>;
  remove(account: string, signal?: AbortSignal): Promise<void>;
}

export class KeyringMcpOAuthSecretStore implements McpOAuthSecretStore {
  async read(account: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const entry = await keyringEntry(account);
      return (await entry.getPassword(signal)) ?? undefined;
    } catch (error) {
      throw credentialStoreError('read', error);
    }
  }

  async write(account: string, value: string, signal?: AbortSignal): Promise<void> {
    try {
      const entry = await keyringEntry(account);
      await entry.setPassword(value, signal);
    } catch (error) {
      throw credentialStoreError('write', error);
    }
  }

  async remove(account: string, signal?: AbortSignal): Promise<void> {
    try {
      const entry = await keyringEntry(account);
      await entry.deleteCredential(signal);
    } catch (error) {
      throw credentialStoreError('remove', error);
    }
  }
}

export class McpOAuthCredentialRepository {
  readonly #namespace: string;
  readonly #store: McpOAuthSecretStore;

  constructor(namespace: string, store: McpOAuthSecretStore = new KeyringMcpOAuthSecretStore()) {
    this.#namespace = namespace;
    this.#store = store;
  }

  async read(
    server: ResolvedMcpServer,
    signal?: AbortSignal,
  ): Promise<StoredMcpOAuthCredentials | undefined> {
    signal?.throwIfAborted();
    const payload = await this.#store.read(this.#account(server), signal);
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
      const payload = await this.#store.read(account, signal);
      const parsed = payload == null ? undefined : parseStoredCredentials(payload);
      const current = parsed?.serverUrl === server.url ? parsed : undefined;
      const next = await update(current);
      signal?.throwIfAborted();
      if (next === undefined) {
        await this.#store.remove(account, signal);
      } else {
        await this.#store.write(account, JSON.stringify(next), signal);
      }
    });
  }

  async remove(server: ResolvedMcpServer, signal?: AbortSignal): Promise<void> {
    const account = this.#account(server);
    await this.#withLock(account, () => this.#store.remove(account, signal));
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

async function keyringEntry(account: string) {
  const { AsyncEntry } = await import('@napi-rs/keyring');
  return new AsyncEntry(KEYRING_SERVICE, account);
}

function parseStoredCredentials(payload: string): StoredMcpOAuthCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch (error) {
    throw new Error('Stored MCP OAuth credentials are invalid', { cause: error });
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

function credentialStoreError(operation: string, cause: unknown): Error {
  return new Error(
    `MCP OAuth credential store is unavailable during ${operation}. Configure or unlock the OS credential store and retry.`,
    { cause },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
