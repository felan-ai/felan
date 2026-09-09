# Background Bash Extension

- Keep the process surface provider-neutral; model-specific tool replacement belongs to the owning model extension.
- Route files, shell execution, process inspection, and signals through `AgentRuntime` so host, Docker, and Daytona consumers share the same behavior.
- Probe required POSIX process utilities through `AgentRuntime` and leave the feature inactive when they are unavailable; do not register unusable tools or attempt to install operating-system utilities.
- Capture `AgentRuntime.storage('session')` once and store workspace-isolated process records under `<session-storage>/background-bash/<workspace-key>/jobs`.
- Install overlays, shortcuts, and status polling only for TUI sessions. Always clear polling and status state on shutdown.
