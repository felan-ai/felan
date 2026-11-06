# ADR 0047: Run foreground Bash in-process

> Status: Accepted
> Date: 2026-11-06
> Deciders: Felan maintainers
> Related: [ADR 0002](0002-share-bash-process-surface.md),
> [background Bash](../../packages/ext-background-bash/README.md)

## Context

Using a detached runner for every foreground command requires per-command files,
a shell runner, a heartbeat, and 500 ms status polling. Commands that finish
within the foreground window already return their output to the session
transcript. Their job records duplicate that history.

The shared Bash contract still needs bounded foreground waiting and promotion
without restarting the command. The daemon must retain ownership of live
children so shutdown can stop them.

## Decision

Run non-PTY foreground commands through `runtime.processes.startShell` as
in-process children. Do not create a job record before timeout promotion. The
daemon tracks each child as a `foreground` process. Return the last 2000 lines /
50 KB of output. Write larger output in full to
`<session-storage>/background-bash/<workspace-key>/output/output-*.log` and keep
the newest 20 spill files.

When the command exceeds its timeout, adopt the same child into a background
job with `executionMode: 'attached'`. The default timeout is 120 seconds,
configured by `extensionConfig.backgroundBash.foregroundTimeoutSeconds`.
Promotion creates an `output.log` and a record for `list_background_bash`,
`/processes`, and completion messages. Attached jobs stop when the session that
started them closes (for a subagent, when that subagent closes) or reloads,
record `killed` when stopped, and are never reattached. Cancelling a turn does
not stop them. The daemon's run cancellation only stops user `shell.execute`
processes, and the `bash` tool's abort signal stops a command that is still in
the foreground.

A shell process counts as finished when the shell exits. If a background
descendant (`cmd &`) keeps the output pipes open, the host runtime waits at most
500 ms after the shell exits before completing.

Keep durable detached records for non-PTY commands with `background: true` or
`timeout: 0`. Keep PTY records from the start for `tty: true`, since the daemon
registers the PTY under its job ID and needs the record before launch. Detached
jobs survive restarts when their runtime storage persists; PTYs remain
root-session-scoped.

## Alternatives considered

- Keep the detached runner for every foreground command. Rejected because it
  keeps per-command files, the runner, the heartbeat, and 500 ms polling for
  commands that need no durable record.
- Kill the command at timeout. Rejected because it loses promotion without a
  restart and interrupts work that should continue in the background.

## Consequences

- Short foreground commands create no background job history. Their output
  remains in the session transcript, with spill files only for larger output.
- Promotion changes visibility, not process lifetime. Attached jobs have no
  stdin; interactive commands must start with `tty: true`.
- The daemon keeps the original `foreground` process registration and ignores
  the attached job record. The TUI footer excludes foreground processes,
  including promoted commands.
- Attached jobs append new output to `output.log` and release their in-memory
  handle once their final status is written. Disposed host processes release
  their output buffer.
- Retention accepts runner completion times truncated to whole seconds, even
  when the millisecond start time is later within that same second. Matching
  terminal records and process-absence checks still apply.
