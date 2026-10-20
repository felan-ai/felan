# ADR 0041: Retry incomplete daemon shutdown explicitly

## Status

Accepted.

## Context

A shutdown can fail after session admission has closed but before its processes,
services and writers have settled. Reopening admission is then unsafe. Keeping
ownership without recording the cause leaves clients unable to distinguish an
active drain from a failed cleanup or choose a safe recovery action.

## Decision

An incomplete shutdown keeps ownership and records a bounded, redacted cause,
failure step, optional session, timestamp and daemon PID. Status and control
responses expose that record while blocked; operational and stderr logs retain
diagnostics. The daemon refuses new work explicitly with `host_blocked` but
keeps the drain safety and management operations available. A repeated drain
request is rejected without starting settlement again.

Only an explicit force request may retry remaining cleanup, and only while
ownership is current, the registry is not fenced, and release has not started.
Completed sessions and services are skipped; failed cleanup is retried, never
assumed successful. A second failure replaces the recorded cause. Ownership
loss, idle-eviction failures, release failures and a settlement deadline with
unfinished cleanup are not safely retryable and require force-terminating the
daemon process: SIGTERM requests a drain, which a blocked daemon refuses. A drain abandoned before registry shutdown may still reopen admission.

Stable diagnostic steps are `begin-drain`, `setup-drain`, `broker-drain`,
`drain-wait`, `server-commands`, `providers-settle`, `release`, `ownership-lost`,
`idle-eviction`, `settlement`, `settlement-deadline`, `management-response`,
`registry-pending`, `registry-fenced`, `live-roots` and `retained-services`.
Per-session steps are `session-cancel-views`, `session-interactions`,
`session-host-shutdown`, `session-abort`, `session-cancel-foreground`,
`session-writers`, `session-processes`, `session-services`, `session-runtime`,
`session-run`, `session-dispose` and `session-close`. These identify boundaries, not a promise
that third-party cleanup is transactional.

## Alternatives considered

- Release ownership after a bounded retry. Rejected: stray processes, terminals
  or writers could remain live without their owner, allowing a replacement to
  race them.
- Retry automatically. Rejected: force interrupts work and requires explicit
  consent; release failures may leave resources half-closed.
- Require process termination after every failure. Rejected: a transient
  settlement failure can safely finish through the existing owner when its
  cleanup has not crossed the release boundary.

## Consequences

- Clients can explain the failure and offer force only when safe. They must not
  treat a previously accepted stop as proof that ownership was released.
- Successful cleanup steps must remain repeat-safe; services leave the pending
  set only after settlement and disposal both succeed.
- Diagnostics are best effort. Ownership fencing or an already closed sink can
  prevent log writes; the blocked record is retained in memory nonetheless.
- Unrecoverable failures retain ownership until the process is terminated;
  they are never hidden by a successful-looking restart.
