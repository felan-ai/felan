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
felan daemon stop --yes
felan daemon restart --yes
felan daemon stop --yes --force
```

Status and logs never start a daemon. Start attaches to an existing compatible
instance or launches the exact installed daemon package. Foreground remains
attached to the service process. Exiting a normal TUI or completing a client
request does not stop the daemon.

`--daemon-runtime <dir>` selects an explicit private test/CI namespace, not an
environment-derived alternative target. Custom external session stores must be
declared with `--session-dir`; canonical root-set checks are not weakened.

The TUI provides `/daemon status`, `/daemon logs`, `/daemon stop`, and
`/daemon restart`. Adding `force` requires a second confirmation. Restart creates
a new protocol client and reattaches the selected session ID without resending
old prompts or applying session configuration again. Local drafts remain local.

## Shutdown and replacement

Graceful shutdown rejects new work, defers eligible questions and waits for
accepted work. It does not silently become a forced stop. If its deadline expires
or long-lived resources remain, the service reports `blocked` and keeps ownership.
An explicit force request cancels and joins owned work, verifies process
settlement and persists interrupted run identities before ownership release.

The requesting client launches a replacement after the old daemon stops. This
uses the requesting shell's environment; no environment map is transmitted or
persisted. An identity-pinned, bounded handoff handles the short interval between
endpoint closure and kernel-lock release. A failed replacement is reported, not
silently retried. See [ADR 0030](../decisions/0030-launch-daemon-replacements-from-clients.md).

A version mismatch preserves the verified control identity but refuses session
traffic. Replacement requires explicit consent. SIGINT/SIGTERM request graceful
shutdown; they are not implicit permission to interrupt other clients' work.

## Recovery and diagnostics

Unknown foreground/PTY or detached process records after a crash are not proof
that the processes exited. Such recovery is blocked pending operator
reconciliation. Force never signals an arbitrary stored PID. Do not remove lock
files, reset control state or overwrite the claim ledger to force access.

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
