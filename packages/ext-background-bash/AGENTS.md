# Background Bash Extension

- Keep the process surface provider-neutral; model-specific tool replacement belongs to the owning model extension.
- Route files, shell execution, process inspection, and signals through `AgentRuntime` so host, Docker, and Daytona consumers share the same behavior.
- Probe required POSIX process utilities through `AgentRuntime` and leave the feature inactive when they are unavailable; do not register unusable tools or attempt to install operating-system utilities.
- Capture `AgentRuntime.storage('session')` once and store workspace-isolated process records under `<session-storage>/background-bash/<workspace-key>/jobs`.
- The default root publishes generic process views and output documents through `pi.ui` without requiring a TUI. Keep overlays, shortcuts, and native status polling in `apps/felan`. Shutdown must cancel and join view work, close presentation handles, and preserve process/coordinator ownership.
