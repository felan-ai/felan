# ADR 0048: Authenticate Windows daemon IPC with a private secret

> Status: Accepted; implemented
> Date: 2026-11-13
> Deciders: Felan maintainer
> Related: [native ownership](../maintainers/session-daemon-native-ownership.md),
> [ADR 0022](0022-shared-daemon-launch-environment-and-explicit-lifetime.md)

## Context

Native Windows clients need the same persistent daemon as macOS and Linux.
Node's named-pipe API does not expose peer token checks or a custom pipe DACL.
The daemon already uses Koffi for account SID and filesystem DACL checks, but
owning Win32 pipe I/O would also require native connection and handle management.
Neither TCP nor heartbeat leases meet the local ownership contract.

## Decision

Use Node named pipes with mutual HMAC-SHA256 authentication before handing a
connection to the session protocol. Each launch generates a random pipe name
and a 32-byte secret. The daemon publishes both in `ipc-endpoint.json` inside
its private runtime directory. Production uses the OS account profile's
`AppData\Local\felan-daemon-v1\production`, not a path chosen by environment
variables.

Koffi reads the process token SID and validates filesystem owners and DACLs.
Private paths permit only that SID, SYSTEM and Administrators. The client pins
the runtime directory chain and endpoint file, validates the bounded endpoint,
authenticates the server and rechecks path identities. Fresh client and server
nonces and role-specific proofs prevent replay and reflection. Authentication
has a default two-second deadline; failures destroy the connection. The secret
never enters the launch environment, logs or protocol frames.

Retain exclusive-share file handles for Windows lifetime locks. Keep POSIX
`flock`, Unix socket permissions and kernel peer-UID authentication unchanged.
There is no lease-lock, TCP or POSIX-emulation fallback.

## Alternatives considered

- Native Win32 pipes through Koffi, with a restricted DACL and client/server
  token SID checks. This would enforce account access at pipe open and allow
  explicit impersonation limits, but requires native overlapped I/O, handle
  transfer and cancellation code beyond the existing filesystem bindings.
- WSL-only support. This avoids a Windows adapter but cannot attach native
  clients or share their process and path namespace. WSL remains an alternative
  Linux environment, not an automatic transport fallback.

## Consequences

- Node retains the pipe's default DACL. Other local accounts may open read-only
  connections but cannot authenticate without the secret. The 64-connection cap
  counts pending handshakes, and timeouts release them; local denial of service
  remains possible.
- Client pipe opens do not impose `SECURITY_IDENTIFICATION`. The handshake does
  not remove Windows named-pipe impersonation risk. A client checks that another
  process holds the namespace lifetime lock with a shared read probe before
  opening the pipe. A successful open means the endpoint is stale. Concurrent
  shared probes do not exclude each other. Each acquisition sets a random mtime
  through the exclusive lock handle. Endpoint version 2 records that generation
  as `lockStamp`, which must match the lock's nanosecond mtime. Startup validates
  privacy and removes any old endpoint immediately after taking the lock,
  without parsing its contents or contacting its pipe. A fenced daemon rejects
  connections but keeps its pipe bound until its lock handles close. A normal
  close removes the endpoint before releasing the pipe name. An in-process
  guard rejects repeated listeners for the same owner.
- The lock probe and pipe open are not atomic. A microsecond-scale race remains
  if the daemon exits after the checks, or another daemon's brief exclusive
  claim probe or an exclusive third-party handle makes the lock appear held.
  Generation checks reject an older endpoint during startup, but cannot prove
  the identity of every exclusive handle holder.
- The endpoint records the daemon token's elevation state. A non-elevated
  client refuses an elevated daemon before opening its pipe and tells the user
  to stop it with `felan daemon stop` from an elevated terminal or run Felan
  elevated. Launching from an elevated client makes the daemon elevated too.
  An elevated client may attach to a non-elevated daemon, so medium-integrity
  same-user code that can read the endpoint secret may serve that client.
  Authentication does not establish the server's integrity level. The default
  pipe DACL is never widened to let medium-integrity code control an elevated
  daemon.
- Administrators and SYSTEM can read the secret. Same-account code can too.
  This authenticates access to the private endpoint, not trusted client code,
  and does not sandbox tools or defend against a compromised account.
- Windows CI covers x64 and arm64 daemon behavior under an elevated
  Administrator account. It does not cover a standard non-admin account or
  interactive console-window behavior.
