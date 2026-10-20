# ADR 0026: Deliver host and transient interactions without session revisions

## Context

Host setup prompts have no session revision. OAuth presentation must not persist URLs or transient credentials in control snapshots. Ordinary session questions already use the durable, revisioned session stream.

## Decision

Use a separate interaction notification for host-scoped prompts and transient OAuth presentation. Deliver it only to a bound, eligible client that negotiated the interaction kind. On reconnect, resend currently pending notifications; never revive transient OAuth after daemon restart. Ordinary session interactions remain on the revisioned stream.

## Alternatives considered

- Persisting OAuth in session projections would violate the credential boundary and consume unrelated session revisions.
- Keeping these prompts local to the TUI would prevent the daemon from owning arbitration and recovery.

## Consequences

Clients keep notification state separately and discard it on transport loss. This adds a protocol envelope variant; the unpublished protocol surface must be accounted for in the final release assessment. It does not add a new store or execution service.
