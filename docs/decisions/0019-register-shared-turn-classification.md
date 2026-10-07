# ADR 0019: Register shared turn classification and temporary selection ownership

> Status: Accepted
> Date: 2026-10-07
> Deciders: Felan maintainers
> Related: [classifier lifecycle](../concepts/classifier-lifecycle.md)

## Context

Prewalk entry, discovery routing and regular effort independently classified the
same turn. Sharing a deadline did not share evidence or reconcile phase intent:
Prewalk could inherit low-effort planning and then raise implementation effort.
Its automated selections could also be mistaken for permanent manual overrides.
The classifier already accepts multiple typed questions, while feature rules
belong to extensions rather than a feature-aware Core router.

## Decision

Agent Core owns an optional session-scoped registration and coordination service.
Extensions contribute eligible namespaced questions and additional state over a
shared bounded, sanitized snapshot, then consume their own validated answers.
Registration, cancellation, deadlines, stale-result guards and lifecycle cleanup
are Core concerns; criteria, thresholds, actions and fallbacks remain feature-owned.
The existing classifier contract and host-owned credentials/settings remain intact.

Independent questions state conditional premises rather than depending on another
answer in the same request. Code selects the applicable result. Prewalk establishes
an authenticated, scoped, capable planning profile after entry approval and owns
selection during its phases. Configured implementation targets remain authoritative;
classifier escalation recommendations are advisory. Core provides feature-neutral
temporary ownership and automated-selection provenance, preserving manual choices
and restoring the original pre-entry selection without changing saved defaults.

Child-launch, handoff, completion, compaction and memory decisions retain their own
evidence boundaries. Do not predict later assignments or implementation requirements
from entry evidence alone.

## Alternatives Considered

- Keep independent parallel calls: simplest migration, but repeats state and leaves
  consistency and selection ownership unresolved.
- Batch calls without phase ownership: reduces request duplication without preventing
  low planning effort, silent implementation escalation or permanent override pins.
- Hardcode a central feature router: rejects extensible feature ownership and couples
  portable Core composition to Prewalk and subagent policy.
- Replace typed questions with one free-form planner prompt: requires parsing and
  broadens model authority instead of keeping decisions bounded by code.

## Consequences

- Extensions can add entry decisions without owning provider transports or root timing.
- One logical pass may still require several provider requests under existing byte
  budgets; slow preparation or a failed response can exhaust the shared pass.
- Manual selections and entry approval remain authoritative; internal changes release
  their temporary scope rather than permanently disabling ordinary dynamic thinking.
- Fewer requests do not establish latency, quality or cost improvements. The existing
  evaluation framework contains prepared comparisons; provider execution remains
  separately authorized and unmeasured.
- Applying the root deadline to registered custom classifiers changes documented
  lifecycle behavior, so Core advances to 0.11.0. Extensions advance their 0.x
  minor versions to require the matching compatible-minor peer; unchanged feature
  implementations receive manifest-only compatibility updates.
