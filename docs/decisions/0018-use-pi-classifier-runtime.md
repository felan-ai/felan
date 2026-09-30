# ADR 0018: Use Pi's classifier runtime behind Felan's classifier contract

> Status: Accepted
> Date: 2026-09-30
> Deciders: Felan maintainers
> Supersedes: [ADR 0016](0016-jev-classifier-in-agent-core.md)

## Context

Pi 0.99 provides classifier models, credential resolution, catalog discovery,
and native classification transports. Felan's separate Jev clients duplicate
that infrastructure, while its feature owners already depend on a portable
runtime capability and optional-decision fallbacks. The root preflight deadline
is a Felan lifecycle policy, not a provider transport concern.

## Decision

Keep the optional Agent Runtime classifier capability with one classification
operation supporting choice, boolean-probability, and score judgments. Agent
Core bridges that contract to the host's injected Pi model runtime and retains
bounded admission, answer validation, usage mapping, and managed-root preflight.
Retire the owned Jev clients and their direct-HTTPS ownership exception.

The local application owns global classifier-model settings and selection from
authenticated Pi catalog models. Auto prefers Jev before other configured
classifiers. An unavailable explicit choice warns and uses Auto without
rewriting the saved preference. Credentials remain host-owned and feature
extensions retain their decision policies and fallback behavior.

## Alternatives Considered

- Retain the owned transports while borrowing auth/catalog data: rejected as
  continuing avoidable duplication and provider-specific maintenance.
- Replace the portable capability with direct Pi calls in every feature:
  rejected because it moves host selection and lifecycle concerns into owners.
- Silently disable an unavailable explicit model: rejected in favor of the
  user's chosen warning-and-Auto behavior.

## Consequences

- Native providers can be adopted without new Felan HTTP clients; configured
  classifier data destinations are broader than TypeSafe/OpenRouter alone.
- The shared root deadline and late-answer suppression remain independent of
  native request timeouts and retries.
- This is a breaking contract change in the pending Agent Core 0.10.0 release;
  consumers migrate together without retaining legacy method aliases.
- Catalog-priced costs are estimates; missing pricing is not free inference,
  and provider changes require workflow-specific quality validation.
