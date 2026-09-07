# ADR 0001: Retain local memory work as standard sessions

> Status: Accepted
> Date: 2026-09-05
> Deciders: Felan maintainers
> Related: [Local memory architecture](../concepts/local-memory.md)

## Context

Background memory work consumes model capacity and must remain attributable,
inspectable, bounded, and recoverable. The local host already relies on Pi's
append-only `SessionManager` JSONL format and Insights parser. Memory processing
also needs linked diagnostic artifacts that must not appear in the customer
repository or become canonical memory.

The choice affects local TUI storage and presentation only. Felan Platform owns
separate persistence, scheduling, team archives, and entitlements. Agent Core
and `@felan-ai/ext-memory` must remain adapter-neutral.

## Decision

The local TUI retains every memory worker as a standard Pi session under
`<sessionDir>/memory`, linked by validated metadata to a project-scoped run
directory. The normal picker labels these entries `Memory:`, and `/memory`
opens a status, retained-run, and read-only transcript view. Existing explicit
session operations remain unchanged.

The subdirectory is organizational, not an execution sandbox or portable
session-kind contract. Metadata classifies records for presentation and
retention; bounded reads, ownership validation, filesystem checks, durable
control generations, and writer leases enforce safety. Insights counts each
retained worker once through its existing session accounting contract.

## Alternatives Considered

- Store memory sessions flat beside ordinary sessions: rejected because it
  makes routine discovery noisy and couples ordinary recovery to background
  diagnostics.
- Define a custom transcript format: rejected because it duplicates Pi parsing,
  usage accounting, and inspection behavior.
- Add a portable memory-session kind and operation guards: rejected because it
  would leak local host policy into shared contracts and change explicit
  resume/import/fork behavior.

## Consequences

- Memory work uses existing session tooling and remains directly inspectable.
- Flat ordinary-session discovery naturally excludes the nested files; memory
  history and configured-directory Insights discovery opt in explicitly.
- Run metadata cannot be trusted by itself; reconciliation and deletion must
  prove record identity and ownership read-only before mutation. Terminal
  workspaces are disposable; the session JSONL and manifest remain inspectable.
- Publication recovery trusts durable canonical state and exact checkpoint
  cursors, not diagnostic manifests; ambiguous interruptions remain pending and
  rerunnable without consuming a failure attempt.
- Local retention, retry, cancellation, and warning policy can evolve without a
  shared API or Platform database migration.
- Global extension enablement follows ordinary root-session construction; live
  current-session observation and cross-process cancellation are intentionally deferred.
