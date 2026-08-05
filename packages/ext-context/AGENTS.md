# Progressive Context Extension

- Load instructions only from nested directories below the session cwd; cwd-level instructions are composed elsewhere. Per-directory precedence is `AGENTS.md`, then `CLAUDE.md`.
- Discovery follows successful structured `read` results or decoded CLI `@file` blocks, never shell reads. Loaded instructions enter hidden context on subsequent model calls.
- Resolve and read through `AgentRuntime`; preserve containment, session deduplication, and nonfatal missing or unreadable candidates.
