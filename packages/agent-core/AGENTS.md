# Agent Core

- Own `AgentRuntime`, `HostAgentRuntime`, the Felan base prompt, capabilities, resource/session composition, coding tools, and the public Pi composition surface.
- Keep this package feature-neutral. Subagents, progressive context, Prewalk, local settings/storage, and UI policy belong to their extension or application.
- Runtime contracts stay adapter-neutral. Host mode contains paths to its immutable cwd but is not a sandbox; preserve byte-based file I/O and literal argv for `exec`, using `shell` only intentionally.
- Export public API through `src/index.ts`; cover contract changes with corresponding runtime and composition tests.
