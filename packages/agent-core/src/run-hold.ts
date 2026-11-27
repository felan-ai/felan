import type { EventBus, ResourceLoader } from '@earendil-works/pi-coding-agent';

/**
 * Channel on a session's `pi.events` bus that the host emits, with a {@link RunHoldEvent}, before it holds the session's run
 * at a step end to continue it after a restart. An extension whose in-memory state the restored session cannot rebuild calls
 * `refuse` from a synchronous handler; the run then keeps going and a restart interrupts it as before.
 */
export const RUN_HOLD_EVENT = 'felan:run-hold';

export interface RunHoldEvent {
  refuse(reason: string): void;
}

const buses = new WeakMap<ResourceLoader, EventBus>();

/** @internal Associates a resource loader with the event bus its extensions were loaded with. */
export function registerSessionEventBus(loader: ResourceLoader, bus: EventBus): void {
  buses.set(loader, bus);
}

/** Reasons the session's extensions gave for refusing a hold now; empty when the run may be held. */
export function runHoldRefusals(session: { readonly resourceLoader: ResourceLoader }): string[] {
  const bus = buses.get(session.resourceLoader);
  if (!bus) return [];
  const reasons: string[] = [];
  const event: RunHoldEvent = { refuse: reason => { reasons.push(String(reason)); } };
  bus.emit(RUN_HOLD_EVENT, event);
  return reasons;
}
