# ADR 0023: Retain ACP approvals as monotonic daemon session policy

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
session attaches and replays immediately; queue one-way policy tightening and
activate it at a safe dispatch boundary before any new dispatch. ACP prompts receive
a typed busy/retry response until that activation. Never change an in-flight
run's policy or loosen policy on detach. Children, forks and restored sessions
inherit the effective restriction and pending tightening.

Activation requires no in-flight turn/tool call or admitted dispatch anywhere
in the session/root scope, including active child turns. Detached background
jobs, PTYs and idle retained children do not block it; their future control
actions are gated tool calls. Expose blocking IDs/reasons, cap explicit activation
waits at 30 seconds with typed busy/cancel/retry guidance, and keep authorized
blocker cancellation available. Neither a timeout nor policy activation changes
process shutdown rules or silently cancels work.

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

- A session may remain stricter after the editor leaves; this is deliberate.
- Name-collision, busy-load, queued-dispatch and detach tests are safety gates.
- Same-UID client-kind claims are cooperative policy, not a sandbox against
  arbitrary code running as the same operating-system user.
