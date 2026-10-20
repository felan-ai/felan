import { hostname } from 'node:os';
import {
  INTERACTION_KINDS, REMOTE_FEATURES, ROW_SCHEMA_VERSION, isPublishedChangeType, parseRemoteConfigureParams, parseRemoteStatus,
  type HostCapabilities, type HostRegistration, type KnownSessionChange, type OperationParams, type RemoteStatus,
} from '@felan-ai/session-protocol';
import type { ProviderSecretStorage } from '../daemon/provider.js';
import type { RemoteDatabase } from '../daemon/persistence.js';
import type { SessionRegistry } from '../daemon/registry.js';
import type { SessionServer } from '../daemon/server.js';
import type { ProjectionOutput } from '../daemon/projection.js';
import { commandError } from '../daemon/commands.js';
import { redact } from '../logger.js';
import { DAEMON_VERSION } from '../version.js';
import { retryDelay, schedule, systemClock, type RemoteClock, type TimerHandle } from './backoff.js';
import { publicationBatches } from './batch.js';
import { RemoteCommandJournal } from './command-journal.js';
import { RemoteCommandExecutor } from './commands.js';
import { publishableChange, publishedEvent, publishedSession } from './content.js';
import { RemoteOutbox, RemoteOutboxCapacityError, type OutboxItem } from './outbox.js';
import { PlatformClient, PlatformError } from './platform.js';
import { sessionShared, setSessionSharing, webCreatedSession, type SharingInput } from './sharing.js';
import { RemoteTextSanitizer } from './text.js';
import { RemoteIntegrityError, RemoteStorageError, RemoteStore, type RemoteSessionRecord } from './state.js';
import { HostTokenSource, HostTokenExchangeError, type HostTokenProvider, type HostTokenSourceOptions } from './token.js';

export const REMOTE_CAPABILITIES: HostCapabilities = {
  operations: ['sessions.create', 'prompt', 'steer', 'cancel', 'interaction.answer'],
  interactionKinds: [...INTERACTION_KINDS],
  features: [...REMOTE_FEATURES],
};
export type ConnectorTokenSource = HostTokenProvider & Pick<HostTokenSource, 'stop' | 'invalidate'>;
export type ConnectorPlatform = Pick<PlatformClient, 'register' | 'heartbeat' | 'publish' | 'claim' | 'complete' | 'close'> & {
  realtime: Pick<PlatformClient['realtime'], 'subscribeCommands' | 'sendText'>;
};
export interface RemoteConnectorOptions {
  database: RemoteDatabase;
  registry: SessionRegistry;
  server: Pick<SessionServer, 'submitRemote' | 'hasRemoteRequest'>;
  secretStorage: ProviderSecretStorage;
  owner: { assertCurrent(): void };
  apiUrl?: string;
  name?: string;
  daemonVersion?: string;
  capabilities?: HostCapabilities;
  clock?: RemoteClock;
  heartbeatMs?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  tokenSource?(options: HostTokenSourceOptions): ConnectorTokenSource;
  connect?(source: ConnectorTokenSource): Promise<ConnectorPlatform>;
}

const stoppedMessages = {
  invalid_pat: 'Run /remote login with a new personal access token to resume sharing.',
  not_a_member: 'Publishing stopped: the host owner is no longer a team member.',
  host_revoked: 'Publishing stopped: this host was revoked. Run /remote login to pair it again.',
  unsupported_schema: 'Update Felan (the daemon) to resume sharing with a supported schema.',
} as const;
type StopReason = keyof typeof stoppedMessages;

export class RemoteConnector {
  readonly store: RemoteStore;
  readonly outbox: RemoteOutbox;
  private readonly executor: RemoteCommandExecutor;
  private readonly clock: RemoteClock;
  private readonly capabilities: HostCapabilities;
  private lastStatus: RemoteStatus;
  private state: RemoteStatus['state'] = 'off';
  private reason: RemoteStatus['reason'];
  private message: string | undefined;
  private supported: RemoteStatus['supported'];
  private configured = false;
  private host: string | undefined;
  private token: ConnectorTokenSource | undefined;
  private platform: ConnectorPlatform | undefined;
  private generation = 0;
  private started = false;
  private stopped = false;
  private draining = false;
  private attempt = 0;
  private retryTimer: TimerHandle | undefined;
  private heartbeatTimer: TimerHandle | undefined;
  private publishTimer: TimerHandle | undefined;
  private unobserve = () => {};
  private unsubscribeCommands = () => {};
  private publishWork: Promise<void> | undefined;
  private claimWork: Promise<void> | undefined;
  private claimAgain = false;
  private publishAgain = false;
  private configureWork: Promise<unknown> = Promise.resolve();
  private registrationWork: Promise<void> = Promise.resolve();
  private readonly work = new Set<Promise<unknown>>();
  private readonly text = new RemoteTextSanitizer();
  private readonly indexed = new Set<string>();
  private readonly backfilling = new Set<string>();
  private readonly backfillScheduled = new Set<string>();
  private readonly backfillRetryAt = new Map<string, number>();
  private readonly backfillIssues = new Map<string, string>();
  private readonly buffered = new Map<string, { items: OutboxItem[]; bytes: number }>();
  private readonly reauthorizedPublications = new Set<string>();
  private readonly publicationGaps = new Map<string, { lastSeq: number; fastForwarded: boolean }>();
  private outboxErrorsWired = false;
  private readonly blocked = new Map<string, string>();
  private readonly recordingIssues = new Map<string, string>();
  private readonly recordingBlocked = new Set<string>();
  private readonly rootIds = new Map<string, string>();

  constructor(private readonly options: RemoteConnectorOptions) {
    this.clock = options.clock ?? systemClock;
    this.capabilities = structuredClone(options.capabilities ?? REMOTE_CAPABILITIES);
    this.store = new RemoteStore(options.database);
    this.outbox = new RemoteOutbox(options.database);
    this.lastStatus = { configured: false, share: this.store.settings().share, state: 'off', apiUrl: this.apiOrigin(), projects: [], pending: 0, sessions: 0 };
    options.owner.assertCurrent();
    const journal = new RemoteCommandJournal(options.database);
    this.executor = new RemoteCommandExecutor({
      submit: (request, remote) => options.server.submitRemote(request, remote),
      lookup: id => options.server.hasRemoteRequest(id),
      owner: () => this.token?.current()?.host.userId,
      clock: this.clock,
      projects: () => this.store.settings().projects,
      isShared: id => this.isShared(id),
      markWebCreated: id => {
        options.owner.assertCurrent();
        this.store.setSession(id, { ...webCreatedSession(), ...this.store.session(id), origin: 'web', shared: true, unsharedPending: false });
        this.backfill(id); this.wakePublish();
      },
      capabilities: this.capabilities,
      unrecordedIsIndeterminate: () => options.database.rebuilt && options.database.record('command_recovery', this.host ?? '') === undefined,
      journal: {
        get: id => { options.owner.assertCurrent(); return journal.get(id); },
        write: entry => { options.owner.assertCurrent(); journal.write(entry); },
        forget: id => { options.owner.assertCurrent(); journal.forget(id); },
      },
    });
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.unobserve = this.options.registry.observe(event => this.observe(event), id => this.safelyBackfill(id));
    const generation = this.generation;
    this.track((async () => {
      try {
        const pat = await this.bounded(this.options.secretStorage.read('remote', 'pat'));
        if (!this.current(generation)) return;
        if (pat) this.login(pat);
      } catch { if (this.current(generation)) this.message = 'Remote credentials are unavailable. Run /remote login to retry.'; }
    })());
  }

  beginDrain(): void { this.draining = true; }
  endDrain(): void { this.draining = false; this.wakeClaims(); }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true; this.generation++;
    this.unobserve(); this.clearTimers(); this.token?.stop(); this.token = undefined;
    const close = this.disconnect();
    await this.bounded(Promise.allSettled([close, ...this.work]), this.options.shutdownTimeoutMs ?? 2_000).catch(() => {});
    try { this.outbox.flush(); }
    catch (error) { this.recordingFailure('outbox', error); }
  }

  status(): RemoteStatus {
    try { return this.readStatus(); }
    catch { return { ...structuredClone(this.lastStatus), configured: this.configured, state: this.state === 'stopped' ? 'stopped' : 'offline',
      reason: this.state === 'stopped' ? this.reason ?? 'unavailable' : 'unavailable',
      message: 'Remote persistence is unavailable; counts may be stale. Restart the daemon after checking local storage.' }; }
  }

  private readStatus(): RemoteStatus {
    try { return this.collectStatus(); }
    catch (error) {
      if (!this.recordingIssues.size) throw error;
      const last = structuredClone(this.lastStatus); delete last.reason;
      return { ...last, configured: this.configured, state: this.state, ...(this.reason ? { reason: this.reason } : {}),
        message: `Remote persistence is unavailable; counts may be stale. ${[...this.recordingIssues].slice(0, 3).map(([id, reason]) => `${id}: ${reason}`).join('; ')}` };
    }
  }
  private collectStatus(): RemoteStatus {
    const settings = this.store.settings();
    const issues: string[] = [];
    const omissions: string[] = [];
    for (const id of this.store.sessions()) {
      const record = this.store.session(id);
      if (record?.terminal) issues.push(`${id}: ${record.terminal}`);
      if (record?.skippedChanges) omissions.push(`${id}: ${record.skippedChanges} changes could not be published`);
    }
    for (const [id, reason] of this.blocked) issues.push(`${id}: ${reason}`);
    for (const [id, reason] of this.recordingIssues) issues.push(`${id}: ${reason}`);
    for (const [id, reason] of this.backfillIssues) issues.push(`${id}: ${reason}`);
    let sessions = 0;
    for (const row of this.options.registry.list()) {
      this.rootIds.set(row.id, row.root);
      if (this.configured && sessionShared(this.sharing(row.id, row.root, settings.share))) sessions++;
    }
    const message = [this.message, issues.length ? `${issues.length} session issue(s). ${issues.slice(0, 3).join('; ')}` : undefined,
      ...omissions.slice(0, 3)].filter(Boolean).join(' ');
    this.lastStatus = parseRemoteStatus({ configured: this.configured, share: settings.share, state: this.state,
      ...(this.reason ? { reason: this.reason } : {}), ...(message ? { message: redact(message) } : {}),
      ...(this.host ? { host: { id: this.host } } : {}), apiUrl: this.apiOrigin(),
      projects: settings.projects.map(project => ({ id: project.id, name: redact(project.name), path: redact(project.path) })),
      pending: this.outbox.pendingCount(), sessions,
      ...(this.supported ? { supported: this.supported } : {}) });
    return structuredClone(this.lastStatus);
  }

  setupNeeds(): { code: string; message: string }[] {
    return this.state === 'stopped' ? [{ code: 'remote', message: this.message ?? 'Publishing stopped. Run /remote login to retry.' }] : [];
  }

  configure(value: OperationParams<'remote.configure'>): Promise<RemoteStatus> {
    const work = this.configureWork.catch(() => {}).then(async () => {
      if (this.stopped) throw commandError('unavailable', 'Remote connector is stopped.');
      let params: OperationParams<'remote.configure'>;
      try { params = parseRemoteConfigureParams(value); }
      catch {
        const message = value?.action === 'login' ? 'Invalid remote login token or API URL.'
          : value?.action === 'open_project' ? 'Remote project path must be absolute and its name must be 1–256 bytes.' : 'Invalid remote configuration.';
        throw commandError('invalid_request', message);
      }
      if (params.action === 'login' && params.apiUrl !== undefined) this.validateApiUrl(params.apiUrl);
      try {
        if (params.action === 'login') {
          await this.bounded(this.options.secretStorage.write('remote', 'pat', params.token));
          if (this.stopped) throw commandError('unavailable');
          if (params.apiUrl !== undefined) this.store.configure({ apiUrl: params.apiUrl });
          this.generation++; this.token?.stop(); this.token = undefined;
          await this.bounded(this.disconnect(), this.options.shutdownTimeoutMs ?? 2_000).catch(() => {});
          this.clearTimers(); this.login(params.token);
        } else if (params.action === 'logout') {
          await this.bounded(this.options.secretStorage.remove('remote', 'pat'));
          if (this.stopped) throw commandError('unavailable');
          this.generation++; this.configured = false; this.token?.stop(); this.token = undefined;
          this.clearTimers(); await this.bounded(this.disconnect(), this.options.shutdownTimeoutMs ?? 2_000).catch(() => {});
          this.state = 'off'; this.reason = undefined; this.message = undefined; this.supported = undefined;
        } else {
          if (params.action === 'share') {
            const rows = this.options.registry.list(); const share = this.store.settings().share;
            const before = new Map(rows.map(row => [row.id, sessionShared(this.sharing(row.id, row.root, share))]));
            this.store.configure({ share: params.share });
            for (const row of rows) {
              const shared = sessionShared(this.sharing(row.id, row.root, params.share));
              if (before.get(row.id) && !shared) this.markUnshared(row.id);
              else if (shared) {
                const record = this.store.session(row.id);
                if (!before.get(row.id) && record?.backfilled) this.store.setSession(row.id, { ...record, sharedPending: true, unsharedPending: false });
                this.safelyBackfill(row.id);
              }
            }
            this.wakePublish();
          } else {
            if (params.action === 'open_project') this.store.addProject(params.path, params.name);
            else this.store.removeProject(params.id);
            const platform = this.platform;
            if (platform) this.track(this.register(platform).catch(error => this.failed(error, platform)));
          }
        }
        return this.status();
      } catch (error) {
        const cause = error && typeof error === 'object' ? Reflect.get(error, 'cause') ?? error : error;
        if (params.action === 'open_project' && cause && typeof cause === 'object'
          && (['ENOENT', 'ENOTDIR', 'invalid_request'].includes(String(Reflect.get(cause, 'code')))
            || ['Remote project path must be absolute.', 'Remote project path must be a directory.'].includes(String(Reflect.get(cause, 'message'))))) {
          throw commandError('invalid_request', 'Remote project path must name an existing directory and its name must be 1–256 bytes.');
        }
        throw commandError('unavailable', 'Remote configuration could not be saved. Check the directory and credential storage, then retry.');
      }
    });
    this.configureWork = work; this.track(work); return work;
  }

  setShared(session: string, shared: boolean): void {
    const root = this.currentRootId(session);
    if (!root) throw commandError('not_found');
    const children = this.options.registry.list().filter(row => row.root === root);
    const share = this.store.settings().share;
    const before = new Map(children.map(row => [row.id, sessionShared(this.sharing(row.id, root, share))]));
    let transition;
    try { transition = setSessionSharing(this.sharing(session, root, share), shared); }
    catch { throw commandError('forbidden', 'Web-created or terminal remote sessions cannot change sharing.'); }
    this.store.setSession(root, transition.record);
    for (const child of children) {
      if (!shared && before.get(child.id)) this.markUnshared(child.id);
      if (shared) {
        const record = this.store.session(child.id);
        if (record?.backfilled) this.store.setSession(child.id, { ...record, unsharedPending: false, sharedPending: true });
        this.safelyBackfill(child.id);
      }
    }
    this.wakePublish();
  }

  isShared(session: string): boolean {
    if (!this.configured) return false;
    const root = this.currentRootId(session);
    return root !== undefined && sessionShared(this.sharing(session, root));
  }

  private rootId(session: string): string | undefined {
    return this.rootIds.get(session) ?? this.currentRootId(session);
  }
  private currentRootId(session: string): string | undefined {
    const row = this.options.registry.options.store.findSessionMetadata(session);
    if (!row || row.deletedAt !== undefined) { this.rootIds.delete(session); return; }
    this.rootIds.set(session, row.root);
    return row.root;
  }
  private sharing(session: string, root = this.rootId(session), share = this.store.settings().share): SharingInput {
    const record = this.store.session(session);
    const rootRecord = root && root !== session ? this.store.session(root) : undefined;
    return { configured: this.configured, share, ...(record ? { record } : {}), ...(rootRecord ? { rootRecord } : {}) };
  }
  private record(session: string, share?: SharingInput['share']): RemoteSessionRecord {
    return this.store.session(session) ?? { shared: (share ?? this.store.settings().share) === 'all', explicit: false, origin: 'local', backfilled: false, unsharedPending: false };
  }
  private markUnshared(session: string): void {
    this.text.discard(session);
    this.buffered.delete(session); this.backfillIssues.delete(session); this.backfillRetryAt.delete(session);
    const record = this.record(session);
    if (record.terminal) return;
    if (!record.hostId && !record.uploadAttempted && this.outbox.acked(session) === 0) {
      this.outbox.discard(session);
      this.store.setSession(session, { ...record, backfilled: false, unsharedPending: false, sharedPending: false });
      this.recordingBlocked.delete(session); this.recordingIssues.delete(session); this.blocked.delete(session);
    } else this.store.setSession(session, { ...record, unsharedPending: true, sharedPending: false });
  }
  private apiUrl(): string { return this.store.settings().apiUrl ?? this.options.apiUrl ?? process.env.FELAN_API_URL ?? 'https://app.felan.ai'; }
  private apiOrigin(): string {
    try { this.validateApiUrl(this.apiUrl()); return new URL(this.apiUrl()).origin; }
    catch {
      this.state = 'offline'; this.reason = 'unavailable';
      this.message = 'Remote API URL is invalid. Run /remote login with a valid HTTPS URL (HTTP is allowed only on loopback).';
      // Status requires an HTTP origin even when the configured endpoint cannot be parsed.
      return 'https://invalid.invalid';
    }
  }
  private validateApiUrl(value: string): void {
    try {
      const url = new URL(value);
      if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)
        || /[\\\u0000-\u0020\u007f-\u009f]/u.test(value)
        || url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error();
    } catch { throw commandError('invalid_request', 'Remote API URL must use HTTPS (HTTP is allowed only on loopback), without credentials, query or fragment.'); }
  }
  private registration(): HostRegistration {
    return { name: Array.from(this.options.name ?? hostname()).reduce((name, char) => Buffer.byteLength(name + char) <= 128 ? name + char : name, ''),
      daemonVersion: this.options.daemonVersion ?? DAEMON_VERSION, rowSchemaVersion: ROW_SCHEMA_VERSION,
      capabilities: this.capabilities, projects: this.store.settings().projects };
  }
  private register(platform: ConnectorPlatform): Promise<void> {
    const generation = this.generation;
    const work = this.registrationWork.catch(() => {}).then(async () => {
      while (this.current(generation)) {
        const registration = this.registration();
        await this.bounded(platform.register(registration));
        if (JSON.stringify(registration) === JSON.stringify(this.registration())) return;
      }
    });
    this.registrationWork = work;
    return work;
  }
  private login(pat: string): void {
    if (this.stopped) return;
    this.configured = true; this.state = 'connecting'; this.reason = undefined; this.message = undefined; this.supported = undefined; this.attempt = 0;
    this.reauthorizedPublications.clear();
    try {
      try { this.validateApiUrl(this.apiUrl()); }
      catch { this.apiOrigin(); return; }
      this.token = (this.options.tokenSource ?? (options => new HostTokenSource(options)))({
        pat, apiUrl: this.apiUrl(), installId: this.store.settings().installId,
        daemonVersion: this.options.daemonVersion ?? DAEMON_VERSION, name: this.options.name ?? hostname(), clock: this.clock,
      });
      for (const row of this.options.registry.list()) this.safelyBackfill(row.id);
      this.connect();
    } catch { this.state = 'offline'; this.reason = 'unavailable'; this.message = 'Remote connection settings are unavailable. Run /remote login to retry.'; }
  }

  private connect(): void {
    const token = this.token; const generation = this.generation;
    if (!token || this.stopped || this.state === 'stopped') return;
    try { this.validateApiUrl(this.apiUrl()); }
    catch { this.apiOrigin(); return; }
    const work = (async () => {
      let platform: ConnectorPlatform | undefined;
      try {
        let abandoned = false;
        const opening = (this.options.connect ?? (source => PlatformClient.connect(source)))(token);
        void opening.then(opened => { if (abandoned) void this.bounded(opened.close()).catch(() => {}); }, () => {});
        try { platform = await this.bounded(opening); }
        catch (error) { abandoned = true; throw error; }
        if (!this.current(generation)) { await this.bounded(platform.close()).catch(() => {}); return; }
        const host = token.current()?.host.id;
        if (!host) throw new PlatformError('invalid', 'Host metadata is unavailable.');
        this.host = host;
        this.fenceRepairedSessions(host);
        await this.register(platform);
        if (!this.current(generation)) { await this.bounded(platform.close()).catch(() => {}); return; }
        for (const id of this.store.sessions()) {
          const record = this.store.session(id)!;
          if (!record.terminal && record.indexedHostId === host) this.indexed.add(id);
        }
        this.platform = platform;
        this.unsubscribeCommands = platform.realtime.subscribeCommands(host, () => this.wakeClaims(), () => this.wakeClaims());
        this.state = 'connected'; this.reason = undefined; this.message = undefined; this.attempt = 0;
        this.clearStoppedPresentations();
        this.wakeClaims(); this.wakePublish(); this.heartbeat(platform);
      } catch (error) {
        if (platform && platform !== this.platform) void this.bounded(platform.close()).catch(() => {});
        if (this.current(generation)) await this.failed(error);
      }
    })();
    this.track(work);
  }
  private fenceRepairedSessions(host: string): void {
    for (const id of this.store.sessions()) {
      const record = this.store.session(id)!;
      if (!record.terminal && record.hostId && record.hostId !== host) this.terminate(id, 'forbidden');
    }
  }
  private heartbeat(platform: ConnectorPlatform): void {
    this.heartbeatTimer = schedule(this.clock, () => {
      this.heartbeatTimer = undefined;
      this.track((async () => {
        try {
          await this.bounded(platform.heartbeat());
          if (this.platform !== platform || this.stopped) return;
          this.clearStoppedPresentations();
          this.wakeClaims(); this.wakePublish(); this.heartbeat(platform);
        } catch (error) { await this.failed(error, platform); }
      })());
    }, this.options.heartbeatMs ?? 30_000);
  }

  private observe(event: ProjectionOutput): void {
    try {
      if (this.stopped || !this.configured || !('change' in event) && (!this.platform || this.state !== 'connected')) return;
      if ('change' in event && !isPublishedChangeType(event.change.type)) return;
      if (this.recordingBlocked.has(event.session)) return;
      const root = this.rootId(event.session);
      if (!root) return;
      const sharing = this.sharing(event.session, root);
      if (!sessionShared(sharing)) return;
      if ('change' in event) {
        if (event.change.type === 'message.completed' && 'message' in event.change) {
          for (const text of this.text.finish(event.session, event.change.message.id)) if (this.indexed.has(event.session)) this.platform?.realtime.sendText(text);
        }
        if (!sharing.record?.backfilled || this.backfilling.has(event.session)) {
          const buffer = this.buffered.get(event.session) ?? { items: [], bytes: 0 };
          const item = { rev: Math.max(1, event.rev), occurredAt: this.clock.now(), change: event.change as OutboxItem['change'] };
          const bytes = Buffer.byteLength(JSON.stringify(item));
          // A future snapshot subsumes this bounded pre-snapshot window.
          if (buffer.bytes + bytes > 4 * 1024 * 1024) { buffer.items = []; buffer.bytes = 0; }
          if (bytes <= 4 * 1024 * 1024) { buffer.items.push(item); buffer.bytes += bytes; }
          this.buffered.set(event.session, buffer);
          this.safelyBackfill(event.session);
        } else {
          const change = this.publicationChange(event.session, event.change as KnownSessionChange);
          if (change) { this.outbox.append(event.session, [{ rev: Math.max(1, event.rev), occurredAt: this.clock.now(), change }]); this.wakePublish(); }
        }
      } else if (this.platform && this.state === 'connected') {
        const safe = this.text.push(event);
        if (safe && this.indexed.has(event.session)) this.platform.realtime.sendText(safe);
      }
    } catch (error) { this.recordingFailure(event.session, error); }
  }
  private safelyBackfill(session: string): void {
    try {
      if (!this.outboxErrorsWired) {
        this.outbox.setErrorHandler((id, error) => this.recordingFailure(id, error)); this.outboxErrorsWired = true;
      }
      if (!this.currentRootId(session)) { this.removeLocalSession(session); return; }
      this.backfill(session);
    } catch (error) { this.recordingFailure(session, error); }
  }
  private blockRecording(session: string, reason: string): void {
    this.recordingBlocked.add(session); this.recordingIssues.set(session, reason); this.buffered.delete(session);
  }
  private recordingFailure(session: string, error: unknown): void {
    if (error instanceof RemoteOutboxCapacityError) {
      this.blockRecording(session, `Recording stopped: pending outbox reached the ${error.scope === 'total' ? '256 MiB total' : '64 MiB session'} limit. Changes during this block will not be uploaded; restart after draining it.`);
    } else if (error instanceof RemoteStorageError || error instanceof RemoteIntegrityError) {
      this.blockRecording(session, 'Recording failed: local storage is unavailable. Changes during this block will not be uploaded; restart after checking local storage.');
    } else {
      this.backfillIssues.set(session, 'Backfill unavailable; retrying on a later publishable change or residency.');
      this.backfillRetryAt.set(session, this.clock.now() + 1_000);
    }
  }
  private publicationChange(session: string, change: KnownSessionChange): ReturnType<typeof publishableChange> {
    try { return publishableChange(change); }
    catch {
      const record = this.record(session);
      this.store.setSession(session, { ...record, skippedChanges: (record.skippedChanges ?? 0) + 1 });
      return;
    }
  }
  private backfill(session: string): void {
    if (this.stopped || !this.configured || this.recordingBlocked.has(session) || this.backfilling.has(session)
      || this.backfillScheduled.has(session) || (this.backfillRetryAt.get(session) ?? 0) > this.clock.now()
      || !this.options.registry.binding(session)) return;
    const sharing = this.sharing(session);
    if (!sessionShared(sharing) || sharing.record?.backfilled) return;
    this.backfillScheduled.add(session);
    // Projection observers run mid-refresh; snapshot() must not re-enter that refresh.
    queueMicrotask(() => {
      this.backfillScheduled.delete(session);
      try { this.performBackfill(session); }
      catch (error) { this.recordingFailure(session, error); }
    });
  }
  private performBackfill(session: string): void {
    if (this.stopped || !this.configured || this.recordingBlocked.has(session) || !this.currentRootId(session)
      || !this.options.registry.binding(session)) return;
    const sharing = this.sharing(session);
    if (!sessionShared(sharing) || sharing.record?.backfilled) return;
    const record = sharing.record ?? this.record(session, sharing.share);
    if (this.outbox.nextSeq(session) > 1) {
      this.store.setSession(session, { ...record, backfilled: true });
      this.finishBackfill(session, 0); return;
    }
    this.backfilling.add(session);
    try {
      const projection = this.options.registry.projection(session); const snapshot = projection.snapshot();
      const revision = Math.max(1, snapshot.revision);
      const pages = [snapshot.history];
      while (pages.at(-1)!.cursor) pages.push(projection.history(pages.at(-1)!.cursor, snapshot.revision));
      const entries: OutboxItem[] = [];
      const append = (change: KnownSessionChange, occurredAt = this.clock.now()) => {
        const value = this.publicationChange(session, change);
        if (value) entries.push({ rev: revision, occurredAt, change: value });
      };
      for (const page of pages.reverse()) for (const message of page.entries) append({ type: 'message.completed', message }, message.timestamp);
      append({ type: 'model.updated', model: snapshot.model, thinking: snapshot.thinking });
      append({ type: 'metadata.updated', title: snapshot.title, state: snapshot.state, residency: snapshot.residency });
      append({ type: 'run.updated', run: snapshot.run }); append({ type: 'queue.updated', queue: snapshot.queue });
      for (const interaction of snapshot.interactions) append({ type: 'interaction.requested', interaction });
      for (const child of snapshot.children) append({ type: 'child.updated', child });
      for (const tool of snapshot.tools) append({ type: 'tool.updated', tool });
      this.outbox.initialize(session, entries);
      this.store.setSession(session, { ...this.record(session), backfilled: true });
      this.finishBackfill(session, snapshot.revision);
    } finally { this.backfilling.delete(session); }
  }
  private finishBackfill(session: string, revision: number): void {
    const items = this.buffered.get(session)?.items.filter(item => item.rev > revision).flatMap(item => {
      const change = this.publicationChange(session, item.change);
      return change ? [{ ...item, change }] : [];
    }) ?? [];
    if (items.length) this.outbox.append(session, items);
    this.buffered.delete(session); this.backfillIssues.delete(session); this.backfillRetryAt.delete(session); this.wakePublish();
  }
  private removeLocalSession(session: string, unshared = false): void {
    const record = this.store.session(session);
    const attempted = record?.hostId || record?.uploadAttempted || this.outbox.acked(session) > 0;
    if (attempted && !record?.terminal && !unshared) {
      this.store.setSession(session, { ...this.record(session), shared: false, unsharedPending: true, sharedPending: false });
      this.wakePublish();
    } else {
      if (attempted || record?.terminal) this.outbox.drop(session);
      else this.outbox.discard(session);
      this.store.removeSession(session);
    }
    this.text.discard(session); this.indexed.delete(session); this.rootIds.delete(session); this.buffered.delete(session);
    this.backfillIssues.delete(session); this.backfillRetryAt.delete(session);
    this.blocked.delete(session); this.recordingBlocked.delete(session); this.recordingIssues.delete(session); this.publicationGaps.delete(session);
  }

  private wakePublish(): void {
    if (!this.platform || this.stopped) return;
    if (this.publishWork) { this.publishAgain = true; return; }
    if (this.publishTimer) return;
    this.publishTimer = schedule(this.clock, () => {
      this.publishTimer = undefined;
      const platform = this.platform;
      if (!platform) return;
      this.publishAgain = false;
      const work = Promise.resolve().then(() => this.publish(platform));
      this.publishWork = work; this.track(work);
      void work.finally(() => { if (this.publishWork === work) { this.publishWork = undefined; if (this.publishAgain) this.wakePublish(); } }).catch(() => {});
    }, 0);
  }
  private async publish(platform: ConnectorPlatform): Promise<void> {
    try {
      do {
        this.publishAgain = false;
        let pending: string[] = [];
        try { pending = this.outbox.sessions(); }
        catch (error) {
          if (!(error instanceof RemoteStorageError || error instanceof RemoteIntegrityError)) throw error;
          this.recordingFailure('outbox', error);
        }
        const ids = new Set([...pending, ...this.store.sessions().filter(id => {
          const record = this.store.session(id);
          return record?.unsharedPending || record?.sharedPending || record?.backfilled && !this.indexed.has(id) && !record.terminal;
        })]);
        for (const id of ids) {
          if (this.platform !== platform || this.stopped) return;
          const record = this.store.session(id);
          if (this.blocked.has(id) && !record?.unsharedPending || record?.terminal) continue;
          try {
            if (await this.publishSession(platform, id)) this.publishAgain = true;
          } catch (error) {
            if (error instanceof RemoteStorageError || error instanceof RemoteIntegrityError) { this.recordingFailure(id, error); continue; }
            if (error instanceof PlatformError && error.kind === 'revoked' && error.httpStatus === 403) {
              if (!this.reauthorizedPublications.has(id)) { await this.failed(error, platform, id); return; }
              this.blocked.set(id, 'Publication rejected again after token exchange; check the session payload before restarting the daemon.');
              continue;
            }
            if (error instanceof HostTokenExchangeError || error instanceof PlatformError && ['retry', 'revoked', 'unsupported_schema'].includes(error.kind)) throw error;
            this.blocked.set(id, 'Publication failed; restart the daemon after checking the session and local storage.');
          }
        }
      } while (this.publishAgain && this.platform === platform && !this.stopped);
    } catch (error) {
      if (error instanceof RemoteStorageError || error instanceof RemoteIntegrityError) this.recordingFailure('outbox', error);
      else await this.failed(error, platform);
    }
  }
  private async publishSession(platform: ConnectorPlatform, id: string): Promise<boolean> {
    try { return await this.publishSessionNow(platform, id); }
    catch (error) {
      if (error instanceof RemoteStorageError || error instanceof RemoteIntegrityError || error instanceof RemoteOutboxCapacityError) this.recordingFailure(id, error);
      throw error;
    }
  }
  private async publishSessionNow(platform: ConnectorPlatform, id: string): Promise<boolean> {
    const row = this.options.registry.options.store.findSessionMetadata(id);
    if (!row || row.deletedAt !== undefined) {
      this.removeLocalSession(id);
      if (!row || !this.store.session(id)?.unsharedPending) return false;
    }
    if (this.platform === platform && !this.stopped) {
      const record = this.record(id);
      if (record.hostId && this.host && record.hostId !== this.host) { this.terminate(id, 'forbidden'); return false; }
      const shared = this.isShared(id);
      if (!shared && !record.unsharedPending) return false;
      const pending = shared ? this.outbox.pending(id) : [];
      if (shared && !pending.length && !record.sharedPending && this.indexed.has(id)) { this.publicationGaps.delete(id); return false; }
      const currentRow = this.options.registry.list().find(row => row.id === id) ?? row;
      const session = publishedSession({ ...currentRow, session: id, shared });
      const batch = publicationBatches(session, pending.map(entry => publishedEvent(id, entry)))[0]!;
      const host = this.host; const generation = this.generation;
      try {
        if (!record.uploadAttempted) this.store.setSession(id, { ...record, uploadAttempted: true, ...(host ? { hostId: host } : {}) });
        const acknowledged = await this.bounded(platform.publish(session, batch));
        if (this.platform !== platform || !this.current(generation) || host !== this.host) return false;
        this.reauthorizedPublications.delete(id);
        if (!this.currentRootId(id)) { this.removeLocalSession(id, !shared); return false; }
        if (batch.length && (acknowledged < batch.at(-1)!.seq || acknowledged >= this.outbox.nextSeq(id))) {
          throw new PlatformError('sequence_gap', 'Invalid publication acknowledgement.', acknowledged);
        }
        this.options.owner.assertCurrent();
        const current = this.record(id);
        const next = { ...current, ...(host ? { hostId: host, indexedHostId: host } : {}), ...(!shared && !this.isShared(id) ? { unsharedPending: false } : {}), ...(shared && this.isShared(id) ? { sharedPending: false } : {}) };
        if (next.hostId !== current.hostId || next.indexedHostId !== current.indexedHostId || next.unsharedPending !== current.unsharedPending || next.sharedPending !== current.sharedPending) this.store.setSession(id, next);
        if (host && this.host && host !== this.host) { this.terminate(id, 'forbidden'); return false; }
        this.indexed.add(id);
        if (batch.length) this.outbox.acknowledge(id, acknowledged);
        this.publicationGaps.delete(id);
        return true;
      } catch (error) {
        if (this.platform !== platform || this.stopped) return false;
        if (error instanceof PlatformError && ['session_deleted', 'forbidden'].includes(error.kind)) {
          this.terminate(id, error.kind === 'session_deleted' ? 'deleted' : 'forbidden');
          if (!this.currentRootId(id)) this.removeLocalSession(id, true);
          return false;
        }
        if (error instanceof PlatformError && error.kind === 'sequence_gap') {
          const seq = error.lastSeq;
          const previous = this.publicationGaps.get(id);
          if (seq !== undefined && Number.isSafeInteger(seq) && seq >= this.outbox.acked(id) && seq !== previous?.lastSeq) {
            const fastForward = seq >= this.outbox.nextSeq(id);
            if (!fastForward || !previous?.fastForwarded) {
              if (fastForward) this.outbox.fastForward(id, seq);
              else this.outbox.acknowledge(id, seq);
              this.publicationGaps.set(id, { lastSeq: seq, fastForwarded: fastForward || previous?.fastForwarded === true });
              return true;
            }
          }
          this.blocked.set(id, 'Publication sequence cannot be recovered from the local outbox; restart the daemon after checking local storage.'); return false;
        }
        throw error;
      }
    }
    return false;
  }
  private terminate(session: string, terminal: 'deleted' | 'forbidden'): void {
    this.store.setSession(session, { ...this.record(session), terminal, unsharedPending: false }); this.outbox.drop(session);
    this.indexed.delete(session); this.publicationGaps.delete(session);
  }

  private wakeClaims(): void {
    if (!this.platform || this.stopped || this.draining) return;
    if (this.claimWork) { this.claimAgain = true; return; }
    const platform = this.platform;
    const work = (async () => {
      try {
        do {
          this.claimAgain = false;
          const startedAt = this.clock.now();
          const rows = await this.bounded(platform.claim());
          const receivedAt = this.clock.now();
          // An empty claim proves this host's old commands have drained after journal loss.
          if (!rows.length && this.platform === platform && !this.stopped && this.host && this.options.database.rebuilt) {
            const database = this.options.database;
            if (database.record('command_recovery', this.host) === undefined) database.transaction(() => database.putRecord('command_recovery', this.host!, 'drained'));
          }
          for (const row of rows.sort((a, b) => a.id.localeCompare(b.id))) {
            if (this.platform !== platform || this.stopped || this.draining) return;
            if (!row.id) continue;
            const outcome = await this.executor.execute(row, { startedAt, receivedAt });
            if (this.platform !== platform || this.stopped) return;
            try { await this.bounded(platform.complete(row.id, outcome)); }
            catch (error) {
              if (!(error instanceof PlatformError)) throw error;
              if (error.kind === 'invalid') {
                try {
                  await this.bounded(platform.complete(row.id, { v: 1, re: row.id, outcome: 'rejected',
                    error: { code: 'unavailable', message: 'Remote command outcome could not be published.', retryable: false } }));
                } catch (fallback) {
                  if (!(fallback instanceof PlatformError) || fallback.kind !== 'conflict') {
                    continue;
                  }
                }
              } else if (!['conflict', 'forbidden', 'session_deleted'].includes(error.kind)) throw error;
            }
            this.executor.forget(row.id);
          }
        } while (this.claimAgain && !this.draining && this.platform === platform && !this.stopped);
      } catch (error) { await this.failed(error, platform); }
    })();
    this.claimWork = work; this.track(work);
    void work.finally(() => { if (this.claimWork === work) { this.claimWork = undefined; if (this.claimAgain) this.wakeClaims(); } }).catch(() => {});
  }

  private async failed(error: unknown, expected?: ConnectorPlatform, reauthorizeSession?: string): Promise<void> {
    if (this.stopped || expected && this.platform !== expected || this.state === 'stopped') return;
    const generation = this.generation;
    this.clearTimers(); const close = this.disconnect();
    let failure = error;
    if (failure instanceof PlatformError && failure.kind === 'unsupported_schema') {
      failure = new HostTokenExchangeError('unsupported_schema', 'Publishing stopped.',
        failure.supported ? { protocol: [], rowSchemaVersion: failure.supported } : undefined);
    } else if (failure instanceof PlatformError && failure.kind === 'revoked') {
      try {
        this.token?.invalidate(); await this.bounded(this.token!.token());
        if (reauthorizeSession && this.current(generation)) this.reauthorizedPublications.add(reauthorizeSession);
      } catch (exchange) { failure = exchange; }
    }
    if (!this.current(generation)) return;
    if (failure instanceof HostTokenExchangeError && failure.kind in stoppedMessages) {
      this.state = 'stopped'; this.reason = failure.kind as StopReason; this.message = stoppedMessages[this.reason];
      this.supported = failure.supported; this.token?.stop(); this.notifyStopped();
    } else {
      this.state = 'offline';
      this.reason = (failure instanceof PlatformError || failure instanceof HostTokenExchangeError) && failure.rateLimited ? 'rate_limited' : 'unavailable';
      this.message = 'Remote connection is unavailable; local work is unaffected. Retrying.';
      this.retryTimer = schedule(this.clock, () => { this.retryTimer = undefined; this.connect(); }, retryDelay(this.attempt++));
    }
    await this.bounded(close, this.options.shutdownTimeoutMs ?? 2_000).catch(() => {});
  }
  private notifyStopped(): void {
    for (const row of this.options.registry.list()) {
      try {
        if (this.isShared(row.id) && this.options.registry.binding(row.id) && this.options.registry.attachmentCount(row.id)) {
          this.options.registry.projection(row.id).setPresentation({ id: 'remote-stopped', kind: 'notification', level: 'warning', text: this.message! });
        }
      } catch {}
    }
  }
  private clearStoppedPresentations(): void {
    for (const row of this.options.registry.list()) {
      if (this.options.registry.binding(row.id) && this.options.registry.projection(row.id).presentations().some(item => item.id === 'remote-stopped')) {
        this.options.registry.projection(row.id).setPresentation({ id: 'remote-stopped', remove: true });
      }
    }
  }
  private disconnect(): Promise<void> {
    this.text.clear(); this.indexed.clear();
    this.unsubscribeCommands(); this.unsubscribeCommands = () => {};
    const platform = this.platform; this.platform = undefined;
    return platform ? platform.close().catch(() => {}) : Promise.resolve();
  }
  private clearTimers(): void {
    for (const timer of [this.retryTimer, this.heartbeatTimer, this.publishTimer]) if (timer) this.clock.clearTimeout(timer);
    this.retryTimer = undefined; this.heartbeatTimer = undefined; this.publishTimer = undefined;
  }
  private current(generation: number): boolean { return !this.stopped && generation === this.generation; }
  private track(work: Promise<unknown>): void {
    this.work.add(work); void work.finally(() => this.work.delete(work)).catch(() => {});
  }
  private async bounded<T>(work: Promise<T>, timeout = this.options.requestTimeoutMs ?? 15_000): Promise<T> {
    let timer: TimerHandle | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = schedule(this.clock, () => reject(new PlatformError('retry', 'Remote request timed out.')), timeout); });
    try { return await Promise.race([work, deadline]); }
    finally { if (timer) this.clock.clearTimeout(timer); }
  }
}
