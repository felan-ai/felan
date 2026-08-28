export interface CodebaseMemorySessionState {
  readonly disabled: boolean;
  disable(): void;
  assertEnabled(): void;
}

export function createCodebaseMemorySessionState(): CodebaseMemorySessionState {
  let disabled = false;
  return {
    get disabled() { return disabled; },
    disable: () => { disabled = true; },
    assertEnabled: () => {
      if (disabled) throw new Error('Codebase Memory is disabled for this session because startup indexing failed.');
    },
  };
}
