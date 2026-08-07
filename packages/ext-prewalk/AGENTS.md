# Prewalk Extension

- Preserve the same-session state machine: the first successful code mutation triggers handoff at the turn boundary without forking or replacing history.
- Phase guidance stays in transient hidden context. Preserve bounded continuation, tier or exact-model target resolution, planner model and thinking restoration on settle/shutdown, and cancellation on manual model changes.
- Keep the Tasks workflow in phase guidance. Do not inspect Tasks, todo, or Beads activity at runtime. Qualify only explicit mutation tools (`edit`, `write`, and Codex `apply_patch`), not general shell tools; keep mutation qualification in `state.ts` and lifecycle/model orchestration in `index.ts`.
