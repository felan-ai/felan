# ADR 0014: Own Jev as a portable classifier service

> Status: Superseded
> Date: 2026-09-18
> Deciders: Felan maintainers
> Superseded-by: [ADR 0016](0016-jev-classifier-in-agent-core.md)
> Related: [ADR 0005](0005-own-verified-session-compaction-in-an-extension.md),
> [ADR 0010](0010-retire-code-mode.md),
> [Efficient execution](../concepts/efficient-execution.md),
> [`Pi_Compaction_Research.md`](../research/Pi_Compaction_Research.md)

## Context

TypeSafe Jev is a System One model: unstructured state in, typed probabilistic
answers out. It evaluates Choice, Score, and Noul questions and cannot generate
prose. Felan wants that classifier so owning extensions can make better keep,
drop, and routing decisions. Compaction, Prewalk, memory, and subagents already
have owners. Pi 0.85.1 accepts only one custom compaction result per prepared
span. Two `session_before_compact` producers can both spend models. ADR 0005
already rejected a second compaction product inside
`@felan-ai/ext-session-compaction`. Extensions see only their own `pi.config`,
so a consumer cannot read `extensionConfig.jev` by itself.

## Decision

Create `@felan-ai/ext-jev` as a portable Jev classifier service. The package
owns the Typesafe and OpenRouter transports, question/answer validation, and
host-owned credential configuration. It does not register compaction, routing,
or other Pi lifecycle hooks. Agent Core stays feature-neutral. Other extensions
do not import `@felan-ai/ext-jev` at runtime.

The local host is the composition root. When the Jev built-in is enabled and a
credential resolves, the host injects a structural classifier into owning
factories. Session compaction defines that classifier as an optional
`evaluate(state, questions, signal)` dependency. Missing credentials, a
disabled Jev built-in, or classifier failure leave the owner’s existing
behavior unchanged.

The first consumer is opt-in prune-then-summarize in
`@felan-ai/ext-session-compaction`. Jev may classify eligible successful tool
evidence as keep, drop, or shorten. Session compaction still extracts bounded
evidence, protects split-turn prefix and failures, writes the canonical
checkpoint, and falls back to native Pi. Jev does not write summary prose or
replace Pi cut points. Model routing, Prewalk gating, memory filtering,
auto-branching, and tool-safety classification stay out of scope until those
owners receive the same injection seam and a quality-gated eval.

## Alternatives Considered

- Jev as a competing `session_before_compact` producer: rejected because it
  creates a second compaction product, cannot emit canonical checkpoints, and
  forces evals to disable verified summarization.
- Session compaction imports `ext-jev`: rejected because portable extensions
  peer-depend only on Agent Core, cannot read another extension’s config, and
  would couple later owners to compaction.
- A non-extension `@felan-ai/jev` library: rejected because there is no
  `extensionConfig` home for credentials once a second consumer exists.
- Host-injected classifier used by every owner in v1: rejected as premature;
  only compaction is wired now.

## Consequences

- `extensionConfig.jev` configures provider and keys only.
  `extensionConfig.sessionCompaction.prune` opts into Jev pruning and defaults
  to `off`.
- There is one compaction producer. Eval arms that measure Jev keep session
  compaction enabled and set prune to `jev`.
- Future owners reuse the host-injected classifier rather than depending on
  `ext-jev` or session compaction.
- Token reduction alone is not a savings claim. Continuation quality against
  native Pi remains the gate before cost objectives.
- npm bootstrap of the new package remains a release-time step.
