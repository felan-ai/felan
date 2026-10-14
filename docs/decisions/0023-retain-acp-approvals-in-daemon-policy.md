# ADR 0023: Retain ACP approvals in daemon session policy

> Status: Accepted for Story 1
> Date: 2026-10-10
> Deciders: Felan maintainers, explicit user ACP gate choice
> Related: [Policy contract](../maintainers/session-daemon-contracts.md#acp-policy-transition-and-interaction-contract), [ADR 0004](0004-own-native-acp-in-the-local-host.md)

## Context

ACP currently asks the editor before unsafe tools and exempts named read-only
built-ins. In a shared session the editor cannot own approval callbacks or
execution lifetime. Existing load/replay should continue while a session is
busy, without adding a read-only/fork product restriction or weakening safety.

## Decision

Create ACP sessions with strict approvals. Loading an existing host-default
session attaches, replays and tightens the root tree to strict policy
immediately; running tool calls keep the approvals they already had. When the
last ACP attachment in the tree detaches, the tree relaxes to host defaults.
Children, forks and restored sessions inherit the current policy.

Amended: the earlier pending, one-way tightening with a safe-boundary activation
wait was removed because 0.28.3 never refused ACP prompts on that basis and
permanently strict sessions surprised TUI users.

The daemon broker owns approvals and validates trusted built-in provenance,
not only tool names. An eligible TUI can answer. Editor loss leaves pending
requests unresolved, not approved, denied or automatically cancelled. ACP
retains its current public capabilities and translation, not a parallel engine.

## Alternatives considered

- Per-turn origin privileges: adds policy switching and enables queued/child
  work to run with accidental or spoofed authority.
- Require an idle/read-only load or force a fork: changes the approved ACP
  workflow unnecessarily.
- Bind approvals to the editor attachment: breaks surviving runs on disconnect
  and prevents other eligible local clients answering.

## Consequences

- Name-collision, busy-load and detach-relaxation tests are safety gates.
- Same-UID client-kind claims are cooperative policy, not a sandbox against
  arbitrary code running as the same operating-system user.
