# ADR 0012: Share memory checkpoint-input compaction

> Status: Accepted
> Date: 2026-09-14
> Deciders: Felan maintainers
> Related: [Local memory architecture](../concepts/local-memory.md), [`@felan-ai/ext-memory`](../../packages/ext-memory/README.md)

## Context

Felan Code and Felan Platform both need to turn Pi session checkpoints into
bounded, redacted evidence for memory processing. The transformation is
feature behavior, while transcript storage, scheduling, leases, model calls,
staging, publication, and cursor acknowledgement differ by host.

The platform implementation duplicated lineage selection and projection in an
application module. That makes security and correctness fixes diverge between
hosts, particularly for branch rewrites, Pi compaction summaries, and bounded
JSONL output.

## Decision

`@felan-ai/ext-memory` owns the host-neutral checkpoint-input transformation.
It validates replayed session lines, removes injected memory context, computes
checkpoint relations, preserves active-lineage `compaction` and
`branch_summary` records, projects and redacts evidence deterministically, and
rejects output that cannot fit as complete JSONL. Diverged lineages emit the
complete current visible lineage and identify the prior cursor for downstream
reconciliation.

Hosts provide transcript readers and choose resource limits. They retain all
storage, scheduling, model, staging, retry, publication, and acknowledgement
policy. Agent Core and the session-compaction extension do not own
cross-session memory processing.

## Alternatives Considered

- Keep separate local and cloud materializers: rejected because identical
  evidence policy would continue to require duplicated security fixes.
- Put the materializer in Agent Core: rejected because Agent Core is
  feature-neutral and should not own memory policy.
- Put it in `ext-session-compaction`: rejected because that package owns
  single-session Pi compaction hooks, not cross-session memory input.

## Consequences

- Local and cloud hosts can share deterministic evidence semantics and golden
  fixtures.
- Hosts remain free to use filesystem, database, or object-storage readers and
  different batch budgets.
- A complete checkpoint is never acknowledged from partial or malformed input.
- Branch divergence metadata enables, but does not itself perform, stale-memory
  retraction; the host dreamer and publication policy remain responsible.
