# ADR 0030: Launch daemon replacements from clients

Status: Accepted

## Context

Every session shares the daemon's launch environment. Restarting by forking the
old daemon would retain that environment even when the user explicitly restarts
from a shell with different provider or process settings.

## Decision

A confirmed restart drains and stops the old instance. The requesting client
then launches the installed replacement under its own environment and verifies
its identity. No environment values are transported or persisted. If the client
leaves mid-restart, the operation may stop without launching a replacement;
clients must report that outcome rather than claim a completed restart.

The launcher may wait briefly for the specifically identified draining owner's
kernel locks to be released. It never signals a stored PID, waits on a different
live instance, or weakens canonical target checks.

## Alternatives considered

- Daemon self-restart preserves the wrong environment.
- Sending an environment map introduces an unnecessary credential-bearing
  provisioning contract and contradicts the shared launch-environment boundary.
- Ignoring the old owner's identity can wait on or confuse an unrelated instance.

## Consequences

Stop/restart require explicit consent, with separate consent to force interruption.
Status and logs never start a daemon. A replacement needs a new verified client
binding; an old pinned connection cannot silently accept a different instance.
