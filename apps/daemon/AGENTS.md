# Session daemon

- `@felan-ai/daemon` owns the session server, admission, registry, canonical persistence, descendants and process lifetime. Never import or depend on `@felan-ai/felan`, `apps/felan`, extension implementations or client renderers.
- Keep the `./session-runtime` and `./provider` contracts adapter-neutral. Trusted managing-package providers own local composition; the daemon supplies restricted lifecycle operations, not an unrestricted registry. Portable wire contracts remain in `packages/session-protocol`; do not move host implementation into Agent Core to avoid a dependency cycle.
- Preserve canonical store ownership, the account-wide singleton, shared launch environment, root-session storage mapping and descendant shutdown order. Run daemon and client tests through `scripts/test-isolated.sh` (fresh HOME, agent and temp directories), never against the developer's account, daemon or stores.
- Presentation remains client-owned, including themes. Do not claim a terminal-free distribution: the pinned Pi SDK also transitively includes `pi-tui`.
- Resource loading must honor the managing package's configured allowlist and trust rules. Never discover ambient Pi resources, infer provider code from cwd, or load providers relative to a project or configuration file.
