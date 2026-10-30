import { resolve } from 'node:path';
import { ConfigValuesSchema, INTERACTION_KINDS, LIMITS, parseSchema, readMessageDisplay, type OperationParams, type PresentationEvent, type SessionSnapshot } from '@felan-ai/session-protocol';
import { accepted, createDaemonClient, daemonRestartRecovery, readCurrentDaemonHistory, waitForDaemonAttachment, waitForDaemonRun, type DaemonClientOptions } from './acp/daemon-session.js';
import { watchDaemonBuildMismatch } from './client/build-mismatch.js';
import { sanitizeAcpErrorMessage } from './acp/session-updates.js';

export interface RunLocalFelanHeadlessOptions extends DaemonClientOptions {
  readonly cwd?: string;
  readonly continueRecent?: boolean;
  readonly thinkingLevel?: OperationParams<'set_thinking'>['thinking'];
  readonly mode: 'text' | 'json';
  readonly initialMessage: string;
  readonly provider?: string;
  readonly model?: string;
  readonly sessionId?: string;
  readonly config?: OperationParams<'sessions.create'>['config'];
  readonly signal?: AbortSignal;
  readonly writeOutput?: (chunk: string) => void | Promise<void>;
  readonly writeError?: (line: string) => void;
  readonly signalSource?: {
    on(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP', listener: () => void): unknown;
    off(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP', listener: () => void): unknown;
  };
}

export async function runLocalFelanHeadless(options: RunLocalFelanHeadlessOptions): Promise<number> {
  const writeError = options.writeError ?? (line => process.stderr.write(`${line}\n`));
  const writeOutput = options.writeOutput ?? (chunk => { process.stdout.write(chunk); });
  if (options.provider !== undefined && options.model === undefined) { writeError('--provider requires --model in headless mode'); return 1; }
  if (options.signal?.aborted) return 130;
  let client: Awaited<ReturnType<typeof createDaemonClient>> | undefined;
  let session: string | undefined;
  let runId: string | undefined;
  let signalCode: number | undefined;
  let cancel: Promise<void> | undefined;
  let unsubscribe = () => {};
  let unsubscribePresentation = () => {};
  let stopBuildMismatchWatch = () => {};
  let output: HeadlessJsonWriter | undefined;
  let failOutput: ((error: Error) => void) | undefined;
  const outputFailure = new Promise<never>((_resolve, reject) => { failOutput = reject; });
  void outputFailure.catch(() => {});
  const signalSource = options.signalSource ?? process;
  const requestCancel = (code: number) => {
    signalCode ??= code;
    if (client && session && runId) cancel ??= client.request('cancel', { runId }, { session }).then(response => { accepted(response); });
    void cancel?.catch(() => {});
  };
  const handlers = ([['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const).map(([name, code]) => {
    const handler = () => requestCancel(code);
    signalSource.on(name, handler);
    return [name, handler] as const;
  });
  const abort = () => requestCancel(130);
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    for (const name of ['sessionManager', 'modelRuntime', 'runtimeFactory', 'inlineExtensions', 'memoryCoordinator', 'subagentUiContext', 'homeDir', 'skillPaths', 'themePaths', 'subagentSettings'] as const) {
      if (Reflect.get(options, name) !== undefined) throw new Error(`${name} is an in-process runtime option; use daemon session IDs and configuration in headless mode`);
    }
    if (Reflect.get(options, 'extensionConfigOverrides') !== undefined) throw new Error('Use typed daemon config rather than extensionConfigOverrides in headless mode');
    const cwd = resolve(options.cwd ?? process.cwd());
    const sessionDir = options.sessionDir ? resolve(options.sessionDir) : undefined;
    const attachOptions = sessionDir ? { sessionDir } : undefined;
    client = await createDaemonClient(options, 'headless', [...INTERACTION_KINDS]);
    await client.connect();
    if (options.mode === 'text') stopBuildMismatchWatch = watchDaemonBuildMismatch(client,
      daemonRestartRecovery(options.daemonRuntime), writeError);
    if (signalCode) return signalCode;
    session = options.sessionId;
    if (!session && options.continueRecent) {
      let cursor: string | undefined;
      const seen = new Set<string>();
      let latest = -1;
      do {
        const page = accepted(await client.request('sessions.list', { cwd, limit: LIMITS.pageEntries, ...(cursor ? { cursor } : {}) }));
        for (const row of page.entries) if (row.state === 'open' && row.session === row.root && row.lastActivity > latest) {
          session = row.session; latest = row.lastActivity;
        }
        cursor = page.cursor;
        if (cursor && seen.has(cursor)) throw new Error('Session inventory cursor repeated');
        if (cursor) seen.add(cursor);
      } while (cursor);
    }
    const config = options.config ? parseSchema(ConfigValuesSchema, options.config) : undefined;
    const creating = !session;
    if (!session) {
      session = accepted(await client.request('sessions.create', { cwd,
        ...(sessionDir ? { sessionDir } : {}), ...(config ? { config } : {}),
        ...(options.thinkingLevel ? { thinking: options.thinkingLevel } : {}) })).sessionId;
    }
    const initial = accepted(await client.attach(session, attachOptions)).snapshot;
    if (!creating && config && Object.keys(config).length) {
      accepted(await client.request('config.set', { scope: 'session', values: config }, { session }));
      await waitForDaemonAttachment(client, session, options.signal);
    }
    const selected = options.model === undefined ? undefined : resolveHeadlessModel(options, initial.catalog.models);
    if (selected) accepted(await client.request('set_model', { provider: selected.model.provider, id: selected.model.id }, { session }));
    const thinking = options.thinkingLevel ?? selected?.thinking;
    if (thinking) accepted(await client.request('set_thinking', { thinking }, { session }));
    if (signalCode) return signalCode;
    if (options.mode === 'json') {
      accepted(await client.detach(session));
      client.close();
      client = await createDaemonClient(options, 'headless', [...INTERACTION_KINDS], ['native.events']);
      await client.connect();
      stopBuildMismatchWatch = watchDaemonBuildMismatch(client,
        daemonRestartRecovery(options.daemonRuntime), writeError);
      if (!client.capabilities?.capabilities?.includes('native.events')) {
        throw new Error('The daemon does not support native headless JSON output');
      }
      output = new HeadlessJsonWriter(options.writeOutput
        ? (line, done) => { Promise.resolve().then(() => options.writeOutput!(line)).then(() => done(), error => done(error instanceof Error ? error : new Error(String(error)))); }
        : (line, done) => { process.stdout.write(line, done); }, error => failOutput?.(error));
      let nextSequence = 0;
      unsubscribePresentation = client.subscribePresentation((event: PresentationEvent) => {
        if (event.session !== session) return;
        if (event.presentationEvent.sequence !== nextSequence++) {
          output!.fail(new Error('Native headless JSON sequence was interrupted; output cannot be replayed'));
          return;
        }
        output!.enqueue(event.presentationEvent.data);
      });
      unsubscribe = client.subscribe(() => {
        if (client!.status !== 'ready') output!.fail(new Error('Native headless JSON connection was interrupted; output cannot be replayed'));
      });
      accepted(await Promise.race([client.attach(session, attachOptions), outputFailure]));
    }
    // Like a client without UI, headless runs resolve dialogs with their cancelled defaults instead of waiting.
    const dismissed = new Set<string>();
    const observe = () => {
      const attachment = client!.getAttachment(session!);
      if (attachment?.state.status !== 'live' || !attachment.state.snapshot) return;
      const observed = attachment.state.snapshot;
      const origin = observed.run.origin;
      if (!runId && (!origin || !('attachment' in origin) || origin.attachment !== client!.capabilities?.attachmentId)) return;
      if (runId && observed.run.id && observed.run.id !== runId) return;
      for (const item of observed.interactions) {
        if (item.state !== 'waiting' || dismissed.has(item.id)) continue;
        dismissed.add(item.id);
        void client!.request('interaction.answer', { interactionId: item.id, answer: { cancelled: true, reason: 'user' } }, { session: session! }).catch(() => {});
      }
    };
    const stopObserving = client.subscribe(observe);
    const stopConnection = unsubscribe;
    unsubscribe = () => { stopObserving(); stopConnection(); };
    runId = accepted(await Promise.race([client.request('prompt', { text: options.initialMessage }, { session }), outputFailure])).runId;
    if (signalCode) requestCancel(signalCode);
    await Promise.race([waitForDaemonRun(client, session, runId), outputFailure]);
    await cancel;
    observe();
    if (output) {
      // An idle revision can precede native terminal events; a round trip drains those frames without reattaching the transient stream.
      accepted(await Promise.race([client.request('host.status', {}), outputFailure]));
      await Promise.race([output.flush(), outputFailure]);
      if (signalCode) return signalCode;
      if (client.getAttachment(session)?.state.snapshot?.run.state === 'interrupted') { writeError('Request interrupted'); return 1; }
      return 0;
    }
    const { snapshot: final, messages } = await Promise.race([readCurrentDaemonHistory(client, session), outputFailure]);
    const assistant = [...messages].reverse().find(message => message.role === 'assistant');
    const display = readMessageDisplay(assistant?.details);
    if (signalCode) return signalCode;
    if (options.mode === 'text' && assistant) {
      if (display?.kind === 'assistant' && (display.stopReason === 'error' || display.stopReason === 'aborted')) {
        writeError(sanitizeAcpErrorMessage(display.errorMessage ?? `Request ${display.stopReason}`)); return 1;
      }
      for (const content of assistant.content) if (content.type === 'text') await writeOutput(`${content.text}\n`);
    }
    if (final.run.state === 'interrupted') { writeError('Request interrupted'); return 1; }
    return 0;
  } catch (error) { writeError(sanitizeAcpErrorMessage(error)); return 1; }
  finally {
    unsubscribe(); unsubscribePresentation(); stopBuildMismatchWatch(); output?.close();
    for (const [name, handler] of handlers) signalSource.off(name, handler);
    options.signal?.removeEventListener('abort', abort);
    if (client && session && client.getAttachment(session)) await client.detach(session).catch(() => {});
    client?.close();
  }
}

type CatalogModel = SessionSnapshot['catalog']['models'][number];

export function resolveHeadlessModel(options: Pick<RunLocalFelanHeadlessOptions, 'provider' | 'model'>, models: readonly CatalogModel[]): { model: CatalogModel; thinking?: SessionSnapshot['thinking'] } {
  if (!models.length) throw new Error('No models available. Check your installation or add models to models.json.');
  const reference = options.model!;
  const providers = new Map(models.map(model => [model.provider.toLowerCase(), model.provider]));
  let provider = options.provider ? providers.get(options.provider.toLowerCase()) : undefined;
  if (options.provider && !provider) throw new Error(`Unknown provider "${options.provider}". Use --list-models to see available providers/models.`);
  let pattern = reference;
  let inferred = false;
  const slash = reference.indexOf('/');
  if (!provider && slash > 0) {
    provider = providers.get(reference.slice(0, slash).toLowerCase());
    if (provider) { pattern = reference.slice(slash + 1); inferred = true; }
  } else if (provider && reference.toLowerCase().startsWith(`${provider.toLowerCase()}/`)) pattern = reference.slice(provider.length + 1);
  const match = (pattern: string, candidates: readonly CatalogModel[]): CatalogModel | undefined => {
    const lower = pattern.toLowerCase();
    const exact = candidates.filter(model => model.id.toLowerCase() === lower || `${model.provider}/${model.id}`.toLowerCase() === lower);
    if (exact.length > 1) throw new Error(`Model "${reference}" is ambiguous across providers: ${exact.map(model => `${model.provider}/${model.id}`).sort().join(', ')}. Use --provider or provider/model.`);
    if (exact.length) return exact[0];
    const partial = candidates.filter(model => model.id.toLowerCase().includes(lower) || model.label.toLowerCase().includes(lower));
    const aliases = partial.filter(model => !/-\d{8}$/u.test(model.id));
    return [...(aliases.length ? aliases : partial)].sort((a, b) => b.id.localeCompare(a.id))[0];
  };
  const parse = (pattern: string, candidates: readonly CatalogModel[]): { model: CatalogModel; thinking?: SessionSnapshot['thinking'] } | undefined => {
    const model = match(pattern, candidates);
    if (model) return { model };
    const colon = pattern.lastIndexOf(':');
    if (colon < 1) return undefined;
    const thinking = pattern.slice(colon + 1);
    if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)) return undefined;
    const result = parse(pattern.slice(0, colon), candidates);
    return result ? { ...result, thinking: thinking as SessionSnapshot['thinking'] } : undefined;
  };
  const result = parse(pattern, provider ? models.filter(model => model.provider === provider) : models)
    ?? (inferred ? parse(reference, models) : undefined);
  if (!result) throw new Error(`Model "${reference}" not found`);
  return result;
}


export class HeadlessJsonWriter {
  readonly #queue: string[] = [];
  readonly #waiters = new Set<{ resolve(): void; reject(error: Error): void }>();
  #writing = false;
  #closed = false;
  #failure: Error | undefined;

  constructor(readonly write: (line: string, done: (error?: Error | null) => void) => void, readonly onError: (error: Error) => void) {}

  enqueue(data: unknown): void {
    if (this.#closed) return;
    this.#queue.push(`${JSON.stringify(data)}\n`);
    this.pump();
  }

  fail(error: Error): void {
    if (this.#closed) return;
    this.#failure = error; this.#closed = true;
    this.#queue.length = 0;
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear();
    this.onError(error);
  }

  flush(): Promise<void> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (!this.#queue.length) return Promise.resolve();
    return new Promise<void>((resolve, reject) => { this.#waiters.add({ resolve, reject }); });
  }

  close(): void {
    this.#closed = true;
    this.#queue.length = 0;
    for (const waiter of this.#waiters) waiter.reject(new Error('Headless JSON output closed'));
    this.#waiters.clear();
  }

  private pump(): void {
    if (this.#writing || this.#closed) return;
    const line = this.#queue[0];
    if (line === undefined) {
      for (const waiter of this.#waiters) waiter.resolve();
      this.#waiters.clear(); return;
    }
    this.#writing = true;
    try {
      this.write(line, error => {
        if (this.#closed) return;
        this.#writing = false;
        if (error) { this.fail(error); return; }
        this.#queue.shift();
        queueMicrotask(() => this.pump());
      });
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }
}
