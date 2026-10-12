import type { Interaction } from '@felan-ai/session-protocol';
import type { ClientInteractionPresenters } from '../client/presenters.js';
import type { TuiSessionController } from './controller.js';
import type { TerminalSetup } from './setup.js';

export const TERMINAL_INTERACTION_KINDS = ['select', 'confirm', 'input', 'editor', 'ask_user', 'tool_approval', 'oauth', 'trust', 'dependency', 'custom'] as const;
export { TERMINAL_PRESENTERS } from './presenters.js';

export class TerminalInteractions {
  private readonly unsubscribe: () => void;
  private readonly unsubscribeSetup: (() => void) | undefined;
  private readonly handled = new Set<string>();
  private active: { id: string; item: Interaction; control: AbortController; work: Promise<void> } | undefined;
  private closed = false;

  constructor(private readonly controller: TuiSessionController, private readonly presenters: ClientInteractionPresenters,
    private readonly setup?: Pick<TerminalSetup, 'busy' | 'subscribe'>) {
    this.unsubscribeSetup = setup?.subscribe(() => this.refresh());
    this.unsubscribe = controller.subscribe(() => this.refresh()); this.refresh();
  }

  get busy(): boolean { return this.active !== undefined; }

  private pending(): readonly Interaction[] {
    if (this.controller.client.status !== 'ready') return [];
    const items = new Map(this.controller.client.getInteractions({ includeSessions: true }).map(item => [item.id, item]));
    return [...items.values()].filter(item => ['waiting', 'deferred'].includes(item.state)
      && (item.scope.kind === 'host' || this.controller.client.getAttachment(item.scope.session)?.state.status === 'live'));
  }

  private refresh(): void {
    if (this.closed) return;
    const pending = this.pending();
    if (this.active) {
      if (this.recovering(this.active.item)) return;
      if (!pending.some(item => item.id === this.active!.id)) this.active.control.abort();
      return;
    }
    if (this.setup?.busy) return;
    const item = pending.find(item => !this.handled.has(item.id));
    if (!item) return;
    const active = { id: item.id, item, control: new AbortController(), work: Promise.resolve() };
    this.active = active;
    active.work = Promise.resolve().then(async () => {
      if (this.closed || this.setup?.busy) return;
      const outcome = await this.presenters.present(item, active.control.signal);
      if (!await this.available(item, active.control.signal)) return;
      this.remember(item.id);
      if (outcome.state === 'cancelled' && outcome.reason !== 'user') return;
      if (outcome.state === 'unsupported') { this.controller.setNotice(outcome.message); return; }
      const answer = outcome.state === 'answered' ? outcome.answer : { cancelled: true as const, reason: 'user' as const };
      await this.controller.perform('interaction.answer', { interactionId: item.id, answer }, item.scope.kind === 'session' ? item.scope.session : undefined);
    }).catch(error => {
      if (!active.control.signal.aborted && !this.closed) { this.remember(item.id); this.controller.setNotice(error instanceof Error ? error.message : 'Interaction could not complete.'); }
    }).finally(() => { if (this.active === active) this.active = undefined; this.refresh(); });
  }

  private recovering(item: Interaction): boolean {
    return this.controller.client.status === 'ready' && item.scope.kind === 'session'
      && this.controller.client.getAttachment(item.scope.session)?.state.status === 'recovering';
  }

  private available(item: Interaction, signal: AbortSignal): Promise<boolean> {
    return new Promise(resolve => {
      let unsubscribe = () => {};
      const check = () => {
        if (!this.closed && !signal.aborted && this.recovering(item)) return;
        unsubscribe(); signal.removeEventListener('abort', check);
        resolve(!this.closed && !signal.aborted && this.pending().some(current => current.id === item.id));
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
  }
}
