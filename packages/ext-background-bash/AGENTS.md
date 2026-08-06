# Background Bash Extension

- Keep model eligibility with the extension. Activate only when a selected model is outside the OpenAI provider family.
- Route files, shell execution, process inspection, and signals through `AgentRuntime` so host, Docker, and Daytona consumers share the same behavior.
- Capture `AgentRuntime.storage('session')` once and store workspace-isolated process records under `<session-storage>/background-bash/<workspace-key>/jobs`.
- Install overlays, shortcuts, and status polling only for TUI sessions. Always clear polling and status state on shutdown.
