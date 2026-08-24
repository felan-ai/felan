# @felan-ai/ext-background-bash

Detached project-local Bash execution for Felan sessions. The extension augments
`bash` with `background: true` and adds tools to list, wait for, and stop processes.
Output and process metadata live under
`<session-storage>/background-bash/<workspace-key>/jobs`. Local Felan maps
`<session-storage>` to
`$FELAN_AGENT_DIR/storage/sessions/<encoded-root-session-id>`, while cloud
adapters map it to their root-session state path.

The implementation routes filesystem and process operations through the active
`AgentRuntime`. Background launch uses a detached POSIX shell runner. Host,
Docker, and Daytona runtimes need `nohup`, `ps`, `sleep`, and either `setsid`
or shell job control so each process receives an isolated process group. The extension
captures `runtime.storage('session')` once; that handle must be
durable and visible in the same filesystem namespace as `runtime.shell`.
It requests the explicit POSIX shell flavor for probing and execution, then
leaves its tools inactive when the runtime is incompatible. On native Windows,
`HostAgentRuntime` discovers a same-host Git Bash installation through
`FELAN_POSIX_SHELL`, `PATH`, or standard Git-for-Windows locations. WSL is not
selected automatically because its path and process namespace does not match
the host runtime. Git Bash's process tools use its `ps -l` format when GNU
`ps -o` is unavailable. The local TUI can persistently disable the extension
through dependency onboarding; Felan does not install operating-system
utilities.

The extension activates for selected models outside the OpenAI provider family.
OpenAI and OpenAI Codex sessions use the separate Codex-specific process
surface instead. Keeping eligibility here gives cloud and local consumers
identical behavior without duplicating model filters in their composition
roots.

This release requires `@felan-ai/agent-core` 0.4.11 or newer within the 0.x
compatible-minor range because it uses the runtime's explicit POSIX shell
flavor.

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
pnpm --filter @felan-ai/ext-background-bash type-check
pnpm --filter @felan-ai/ext-background-bash test
```

## Attribution

This package adapts the MIT-licensed `pi-background-bash` implementation. See
[NOTICE](NOTICE) and [LICENSE](LICENSE) for source details.

## Composition and requirements

```ts
import backgroundBashExtension from '@felan-ai/ext-background-bash';

const extension = backgroundBashExtension;
```

Hosts provide the `AgentRuntime`; the local TUI owns the process overlay,
shortcut, status polling, and dependency onboarding. Compatible runtimes need
the POSIX shell/process facilities listed in
[runtime dependencies](../../docs/reference/runtime-dependencies.md). Felan
does not install operating-system utilities, and the feature remains inactive
when they are unavailable.

The extension owns detached job records, logs, lifecycle, model eligibility,
and the five model-facing process controls. It does not provide a sandbox.

## Related documentation

- [Commands and shortcuts](../../docs/user-guide/commands-and-shortcuts.md)
- [Runtime dependencies](../../docs/reference/runtime-dependencies.md)
- [Runtime and security](../../docs/concepts/runtime-and-security.md)
