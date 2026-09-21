# ADR 0015: Structured logger in Agent Core

> Status: Accepted
> Date: 2026-09-19
> Deciders: Felan maintainers
> Related: [ADR 0005](0005-own-verified-session-compaction-in-an-extension.md),
> [Architecture](../concepts/architecture.md)

## Context

Session compaction needed a durable prune trace (trigger, state, questions,
answers, leftovers) that must not enter session JSONL. The first implementation
was a TUI-only, env-gated JSONL sink injected as `debugPrune`. That sink is
feature-specific, bypasses `AgentRuntime` storage, and cannot be reused by other
extensions or by a cloud host.

Hosts still differ: the local TUI wants a persistent file under agent storage
so maintainers can leave debug logging on; a cloud consumer may send the same
events to stdout, a collector, or nowhere. Session storage remains the wrong
place because logs must outlive a single transcript and must not mix with
session evidence.

## Decision

Agent Core owns a small structured logger: levels, child bindings, and
JSON-safe fields. It is not a third-party logging framework and does not write
files itself.

The host owns configuration and the destination. The local TUI decides enablement,
level, and persistence, and by default appends under `storage('agent')` rather
than session storage or `~/.felan/logs` outside the runtime. Extensions and the
TUI obtain the same logger from Agent Core. Session compaction logs prune
events through that logger directly; the host-injected `debugPrune` callback
is removed.

## Alternatives Considered

- Keep the TUI compaction-debug sink: rejected because it cannot be shared and
  bypasses runtime storage.
- Depend on pino inside Agent Core: rejected because destinations, append
  semantics, and cloud transports belong to the host, not the portable contract.

## Consequences

- Agent runtime storage must support append for persistent log files, or the
  TUI destination must append through an equivalent agent-scoped path.
- Compaction stays host-neutral for filesystems; it only calls the core logger.
- Debug payloads can contain session excerpts. Default-on TUI debug is a host
  policy choice and must stay out of session JSONL and model context.
- Future owners reuse the same logger instead of adding one-off sinks.
