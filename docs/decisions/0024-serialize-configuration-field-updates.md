# ADR 0024: Serialize configuration field updates without compare-and-set

> Status: Accepted for Story 1
> Date: 2026-10-10
> Deciders: Felan maintainers, explicit user configuration concurrency choice
> Related: [Server contract](../maintainers/session-daemon-server.md), [ADR 0020](0020-own-local-session-protocol-and-stores.md), [ADR 0022](0022-shared-daemon-launch-environment-and-explicit-lifetime.md)

## Context

The unpublished session protocol required `config.set.expectedRevision`, but
configuration reads exposed no revision and the existing settings writers
maintained none. Session revisions and the daemon clock do not represent
configuration versions. The local host already serializes cooperative settings
writes with a file lock and merges changed fields into the latest document.

## Decision

Configuration updates are unconditional, schema-validated field merges under
the existing host-owned settings lock. Unrelated fields are preserved; the last
successful writer wins when two updates address the same field. Reads do not
promise an optimistic-concurrency token.

Remove `expectedRevision` from the configuration mutation contract. Requests
that still supply it must be explicitly rejected before effects, rather than
silently stripping the field and appearing to honor compare-and-set. This does
not remove revision checks from branch, label, queue or deletion operations.

Only approved Felan-owned settings layers may be targeted. This decision does
not enable ambient Pi project settings, introduce a project document or define
session-override persistence. Configuration changes never transfer environment
variables, expose credentials or automatically reload running sessions.

## Alternatives considered

- Keep writes unavailable: safe temporarily, but not a complete configuration
  feature.
- Add real compare-and-set: requires atomic ownership of values and revisions,
  participation by existing writers, and defined external-edit behavior. That
  additional persistence contract is not selected for Story 1.
- Compare the daemon clock, session revision or file timestamp: rejected because
  none is an authoritative configuration version.

## Consequences

- Cooperative writers avoid lost updates to unrelated fields without a new
  version store. Same-field stale writes may overwrite newer values deliberately.
- Noncooperating file editors can still race; a lock is not isolation from them.
- Write and lock failures must be surfaced. An accepted update must not be
  inferred merely from a queued settings setter.
- This breaks an unpublished protocol contract. Release assessment must apply
  the repository's next-minor rule for breaking `0.x` APIs and inspect exact
  application dependencies before publication. No version bump is made here.
