# ADR 0046: Attach clients to compatible daemon builds

> Status: Accepted; implemented
> Date: 2026-10-30
> Deciders: Felan maintainer
> Related: [daemon contracts](../maintainers/session-daemon-contracts.md),
> [ADR 0036](0036-configure-extension-services-through-trusted-providers.md)

## Context

The client required an exact `daemonVersion` match and identical
`providerDigest` and `managerVersion`. The provider digest includes the manager
version and resolved module URLs, so a build change can look like a
configuration change. Version bumps make a running daemon unusable for new
sessions and force a restart that interrupts every session. This is routine
when Felan is linked to the repository.

The session protocol is explicitly additive within `PROTOCOL_VERSION = 1`:
operations are advertised, `interactionKinds` and `capabilities` are enumerated,
and unknown fields are stripped. A build difference is not itself a protocol
incompatibility.

## Decision

Attachment requires a compatible wire protocol and authenticated target identity,
not matching installed builds or host configuration. Differences in manager
package, manager version, providers or configuration never block attachment.
Missing composition metadata is also allowed. Protocol and target identity
mismatches remain blocking; never automatically replace an incompatible-protocol
daemon.

Daemon version, manager package/version and provider digest differences produce
a warning naming the installed and running daemon versions and `/restart`.
Sessions keep running the daemon's build and configuration. The configuration
digest remains informational. Only an initial, launch-capable connection without
an explicit expected daemon identity may transparently refresh a provably idle
daemon when its daemon version differs. Composition differences alone never
trigger replacement. An unknown active-work count is not proof of idleness.

Established clients' automatic and manual reconnects never replace compatible
builds, even when idle, so one client cannot undo another client's restart.
Callers without launch authority or with an explicit expected identity also
attach to compatible idle builds with the warning.

## Alternatives considered

- Keep exact version equality: blocks routine development and forces restarts
  that interrupt unrelated sessions.
- Require matching host configuration: unnecessarily prevents clients from using
  a running daemon; composition is diagnostic, not an attachment boundary.
- Negotiate a semantic version range: needs a compatibility policy per release
  with no current consumer.
- Fingerprint built daemon code: would flag rebuilds without a version bump,
  but no cheap reliable fingerprint is available at connect time. Retain this
  as a known limitation and possible future work.

## Consequences

- A client may drive an older daemon. Missing operations surface as explicit
  per-operation rejections.
- Older same-protocol daemons can accept new clients regardless of provider
  selection or whether composition metadata is present.
- A rebuild that does not change the version is still not detected.
- `providerDigest` keeps its `restartRequired` meaning for host configuration
  changes. It does not restrict client attachment.
