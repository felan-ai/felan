# ADR 0028: Retain session-scoped launch options

## Context

CLI extension overrides and explicitly selected extension paths belong to the
session they start, not to global settings. Moving execution into a daemon must
not silently write these values globally or forget them during idle eviction.
Multiple attached clients must observe one execution configuration.

## Decision

Retain bounded, validated profile options with the daemon's session metadata.
Restore and fork use those options without copying environment variables or
credentials. A session configuration update requires an admitted, quiescent
reload; it cannot race a running turn or weaken the independent approval policy.
The configuration intent and dispatch marker commit before runtime replacement.
Failed activation remains visible and can require another explicit reload.
Profiles validate requested overrides against their declarations before dispatch,
without binding extensions or starting runtime work.

Only the existing public extension configuration fields are accepted from the
wire. Global model defaults retain their separate global operation. The client
does not interpret plugin execution configuration or modify host settings files.

Attaching to an existing session does not replace its executable extension paths.
Those paths are retained from creation; a different path set requires a new
session. This prevents an attachment from silently changing code for other clients.

This choice preserves existing session-scoped behavior under the user's
instruction to decide unspecified details without further questions.

## Alternatives considered

- Global writes would unexpectedly affect other sessions and future launches.
- Memory-only overrides would disappear on an internal idle eviction or restart.
- Reusing environment transport would violate the shared launch-environment
  boundary and risk exposing credentials.

## Consequences

Profile options participate in the existing control-store size accounting and
durability rules. They are not emergency writes. Old rows without profile
metadata keep their previous defaults. Release and downgrade checks must account
for the added metadata; an older binary must not be assumed to preserve it.
