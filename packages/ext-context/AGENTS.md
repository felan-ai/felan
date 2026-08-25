# Progressive Context Extension

- Load instructions only from nested directories below the session cwd; Agent Core composes cwd-level instructions. Per-directory precedence is `AGENTS.md`, then `CLAUDE.md`.
- Discovery follows successful structured `read` results or decoded CLI `@file` blocks, never shell reads. Loaded instructions enter hidden context at a stable transient position on subsequent model calls; reset that anchor only when newly discovered instructions or rebuilt context genuinely change it.
- Resolve and read through `AgentRuntime`; preserve containment, session deduplication, and nonfatal missing or unreadable candidates.
