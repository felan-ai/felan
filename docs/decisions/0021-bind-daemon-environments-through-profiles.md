# ADR 0021: Bind daemon environments through a small host profile

> Status: Accepted for Story 1
> Date: 2026-10-10
> Deciders: Felan maintainers, approved Story 1 plan
> Related: [Profile contract](../maintainers/session-daemon-contracts.md#public-profile-seam-felan-aifelandaemon-profile)

Distribution amendment: [ADR 0025](0025-separate-daemon-and-client-distributions.md)
moves the profile surface to the daemon package during S1.07a. The
`@felan-ai/felan/daemon-profile` path below records the original implementation;
it is not the target client-package boundary. The ownership and profile rules
remain unchanged.

## Context

The local composition root owns credentials, host paths, settings, extension
allowlists, model selection, memory and process hosts. A future private cloud
profile must use the same daemon without putting private platform code in the
public binary or moving local policy into Agent Core.

## Decision

Export a small versioned profile type surface from
`@felan-ai/felan/daemon-profile`. Resource discovery is read-only; opening a
session requires already-verified ownership. A local implementation binds the
existing Agent Core/extension services and injected daemon interaction, child
and process ports. The shared daemon owns admission, lifecycle, revisions and
protocol behavior. Presenter code is loaded by clients, not by the local profile.

The user subsequently superseded per-session environment transfer: all local
sessions use the daemon launch environment, fixed until restart. Initialize
PI_* and process-wide HTTP proxy/idle-timeout configuration once, and require restart for
changes. Keep per-session cwd/config/model registrations independent;
no getEnv/provisioning API or provider patch is required.

Only implement the local profile now. Configuration and credentials are files;
existing locked auth refresh remains supported. A live session adopts changed
configuration only on explicit reload. Do not build generic plugin discovery or
a new persistence backend to anticipate the cloud.

## Alternatives considered

- Duplicate local/cloud composition roots: initially cheap but perpetuates
  different execution/lifecycle behavior.
- Put environment policy in Agent Core: couples portable consumers to local
  storage, credentials and interaction policy.
- A general service-container/plugin framework: adds a public abstraction much
  larger than the current local/future-cloud variation requires.

## Consequences

- Profile API changes are public SemVer changes and need packed export tests.
- S1.05 owns the app export together with its emitted file; S1.02 owns only the
  protocol package and its root dependency wiring. No dangling profile export.
- Public types use Agent Core's re-export surface rather than direct Pi imports.
- Tests can bind fake services before registry/broker implementation exists.
- Existing extension host contracts are reused; feature behavior stays in its
  owning package. Presentation extraction is necessary, not optional mode checks.
