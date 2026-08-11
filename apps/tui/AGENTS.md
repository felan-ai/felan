# Local TUI

- This is the `felan` composition root. It owns credentials, settings, root-session and agent storage path mapping, model scope, the built-in extension allowlist, the local subagent host, lifecycle, and presentation; portable behavior belongs in `packages/*`.
- Preserve the fixed resource boundary: source-controlled built-ins, Felan-owned settings/appends, explicit global/workspace agent definitions and Agent Skills, and the Agent Core-selected cwd `AGENTS.md`/`CLAUDE.md`. Ambient Pi project resources and external extensions remain filtered.
- Every new, resumed, forked, cloned, or imported root session gets a host-path runtime whose cwd resolves relative paths, plus a local subagent host keyed by its active SessionManager ID. Nested subagents share that root session's storage path. Rebind presentation after replacement and await host shutdown before Pi disposal.
