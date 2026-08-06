# @felan-ai/ext-background-bash

Detached project-local Bash execution for Felan sessions. The extension augments
`bash` with `background: true` and adds tools to list, wait for, and stop processes.
Output and process metadata live under
`<runtime-storage>/background-bash/<workspace-key>/jobs`. Local Felan maps
`<runtime-storage>` to `$FELAN_AGENT_DIR` (`~/.felan` by default), while cloud
adapters map it to their durable state root.

The implementation routes filesystem and process operations through the active
`AgentRuntime`. Background launch uses a detached POSIX shell runner. Host,
Docker, and Daytona runtimes need `nohup`, `ps`, and either `setsid` or shell job
control so each process receives an isolated process group. `runtime.storage.root`
must be durable and visible in the same filesystem namespace as `runtime.shell`.

The extension activates for selected models outside the OpenAI provider family.
Providers `openai` and `openai-codex` are reserved for a separate background Bash
extension. Keeping this policy here gives cloud and local consumers identical
behavior without duplicating model filters in their composition roots.

## Tools and controls

- `bash({ command, background: true })` starts a detached process.
- `list_background_bash` lists workspace processes and statuses.
- `read_background_bash` reads trailing process output.
- `wait_background_bash` waits for terminal status without returning log output.
- `stop_background_bash` sends `SIGTERM` or `SIGKILL`.
- `/background-bash` and `Ctrl+Shift+J` open the interactive process/log overlay in the TUI.

The footer status shows the number of running processes. Foreground `bash` continues
to use the active `AgentRuntime`. Processes started by the active session deliver a
completion message automatically. The message steers an active run at its next
model-call boundary or triggers a turn when the agent is idle. A terminal result
returned directly by `list_background_bash`, `read_background_bash`,
`wait_background_bash`, or `stop_background_bash` suppresses the duplicate
completion message.

## Development

Source: `packages/ext-background-bash` in <https://github.com/felan-ai/felan>.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @felan-ai/ext-background-bash build
pnpm --filter @felan-ai/ext-background-bash test
```

## Attribution

This package adapts the MIT-licensed `pi-background-bash` implementation. See
[NOTICE](NOTICE) for source details.
