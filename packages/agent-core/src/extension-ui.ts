import type {
  UiActionRequest,
  UiActionSource,
  UiFormAnswer,
  UiForm,
  UiStatus,
} from '@felan-ai/session-protocol';

export type UiCancelReason = 'user' | 'abort' | 'timeout' | 'unsupported' | 'drain' | 'restart';

export type UiRequestResult =
  | { readonly state: 'answered'; readonly answer: UiFormAnswer }
  | { readonly state: 'deferred'; readonly interactionId: string }
  | { readonly state: 'cancelled'; readonly reason: UiCancelReason };

export interface UiActionContext {
  readonly requestId: string;
  readonly signal: AbortSignal;
}

export type UiInteractiveElement = UiActionSource;

export interface UiElementHandle {
  update(element: UiInteractiveElement): Promise<void>;
  close(): Promise<void>;
}

export interface UiRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly deferrable?: boolean;
  /** Host-only: keeps the form out of durable state; answer admission remains durable, so do not collect secrets. */
  readonly transient?: boolean;
  readonly audience?: 'session' | 'owner' | 'host';
}

export interface UiPresentOptions {
  readonly signal?: AbortSignal;
  readonly onAction?: (request: UiActionRequest, context: UiActionContext) => Promise<void>;
}

export interface ExtensionUi {
  /** Current presentation availability only; this does not grant consent or authorization. */
  canRequest(form: UiForm, options?: Pick<UiRequestOptions, 'audience'>): boolean;
  notify(message: { readonly level: 'info' | 'warning' | 'error'; readonly text: string }): Promise<void>;
  status(item: UiStatus): Promise<void>;
  removeStatus(id: string): Promise<void>;
  request(form: UiForm, options?: UiRequestOptions): Promise<UiRequestResult>;
  present(element: UiInteractiveElement, options?: UiPresentOptions): Promise<UiElementHandle>;
}

export type ExtensionUiBindingFactory = (packageName: string) => ExtensionUi;

export class ExtensionUiUnavailableError extends Error {
  constructor() {
    super('Extension UI is unavailable in this host.');
    this.name = 'ExtensionUiUnavailableError';
  }
}

export function createUnavailableExtensionUi(): ExtensionUi {
  const unavailable = async (): Promise<never> => { throw new ExtensionUiUnavailableError(); };
  const ui: ExtensionUi = {
    canRequest: () => false,
    notify: unavailable,
    status: unavailable,
    removeStatus: unavailable,
    request: async (_form, options) => ({
      state: 'cancelled',
      reason: options?.signal?.aborted ? 'abort' : 'unsupported',
    }),
    present: unavailable,
  };
  return Object.freeze(ui);
}
