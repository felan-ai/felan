# Felan

- Use Node.js 22.20.0 and pnpm 9.15.5. This is a strict ESM TypeScript workspace with packages under `apps/*` and `packages/*`.
- Ownership flows from `apps/tui` (local host, policy, storage, presentation) through `ext-*` (feature behavior) to `agent-core` (portable contracts and base composition). Keep behavior in its owning layer.
- Keep runtime contracts adapter-neutral and route host I/O through `AgentRuntime` or the extension API unless a scoped `AGENTS.md` names an intentional exception.
- Keep pinned `@earendil-works/pi-*` versions aligned; `agent-core/src/index.ts` is the shared Pi composition surface.
- Extensions consume `@felan-ai/agent-core` through a compatible-minor peer dependency and use `workspace:*` only as a development dependency.
- Apply SemVer deliberately to every public package. For stable packages, use patch for backward-compatible fixes, minor for backward-compatible functionality, and major for breaking public APIs. For `0.x` packages, keep compatible changes within the current minor using patch releases and use the next minor for breaking public API changes; never hide a breaking change in a patch. Before bumping, inspect exported types, runtime behavior, manifests, and packed exact workspace dependencies, and bump applications when those exact dependencies change.
- Run each changed workspace's `build`, `type-check`, and `test`; run `pnpm verify` for cross-package or release-facing changes.
- Follow `docs/releasing.md` for every package release. New npm packages require its manual `0.0.0` bootstrap and trusted-publisher setup before the intended version publishes from CI.
