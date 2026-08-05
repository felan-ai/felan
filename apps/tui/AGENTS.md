# Local TUI

- This is the `felan` composition root. It owns credentials, settings, session storage, model scope, the built-in extension allowlist, the local subagent host, lifecycle, and presentation; portable behavior belongs in `packages/*`.
- Preserve the fixed resource boundary: source-controlled built-ins, Felan-owned settings/appends/agents, and explicit global/workspace Agent Skills. Ambient Pi project resources and external extensions remain filtered.
- Every new, resumed, forked, cloned, or imported session gets a cwd-bound runtime and local subagent host. Rebind presentation after replacement and await host shutdown before Pi disposal.
