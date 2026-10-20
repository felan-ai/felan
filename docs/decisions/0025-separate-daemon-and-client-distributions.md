# ADR 0025: Separate daemon and client distributions

> Status: Accepted; implementation pending S1.07a
> Date: 2026-10-10
> Deciders: Felan maintainer, explicit user decision
> Related: [Story 1 handoff](../maintainers/session-daemon-implementation.md), [profile boundary](0021-bind-daemon-environments-through-profiles.md)

## Context

The original design distributed the daemon and clients in one Felan package.
The historical `apps/tui` directory contains both host composition and terminal
presentation. Cloud deployments need the same daemon with a different profile,
not the Felan CLI/TUI and its client dependency graph. Process separation alone
does not establish this distribution boundary.

## Decision

Create `apps/daemon`, published as `@felan-ai/daemon`, for execution, persistence,
environment hosts and profiles. Move the CLI, TUI, ACP and headless clients to
`apps/felan`, retaining the `@felan-ai/felan` name and `felan` command. The daemon
must not depend on this client application. Its profile API belongs to the
daemon package; portable contracts remain in Agent Core and session-protocol.

The client distribution ships the daemon through an exact package dependency
and resolves that installed entrypoint. Initially releases are coordinated, so
local users still perform one installation. CLI commands and TUI controls
manage the daemon through the existing ownership and control contracts. Client
exit remains detach, not daemon shutdown. Cloud installs only daemon and profile.

Implement the packaging split after S1.07 verification and before S1.08. Preserve
runtime behavior and reviewed history; cloud implementation is not added here.

## Alternatives considered

- Keep one package and rename `apps/tui`: simplest wiring, but cloud still
  receives the client distribution and dependency boundaries remain unclear.
- Independently install and release both applications: flexible, but adds
  installation and upgrade coordination not needed for the current goals.

## Consequences

- Separate application manifests, exports and one-way import tests are required.
- Package moves require fresh verification manifests and explicit owner handoffs.
- Public profile exports and packed exact dependencies need deliberate SemVer
  and release checks; a new package requires the normal publication bootstrap.
- The pinned Pi SDK itself depends on `pi-tui`. Audit and document that upstream
  payload without claiming zero terminal-related dependencies, requiring an
  upstream change, or moving daemon-owned PTY execution into the client.
