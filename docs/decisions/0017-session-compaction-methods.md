# ADR 0017: Provide summary and classifier session-compaction methods

> Status: Accepted
> Date: 2026-09-20; amended 2026-10-23 for summary default and classifier fallback
> Deciders: Felan maintainers
> Related: [ADR 0005](0005-own-verified-session-compaction-in-an-extension.md),
> [ADR 0016](0016-jev-classifier-in-agent-core.md)

## Context

Felan's verified summary method preserves structured evidence and continuity,
but it spends a summary-model request and can still lose exact transcript detail.
The classifier capability offers a different trade-off: select and shorten
historical tool evidence while retaining the surviving transcript verbatim.
The earlier `prune` setting combined both operations, making its cost and
quality impossible to attribute and leaving the classifier's small benefit
confounded with summarization.

## Decision

Amended 2026-10-23: `summary` is the default method; `classifier` is opt-in.
Ordinary compaction falls back from classifier to verified summary, then native
Pi. [Idle-expiry compaction](0045-compact-before-prompt-cache-expiry.md) may use
the classifier or verified summary, but cancels on failure without native Pi.

Expose one explicit `sessionCompaction.method` with `summary` and `classifier`
values. When selected and the host injects the provider-neutral classifier,
it retains, shortens, or drops every eligible
historical tool call/result pair admitted by the central evidence bounds, then
returns the resulting transcript without a summary-model request. Without that
capability, the extension uses verified summary compaction. Selecting `summary`
explicitly disables classification and uses the configured summary model. Agent
Core partitions the classifier question set across provider requests when
necessary.

Both methods remain inside the single session-compaction extension and use Pi's
prepared cut, retained tail, lifecycle, and persistence. Missing classifier
credentials select verified summary compaction. Classifier request failures
also use that method, making one additional request with the configured summary
model; native Pi takes over only if ordinary summary compaction also fails.
For ordinary compaction, unsafe bounds or classifier split-prefix preparation
failures return control directly to native Pi, while cancellation remains
cancellation.
`model` continues to select only the summary method's model; it is not overloaded
with a classifier sentinel.

The design was informed by the MIT-licensed
[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction/tree/e3f262a7f4d42bd8dd32ced30d26176f7cb545b0)
and [pi-jev](https://github.com/iefnaf/pi-jev/tree/77516ee1a51e98958430e24a9a82d58173e3422a)
repositories. Felan does not copy their source.

## Alternatives Considered

- Keep prune-then-summarize: rejected because it adds classifier cost without
  isolating a second compaction method.
- Use `model: classifier`: rejected because method selection and summary-model
  selection are separate concerns and would make configuration and metrics
  ambiguous.
- Add a second compaction extension: rejected because Pi accepts one custom
  result and multiple producers would compete for the same prepared cut.

## Consequences

- Benchmarks can compare native Pi, verified summary, and classifier-only
  transcript compaction with attributable model calls and costs.
- Classifier mode may retain more raw transcript text than summary mode and
  does not replace semantic continuity extraction; continuation quality remains
  the promotion gate. Pi/model budgets govern summary capacity; Felan does not
  impose a separate fixed compaction-result byte ceiling.
- Existing sessions remain readable because the method is configuration-only;
  persisted compaction entries continue to use the existing namespace.
