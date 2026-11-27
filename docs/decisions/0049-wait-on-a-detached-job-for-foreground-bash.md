# ADR 0049: Wait on a detached job for foreground Bash

> Status: Accepted
> Date: 2026-11-26
> Deciders: Felan maintainers
> Supersedes: [ADR 0047](0047-run-foreground-bash-in-process.md)
> Related: [ADR 0002](0002-share-bash-process-surface.md),
> [background Bash](../../packages/ext-background-bash/README.md)

## Context

ADR 0047 ran foreground commands as in-process children and promoted a child
that outlived its timeout to an `attached` job. An attached job belongs to the
daemon process that started it. A daemon restart loses it: the job then reads
`unknown`, the agent never receives its finish notice, and while it runs the
daemon counts it as interruptible work, which blocks an idle host update.
Hosts that update by restarting the daemon need promoted commands to survive
that restart.

## Decision

Start every non-PTY foreground command as a detached job, the same runner that
`background: true` uses, and wait on it from the tool call. While the call
waits, the record's `foreground` field holds a random token for the waiting
process, so `list_background_bash`, `/processes` and the daemon do not list it.
A session start promotes a foreground job whose token belongs to an earlier
process, because its tool call ended with that process. A job that finishes in time is removed unless its
output exceeds 2000 lines or 50 KB; the result then names the job's
`output.log` and the record stays unlisted until retention removes it. At the
timeout, promotion clears `foreground` and records `promotedAt`. The process
and its output file are unchanged, so nothing is converted.

Each non-PTY job records `notice` (`pending` or `delivered`) and the
`noticeSession` that receives it, with a marker file indexing pending notices.
A session start watches every job that still owes it a notice and delivers the
notice once for each finished job, as a steering message that triggers a turn.
The daemon copies the pending flag to its resource row, and startup recovery
restores each open root session with a running detached job or a pending
notice.

## Alternatives considered

- Convert a live attached process into a detached job at promotion. Rejected
  because the child still belongs to the daemon process that spawned it; its
  pipes and process group cannot be handed to a runner that outlives the daemon.
- Keep attached promotion and hold the restart until promoted commands finish.
  Rejected because a long command would block updates for hours.

## Consequences

- Every foreground command writes a short-lived job directory, which ADR 0047
  avoided. A command that finishes in time with small output costs two
  `runtime.shell` calls, against four process calls under ADR 0047. One call
  writes the directory and launches the runner. The other waits inside the
  runtime in slices of at most 25 seconds, so a long command adds one call per
  slice. The wait checks the completion file every 10 ms, then every 30 ms
  after 0.2 s, and returns the output and deletes the job in the same call.
  Output over 16 KB or 2000 lines is read and removed through storage
  afterwards.
- On a local macOS host, `echo hi` takes 40 to 50 ms against about 3 ms under
  ADR 0047, and the result arrives a median of 25 to 28 ms after the command
  exits. Spawning the runner and writing its completion file take most of that
  time. On a remote runtime the two round trips dominate.
- Each command counts as a job-store mutation, so retention scans a batch every
  32 commands.
- A background descendant (`cmd &`) no longer delays a foreground result.
- Promoted commands survive session reload, subagent close and daemon restart,
  and no longer count as daemon work after their run ends.
- A forced stop aborts the tool call, which stops its foreground job. A crash
  leaves the job running, unknown to the daemon, so recovery does not restore
  its session; the next start of any session in that storage promotes it, and
  its own session's next start delivers its notice.
- Child-session notices are not restored by the daemon, because a turn in an
  orphaned subagent session has no reader. PTY jobs keep in-memory notices.
