import type { Interaction, UiPresentation } from '@felan-ai/session-protocol';
import { GENERIC_UI_CAPABILITIES, uiCapability } from '../client/ui.js';
import type { ClientInteractionPresenters } from '../client/presenters.js';
import type { TuiSessionController } from './controller.js';
import type { TerminalSetup } from './setup.js';

export const TERMINAL_INTERACTION_KINDS = ['select', 'confirm', 'input', 'editor', 'form', 'tool_approval', 'dependency'] as const;
export const TERMINAL_UI_CAPABILITIES = GENERIC_UI_CAPABILITIES;

export class TerminalInteractions {
  private readonly unsubscribe: () => void;
  private readonly unsubscribeSetup: (() => void) | undefined;
  private readonly handled = new Set<string>();
  private active: { id: string; item: Interaction; control: AbortController; work: Promise<void> } | undefined;
  private elementActive: { session: string; element: UiPresentation; manual: boolean; control: AbortController; work: Promise<void> } | undefined;
  private readonly seenElements = new Map<string, string>();
  private requestedElement: string | undefined;
  private closed = false;

  constructor(private readonly controller: TuiSessionController, private readonly presenters: ClientInteractionPresenters,
    private readonly setup?: Pick<TerminalSetup, 'busy' | 'subscribe'>) {
    this.unsubscribeSetup = setup?.subscribe(() => this.refresh());
    this.unsubscribe = controller.subscribe(() => this.refresh()); this.refresh();
  }

  get busy(): boolean { return this.active !== undefined || this.elementActive !== undefined; }

  elements(): readonly UiPresentation[] {
    return (this.controller.snapshot?.presentation ?? []).filter((item): item is UiPresentation =>
      item.kind === 'document' || item.kind === 'view' || item.kind === 'progress' || item.kind === 'status');
  }

  showElement(id: string): void {
    if (this.closed || this.controller.state?.status !== 'live' || this.controller.client.status !== 'ready') throw new Error('Session UI is unavailable while disconnected.');
    if (this.active) throw new Error('Complete the pending question before opening another view.');
    if (!this.elements().some(item => item.id === id)) throw new Error('This UI surface is no longer available.');
    this.requestedElement = id;
    this.seenElements.delete(JSON.stringify([this.controller.sessionId, id]));
    this.elementActive?.control.abort();
    this.refresh();
  }

  /** Prompts this terminal presents: host prompts and those of live attached sessions. */
  pending(): readonly Interaction[] {
    if (this.controller.client.status !== 'ready') return [];
    const items = new Map(this.controller.client.getInteractions({ includeSessions: true }).map(item => [item.id, item]));
    return [...items.values()].filter(item => ['waiting', 'deferred'].includes(item.state)
      && (item.scope.kind === 'host' || this.controller.client.getAttachment(item.scope.session)?.state.status === 'live'));
  }

  private refresh(): void {
    if (this.closed) return;
    if (this.controller.state?.status === 'live') {
      const current = new Set(this.elements().map(element => JSON.stringify([this.controller.sessionId, element.id])));
      for (const key of this.seenElements.keys()) if (!current.has(key)) this.seenElements.delete(key);
    }
    const pending = this.pending();
    if (this.elementActive) {
      const active = this.elementActive;
      if (pending.some(item => !this.handled.has(item.id))) {
        if (!this.requestedElement && active.manual) this.requestedElement = active.element.id;
        active.control.abort(); return;
      }
      if (this.recoveringSession(active.session)) return;
      if (!this.currentElement(active.session, active.element)) {
        const next = this.controller.sessionId === active.session && this.controller.state?.status === 'live'
          && this.controller.client.status === 'ready'
          ? this.elements().find(element => element.id === active.element.id && element.kind === active.element.kind) : undefined;
        if (next && next.hint?.id === active.element.hint?.id && next.hint?.version === active.element.hint?.version
          && this.presenters.updateElement(next, active.control.signal)) {
          active.element = next;
          return;
        }
        if (!this.requestedElement && active.manual && this.controller.sessionId === active.session
          && this.elements().some(element => element.id === active.element.id)) this.requestedElement = active.element.id;
        active.control.abort();
      }
      return;
    }
    if (this.active) {
      if (this.recovering(this.active.item)) return;
      if (!pending.some(item => item.id === this.active!.id && JSON.stringify(item.request) === JSON.stringify(this.active!.item.request))) this.active.control.abort();
      return;
    }
    if (this.setup?.busy) return;
    const item = pending.find(item => !this.handled.has(item.id));
    if (!item) { this.refreshElements(); return; }
    if (!this.controller.client.capabilities?.interactionKinds.includes(item.request.kind)) {
      this.remember(item.id); this.controller.setNotice('Interaction kind was not negotiated.'); return;
    }
    const active = { id: item.id, item, control: new AbortController(), work: Promise.resolve() };
    this.active = active;
    active.work = Promise.resolve().then(async () => {
      if (this.closed || this.setup?.busy) return;
      const outcome = await this.presenters.present(item, active.control.signal);
      if (!await this.available(item, active.control.signal) || active.control.signal.aborted) return;
      this.remember(item.id);
      if (outcome.state === 'cancelled' && outcome.reason !== 'user') return;
      if (outcome.state === 'unsupported') { this.controller.setNotice(outcome.message); return; }
      const answer = outcome.state === 'answered' ? outcome.answer : { cancelled: true as const, reason: 'user' as const };
      const response = await this.controller.perform('interaction.answer', { interactionId: item.id, answer }, item.scope.kind === 'session' ? item.scope.session : undefined);
      if (response.outcome !== 'accepted') throw new Error(`${response.error.code}: ${response.error.message}`);
    }).catch(error => {
      if (!active.control.signal.aborted && !this.closed) { this.remember(item.id); this.controller.setNotice(error instanceof Error ? error.message : 'Interaction could not complete.'); }
    }).finally(() => { if (this.active === active) this.active = undefined; this.refresh(); });
  }

  private currentElement(session: string, element: UiPresentation): boolean {
    if (this.closed || this.controller.client.status !== 'ready' || this.controller.sessionId !== session || this.controller.state?.status !== 'live') return false;
    return this.controller.snapshot?.presentation.some(current => current.id === element.id && current.kind === element.kind
      && (element.kind === 'status' ? JSON.stringify(current) === JSON.stringify(element)
        : 'revision' in current && current.revision === element.revision)) ?? false;
  }

  private refreshElements(): void {
    const session = this.controller.sessionId;
    if (!session || this.controller.client.status !== 'ready' || this.controller.state?.status !== 'live') return;
    const elements = [...this.elements()].sort((left, right) => Number(right.id === this.requestedElement) - Number(left.id === this.requestedElement));
    if (this.requestedElement && !elements.some(element => element.id === this.requestedElement)) this.requestedElement = undefined;
    for (const element of elements) {
      const key = JSON.stringify([session, element.id]);
      const version = JSON.stringify(element);
      if (this.seenElements.get(key) === version) continue;
      if ((element.kind === 'status' || !element.actions.length) && element.id !== this.requestedElement) continue;
      const manual = element.id === this.requestedElement;
      if (manual) this.requestedElement = undefined;
      const active = { session, element, manual, control: new AbortController(), work: Promise.resolve() };
      this.elementActive = active;
      active.work = Promise.resolve().then(async () => {
        const capabilities = this.controller.client.capabilities?.capabilities ?? [];
        const interactive = capabilities.includes(uiCapability(element)) && capabilities.includes('ui.action')
          && Boolean(this.controller.client.capabilities?.operations.includes('ui.action'));
        const action = await this.presenters.presentElement(element, active.control.signal, interactive);
        if (!await this.availableElement(session, active.element, active.control.signal)
          || active.control.signal.aborted || !this.currentElement(session, active.element)) return;
        this.rememberElement(key, JSON.stringify(active.element));
        if (action && interactive) {
          const response = await this.controller.perform('ui.action', action, session);
          if (response.outcome !== 'accepted') throw new Error(`${response.error.code}: ${response.error.message}`);
        }
      }).catch(error => {
        if (!active.control.signal.aborted && !this.closed) {
          this.rememberElement(key, version);
          this.controller.setNotice(error instanceof Error ? error.message : 'Generic UI could not complete.');
        }
      }).finally(() => { if (this.elementActive === active) this.elementActive = undefined; this.refresh(); });
      return;
    }
  }

  private rememberElement(key: string, version: string): void {
    this.seenElements.set(key, version);
    if (this.seenElements.size > 256) this.seenElements.delete(this.seenElements.keys().next().value!);
  }

  private availableElement(session: string, element: UiPresentation, signal: AbortSignal): Promise<boolean> {
    return new Promise(resolve => {
      let unsubscribe = () => {};
      const check = () => {
        if (!this.closed && !signal.aborted && this.recoveringSession(session)) return;
        unsubscribe(); signal.removeEventListener('abort', check);
        resolve(!signal.aborted && this.currentElement(session, element));
      };
      unsubscribe = this.controller.subscribe(check);
      signal.addEventListener('abort', check, { once: true });
      check();
    });
  }

  private recovering(item: Interaction): boolean {
    if (item.scope.kind === 'host') return this.controller.client.status === 'connecting' || this.controller.client.status === 'disconnected';
    const attachment = this.controller.client.getAttachment(item.scope.session);
    if (!attachment || attachment.state.status === 'blocked') return false;
    return this.controller.client.status === 'connecting' || this.controller.client.status === 'disconnected'
      || attachment?.state.status === 'disconnected' || attachment?.state.status === 'recovering';
  }

  private recoveringSession(session: string): boolean {
    if (this.controller.sessionId !== session) return false;
    const attachment = this.controller.client.getAttachment(session);
    if (!attachment || attachment.state.status === 'blocked') return false;
    return this.controller.client.status === 'connecting' || this.controller.client.status === 'disconnected'
      || attachment?.state.status === 'disconnected' || attachment?.state.status === 'recovering';
  }

  private available(item: Interaction, signal: AbortSignal): Promise<boolean> {
    return new Promise(resolve => {
      let unsubscribe = () => {};
      const check = () => {
        if (!this.closed && !signal.aborted && this.recovering(item)) return;
        unsubscribe(); signal.removeEventListener('abort', check);
        resolve(!this.closed && !signal.aborted && this.pending().some(current => current.id === item.id
          && JSON.stringify(current.request) === JSON.stringify(item.request)));
      };
      unsubscribe = this.controller.subscribe(check);
      signal.addEventListener('abort', check, { once: true });
      check();
    });
  }

  private remember(id: string): void {
    this.handled.add(id);
    if (this.handled.size > 256) this.handled.delete(this.handled.values().next().value!);
  }

  async dispose(): Promise<void> {
    this.closed = true; this.unsubscribe(); this.unsubscribeSetup?.();
    const active = this.active; active?.control.abort(); await active?.work; this.handled.clear();
    const element = this.elementActive; element?.control.abort(); await element?.work; this.seenElements.clear();
  }
}
