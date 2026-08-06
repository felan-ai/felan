# Felan

- Use Node.js 22.20.0 and pnpm 9.15.5. This is a strict ESM TypeScript workspace with packages under `apps/*` and `packages/*`.
- Ownership flows from `apps/tui` (local host, policy, storage, presentation) through `ext-*` (feature behavior) to `agent-core` (portable contracts and base composition). Keep behavior in its owning layer.
- Keep runtime contracts adapter-neutral and route host I/O through `AgentRuntime` or the extension API unless a scoped `AGENTS.md` names an intentional exception.
- Keep pinned `@earendil-works/pi-*` versions aligned; `agent-core/src/index.ts` is the shared Pi composition surface.
- Extensions consume `@felan-ai/agent-core` through a compatible-minor peer dependency and use `workspace:*` only as a development dependency.
- Run each changed workspace's `build`, `type-check`, and `test`; run `pnpm verify` for cross-package or release-facing changes.
