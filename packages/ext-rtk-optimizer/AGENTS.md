# RTK Optimizer Extension

- Route RTK discovery, rewriting, configuration, and all other host I/O through `AgentRuntime`.
- Keep managed installation explicit, pin both the reviewed official installer and RTK release, and verify the installer digest before execution. Never install during extension startup or a model tool call.
- Support ordinary `bash` (`command`) and Codex `exec_command` (`cmd`) symmetrically. Preserve Codex result envelopes and associate `write_stdin` sessions with their originating command.
- Keep lossy `read` compaction opt-in. Explicit ranges and short reads must remain exact.
- Keep configuration in agent-scoped runtime storage under `rtk-optimizer/config.json`; invalid configuration must fall back to documented defaults and report through the extension host's notification channel when one is available.
- Preserve the upstream pi-rtk-optimizer attribution in LICENSE, NOTICE, and the repository root NOTICE.
