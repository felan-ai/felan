# Local daemon service lifecycle

The daemon package entrypoint now starts the owned service when executed by the
installed launcher. Importing the package does not start a daemon. The service
owns the control store, session registry, interaction broker, descendants and
execution lifetime. Configured providers from the managing package own local
credentials, model configuration, settings and runtime composition.

## Commands

```text
felan daemon status
felan daemon start
felan daemon foreground
felan daemon logs
felan daemon stop
felan daemon restart
felan daemon stop --force
```

Status and logs never start a daemon. Start attaches to an existing compatible
instance or launches the exact installed daemon package. Foreground remains
attached to the service process. Exiting a normal TUI or completing a client
request does not stop the daemon.

`--daemon-runtime <dir>` selects an explicit private test/CI namespace, not an
environment-derived alternative target. A custom session directory, from
`settings.json` or `--session-dir`, becomes an owned store root when a session
first opens there: the daemon takes its kernel store lock and records it in
`daemon-store-roots.json` so persisted sessions stay addressable after restart.
Only a directory that overlaps the runtime directory, leaves an isolated fixture
or is locked by another live daemon is refused.

The TUI provides `/daemon status`, `/daemon logs`, `/daemon stop`, and
`/daemon restart`. They confirm once, only when active work would be interrupted,
and then request force. Restart creates
a new protocol client and reattaches the selected session ID without resending
old prompts or applying session configuration again. Local drafts remain local.

## Shutdown and replacement

Graceful shutdown rejects new work, defers eligible questions and waits for
accepted work. Drain never escalates to force. If it fails or misses its
deadline (30 seconds by default), the drain is abandoned: admission reopens, the
daemon returns to `ready` and keeps serving, and the stop or restart is reported
as failed. Only an explicit force request cancels and joins owned work, verifies
process settlement and persists interrupted run identities before ownership
release. A forced settlement that fails or misses its deadline reports `blocked`
and keeps ownership.

`host.status` reports `active.work`: busy resident sessions (including child
executions), running background processes of resident roots, and unanswered host
questions. This is the work a restart would interrupt. Clients use it instead of
`active.runs` to decide whether a confirmation is needed.

The requesting client launches a replacement after the old daemon stops. This
uses the requesting shell's environment; no environment map is transmitted or
persisted. An identity-pinned, bounded handoff handles the short interval between
endpoint closure and kernel-lock release. A failed replacement is reported, not
silently retried. See [ADR 0030](../decisions/0030-launch-daemon-replacements-from-clients.md).

A daemon from another installed version or provider configuration is replaced
automatically by a client that can launch the daemon when `active.work` is zero.
Otherwise it stays connected only for control; the TUI asks before a forced
replacement, and other clients report the mismatch. SIGINT/SIGTERM request graceful
shutdown; they are not implicit permission to interrupt other clients' work.

## Recovery and diagnostics

Unknown foreground/PTY or detached process records after a crash are not proof
that the processes exited, but they do not block startup, new work or shutdown.
Force never signals an arbitrary stored PID. Stale claim-ledger entries (whose
lifetime lock is gone or no longer held) are discarded, and an unreadable ledger
is rebuilt. Control-store recovery follows
[persistence](session-daemon-persistence.md): inconsistent rows are dropped
individually, and only a corrupt or foreign file is quarantined.

Operational logs are bounded rolling tails of fixed, sanitized events. They do
not contain prompts, environment values, credentials or arbitrary provider
errors. Agent log writes are tracked and joined before ownership release.
Server-owned requests, including global settings writes, are also joined.
Final shutdown seals new commands before the control store is closed; waiting
only for session turns is not a complete writer barrier.

Session activation occurs after its full registry binding exists; startup
services never receive a fabricated AgentSession. Memory processing drains
without abort during graceful shutdown. See
[ADR 0029](../decisions/0029-activate-daemon-services-after-registration.md) and
[the current provider lifecycle](extension-services-and-ui.md).

## Verification scope

Run daemon and client tests through `scripts/test-isolated.sh` with the pinned
Node/pnpm toolchain; run `scripts/test-isolated.sh pnpm verify` for integration.
The pre-services S1.15 baseline used disposable mount-free containers and
recorded 3,941 passing assertions with 3 declared skips across
352 file executions; literal `pnpm verify` passed. Daemon-only packaging covered
27 packages without the client, and two foreground start/stop/ownership cycles
passed. The evidence includes native ownership release, startup/foreground
commands, shared environment before/after restart, forced foreground settlement,
version/consent handling, preserved session IDs, log bounds, memory drain, and
blocked recovery.

Three user-approved historical test exceptions remain unfixed and are bounded
known risks. Linux arm64 is verified only to the documented focused/container
scope; Windows remains deferred and untested. This is not publication evidence
or independent review evidence.
