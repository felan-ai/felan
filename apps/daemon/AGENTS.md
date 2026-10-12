# Session daemon

- `@felan-ai/daemon` owns the session server, admission, registry, persistence, local profile, credentials/settings, host-path runtimes, descendants and process execution. Never import or depend on `@felan-ai/felan` or `apps/felan`.
- Keep the profile contract at `./daemon-profile` adapter-neutral. Portable protocol contracts remain in `packages/session-protocol`; do not move host implementation into Agent Core to avoid a dependency cycle.
- Preserve canonical store ownership, the account-wide singleton, shared launch environment, root-session storage mapping and descendant shutdown order. Tests must use the approved isolated runner, not the developer's account or stores.
- Presentation remains client-owned, including themes. Do not claim a terminal-free distribution: the pinned Pi SDK also transitively includes `pi-tui`.
- Keep resource loading bounded to the existing built-ins, Felan settings/appends, explicit agent definitions/skills and trusted interactive-root extensions. Do not enable ambient Pi resource discovery.
