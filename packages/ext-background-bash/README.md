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
`ps -o` is unavailable. Host dependency configuration can disable the extension
when the runtime is incompatible; Felan does not install operating-system
utilities.

The same process surface is available to every selected model. Model-specific
policy belongs to the model-facing prompt/tool composition, not to process
ownership or runtime capability checks.

This release requires a compatible `@felan-ai/agent-core` release because it uses the
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
- `/processes` opens the generic process list and output documents through `pi.ui`.
- Felan's TUI provides `Ctrl+Shift+J` and an inline process/log view.

The native TUI process/log view uses an inline frame. Its completion messages use
a compact one-line summary; `Alt+A` reveals bounded details.

The default foreground promotion window is 120 seconds and can be changed with
`extensionConfig.backgroundBash.foregroundTimeoutSeconds`. Cancelling a foreground
wait terminates its process tree; cancelling a wait for an already-backgrounded job
does not terminate that job. Detached jobs remain discoverable after restart when
their runtime storage persists. PTY handles are root-session-scoped and are not
reattachable after shutdown. The native TUI footer shows the number of running processes.
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

The default export keeps execution in the active runtime and uses the package-owned
generic `pi.ui` adapter for presentation. It uses the host-owned
`runtime.terminals.attach(id)` handles when available, preserving process lifetime
across client detachment. Otherwise it owns the terminals it starts. No
extension-specific service is required.

`createBackgroundBashExtension()` exposes the same portable composition. Native
rendering belongs to `apps/felan`; this package exports no TUI entrypoint.

The generic adapter uses the normalized `./data` records, with at most 18 job summaries
per page. It publishes a `view` with declared navigation and read actions, and a
`document` for each selected process's output. Logs retain the existing bounded
tail (up to 2,000 lines and 128 KiB), split into encoded-byte-bounded chunks. Every
chunk and saved job is reachable through explicit paging actions. Command previews
are marked when clipped, and output is escaped as literal Markdown. No custom
presenter or hidden payload is needed; PIDs, process tokens, paths, and runtime
handles are not control inputs or presentation metadata.

Output documents declare stop and kill controls only for running processes, and
an exact-byte stdin field only for running PTY processes with a write callback.
The normalized presentation source's optional `write(id, chars)` callback delegates
to the same manager used by `write_background_bash`. Controls recheck current job
state before execution. Actions are serialized across the list and output document,
and their element identity, revision, target, and input are validated again at execution.
Stale, closed, foreign, or malformed actions cannot invoke a process control.

Opening a generic view returns after publication; the command does not wait for
user input. Closing or cancelling a view blocks new actions, joins pending reads
and controls, and closes its handles without stopping any process. Shutdown awaits
that cleanup while preserving the coordinator ownership policy. Cleanup failures
remain observable. Refresh is explicit; the generic adapter installs no overlay,
shortcut, or UI polling in any client. Execution's existing completion delivery is
unchanged.

Hosts provide the `AgentRuntime` and common UI binding; the optional local TUI owns
native shortcuts and status polling. Trusted providers own dependency policy,
not the client renderer. Compatible runtimes need
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
