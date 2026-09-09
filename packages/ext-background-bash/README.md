# @felan-ai/ext-background-bash

Provider-neutral project-local Bash execution for Felan sessions. The extension augments
`bash` with explicit backgrounding, bounded foreground waiting, optional PTY input,
and adds tools to list, read, wait for, write to, and stop processes.
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

The same process surface is available to every selected model. Model-specific
policy belongs to the model-facing prompt/tool composition, not to process
ownership or runtime capability checks.

This release requires `@felan-ai/agent-core` `^0.6.1` because it uses the
runtime's explicit POSIX shell flavor.

## Tools and controls

- `bash({ command, background: true })` starts a detached process.
- `bash({ command, timeout: 120 })` waits in the tool, then promotes the same process without restarting it.
- `bash({ command, timeout: 0, tty: true })` starts an interactive PTY immediately.
- `write_background_bash({ id, chars })` sends exact stdin/control bytes to a PTY job.
- `list_background_bash` lists workspace processes and statuses.
- `read_background_bash` reads trailing process output, capped at 128 KiB of log content. Larger files use POSIX `tail` without loading the whole log.
- `wait_background_bash` waits for terminal status without returning log output.
- `stop_background_bash` sends `SIGTERM` or `SIGKILL`.
- `/processes` and `Ctrl+Shift+J` open the interactive process/log view inline in the TUI.

The process/log view uses an inline frame. Automatic completion messages use a
compact one-line summary; `Alt+A` reveals bounded details.

The default foreground promotion window is 120 seconds and can be changed with
`extensionConfig.backgroundBash.foregroundTimeoutSeconds`. Cancelling a foreground
wait terminates its process tree; cancelling a wait for an already-backgrounded job
does not terminate that job. Detached jobs remain discoverable after restart when
their runtime storage persists. PTY handles are root-session-scoped and are not
reattachable after shutdown. The footer status shows the number of running processes.
Live PTY status comes from its root-session handle, not detached-runner PID probes.
Status reads and input remain available while another caller waits in the foreground.
Terminal outcomes and completion timestamps are recorded once. An orphaned PTY is
reported as `unknown`; its stored PID is not used to reattach or signal a process.
Processes started by the active session deliver a
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

Hosts provide the `AgentRuntime`; the local TUI owns the process view,
shortcut, status polling, and dependency onboarding. Compatible runtimes need
the POSIX shell/process facilities listed in
[runtime dependencies](../../docs/reference/runtime-dependencies.md). Felan
does not install operating-system utilities, and the feature remains inactive
when they are unavailable.

The extension owns detached job records, logs, lifecycle, PTY controls, and the
six model-facing process controls. It does not provide a sandbox.

## Related documentation

- [Commands and shortcuts](../../docs/user-guide/commands-and-shortcuts.md)
- [Runtime dependencies](../../docs/reference/runtime-dependencies.md)
- [Runtime and security](../../docs/concepts/runtime-and-security.md)
