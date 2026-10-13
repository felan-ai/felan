import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  ExtensionUi, ExtensionUiBindingFactory, UiActionContext, UiElementHandle,
  UiInteractiveElement, UiPresentOptions, UiRequestOptions, UiRequestResult,
} from '@felan-ai/agent-core';
import {
  IdSchema, LIMITS, PresentationSchema, ProtocolValidationError, UiActionRequestSchema,
  parseSchema, parseUiForm, parseUiPresentation, validateUiAction, validateUiFormAnswer,
  type Presentation, type UiActionRequest, type UiForm, type UiPresentation, type UiStatus,
} from '@felan-ai/session-protocol';

export type UiVocabularyUpdate = UiPresentation | Extract<Presentation, { kind: 'notification' }> | { id: string; remove: true };

export interface UiVocabularyRequestOptions {
  readonly bindingId: string;
  readonly signal: AbortSignal;
  readonly audience: NonNullable<UiRequestOptions['audience']>;
  readonly timeoutMs?: number;
  readonly deferrable?: boolean;
  readonly transient?: boolean;
}

export interface UiVocabularyCallbacks {
  canRequest(form: UiForm, options: Pick<UiVocabularyRequestOptions, 'audience'>): boolean;
  request(form: UiForm, options: UiVocabularyRequestOptions): Promise<UiRequestResult>;
  publish(update: UiVocabularyUpdate): void | Promise<void>;
}

export interface UiVocabulary {
  readonly createExtensionUi: ExtensionUiBindingFactory;
  prepareAction(action: UiActionRequest): (context: UiActionContext) => Promise<void>;
  dispatch(action: UiActionRequest, context: UiActionContext): Promise<void>;
  dispose(): Promise<void>;
}

interface Binding {
  readonly id: string;
  readonly controller: AbortController;
  readonly elements: Map<string, Element>;
  readonly statuses: Map<string, string>;
  readonly notices: Set<string>;
  reason: 'restart' | 'drain';
  writes: Promise<void>;
}

interface Element {
  readonly binding: Binding;
  readonly wireId: string;
  readonly controller: AbortController;
  readonly lifetime: AbortSignal;
  readonly signal: AbortSignal;
  readonly handler: UiPresentOptions['onAction'];
  source: UiInteractiveElement;
  writes: Promise<void>;
  actions: Promise<void>;
  closing?: Promise<void>;
  removeAbortListener: () => void;
}

export function createUiVocabulary(callbacks: UiVocabularyCallbacks): UiVocabulary {
  const bindings = new Map<string, Binding>();
  const elements = new Map<string, Element>();
  const pending = new Set<Promise<unknown>>();
  const disposalFailures: unknown[] = [];
  const publishing = new AsyncLocalStorage<{ active: boolean }>();
  let disposed = false;
  let disposal: Promise<void> | undefined;

  function track<T>(operation: Promise<T>, cleanup = false): Promise<T> {
    pending.add(operation);
    void operation.then(() => { pending.delete(operation); }, error => {
      pending.delete(operation);
      if (cleanup) disposalFailures.push(error);
    });
    return operation;
  }

  function check(binding: Binding): void {
    if (disposed || binding.controller.signal.aborted) throw new Error('UI binding is inactive.');
  }

  function outsidePublisher(): void {
    if (publishing.getStore()?.active) throw new Error('UI publication callbacks cannot reenter UI operations or disposal.');
  }

  async function publish(update: UiVocabularyUpdate): Promise<void> {
    const context = { active: true };
    try { await publishing.run(context, () => callbacks.publish(update)); }
    finally { context.active = false; }
  }

  function checkElement(element: Element): void {
    check(element.binding);
    if (element.signal.aborted || elements.get(element.wireId) !== element) stale();
  }

  function capacity(binding: Binding): void {
    if (binding.elements.size + binding.statuses.size + binding.notices.size >= LIMITS.pageEntries) {
      throw new Error('UI binding presentation capacity reached.');
    }
  }

  function write(binding: Binding, operation: () => Promise<void>): Promise<void> {
    outsidePublisher();
    const result = binding.writes.catch(() => {}).then(() => { check(binding); return operation(); });
    binding.writes = result;
    return track(result);
  }

  function close(element: Element): Promise<void> {
    if (element.closing) return element.closing;
    const cleanup = element.writes.catch(() => {}).then(() => publish({ id: element.wireId, remove: true }));
    element.closing = track(cleanup, true);
    element.writes = element.closing;
    element.removeAbortListener();
    elements.delete(element.wireId);
    element.binding.elements.delete(element.source.id);
    element.controller.abort();
    return element.closing;
  }

  function revoke(binding: Binding, reason: Binding['reason']): void {
    if (binding.controller.signal.aborted) return;
    binding.reason = reason;
    binding.controller.abort();
    for (const element of [...binding.elements.values()]) void close(element);
    const cleanup = binding.writes.catch(() => {}).then(async () => {
      const ids = [...binding.statuses.values(), ...binding.notices];
      const results = await Promise.allSettled(ids.map(id => publish({ id, remove: true })));
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'UI binding cleanup failed.');
      binding.statuses.clear();
      binding.notices.clear();
    });
    track(cleanup, true);
  }

  async function request(binding: Binding, input: UiForm, options: UiRequestOptions = {}): Promise<UiRequestResult> {
    outsidePublisher();
    check(binding);
    const form = parseUiForm(input);
    if (options.audience !== undefined && options.audience !== 'session' && options.audience !== 'owner' && options.audience !== 'host') invalid('Invalid UI audience.');
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647)) {
      invalid('Invalid UI timeout.');
    }
    if (options.deferrable !== undefined && typeof options.deferrable !== 'boolean') invalid('Invalid UI deferral option.');
    if (options.transient !== undefined && typeof options.transient !== 'boolean') invalid('Invalid UI transient option.');
    if (options.transient && options.audience !== 'host') invalid('Transient UI requests require the host audience.');
    if (options.transient && options.deferrable) invalid('Transient UI requests cannot be deferred.');
    const timeout = new AbortController();
    const signal = AbortSignal.any([binding.controller.signal, timeout.signal, ...(options.signal ? [options.signal] : [])]);
    const cancelled = (): UiRequestResult => ({ state: 'cancelled', reason: binding.controller.signal.aborted
      ? binding.reason : timeout.signal.aborted ? 'timeout' : 'abort' });
    if (signal.aborted) return cancelled();
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => timeout.abort(), options.timeoutMs);
    let removeAbortListener = () => {};
    try {
      const aborted = new Promise<UiRequestResult>(resolve => {
        const onAbort = () => resolve(cancelled());
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      });
      const response = track(Promise.resolve().then(() => {
        if (signal.aborted) return cancelled();
        return callbacks.request(parseUiForm(form), {
          bindingId: binding.id, signal, audience: options.audience ?? 'session',
          ...(options.deferrable === undefined ? {} : { deferrable: options.deferrable }),
          ...(options.transient === undefined ? {} : { transient: options.transient }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
      }).catch(error => {
        if (signal.aborted) disposalFailures.push(error);
        throw error;
      }));
      const result = await Promise.race([response, aborted]);
      if (signal.aborted) return cancelled();
      if (result.state === 'answered') return { state: 'answered', answer: validateUiFormAnswer(form, result.answer) };
      if (result.state === 'deferred') return { state: 'deferred', interactionId: parseSchema(IdSchema, result.interactionId) };
      if (result.state === 'cancelled' && ['user', 'abort', 'timeout', 'unsupported', 'drain', 'restart'].includes(result.reason)) return result;
      return invalid('Invalid UI request outcome.');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      removeAbortListener();
    }
  }

  async function present(binding: Binding, input: UiInteractiveElement, options: UiPresentOptions = {}): Promise<UiElementHandle> {
    outsidePublisher();
    check(binding);
    const source = parseElement(input);
    if (source.actions.length && typeof options.onAction !== 'function') invalid('Interactive UI requires an action handler.');
    if (binding.elements.has(source.id)) invalid('UI element is already presented.');
    capacity(binding);
    const controller = new AbortController();
    const lifetime = AbortSignal.any([binding.controller.signal, ...(options.signal ? [options.signal] : [])]);
    const signal = AbortSignal.any([lifetime, controller.signal]);
    signal.throwIfAborted();
    const element: Element = {
      binding, source, wireId: `${binding.id}:element:${randomUUID()}`, controller, lifetime, signal,
      handler: options.onAction, writes: Promise.resolve(), actions: Promise.resolve(), removeAbortListener: () => {},
    };
    binding.elements.set(source.id, element);
    elements.set(element.wireId, element);
    const onAbort = () => { void close(element); };
    signal.addEventListener('abort', onAbort, { once: true });
    element.removeAbortListener = () => signal.removeEventListener('abort', onAbort);

    function update(input: UiInteractiveElement, initial = false): Promise<void> {
      outsidePublisher();
      const next = parseElement(input);
      if (next.id !== source.id || next.kind !== source.kind) invalid('UI update must preserve id and kind.');
      if (next.actions.length && typeof element.handler !== 'function') invalid('Interactive UI requires an action handler.');
      const result = element.writes.catch(() => {}).then(async () => {
        checkElement(element);
        if (!initial && next.revision <= element.source.revision) invalid('UI update revision must increase.');
        const wire = parseUiPresentation({ ...next, id: element.wireId });
        try {
          await publish(wire);
        } catch (error) {
          void close(element);
          throw error;
        }
        checkElement(element);
        element.source = next;
      });
      element.writes = result;
      return track(result);
    }

    try { await update(source, true); }
    catch (error) { void close(element); throw error; }
    return {
      update: async next => update(next),
      close: async () => { outsidePublisher(); await close(element); },
    };
  }

  const createExtensionUi: ExtensionUiBindingFactory = packageName => {
    outsidePublisher();
    if (disposed) throw new Error('UI vocabulary is disposed.');
    const previous = bindings.get(packageName);
    if (previous) revoke(previous, 'restart');
    const binding: Binding = {
      id: `ui:${randomUUID()}`, controller: new AbortController(), elements: new Map(),
      statuses: new Map(), notices: new Set(), writes: Promise.resolve(), reason: 'drain',
    };
    bindings.set(packageName, binding);
    const ui: ExtensionUi = {
      async notify(message) {
        const parsed = parseSchema(PresentationSchema, {
          id: `${binding.id}:notice:${randomUUID()}`, kind: 'notification', level: message.level, text: message.text,
        });
        if (parsed.kind !== 'notification') invalid('Invalid UI notification.');
        return write(binding, async () => {
          capacity(binding);
          binding.notices.add(parsed.id);
          await publish(parsed);
        });
      },
      async status(input: UiStatus) {
        const status = parseUiPresentation(input);
        if (status.kind !== 'status') invalid('Expected UI status.');
        return write(binding, async () => {
          let wireId = binding.statuses.get(status.id);
          if (!wireId) {
            capacity(binding);
            wireId = `${binding.id}:status:${randomUUID()}`;
            binding.statuses.set(status.id, wireId);
          }
          await publish(parseUiPresentation({ ...status, id: wireId }));
        });
      },
      async removeStatus(id) {
        const localId = parseSchema(IdSchema, id);
        return write(binding, async () => {
          const wireId = binding.statuses.get(localId);
          if (!wireId) stale();
          await publish({ id: wireId, remove: true });
          binding.statuses.delete(localId);
        });
      },
      canRequest: (form, options) => {
        check(binding);
        return callbacks.canRequest(parseUiForm(form), { audience: options?.audience ?? 'session' });
      },
      request: (form, options) => track(request(binding, form, options)),
      present: (element, options) => track(present(binding, element, options)),
    };
    return Object.freeze(ui);
  };

  function prepareAction(input: UiActionRequest): (context: UiActionContext) => Promise<void> {
    const action = parseSchema(UiActionRequestSchema, input);
    const element = elements.get(action.elementId);
    if (!element) stale();
    checkElement(element);
    validateUiAction(element.source, { ...action, elementId: element.source.id });
    if (typeof element.handler !== 'function') invalid('Interactive UI requires an action handler.');
    return async context => {
      outsidePublisher();
      const requestId = parseSchema(IdSchema, context.requestId);
      checkElement(element);
      const signal = AbortSignal.any([element.signal, context.signal]);
      const result = element.actions.catch(() => {}).then(async () => {
        await element.writes.catch(() => {});
        checkElement(element);
        signal.throwIfAborted();
        const parsed = validateUiAction(element.source, { ...action, elementId: element.source.id });
        if (typeof element.handler !== 'function') invalid('Interactive UI requires an action handler.');
        await element.handler(parsed, { requestId, signal });
        element.lifetime.throwIfAborted();
        context.signal.throwIfAborted();
      });
      element.actions = result;
      return track(result);
    };
  }

  return {
    createExtensionUi,
    prepareAction,
    async dispatch(input, context) { return prepareAction(input)(context); },
    dispose() {
      if (publishing.getStore()?.active) return Promise.reject(new Error('UI publication callbacks cannot reenter UI operations or disposal.'));
      if (disposal) return disposal;
      disposed = true;
      for (const binding of bindings.values()) revoke(binding, 'drain');
      disposal = (async () => {
        while (pending.size) await Promise.allSettled([...pending]);
        if (disposalFailures.length) throw new AggregateError([...disposalFailures], 'UI vocabulary cleanup failed.');
        bindings.clear();
      })();
      return disposal;
    },
  };
}

function parseElement(input: unknown): UiInteractiveElement {
  const source = parseUiPresentation(input);
  if (source.kind === 'status') invalid('Status is not an interactive UI element.');
  return source;
}

function invalid(message: string): never { throw new ProtocolValidationError('invalid_request', message); }
function stale(): never { throw new ProtocolValidationError('stale_request', 'UI element is stale or foreign.'); }
