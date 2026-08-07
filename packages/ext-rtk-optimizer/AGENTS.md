# RTK Optimizer Extension

- Route RTK discovery, rewriting, configuration, and all other host I/O through `AgentRuntime`.
- Support ordinary `bash` (`command`) and Codex `exec_command` (`cmd`) symmetrically. Preserve Codex result envelopes and associate `write_stdin` sessions with their originating command.
- Keep lossy `read` compaction opt-in. Explicit ranges and short reads must remain exact.
- Keep configuration in agent-scoped runtime storage under `rtk-optimizer/config.json`; invalid configuration must fall back to documented defaults and report through the extension host's notification channel when one is available.
- Preserve the upstream pi-rtk-optimizer attribution in LICENSE, NOTICE, and the repository root NOTICE.
