# ADR 0036: Configure extension services through trusted providers

> Status: Accepted; implemented, final review and release verification pending
> Date: 2026-10-12
> Deciders: Felan maintainer, approved services migration plan
> Supersedes: [ADR 0021](0021-bind-daemon-environments-through-profiles.md)
> Amends: [ADR 0025](0025-separate-daemon-and-client-distributions.md)
> Related: [Activation ordering](0029-activate-daemon-services-after-registration.md), [shared launch environment](0022-shared-daemon-launch-environment-and-explicit-lifetime.md)

## Context

The initial daemon profile and extension importer bind a separate host interface
for each feature. Adding an extension therefore requires deployment-specific
composition changes. Moving those interfaces into a fixed service table would
retain the coupling rather than remove it.

The revised design requires configurable providers and portable extension
contracts. The maintainer reconfirmed the separate daemon and client packages;
older single-package wording in the design does not reverse that decision.

## Decision

Extensions declare required and optional services using named, major-versioned
contracts and receive scoped implementations through the extension API. Agent
Core owns the extensible registry and shared contracts; extensions may publish
additional contracts without changing Core or the daemon. Missing required
services prevent extension activation with an explicit diagnostic. Missing
optional services disable only the dependent features. Interactions and
presentation use the common UI boundary, not extension-specific host services.

Keep `@felan-ai/daemon` generic. Local provider implementations and the default
`host.json` belong to `@felan-ai/felan`. A minimal managing-package entry passes
its fixed installation resolution anchor to the daemon. Configuration selects
installed package exports but cannot supply that anchor. Neither project
settings, the configuration file's location nor the working directory determines
which provider code resolves. The daemon never depends on the client package.

Configuration precedence is an explicit `--host-config`, then `host.json` in the
agent directory, then a packaged default explicitly supplied by the launcher.
The daemon has no implicit default and does not create or overwrite user
configuration. Existing extension enablement settings may narrow the configured
allowlist, never expand it. Provider selection changes require restart;
extension and policy changes apply to new sessions or explicit reload, not
silently during eviction and restoration. The daemon launch environment remains
shared and fixed until restart.

The daemon retains canonical ownership, admission, the control ledger and
session lifecycle. Configured providers use restricted engine operations rather
than creating another registry or receiving unrestricted registry access.
Validate dependencies and options before activation, reject duplicate providers
and dependency cycles, and keep session preflight free of execution effects.
Activate only after registration. Settle owned work before Pi disposal, retain
presentation until asynchronous shutdown handlers finish, and release shared
providers only after their dependent scopes drain. Failed cleanup must not
release ownership prematurely.

Replacing the profile API must preserve persisted session identities, resource
paths, configuration and request outcomes. Convert legacy state only when the
meaning is preserved; otherwise report blocked recovery without overwriting,
replaying or automatically cancelling the affected work.

## Alternatives considered

- Retain profiles or rename each host to a service: preserves feature-specific
  composition in every deployment.
- Add a fixed set of service properties to Core: requires Core changes for new
  extension contracts.
- Discover providers from projects or configuration-relative paths: lets
  workspace content or file relocation select daemon-authority code.
- Merge daemon and clients: unnecessary for configured services and contrary to
  the confirmed distribution boundary.

## Consequences

Public host/profile API removals require deliberate SemVer and coordinated
consumer updates. Import-boundary, configuration-resolution, lifecycle and
persisted-state tests are required alongside clean packed-install verification.
Service handles limit accidental authority but do not sandbox JavaScript
extensions. Cloud provider implementation remains outside this migration.
