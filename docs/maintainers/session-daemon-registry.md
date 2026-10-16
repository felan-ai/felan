# Daemon registry and runtime ownership

`SessionRegistry` owns canonical session bindings, admission-facing state,
descendants and process lifetime. It receives the same held `DaemonOwnership`
and `DaemonControlStore`, a `SessionLifecycle` and a session-services factory.
The caller settles the registry and all writers before closing storage or
releasing ownership. A failed cleanup never grants permission to release a
live writer.

## Sessions and execution

- Create, restore, fork, clone and import go through the configured lifecycle.
  Providers supply composition; the registry validates canonical IDs, paths,
  roots and configuration identity before activation.
- Attach and detach affect client bindings only. Last detach does not stop
  session execution, children, memory work or processes.
- Admitted runs persist dispatch intent before effects. Recovery does not
  replay prompts, shell commands or already-dispatched continuations.
- Cancel interrupts the addressed run. Close settles the session and its
  descendants while preserving history and independent detached jobs.
- Idle eviction releases only eligible resident bindings. Running work,
  registered lifecycle services and unresolved resources prevent eviction.
- Shutdown drains bindings and writers without turning a normal detach into
  cancellation or treating a failed settlement as success.

A failed shutdown leaves admission closed and ownership held. The host may retry
with explicit force only before release and without a registry fence. Shutdown
errors retain a typed step and session ID. Retried cleanup skips removed bindings,
removes each service only after successful settlement/disposal, and records
runtime disposal before later writer or projection steps. Interrupted run
identities survive failed forced attempts. Failure in binding disposal still
fences the registry and is not retryable; a failed shutdown never reopens it.

Children use the core Sessions service and are registered before dispatch, so
queued work is visible and cancellable. Execution metadata lives on the canonical
child session; results and usage come from its transcript. The daemon schedules
these sessions under the configured concurrency and depth limits. There is no
separate execution store or mirrored child resource. Recovery marks unfinished
executions interrupted rather than replaying them. Continuation retains the same
session identity and transcript.

Clients inspect and control authorized executions through `executions.*`. Local
providers configure limits and deliver completion notices to the parent; they do
not own a scheduler, execution inventory or results. Providers receive restricted
operations, never the unrestricted registry.

## Runtime and process identity

`wrapOpeningRuntime` scopes runtime operations to the opening session and its
root storage identity. The real session identity is bound before extension
activation. Drain rejects new effects, joins admitted work and revokes retained
handles only after their users settle.

`RegistryProcesses` wraps process, terminal and storage ports. A stored PID or
terminal status is not proof of ownership or exit. Live PTYs retain their
process handles; restored records cannot recreate a PTY or authorize signals
to an arbitrary PID. Detached jobs require verified identity. Closing one child
must not stop sibling processes. Process reads and control continuations join
the same lifetime barriers as launches and writes.

PTYs and foreground shells end with the daemon; detached jobs outlive it, and a
restored root refreshes their records against verified identity, while live
records left running by a previous daemon become interrupted. A failed probe of
one process leaves its record unchanged; store or ownership failures during
that refresh fence the registry. `activeWork` (and `host.status` `active.work`)
therefore counts busy sessions, in-flight runtime operations and live
non-transport processes, not detached jobs. It first probes unsettled live
handles, so a PTY that exited unread no longer counts. Shutdown settles every
root that still holds live handles, including PTYs kept by a failed reload.

## Projection and UI

Session projection consumes actual Pi events and entries. Durable revisions
commit before publication; token deltas remain streaming data. History pages
pin session, revision and branch. Clients resnapshot after gaps rather than
inventing missing entries or model metadata.

The registry publishes generic UI and binds validated actions to their owning
session. Client hints are optional display enhancements; they do not grant
execution authority. See [Services and UI](extension-services-and-ui.md).

## Verification

Run daemon and client tests through `scripts/test-isolated.sh`; run
`scripts/test-isolated.sh pnpm verify` for integration and packed-install checks.
