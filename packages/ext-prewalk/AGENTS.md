# Prewalk Extension

- Preserve the same-session state machine: the selected tracker must succeed before a successful mutation in tool-call order, and handoff occurs at the turn boundary without forking or replacing history.
- Phase guidance stays in transient hidden context. Preserve bounded continuation, exact target model/auth checks, planner model and thinking restoration on settle/shutdown, and cancellation on manual model changes.
- Probe Beads through `pi.exec`; keep tool-order qualification in `state.ts` and lifecycle/model orchestration in `index.ts`.
