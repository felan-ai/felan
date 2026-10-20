import { execFile } from 'node:child_process';
import { createHash, createPrivateKey, randomBytes, randomUUID, sign, type JsonWebKey, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  PROTOCOL_VERSION, ROW_SCHEMA_VERSION, parseHostTokenClaims, parseHostTokenRequest,
  type HostRegistration, type RemoteCommand,
} from '@felan-ai/session-protocol';
import { PlatformClient } from '../../src/remote/platform.js';
import type { HostTokenProvider } from '../../src/remote/token.js';

const execFileAsync = promisify(execFile);
const probeTimeout = 1_000;
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const registration: HostRegistration = {
  name: 'Connector contract test', daemonVersion: '0.1.0', rowSchemaVersion: ROW_SCHEMA_VERSION,
  capabilities: { operations: ['sessions.create', 'prompt', 'steer', 'cancel', 'interaction.answer'], interactionKinds: ['confirm'] },
  projects: [{ id: 'contract-project', name: 'Contract project', path: '/tmp/connector-contract' }],
};

export interface LocalSupabase {
  url: string;
  apiUrl: string;
  publishableKey: string;
  key: KeyObject;
  kid: string;
  admin: SupabaseClient;
}
export type SupabaseProbe = { environment: LocalSupabase; reason?: never } | { environment?: never; reason: string };

function localUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Connector integration tests require a loopback URL with no credentials or path.');
  }
  return url.origin;
}

async function configuredUrl(platform: string): Promise<string> {
  if (process.env.SUPABASE_URL) return localUrl(process.env.SUPABASE_URL);
  const config = await readFile(resolve(platform, 'supabase/config.toml'), 'utf8').catch(() => '');
  const section = /\[api\]([^]*?)(?:\n\[|$)/u.exec(config)?.[1];
  const port = /^\s*port\s*=\s*(\d+)\s*(?:#.*)?$/mu.exec(section ?? '')?.[1] ?? '54321';
  return localUrl(`http://127.0.0.1:${port}`);
}

export function signedToken(environment: Pick<LocalSupabase, 'key' | 'kid'>, claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: environment.kid, typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const input = `${header}.${body}`;
  return `${input}.${sign('sha256', Buffer.from(input), { key: environment.key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

function claims(role: string, subject: string): Record<string, unknown> {
  const iat = Math.floor(Date.now() / 1_000);
  return { iss: 'https://felan.ai/api/v1/hosts/token', aud: 'authenticated', role, sub: subject, iat, exp: iat + 900 };
}

export function authenticatedClient(environment: LocalSupabase, token: string): SupabaseClient {
  return createClient(environment.url, environment.publishableKey, {
    accessToken: async () => token,
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(8_000) }) },
  });
}

export async function probeSupabase(): Promise<SupabaseProbe> {
  const platform = resolve(process.env.FELAN_PLATFORM_DIR ?? resolve(repository, '../felan-platform'));
  const url = await configuredUrl(platform);
  try { await fetch(`${url}/rest/v1/`, { signal: AbortSignal.timeout(probeTimeout), redirect: 'error' }); }
  catch { return { reason: `shared local Supabase is unreachable at ${url} (${probeTimeout} ms probe); no stack was started` }; }

  let publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!publishableKey) {
    try {
      const { stdout } = await execFileAsync('supabase', ['status', '--output', 'json'], { cwd: platform, timeout: 10_000, maxBuffer: 64 * 1024 });
      const status = JSON.parse(stdout) as Record<string, unknown>;
      const key = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
      if (typeof key === 'string') publishableKey = key;
    } catch { /* Status is read-only; a missing CLI or stopped stack is not a reason to start it. */ }
  }
  if (!publishableKey) return { reason: 'local publishable key unavailable (set SUPABASE_PUBLISHABLE_KEY or enable read-only supabase status)' };

  const path = resolve(platform, 'supabase/signing_keys.json');
  let contents: string;
  try { contents = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { reason: `signing key file missing: ${path}` };
    throw new Error('Cannot read the local Supabase signing key file.');
  }
  let jwks: unknown;
  try { jwks = JSON.parse(contents); }
  catch { throw new Error('Local signing_keys.json is not valid JSON.'); }
  const jwk = Array.isArray(jwks) ? jwks.find((value: unknown) => value !== null && typeof value === 'object'
    && Reflect.get(value, 'alg') === 'ES256' && Reflect.get(value, 'crv') === 'P-256'
    && typeof Reflect.get(value, 'd') === 'string' && typeof Reflect.get(value, 'kid') === 'string') as (JsonWebKey & { kid: string }) | undefined : undefined;
  if (!jwk) throw new Error('Local signing_keys.json must contain a private ES256/P-256 JWK with kid.');
  let key: KeyObject;
  try { key = createPrivateKey({ key: jwk, format: 'jwk' }); }
  catch { throw new Error('Local signing_keys.json contains an invalid ES256 private key.'); }
  const signing = { key, kid: jwk.kid };
  const environment: LocalSupabase = {
    ...signing, url, publishableKey, apiUrl: localUrl(process.env.FELAN_API_URL ?? 'http://localhost:3000'),
    admin: createClient(url, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        headers: { Authorization: `Bearer ${signedToken(signing, claims('service_role', '00000000-0000-0000-0000-000000000000'))}` },
        fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(8_000) }),
      },
    }),
  };
  // Missing tables/RPCs are skippable; bad signing keys, grants, and column mismatches are not.
  for (const table of ['hosts', 'host_sessions', 'session_events', 'session_commands', 'session_tombstones']) {
    const { error, status } = await environment.admin.from(table).select('*').limit(0).abortSignal(AbortSignal.timeout(probeTimeout));
    if (error && (status === 404 || ['PGRST205', '42P01'].includes(error.code))) return { reason: `platform schema not present (${table})` };
    assertDatabase({ error }, `probe ${table}`);
  }
  const { data, error } = await environment.admin.rpc('host_heartbeat').abortSignal(AbortSignal.timeout(probeTimeout));
  if (error?.code === 'PGRST202') return { reason: 'platform schema not present (host_heartbeat RPC)' };
  if (!error || !/host|forbidden/iu.test(`${error.message} ${error.details}`)) {
    throw new Error(`host_heartbeat schema probe must reject a non-host caller (code ${error?.code ?? 'none'}, result ${typeof data}).`);
  }
  return { environment };
}

export async function probeTokenEndpoint(probe: SupabaseProbe): Promise<string | undefined> {
  if (!probe.environment) return probe.reason;
  try {
    const response = await fetch(`${probe.environment.apiUrl}/api/v1/hosts/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
      body: JSON.stringify(parseHostTokenRequest({ installId: randomUUID(), name: registration.name,
        daemonVersion: registration.daemonVersion, rowSchemaVersion: ROW_SCHEMA_VERSION, protocol: PROTOCOL_VERSION })),
      signal: AbortSignal.timeout(probeTimeout),
    });
    if ([404, 405].includes(response.status)) return 'POST /api/v1/hosts/token is not present';
    if (response.status !== 401) throw new Error(`Unauthenticated token endpoint probe returned HTTP ${response.status}, expected 401.`);
    return undefined;
  } catch (error) {
    if (error instanceof TypeError || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))) {
      return `local Felan API is unreachable at ${probe.environment.apiUrl} (${probeTimeout} ms probe)`;
    }
    throw error;
  }
}

export function assertDatabase(result: { error: { code?: string } | null }, operation: string): void {
  if (result.error) throw new Error(`${operation} failed (${result.error.code ?? 'unknown'}); database must match the connector contract.`);
}

export function uuidV7(): string {
  const hex = Date.now().toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7${randomBytes(2).toString('hex').slice(1)}-8${randomBytes(2).toString('hex').slice(1)}-${randomBytes(6).toString('hex')}`;
}

export interface TestHost { id: string; installId: string; teamId: string; userId: string; apiKeyId: string }
export interface TestOwner { teamId: string; userId: string; apiKeyId: string; pat: string; hosts: [TestHost, TestHost] }
export interface TestConnection { platform: PlatformClient; raw: SupabaseClient }

export class SupabaseFixtures {
  #users: string[] = [];
  #teams: string[] = [];
  #connections: TestConnection[] = [];
  #viewers: SupabaseClient[] = [];
  #invitationTeam: Promise<string> | undefined;
  constructor(readonly environment: LocalSupabase) {}

  private invitationTeam(): Promise<string> {
    return this.#invitationTeam ??= (async () => {
      const { data, error } = await this.environment.admin.from('profiles').select('id')
        .not('email', 'like', 'connector-%@example.invalid').limit(1).maybeSingle();
      assertDatabase({ error }, 'read local invitation sponsor');
      if (!data) throw new Error('Connector fixtures require one existing local profile as an invitation sponsor.');
      const id = randomUUID();
      this.#teams.push(id);
      assertDatabase(await this.environment.admin.from('teams').insert({
        id, name: 'Connector invitation fixture', slug: `connector-${id}`, owner_id: data.id,
      }), 'seed invitation team');
      return id;
    })();
  }

  async owner(): Promise<TestOwner> {
    const email = `connector-${randomUUID()}@example.invalid`;
    // Uninvited signups create trial teams with immutable credit grants that cannot be cleaned up.
    assertDatabase(await this.environment.admin.from('team_invitations').insert({
      team_id: await this.invitationTeam(), email, code: randomUUID(), role: 'member',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }), 'seed signup invitation');
    const { data, error } = await this.environment.admin.auth.admin.createUser({ email, email_confirm: true });
    if (error || !data.user) throw new Error('Cannot seed local auth user for connector contract tests.');
    const userId = data.user.id;
    this.#users.push(userId);
    assertDatabase(await this.environment.admin.from('profiles').upsert({ id: userId, email, name: 'Connector contract test' }), 'seed profiles');
    const teamId = randomUUID();
    this.#teams.push(teamId);
    assertDatabase(await this.environment.admin.from('teams').insert({ id: teamId, name: 'Connector contract test', slug: `connector-${teamId}`, owner_id: userId }), 'seed teams');
    assertDatabase(await this.environment.admin.from('team_members').insert({ team_id: teamId, user_id: userId, role: 'owner' }), 'seed team_members');
    const { apiKeyId, pat } = await this.personalKey(teamId, userId);
    const first = await this.host({ teamId, userId, apiKeyId });
    const second = await this.host({ teamId, userId, apiKeyId });
    return { teamId, userId, apiKeyId, pat, hosts: [first, second] };
  }

  async personalKey(teamId: string, userId: string): Promise<{ apiKeyId: string; pat: string }> {
    // Matches felan-platform's documented SHA-256 API-key storage; plaintext is never persisted.
    const pat = `fln_pat_${randomBytes(16).toString('hex')}`;
    const apiKeyId = randomUUID();
    assertDatabase(await this.environment.admin.from('api_keys').insert({
      id: apiKeyId, team_id: teamId, user_id: userId, scope: 'personal', encrypted_key: null,
      key_hash: createHash('sha256').update(pat).digest('hex'), key_prefix: `${pat.slice(0, 12)}...`,
    }), 'seed personal api_keys');
    return { apiKeyId, pat };
  }

  async host(owner: Pick<TestOwner, 'teamId' | 'userId' | 'apiKeyId'>): Promise<TestHost> {
    const host = { id: randomUUID(), installId: randomUUID(), teamId: owner.teamId, userId: owner.userId, apiKeyId: owner.apiKeyId };
    assertDatabase(await this.environment.admin.from('hosts').insert({
      id: host.id, install_id: host.installId, team_id: host.teamId, user_id: host.userId, api_key_id: host.apiKeyId,
      name: registration.name, daemon_version: registration.daemonVersion, row_schema_version: registration.rowSchemaVersion,
      capabilities: registration.capabilities, projects: registration.projects,
    }), 'seed hosts');
    return host;
  }

  tokenSource(host: TestHost): HostTokenProvider {
    const payload = parseHostTokenClaims({ ...claims('authenticated', host.id), felan: { kind: 'host', host_id: host.id, team_id: host.teamId, user_id: host.userId } });
    const token = signedToken(this.environment, payload);
    // The local signing key replaces the HTTP issuer only; RPCs and Realtime use real Supabase clients.
    return {
      token: async () => token, cachedToken: () => token, onChange: () => () => {},
      current: () => ({ expiresAt: payload.exp * 1_000, refreshAt: (payload.exp - 60) * 1_000,
        host: { id: host.id, teamId: host.teamId, userId: host.userId },
        supabase: { url: this.environment.url, publishableKey: this.environment.publishableKey } }),
    };
  }

  async connect(host: TestHost): Promise<TestConnection> {
    const source = this.tokenSource(host);
    let raw: SupabaseClient | undefined;
    const platform = await PlatformClient.connect(source, {
      fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(8_000) }),
      clientFactory: (url, key, options) => {
        const client = createClient(url, key, options);
        raw = client;
        return { rpc: async (name, params) => client.rpc(name, params), channel: (topic, config) => client.channel(topic, config),
          realtime: client.realtime, removeChannel: async channel => client.removeChannel(channel as ReturnType<typeof client.channel>) };
      },
    });
    if (!raw) throw new Error('PlatformClient did not create a Supabase client.');
    const connection = { platform, raw };
    this.#connections.push(connection);
    return connection;
  }

  async viewer(userId: string): Promise<SupabaseClient> {
    const token = signedToken(this.environment, claims('authenticated', userId));
    const client = authenticatedClient(this.environment, token);
    this.#viewers.push(client);
    await client.realtime.setAuth(token);
    return client;
  }

  async command(host: TestHost, command: RemoteCommand): Promise<string> {
    const id = uuidV7();
    assertDatabase(await this.environment.admin.from('session_commands').insert({
      id, team_id: host.teamId, host_id: host.id, session_id: 'session' in command ? command.session : null,
      requester_user_id: host.userId, op: command.op, params: command.params,
      state: 'pending', expires_at: new Date(Date.now() + 60_000).toISOString(),
    }), 'seed session_commands');
    return id;
  }

  async cleanup(): Promise<void> {
    const failures: string[] = [];
    for (const connection of this.#connections) {
      try { await connection.platform.close(); await connection.raw.removeAllChannels(); }
      catch { failures.push('host channel cleanup'); }
    }
    for (const viewer of this.#viewers) {
      try { await viewer.removeAllChannels(); }
      catch { failures.push('viewer channel cleanup'); }
    }
    for (const team of this.#teams) {
      const { error } = await this.environment.admin.from('teams').delete().eq('id', team);
      if (error) failures.push(`team cleanup (${error.code})`);
    }
    for (const user of this.#users) {
      const { error } = await this.environment.admin.auth.admin.deleteUser(user);
      if (error) failures.push(`auth user cleanup (${error.status}: ${error.code ?? 'unknown'}: ${error.message})`);
    }
    if (this.#teams.length) {
      for (const table of ['teams', 'team_members', 'team_invitations', 'api_keys', 'hosts', 'host_sessions', 'session_events', 'session_commands', 'session_tombstones']) {
        const { count, error } = await this.environment.admin.from(table).select('*', { count: 'exact', head: true })
          .in(table === 'teams' ? 'id' : 'team_id', this.#teams);
        if (error || count !== 0) failures.push(`${table} cleanup verification`);
      }
    }
    if (this.#users.length) {
      const { count, error } = await this.environment.admin.from('profiles').select('*', { count: 'exact', head: true }).in('id', this.#users);
      if (error || count !== 0) failures.push('profile cleanup verification');
    }
    if (failures.length) throw new Error(`Connector fixture cleanup failed: ${failures.join(', ')}`);
  }
}

export async function waitFor(check: () => boolean, label: string, timeout = 8_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
