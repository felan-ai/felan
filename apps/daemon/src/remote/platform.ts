import { createClient, type SupabaseClientOptions } from '@supabase/supabase-js';
import {
  PUBLICATION_LIMITS, RemoteCommandRowSchema, UUID_V7_PATTERN, parseHostRegistration, parsePublishedEvent,
  parsePublishedSession, parseRemoteCommand, parseRemoteCommandOutcome, parseSchema,
  type HostRegistration, type PublishedEvent, type PublishedSession, type RemoteCommand, type RemoteCommandOutcome,
} from '@felan-ai/session-protocol';
import { redact } from '../logger.js';
import { RemoteRealtime, type RealtimeClientPort, type RemoteRealtimeOptions } from './realtime.js';
import type { HostTokenProvider } from './token.js';

export type PlatformErrorKind = 'session_deleted' | 'forbidden' | 'sequence_gap' | 'revoked' | 'unsupported_schema' | 'conflict' | 'invalid' | 'retry';
export class PlatformError extends Error {
  constructor(readonly kind: PlatformErrorKind, message: string, readonly lastSeq?: number, readonly supported?: number[], readonly rateLimited = false, readonly httpStatus?: number) {
    super(redact(message));
    this.name = 'PlatformError';
  }
}
export interface RemoteSupabaseClient extends RealtimeClientPort {
  rpc(name: string, params?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown; status?: number }>;
}
export type SupabaseClientFactory = (url: string, key: string, options: SupabaseClientOptions<'public'>) => RemoteSupabaseClient;
export interface PlatformClientOptions {
  clientFactory?: SupabaseClientFactory;
  fetch?: typeof fetch;
  realtime?: Omit<RemoteRealtimeOptions, 'authorize'>;
}
export interface ClaimedCommand {
  id: string;
  session?: string;
  requester: string;
  command: RemoteCommand;
  expiresAt: number;
  claimedAt?: number;
  state: 'pending' | 'claimed' | 'completed' | 'expired';
}
export interface InvalidClaimedCommand { id: string; invalid: string }

function sequence(value: unknown): number | undefined {
  if (typeof value === 'string' && !/^\d+$/u.test(value)) return undefined;
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function errorDetail(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) as unknown; } catch { return; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function parsePlatformError(error: unknown, status?: number, operation: 'publish' | 'other' = 'publish'): PlatformError {
  const record = errorDetail(error);
  if (typeof record?.code === 'string' && /^PT\d{3}$/u.test(record.code)) {
    const detail = errorDetail(record.details);
    const lastSeq = sequence(detail?.lastSeq) ?? sequence(detail?.last_seq);
    const versions = detail?.supported;
    const supported = Array.isArray(versions) && versions.every(version => typeof version === 'number' && Number.isSafeInteger(version) && version >= 1) ? versions as number[] : undefined;
    switch (record.message) {
      case 'session_deleted': return new PlatformError('session_deleted', 'Published session was deleted.');
      case 'sequence_gap': return new PlatformError('sequence_gap', 'Publication sequence has a gap.', lastSeq);
      case 'unsupported_schema': return new PlatformError('unsupported_schema', 'Remote publication requires a supported schema version.', undefined, supported);
      case 'not_a_host': case 'host_revoked': case 'not_a_member':
        return new PlatformError('revoked', 'Host authorization is no longer valid.');
      case 'forbidden': return new PlatformError('forbidden', 'Host cannot publish this session.');
      case 'conflict': return new PlatformError('conflict', 'Remote command is no longer claimed.');
      case 'limit_exceeded': if (record.code === 'PT413') return new PlatformError('invalid', 'Platform rejected the request.'); break;
      case 'invalid_request': if (record.code === 'PT400') return new PlatformError('invalid', 'Platform rejected the request.'); break;
    }
  }
  if (status === 408 || status === 429 || status !== undefined && status >= 500) {
    return new PlatformError('retry', 'Platform is temporarily unavailable.', undefined, undefined, status === 429);
  }
  if (status === 401 || status === 403 || ['PGRST301', 'PGRST302', 'PGRST303', '42501'].includes(String(record?.code))) {
    return new PlatformError('revoked', 'Host authorization is no longer valid.', undefined, undefined, false, status);
  }
  if (operation === 'publish'
    && ([400, 404, 413, 422].includes(status ?? 0) || /^(?:22\w{3}|23502|23514|PGRST1\d{2})$/u.test(String(record?.code)))) {
    return new PlatformError('invalid', 'Platform rejected the publication payload.');
  }
  return new PlatformError('retry', 'Platform is temporarily unavailable.', undefined, undefined, status === 429);
}

function timestamp(value: unknown): number {
  const result = typeof value === 'string' ? Date.parse(value) : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 0) throw new Error();
  return result;
}

function claimed(value: unknown): ClaimedCommand | InvalidClaimedCommand {
  const candidate = value && typeof value === 'object' ? Reflect.get(value, 'id') : undefined;
  const id = typeof candidate === 'string' && new RegExp(UUID_V7_PATTERN).test(candidate) ? candidate : '';
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const session = Reflect.get(value, 'session_id');
    const command = parseRemoteCommand({
      op: Reflect.get(value, 'op'), params: Reflect.get(value, 'params'),
      ...(session === null || session === undefined ? {} : { session }),
    });
    if (command.op === 'sessions.create' && session !== null && session !== undefined) throw new Error();
    const row = parseSchema(RemoteCommandRowSchema, {
      id, host: Reflect.get(value, 'host_id'), requester: Reflect.get(value, 'requester_user_id'), command,
      createdAt: timestamp(Reflect.get(value, 'created_at')), expiresAt: timestamp(Reflect.get(value, 'expires_at')),
    });
    const state = Reflect.get(value, 'state');
    if (!['pending', 'claimed', 'completed', 'expired'].includes(state)) throw new Error();
    return {
      id, ...(typeof session === 'string' ? { session } : {}), requester: row.requester,
      command, expiresAt: row.expiresAt, state: state as ClaimedCommand['state'],
      ...(Reflect.get(value, 'claimed_at') == null ? {} : { claimedAt: timestamp(Reflect.get(value, 'claimed_at')) }),
    };
  } catch { return { id, invalid: 'Invalid claimed command row.' }; }
}

export class PlatformClient {
  readonly realtime: RemoteRealtime;
  #client: RemoteSupabaseClient;
  #source: HostTokenProvider;
  #unsubscribe: () => void;
  #auth: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(source: HostTokenProvider, client: RemoteSupabaseClient, options: PlatformClientOptions) {
    this.#client = client;
    this.#source = source;
    this.realtime = new RemoteRealtime(client, { ...options.realtime, authorize: async () => this.#setAuth(await source.token()) });
    this.#unsubscribe = source.onChange(token => { void this.#setAuth(token).catch(() => {}); });
  }

  static async connect(source: HostTokenProvider, options: PlatformClientOptions = {}): Promise<PlatformClient> {
    const token = await source.token();
    const info = source.current();
    if (!info) throw new PlatformError('invalid', 'Host token metadata is unavailable.');
    const factory: SupabaseClientFactory = options.clientFactory ?? ((url, key, config) => {
      const client = createClient(url, key, config);
      return {
        rpc: async (name, params) => client.rpc(name, params),
        channel: (topic, config) => client.channel(topic, config),
        realtime: client.realtime,
        removeChannel: async channel => client.removeChannel(channel as ReturnType<typeof client.channel>),
      };
    });
    const client = factory(info.supabase.url, info.supabase.publishableKey, {
      accessToken: async () => source.cachedToken(),
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { heartbeatIntervalMs: 25_000 },
      ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
    });
    const platform = new PlatformClient(source, client, options);
    try { await platform.#setAuth(token); }
    catch { await platform.close(); throw new PlatformError('retry', 'Realtime authorization is temporarily unavailable.'); }
    return platform;
  }

  async register(registration: HostRegistration): Promise<void> {
    let parsed: HostRegistration;
    try { parsed = parseHostRegistration(registration); }
    catch { throw new PlatformError('invalid', 'Invalid host registration.'); }
    await this.#rpc('host_register', { p_registration: parsed });
  }

  async heartbeat(): Promise<void> { await this.#rpc('host_heartbeat'); }

  async publish(session: PublishedSession, events: PublishedEvent[]): Promise<number> {
    let args: { p_session: PublishedSession; p_events: PublishedEvent[] };
    try {
      args = { p_session: parsePublishedSession(session), p_events: events.map(parsePublishedEvent) };
      if (events.length > PUBLICATION_LIMITS.eventsPerBatch
        || args.p_events.some(event => event.session !== session.session || Buffer.byteLength(JSON.stringify(event.change)) > PUBLICATION_LIMITS.changeBytes)
        || Buffer.byteLength(JSON.stringify(args)) > PUBLICATION_LIMITS.batchBytes) throw new Error();
    } catch { throw new PlatformError('invalid', 'Invalid publication payload.'); }
    const result = sequence(await this.#rpc('publish_session_events', args));
    if (result === undefined) throw new PlatformError('invalid', 'Platform returned an invalid publication sequence.');
    return result;
  }

  async claim(): Promise<(ClaimedCommand | InvalidClaimedCommand)[]> {
    const data = await this.#rpc('claim_session_commands');
    if (!Array.isArray(data)) throw new PlatformError('invalid', 'Platform returned an invalid command batch.');
    return data.map(claimed);
  }

  async complete(id: string, outcome: RemoteCommandOutcome): Promise<void> {
    let parsed: RemoteCommandOutcome;
    try {
      parsed = parseRemoteCommandOutcome(outcome);
      if (!new RegExp(UUID_V7_PATTERN).test(id) || parsed.re !== id) throw new Error();
    } catch { throw new PlatformError('invalid', 'Invalid command outcome.'); }
    await this.#rpc('complete_session_command', { p_id: id, p_outcome: structuredClone(outcome) });
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#unsubscribe();
    await this.realtime.close();
    await this.#auth.catch(() => {});
  }

  #setAuth(token: string): Promise<void> {
    this.#auth = this.#auth.catch(() => {}).then(async () => {
      if (!this.#closed) await this.#client.realtime.setAuth(token);
    });
    return this.#auth;
  }

  async #rpc(name: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.#closed) throw new PlatformError('invalid', 'Platform client is closed.');
    await this.#source.token();
    let response;
    try { response = await this.#client.rpc(name, params); }
    catch { throw new PlatformError('retry', 'Platform is temporarily unavailable.'); }
    if (response.error) throw parsePlatformError(response.error, response.status, name === 'publish_session_events' ? 'publish' : 'other');
    return response.data;
  }
}
