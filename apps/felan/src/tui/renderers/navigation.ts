export function createElementNavigation<State>() {
  const states = new Map<string, State>();
  return {
    get: (id: string) => states.get(id),
    has: (id: string) => states.has(id),
    set(id: string, state: State) {
      states.set(id, state);
      if (states.size > 128) states.delete(states.keys().next().value!);
    },
    delete: (id: string) => states.delete(id),
  };
}
